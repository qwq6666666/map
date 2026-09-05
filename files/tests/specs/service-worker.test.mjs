/* ---------------------------------------------------------
   tests/specs/service-worker.test.mjs
   ---------------------------------------------------------
   驗證 public/sw.js 的快取策略：App Shell／Data JSON 用 Network-First
   （新版部署後使用者不會被卡在舊版），Tile 圖磚快取版本號跟 App/Data
   脫鉤、activate 清舊快取時絕對不會誤刪，Hashed Asset（JS/CSS）維持
   Cache-First，sw.js 自身的請求完全不攔截。

   public/sw.js 是傳統（非 ES module）腳本，直接用全域的 self /
   caches / fetch / Request / Response / URL，執行環境跟瀏覽器頁面
   （env-stub.mjs 模擬的 DOM + OpenLayers）完全不同，所以這裡刻意
   不 import env-stub.mjs，改用 Node 內建的 node:vm 建立一個獨立、
   乾淨的假 Service Worker global scope，只給這份測試用，避免污染
   既有的 DOM 測試環境。

   每個測試案例呼叫 createSWEnv() 拿到全新的 vm context（重新執行一次
   sw.js 的頂層程式碼、重新註冊 install/activate/fetch handler、
   重新建立一份空的假 CacheStorage），案例之間彼此不共用狀態。
--------------------------------------------------------- */
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SW_PATH = path.join(__dirname, '../../public/sw.js');
const swCode = readFileSync(SW_PATH, 'utf-8');

// 對齊 public/sw.js 目前的常數，測試裡直接寫死字串驗證，若哪天有人
// 改了版本號但沒有同步理解「App/Data／Tile 版本要脫鉤」這件事，
// 這份測試也會因為快取名稱兜不起來而失敗，提早曝露問題。
const APP_CACHE = 'app-shell-v2';
const DATA_CACHE = 'data-v2';
const TILE_CACHE = 'tile-cache-v1';
const OLD_APP_CACHE = 'app-shell-v1'; // 模擬「上一輪 SW 遺留」的舊版快取

/* ---------------------------------------------------------
   假的 Request / Response（不用真的瀏覽器 Fetch API，只還原
   sw.js 實際會讀取的欄位）
--------------------------------------------------------- */
class FakeRequest {
  constructor(url, init = {}){
    this.url = typeof url === 'string' ? url : String(url);
    this.method = init.method || 'GET';
    this.mode = init.mode || 'same-origin';
    this.destination = init.destination || '';
  }
}

class FakeResponse {
  constructor(body, init = {}){
    this.body = body;
    this.status = init.status !== undefined ? init.status : 200;
    this.ok = init.ok !== undefined ? init.ok : (this.status >= 200 && this.status < 300);
    this.type = init.type || 'basic';
    this.headers = init.headers || {};
  }
  clone(){
    // 真的 Response.clone() 是深拷貝 body stream，這裡不需要還原到那麼細，
    // 只要「拷貝後的物件互相獨立、內容相同」即可滿足 sw.js 的用法
    // （cache.put 存的一定是已經 clone 過的版本）。
    return new FakeResponse(this.body, { status: this.status, ok: this.ok, type: this.type, headers: this.headers });
  }
  async json(){ return typeof this.body === 'string' ? JSON.parse(this.body) : this.body; }
  async text(){ return typeof this.body === 'string' ? this.body : JSON.stringify(this.body); }
}
FakeResponse.error = () => new FakeResponse(null, { status: 0, ok: false, type: 'error' });

