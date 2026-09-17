/* ---------------------------------------------------------
   tests/specs-vitest/cors-proxy-worker.test.mjs
   ---------------------------------------------------------
   驗證 tools/cors-proxy-worker/worker.js：這支檔案是要直接貼進
   Cloudflare Workers 編輯器的獨立 ES module（export default
   { async fetch(...) }），只在使用者匯入沒開 CORS 的 WMTS 服務時才會
   被打到，跟前端 Vite 打包完全無關。

   跟 tests/specs/service-worker.test.mjs 測 public/sw.js 的手法一致：
   用 node:vm 讀取原始碼文字，在乾淨的假 global 環境裡執行，取出裡面
   的具名函式呼叫測試，不用真的碰 Cloudflare 執行環境。差異是 sw.js
   是傳統腳本可以直接丟進 vm.Script，但 worker.js 用了 ES module 的
   export default 語法，vm.Script 遇到 export 會直接丟語法錯誤——這裡
   讀檔後把檔案結尾的 export default {...} 區塊整段砍掉再丟進
   vm.Script（isBlockedHost／handleRequest／corsHeaders／jsonError 都是
   模組頂層的具名 function 宣告，不是 ESM 語法，砍掉 export default 那
   段之後這些函式會變成 vm context 全域可以直接呼叫的函式）。
--------------------------------------------------------- */
import { test, expect } from 'vitest';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, '../../tools/cors-proxy-worker/worker.js');
const rawCode = readFileSync(WORKER_PATH, 'utf-8');
// worker.js 是要直接貼進 Cloudflare Workers 編輯器的 ES module（export
// default { async fetch... }），這裡只需要裡面的具名函式（isBlockedHost／
// handleRequest 等），砍掉檔案結尾的 export default 區塊再丟進
// vm.Script，其餘 function 宣告會變成這個 vm context 全域可呼叫的函式。
const testableCode = rawCode.replace(/export default[\s\S]*$/, '');

/* ---------------------------------------------------------
   假的 Request / Response（比照 service-worker.test.mjs，只還原
   worker.js 實際會用到的欄位）
--------------------------------------------------------- */
class FakeResponse {
  constructor(body, init = {}){
    this.body = body;
    this.status = init.status !== undefined ? init.status : 200;
    this.ok = init.ok !== undefined ? init.ok : (this.status >= 200 && this.status < 300);
    this.headers = new Map(Object.entries(init.headers || {}));
  }
  clone(){
    return new FakeResponse(this.body, { status: this.status, ok: this.ok, headers: Object.fromEntries(this.headers) });
  }
  async text(){ return typeof this.body === 'string' ? this.body : JSON.stringify(this.body); }
}

class FakeHeaders {
  constructor(map = {}){ this.map = new Map(Object.entries(map)); }
  get(key){ return this.map.get(key) ?? null; }
}

function createWorkerEnv({ fetchImpl, cacheImpl } = {}){
  const context = {
    console,
    URL,
    Request: class {
      constructor(url, init = {}){
        this.url = typeof url === 'string' ? url : String(url);
        this.method = init.method || 'GET';
      }
    },
    Response: FakeResponse,
    fetch: fetchImpl || (async () => new FakeResponse('<Capabilities/>', {
      status: 200,
      headers: { 'Content-Type': 'text/xml' }
    })),
    caches: {
      default: cacheImpl || {
        async match(){ return undefined; },
        async put(){}
      }
    }
  };
  vm.createContext(context);
  new vm.Script(testableCode).runInContext(context);
  return context;
}

test('isBlockedHost：擋掉常見內網/保留位址', () => {
  const { isBlockedHost } = createWorkerEnv();
  expect(isBlockedHost('localhost')).toBeTruthy();
  expect(isBlockedHost('127.0.0.1')).toBeTruthy();
  expect(isBlockedHost('10.0.0.5')).toBeTruthy();
  expect(isBlockedHost('192.168.1.1')).toBeTruthy();
  expect(isBlockedHost('172.16.0.1')).toBeTruthy();
  expect(isBlockedHost('169.254.1.1')).toBeTruthy();
  expect(isBlockedHost('::1')).toBeTruthy();
});

test('isBlockedHost：新增的數字型 IP 偵測擋掉十進位/十六進位表示法', () => {
  const { isBlockedHost } = createWorkerEnv();
  expect(isBlockedHost('2130706433'), '十進位整數形式的 127.0.0.1').toBeTruthy();
  expect(isBlockedHost('0x7f000001'), '十六進位形式的 127.0.0.1').toBeTruthy();
});

test('isBlockedHost：正常的公開網域不會被誤擋', () => {
  const { isBlockedHost } = createWorkerEnv();
  expect(!isBlockedHost('wmts.nlsc.gov.tw')).toBeTruthy();
  expect(!isBlockedHost('gis.sinica.edu.tw')).toBeTruthy();
});

test('handleRequest：邊緣快取寫入透過 ctx.waitUntil() 保護，不是 fire-and-forget', async () => {
  let putCalled = false;
  let putPromise = null;
  const fakeCache = {
    async match(){ return undefined; },
    put(key, response){
      putCalled = true;
      // 回傳一個 Promise，模擬真實 cache.put() 的非同步行為；重點是
      // handleRequest 呼叫 cache.put() 之後，要把「這個 Promise 本身」
      // 交給 ctx.waitUntil()，而不是直接呼叫完就不管。
      putPromise = Promise.resolve();
      return putPromise;
    }
  };

  const waitUntilCalls = [];
  const fakeCtx = {
    waitUntil(promise){
      waitUntilCalls.push(promise);
      return promise;
    }
  };

  const { handleRequest } = createWorkerEnv({ cacheImpl: fakeCache });

  const fakeRequest = {
    method: 'GET',
    url: 'https://proxy.example.workers.dev/?url=' + encodeURIComponent('https://gis.sinica.edu.tw/foo/wmts/1.0.0/WMTSCapabilities.xml')
  };

  const response = await handleRequest(fakeRequest, fakeCtx);

  expect(response.ok, 'handleRequest 應該成功回應（假 fetch 回傳成功的 upstream response）').toBeTruthy();
  expect(putCalled, 'cache.put() 應該有被呼叫過一次').toBeTruthy();
  expect(waitUntilCalls.length, 'ctx.waitUntil() 應該被呼叫恰好一次').toBe(1);
  expect(waitUntilCalls[0] instanceof Promise, 'ctx.waitUntil() 收到的參數應該是一個 Promise（即 cache.put() 的回傳值），而不是先呼叫完 cache.put() 才傳別的東西進去').toBeTruthy();
  expect(waitUntilCalls[0] === putPromise, 'ctx.waitUntil() 傳入的 Promise 應該就是 cache.put() 回傳的那個 Promise 本身').toBeTruthy();
});