/* ---------------------------------------------------------
   建立一個全新、乾淨的假 Service Worker 執行環境：
   - 用 node:vm 開一個獨立 context，把 sw.js 的原始碼跑一次，讓
     self.addEventListener('install'|'activate'|'fetch', fn) 把
     handler 註冊進我們準備的假 self 物件。
   - caches 用 Map<cacheName, Map<url, response>> 實作，足夠應付
     sw.js 實際呼叫到的 open/match/put/delete/keys/delete(name)。
   - fetch 由呼叫端透過 setFetchImpl() 自行決定行為（回傳新版內容 /
     reject 模擬離線）。
--------------------------------------------------------- */
function createSWEnv(){
  const registered = { install: [], activate: [], fetch: [] };
  let skipWaitingCalled = false;
  let clientsClaimed = false;
  let fetchCallCount = 0;
  let fetchImpl = async () => { throw new Error('這個測試案例沒有設定 fetchImpl'); };

  const cacheStore = new Map(); // cacheName -> Map<url, FakeResponse>

  function getOrCreateCache(name){
    if(!cacheStore.has(name)) cacheStore.set(name, new Map());
    return cacheStore.get(name);
  }

  const context = {};
  context.self = context; // Service Worker global scope：self 就是 global 本身
  context.console = console;
  context.URL = URL; // Node 內建 URL，行為跟瀏覽器一致，直接借用
  context.Request = FakeRequest;
  context.Response = FakeResponse;

  context.addEventListener = (ev, fn) => {
    (registered[ev] = registered[ev] || []).push(fn);
  };
  context.skipWaiting = () => { skipWaitingCalled = true; };
  context.clients = { claim: async () => { clientsClaimed = true; } };
  context.registration = { scope: 'https://example.local/' };
  context.location = { origin: 'https://example.local' };

  context.caches = {
    async open(name){
      const store = getOrCreateCache(name);
      return {
        async match(request){
          const url = typeof request === 'string' ? request : request.url;
          return store.get(url);
        },
        async put(request, response){
          const url = typeof request === 'string' ? request : request.url;
          store.set(url, response);
        },
        async delete(request){
          const url = typeof request === 'string' ? request : request.url;
          return store.delete(url);
        },
      };
    },
    async keys(){
      return Array.from(cacheStore.keys());
    },
    async delete(name){
      return cacheStore.delete(name);
    },
  };

  context.fetch = (...args) => {
    fetchCallCount++;
    return fetchImpl(...args);
  };

  vm.createContext(context);
  vm.runInContext(swCode, context, { filename: 'public/sw.js' });

  return {
    // 觸發 fetch 事件，回傳 { called, promise }：called 代表 handler 有沒有呼叫
    // event.respondWith()（isOwnScriptRequest 命中時完全不呼叫），promise 是
    // respondWith() 拿到的那個 Promise，可以直接 await 取得最終 Response。
    triggerFetch(request){
      let called = false;
      let promise = null;
      const event = {
        request,
        respondWith(p){ called = true; promise = p; },
      };
      registered.fetch.forEach(fn => fn(event));
      return { called, promise };
    },
    // 觸發 activate 事件，回傳 event.waitUntil() 拿到的那個 Promise，
    // 呼叫端 await 完就代表清舊快取／clients.claim() 都跑完了。
    triggerActivate(){
      let waitUntilPromise = null;
      const event = { waitUntil(p){ waitUntilPromise = p; } };
      registered.activate.forEach(fn => fn(event));
      return waitUntilPromise;
    },
    triggerInstall(){
      registered.install.forEach(fn => fn({}));
    },
    presetCache(name, url, response){
      getOrCreateCache(name).set(url, response);
    },
    getCacheEntry(name, url){
      return cacheStore.has(name) ? cacheStore.get(name).get(url) : undefined;
    },
    getCacheNames(){ return Array.from(cacheStore.keys()); },
    getCacheSize(name){ return cacheStore.has(name) ? cacheStore.get(name).size : 0 ; },
    setFetchImpl(fn){ fetchImpl = fn; },
    getFetchCallCount(){ return fetchCallCount; },
    isSkipWaitingCalled(){ return skipWaitingCalled; },
    isClientsClaimed(){ return clientsClaimed; },
  };
}

/* ---------------------------------------------------------
   1. HTML（navigate 請求）Network-First：有網路就拿新版，並更新快取
--------------------------------------------------------- */
test('HTML navigate：有網路時拿新版內容，且會更新 APP_CACHE 裡的快取', async () => {
  const env = createSWEnv();
  const url = 'https://example.local/';
  env.presetCache(APP_CACHE, url, new FakeResponse('<html>舊版</html>'));
  env.setFetchImpl(async () => new FakeResponse('<html>新版</html>', { status: 200 }));

  const request = new FakeRequest(url, { mode: 'navigate' });
  const { called, promise } = env.triggerFetch(request);
  assertTrue(called, 'navigate 請求應該呼叫 event.respondWith()');

  const res = await promise;
  assertEqual(await res.text(), '<html>新版</html>', 'Network-First 應該回傳網路上的新版內容');

  const cached = env.getCacheEntry(APP_CACHE, url);
  assertEqual(await cached.text(), '<html>新版</html>', '拿到新版後應該同步 cache.put() 更新 APP_CACHE');
});

/* ---------------------------------------------------------
   2. HTML 離線 fallback：fetch reject 時退回快取版本，不丟例外
--------------------------------------------------------- */
test('HTML navigate：離線（fetch reject）時 fallback 回快取的舊版內容，不會丟出未處理例外', async () => {
  const env = createSWEnv();
  const url = 'https://example.local/';
  env.presetCache(APP_CACHE, url, new FakeResponse('<html>舊版（離線快取）</html>'));
  env.setFetchImpl(async () => { throw new Error('模擬離線，網路請求失敗'); });

  const request = new FakeRequest(url, { mode: 'navigate' });
  const { promise } = env.triggerFetch(request);

  const res = await promise;
  assertEqual(await res.text(), '<html>舊版（離線快取）</html>', '離線時應該 fallback 回快取版本');
});

/* ---------------------------------------------------------
   3. activate：新版 App Shell 快取會取代舊版（app-shell-v1 被清掉）
--------------------------------------------------------- */
test('activate：舊版 app-shell-v1 會被清掉，目前版本 app-shell-v2 保留', async () => {
  const env = createSWEnv();
  env.presetCache(OLD_APP_CACHE, 'https://example.local/old.html', new FakeResponse('舊版殘留'));
  env.presetCache(APP_CACHE, 'https://example.local/', new FakeResponse('目前版本'));

  const waitUntilPromise = env.triggerActivate();
  assertTrue(waitUntilPromise, 'activate handler 應該呼叫 event.waitUntil()');
  await waitUntilPromise;

  const names = env.getCacheNames();
  assertTrue(!names.includes(OLD_APP_CACHE), '舊版 app-shell-v1 應該被 activate 清除');
  assertTrue(names.includes(APP_CACHE), '目前版本 app-shell-v2 不應該被清掉');
  assertEqual(env.getCacheSize(APP_CACHE), 1, 'app-shell-v2 裡原本的內容應該完整保留');
  assertTrue(env.isClientsClaimed(), 'activate 結束後應該呼叫 self.clients.claim()');
});

/* ---------------------------------------------------------
   4. activate：App 改版不應該連帶清掉 Tile 快取
--------------------------------------------------------- */
test('activate：App Shell 改版清除舊快取時，完全不影響 tile-cache-v1 的內容', async () => {
  const env = createSWEnv();
  env.presetCache(OLD_APP_CACHE, 'https://example.local/old.html', new FakeResponse('舊版殘留'));
  env.presetCache(TILE_CACHE, 'https://gis.sinica.edu.tw/tile/1.png', new FakeResponse('圖磚1'));
  env.presetCache(TILE_CACHE, 'https://gis.sinica.edu.tw/tile/2.png', new FakeResponse('圖磚2'));

  await env.triggerActivate();

  const names = env.getCacheNames();
  assertTrue(!names.includes(OLD_APP_CACHE), '舊版 App Shell 快取應該被清掉');
  assertTrue(names.includes(TILE_CACHE), 'tile-cache-v1 不應該被 activate 誤刪整個 cache');
  assertEqual(env.getCacheSize(TILE_CACHE), 2, 'tile-cache-v1 裡原本的 2 筆圖磚應該完整保留，一筆都不能少');
});

/* ---------------------------------------------------------
   5. data/*.json Network-First：有網路就拿新版並更新 DATA_CACHE
--------------------------------------------------------- */
test('data/*.json：有網路時拿新版內容，且會更新 DATA_CACHE 裡的快取', async () => {
  const env = createSWEnv();
  const url = 'https://example.local/data/layers.bundle.json';
  env.presetCache(DATA_CACHE, url, new FakeResponse('{"version":"舊"}'));
  env.setFetchImpl(async () => new FakeResponse('{"version":"新"}', { status: 200 }));

  const request = new FakeRequest(url); // 一般 <link>/fetch 抓 JSON，mode/destination 用預設值即可
  const { promise } = env.triggerFetch(request);
  const res = await promise;

  assertEqual(await res.text(), '{"version":"新"}', 'Network-First 應該回傳網路上的新版 JSON');
  const cached = env.getCacheEntry(DATA_CACHE, url);
  assertEqual(await cached.text(), '{"version":"新"}', '拿到新版後應該同步更新 DATA_CACHE');
});

/* ---------------------------------------------------------
   6. Network failure 時，index.html 與 data JSON 都能正確 fallback
--------------------------------------------------------- */
test('Network failure：index.html 與 data JSON 都能各自 fallback 回快取版本，不會丟出未處理例外', async () => {
  // 6a：index.html
  const envHtml = createSWEnv();
  const htmlUrl = 'https://example.local/';
  envHtml.presetCache(APP_CACHE, htmlUrl, new FakeResponse('<html>離線快取版</html>'));
  envHtml.setFetchImpl(async () => { throw new Error('網路離線'); });
  const { promise: htmlPromise } = envHtml.triggerFetch(new FakeRequest(htmlUrl, { mode: 'navigate' }));
  const htmlRes = await htmlPromise;
  assertEqual(await htmlRes.text(), '<html>離線快取版</html>', 'index.html 離線時應該 fallback 回快取');

  // 6b：data JSON
  const envData = createSWEnv();
  const dataUrl = 'https://example.local/data/historical-names.json';
  envData.presetCache(DATA_CACHE, dataUrl, new FakeResponse('{"names":["舊"]}'));
  envData.setFetchImpl(async () => { throw new Error('網路離線'); });
  const { promise: dataPromise } = envData.triggerFetch(new FakeRequest(dataUrl));
  const dataRes = await dataPromise;
  assertEqual(await dataRes.text(), '{"names":["舊"]}', 'data JSON 離線時應該 fallback 回快取');
});

/* ---------------------------------------------------------
   額外驗證 1：Hashed JS/CSS 走 Cache-First，快取命中時完全不打網路
--------------------------------------------------------- */
test('Hashed asset（script）：快取命中時 Cache-First 完全不呼叫 fetch()', async () => {
  const env = createSWEnv();
  const url = 'https://example.local/assets/index-abc123.js';
  env.presetCache(APP_CACHE, url, new FakeResponse('console.log("cached")'));
  env.setFetchImpl(async () => { throw new Error('不應該打到網路'); });

  const request = new FakeRequest(url, { destination: 'script' });
  const { promise } = env.triggerFetch(request);
  const res = await promise;

  assertEqual(await res.text(), 'console.log("cached")', 'Cache-First 命中時應該直接回傳快取內容');
  assertEqual(env.getFetchCallCount(), 0, '快取命中時完全不應該呼叫到 fetch()');
});

/* ---------------------------------------------------------
   額外驗證 2：sw.js 自己的請求完全不攔截（不呼叫 respondWith）
--------------------------------------------------------- */
test('isOwnScriptRequest：對 /sw.js 的請求完全不呼叫 event.respondWith()，直接放行給瀏覽器', () => {
  const env = createSWEnv();
  const request = new FakeRequest('https://example.local/sw.js');
  const { called } = env.triggerFetch(request);
  assertTrue(!called, 'sw.js 自己的請求應該完全不套用任何快取策略，不能呼叫 respondWith()');
});

await run();
