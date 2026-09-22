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
import { test, expect, vi } from 'vitest';
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
const OSM_TILE_CACHE = 'tile-cache-osm-v1';
const SAT_TILE_CACHE = 'tile-cache-sat-v1';
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
  const registered = { install: [], activate: [], fetch: [], message: [] };
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
  // fetchWithTimeout() 需要這三個：用包一層的寫法（不是直接指派參照）避免跟
  // vi.useFakeTimers() 的呼叫時機綁死——sw.js 內部呼叫時才去查目前真正的
  // setTimeout/clearTimeout，測試不論是否已經啟用假計時器都能正確接上。
  context.setTimeout = (...args) => setTimeout(...args);
  context.clearTimeout = (...args) => clearTimeout(...args);
  context.AbortController = AbortController;

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
    // 觸發 message 事件（模擬 src/main.js 用 MessageChannel 呼叫
    // sw.js），回傳 { waitUntilPromise, received }：received 是這個
    // 假 port 收到的所有 postMessage 內容，呼叫端 await waitUntilPromise
    // 後再檢查 received 即可。
    triggerMessage(data){
      const received = [];
      const port = { postMessage(msg){ received.push(msg); } };
      let waitUntilPromise = null;
      const event = { data, ports: [port], waitUntil(p){ waitUntilPromise = p; } };
      registered.message.forEach(fn => fn(event));
      return { waitUntilPromise, received };
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
    // touchTileLRU／readTileLRU／writeTileLRU 都是 sw.js 模組頂層用
    // `async function` 宣告（不是 const），vm.runInContext(swCode, context)
    // 執行後這些函式會變成 context 物件上可以直接呼叫的屬性（頂層
    // function 宣告在 vm 的 script 模式下等同 sloppy-mode 全域屬性）。
    // 這裡把 context 開放出去，讓測試可以直接呼叫 touchTileLRU() 驗證
    // LRU 淘汰邏輯，不用真的透過 fetch 事件跑滿一輪假圖磚請求。
    getContext(){ return context; },
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
  expect(called, 'navigate 請求應該呼叫 event.respondWith()').toBeTruthy();

  const res = await promise;
  expect(await res.text(), 'Network-First 應該回傳網路上的新版內容').toBe('<html>新版</html>');

  const cached = env.getCacheEntry(APP_CACHE, url);
  expect(await cached.text(), '拿到新版後應該同步 cache.put() 更新 APP_CACHE').toBe('<html>新版</html>');
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
  expect(await res.text(), '離線時應該 fallback 回快取版本').toBe('<html>舊版（離線快取）</html>');
});

/* ---------------------------------------------------------
   3. activate：新版 App Shell 快取會取代舊版（app-shell-v1 被清掉）
--------------------------------------------------------- */
test('activate：舊版 app-shell-v1 會被清掉，目前版本 app-shell-v2 保留', async () => {
  const env = createSWEnv();
  env.presetCache(OLD_APP_CACHE, 'https://example.local/old.html', new FakeResponse('舊版殘留'));
  env.presetCache(APP_CACHE, 'https://example.local/', new FakeResponse('目前版本'));

  const waitUntilPromise = env.triggerActivate();
  expect(waitUntilPromise, 'activate handler 應該呼叫 event.waitUntil()').toBeTruthy();
  await waitUntilPromise;

  const names = env.getCacheNames();
  expect(!names.includes(OLD_APP_CACHE), '舊版 app-shell-v1 應該被 activate 清除').toBeTruthy();
  expect(names.includes(APP_CACHE), '目前版本 app-shell-v2 不應該被清掉').toBeTruthy();
  expect(env.getCacheSize(APP_CACHE), 'app-shell-v2 裡原本的內容應該完整保留').toBe(1);
  expect(env.isClientsClaimed(), 'activate 結束後應該呼叫 self.clients.claim()').toBeTruthy();
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
  expect(!names.includes(OLD_APP_CACHE), '舊版 App Shell 快取應該被清掉').toBeTruthy();
  expect(names.includes(TILE_CACHE), 'tile-cache-v1 不應該被 activate 誤刪整個 cache').toBeTruthy();
  expect(env.getCacheSize(TILE_CACHE), 'tile-cache-v1 裡原本的 2 筆圖磚應該完整保留，一筆都不能少').toBe(2);
});

/* ---------------------------------------------------------
   4.5 OSM 底圖圖磚跟其他圖磚（歷史 WMTS／衛星）各自走獨立的快取空間，
       互不干擾、activate 也都不會被誤刪。
--------------------------------------------------------- */
test('OSM 底圖圖磚（tile.openstreetmap.org）快取命中時走 OSM_TILE_CACHE，不進 TILE_CACHE', async () => {
  const env = createSWEnv();
  const url = 'https://a.tile.openstreetmap.org/15/1234/5678.png';
  env.presetCache(OSM_TILE_CACHE, url, new FakeResponse('OSM圖磚'));
  env.setFetchImpl(async () => { throw new Error('快取命中時不應該打到網路'); });

  const request = new FakeRequest(url, { destination: 'image' });
  const { promise } = env.triggerFetch(request);
  const res = await promise;

  expect(await res.text(), 'OSM 底圖圖磚快取命中時應該直接回傳 OSM_TILE_CACHE 裡的內容').toBe('OSM圖磚');
  expect(env.getCacheSize(TILE_CACHE), 'OSM 底圖圖磚不應該寫進 TILE_CACHE').toBe(0);
});

test('非 OSM 圖磚（中研院 WMTS）快取命中時走 TILE_CACHE，不進 OSM_TILE_CACHE', async () => {
  const env = createSWEnv();
  const url = 'https://gis.sinica.edu.tw/tile/1.png';
  env.presetCache(TILE_CACHE, url, new FakeResponse('WMTS圖磚'));
  env.setFetchImpl(async () => { throw new Error('快取命中時不應該打到網路'); });

  const request = new FakeRequest(url, { destination: 'image' });
  const { promise } = env.triggerFetch(request);
  const res = await promise;

  expect(await res.text(), '歷史 WMTS 圖磚快取命中時應該直接回傳 TILE_CACHE 裡的內容').toBe('WMTS圖磚');
  expect(env.getCacheSize(OSM_TILE_CACHE), '歷史 WMTS 圖磚不應該寫進 OSM_TILE_CACHE').toBe(0);
});

test('圖磚請求未命中快取時，OSM 與非 OSM 分別寫進各自的快取空間', async () => {
  const env = createSWEnv();
  const osmUrl = 'https://b.tile.openstreetmap.org/10/100/200.png';
  const wmtsUrl = 'https://gis.sinica.edu.tw/tile/2.png';
  env.setFetchImpl(async () => new FakeResponse('新圖磚', { status: 200 }));

  await env.triggerFetch(new FakeRequest(osmUrl, { destination: 'image' })).promise;
  await env.triggerFetch(new FakeRequest(wmtsUrl, { destination: 'image' })).promise;

  expect(!!env.getCacheEntry(OSM_TILE_CACHE, osmUrl), 'OSM 圖磚應該寫進 OSM_TILE_CACHE').toBeTruthy();
  expect(!env.getCacheEntry(TILE_CACHE, osmUrl), 'OSM 圖磚不應該同時出現在 TILE_CACHE').toBeTruthy();
  expect(!!env.getCacheEntry(TILE_CACHE, wmtsUrl), '歷史 WMTS 圖磚應該寫進 TILE_CACHE').toBeTruthy();
  expect(!env.getCacheEntry(OSM_TILE_CACHE, wmtsUrl), '歷史 WMTS 圖磚不應該同時出現在 OSM_TILE_CACHE').toBeTruthy();
});

test('activate：App Shell 改版清除舊快取時，完全不影響 OSM_TILE_CACHE 的內容', async () => {
  const env = createSWEnv();
  env.presetCache(OLD_APP_CACHE, 'https://example.local/old.html', new FakeResponse('舊版殘留'));
  env.presetCache(OSM_TILE_CACHE, 'https://a.tile.openstreetmap.org/1/1/1.png', new FakeResponse('OSM圖磚1'));

  await env.triggerActivate();

  const names = env.getCacheNames();
  expect(!names.includes(OLD_APP_CACHE), '舊版 App Shell 快取應該被清掉').toBeTruthy();
  expect(names.includes(OSM_TILE_CACHE), 'tile-cache-osm-v1 不應該被 activate 誤刪整個 cache').toBeTruthy();
  expect(env.getCacheSize(OSM_TILE_CACHE), 'tile-cache-osm-v1 裡原本的圖磚應該完整保留').toBe(1);
});

/* ---------------------------------------------------------
   4.6 衛星影像圖磚（Esri arcgisonline）也走獨立的 SAT_TILE_CACHE，
       跟 OSM／歷史 WMTS 三邊互不干擾、activate 也不會誤刪。
--------------------------------------------------------- */
test('衛星影像圖磚（server.arcgisonline.com）快取命中時走 SAT_TILE_CACHE，不進 TILE_CACHE／OSM_TILE_CACHE', async () => {
  const env = createSWEnv();
  const url = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/15/1234/5678';
  env.presetCache(SAT_TILE_CACHE, url, new FakeResponse('衛星圖磚'));
  env.setFetchImpl(async () => { throw new Error('快取命中時不應該打到網路'); });

  const request = new FakeRequest(url, { destination: 'image' });
  const { promise } = env.triggerFetch(request);
  const res = await promise;

  expect(await res.text(), '衛星影像圖磚快取命中時應該直接回傳 SAT_TILE_CACHE 裡的內容').toBe('衛星圖磚');
  expect(env.getCacheSize(TILE_CACHE), '衛星影像圖磚不應該寫進 TILE_CACHE').toBe(0);
  expect(env.getCacheSize(OSM_TILE_CACHE), '衛星影像圖磚不應該寫進 OSM_TILE_CACHE').toBe(0);
});

test('圖磚請求未命中快取時，衛星影像／OSM／歷史 WMTS 三邊分別寫進各自的快取空間', async () => {
  const env = createSWEnv();
  const satUrl = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/12/100/200';
  const osmUrl = 'https://b.tile.openstreetmap.org/10/100/200.png';
  const wmtsUrl = 'https://gis.sinica.edu.tw/tile/2.png';
  env.setFetchImpl(async () => new FakeResponse('新圖磚', { status: 200 }));

  await env.triggerFetch(new FakeRequest(satUrl, { destination: 'image' })).promise;
  await env.triggerFetch(new FakeRequest(osmUrl, { destination: 'image' })).promise;
  await env.triggerFetch(new FakeRequest(wmtsUrl, { destination: 'image' })).promise;

  expect(!!env.getCacheEntry(SAT_TILE_CACHE, satUrl), '衛星影像圖磚應該寫進 SAT_TILE_CACHE').toBeTruthy();
  expect(!env.getCacheEntry(TILE_CACHE, satUrl), '衛星影像圖磚不應該同時出現在 TILE_CACHE').toBeTruthy();
  expect(!env.getCacheEntry(OSM_TILE_CACHE, satUrl), '衛星影像圖磚不應該同時出現在 OSM_TILE_CACHE').toBeTruthy();
  expect(!!env.getCacheEntry(OSM_TILE_CACHE, osmUrl), 'OSM 圖磚應該寫進 OSM_TILE_CACHE').toBeTruthy();
  expect(!!env.getCacheEntry(TILE_CACHE, wmtsUrl), '歷史 WMTS 圖磚應該寫進 TILE_CACHE').toBeTruthy();
});

test('activate：App Shell 改版清除舊快取時，完全不影響 SAT_TILE_CACHE 的內容', async () => {
  const env = createSWEnv();
  env.presetCache(OLD_APP_CACHE, 'https://example.local/old.html', new FakeResponse('舊版殘留'));
  env.presetCache(SAT_TILE_CACHE, 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/1/1/1', new FakeResponse('衛星圖磚1'));

  await env.triggerActivate();

  const names = env.getCacheNames();
  expect(!names.includes(OLD_APP_CACHE), '舊版 App Shell 快取應該被清掉').toBeTruthy();
  expect(names.includes(SAT_TILE_CACHE), 'tile-cache-sat-v1 不應該被 activate 誤刪整個 cache').toBeTruthy();
  expect(env.getCacheSize(SAT_TILE_CACHE), 'tile-cache-sat-v1 裡原本的圖磚應該完整保留').toBe(1);
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

  expect(await res.text(), 'Network-First 應該回傳網路上的新版 JSON').toBe('{"version":"新"}');
  const cached = env.getCacheEntry(DATA_CACHE, url);
  expect(await cached.text(), '拿到新版後應該同步更新 DATA_CACHE').toBe('{"version":"新"}');
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
  expect(await htmlRes.text(), 'index.html 離線時應該 fallback 回快取').toBe('<html>離線快取版</html>');

  // 6b：data JSON
  const envData = createSWEnv();
  const dataUrl = 'https://example.local/data/historical-names.json';
  envData.presetCache(DATA_CACHE, dataUrl, new FakeResponse('{"names":["舊"]}'));
  envData.setFetchImpl(async () => { throw new Error('網路離線'); });
  const { promise: dataPromise } = envData.triggerFetch(new FakeRequest(dataUrl));
  const dataRes = await dataPromise;
  expect(await dataRes.text(), 'data JSON 離線時應該 fallback 回快取').toBe('{"names":["舊"]}');
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

  expect(await res.text(), 'Cache-First 命中時應該直接回傳快取內容').toBe('console.log("cached")');
  expect(env.getFetchCallCount(), '快取命中時完全不應該呼叫到 fetch()').toBe(0);
});

/* ---------------------------------------------------------
   額外驗證 2：sw.js 自己的請求完全不攔截（不呼叫 respondWith）
--------------------------------------------------------- */
test('isOwnScriptRequest：對 /sw.js 的請求完全不呼叫 event.respondWith()，直接放行給瀏覽器', () => {
  const env = createSWEnv();
  const request = new FakeRequest('https://example.local/sw.js');
  const { called } = env.triggerFetch(request);
  expect(!called, 'sw.js 自己的請求應該完全不套用任何快取策略，不能呼叫 respondWith()').toBeTruthy();
});

/* ---------------------------------------------------------
   7. message：頁面端「清除圖磚快取」按鈕觸發 CLEAR_TILE_CACHES，
      三份 tile cache 都要被清掉，App/Data 快取不受影響。
--------------------------------------------------------- */
test('message CLEAR_TILE_CACHES：清掉 TILE_CACHE／OSM_TILE_CACHE／SAT_TILE_CACHE，不動 APP_CACHE／DATA_CACHE', async () => {
  const env = createSWEnv();
  env.presetCache(TILE_CACHE, 'https://gis.sinica.edu.tw/tile/1.png', new FakeResponse('WMTS圖磚'));
  env.presetCache(OSM_TILE_CACHE, 'https://a.tile.openstreetmap.org/1/1/1.png', new FakeResponse('OSM圖磚'));
  env.presetCache(SAT_TILE_CACHE, 'https://server.arcgisonline.com/tile/1/1/1', new FakeResponse('衛星圖磚'));
  env.presetCache(APP_CACHE, 'https://example.local/', new FakeResponse('App Shell'));
  env.presetCache(DATA_CACHE, 'https://example.local/data/layers.bundle.json', new FakeResponse('{}'));

  const { waitUntilPromise, received } = env.triggerMessage({ type: 'CLEAR_TILE_CACHES' });
  expect(waitUntilPromise, 'message handler 應該呼叫 event.waitUntil()').toBeTruthy();
  await waitUntilPromise;

  const names = env.getCacheNames();
  expect(!names.includes(TILE_CACHE), 'TILE_CACHE 應該被清除').toBeTruthy();
  expect(!names.includes(OSM_TILE_CACHE), 'OSM_TILE_CACHE 應該被清除').toBeTruthy();
  expect(!names.includes(SAT_TILE_CACHE), 'SAT_TILE_CACHE 應該被清除').toBeTruthy();
  expect(names.includes(APP_CACHE), 'APP_CACHE 不應該被這個訊息清掉').toBeTruthy();
  expect(names.includes(DATA_CACHE), 'DATA_CACHE 不應該被這個訊息清掉').toBeTruthy();
  expect(received.length, '應該透過 port 回傳一次執行結果').toBe(1);
  expect(received[0].ok, '清除成功時應該回傳 { ok: true }').toBe(true);
});

test('message：非 CLEAR_TILE_CACHES 的訊息完全不處理，不呼叫 waitUntil、不動任何快取', () => {
  const env = createSWEnv();
  env.presetCache(TILE_CACHE, 'https://gis.sinica.edu.tw/tile/1.png', new FakeResponse('WMTS圖磚'));

  const { waitUntilPromise, received } = env.triggerMessage({ type: 'SOME_OTHER_MESSAGE' });
  expect(!waitUntilPromise, '不認得的訊息類型不應該呼叫 event.waitUntil()').toBeTruthy();
  expect(received.length, '不認得的訊息類型不應該透過 port 回覆任何內容').toBe(0);
  expect(env.getCacheSize(TILE_CACHE), 'TILE_CACHE 內容應該完全不受影響').toBe(1);
});

/* ---------------------------------------------------------
   8. touchTileLRU()：超過上限時逐出最舊項目、重複 touch 同一 url 只移動
      位置不佔用額外名額。直接呼叫 vm context 上的頂層函式，不透過
      fetch 事件跑滿滿一輪假圖磚請求。
--------------------------------------------------------- */
test('touchTileLRU()：超過上限時，最舊的項目會被逐出快取並從索引移除', async () => {
  const env = createSWEnv();
  const ctx = env.getContext();
  const cache = await ctx.caches.open(TILE_CACHE);
  const lruKey = 'https://tile-lru.local/__test_index__';
  ['url-a', 'url-b', 'url-c', 'url-d'].forEach(u => env.presetCache(TILE_CACHE, u, new FakeResponse('x')));

  await ctx.touchTileLRU(cache, lruKey, 'url-a', 3);
  await ctx.touchTileLRU(cache, lruKey, 'url-b', 3);
  await ctx.touchTileLRU(cache, lruKey, 'url-c', 3);
  await ctx.touchTileLRU(cache, lruKey, 'url-d', 3); // 超過上限 3

  const list = await env.getCacheEntry(TILE_CACHE, lruKey).json();
  expect(list.length, 'LRU 索引長度應該維持在上限').toBe(3);
  expect(!list.includes('url-a'), '最舊的 url-a 應該已經被移出索引').toBeTruthy();
  expect(!env.getCacheEntry(TILE_CACHE, 'url-a'), 'url-a 對應的圖磚快取本體也應該被真的 cache.delete() 移除').toBeTruthy();
});

test('touchTileLRU()：重複 touch 同一個 url 只會移到最新位置，不會佔用額外名額', async () => {
  const env = createSWEnv();
  const ctx = env.getContext();
  const cache = await ctx.caches.open(TILE_CACHE);
  const lruKey = 'https://tile-lru.local/__test_index2__';

  await ctx.touchTileLRU(cache, lruKey, 'url-a', 3);
  await ctx.touchTileLRU(cache, lruKey, 'url-b', 3);
  await ctx.touchTileLRU(cache, lruKey, 'url-a', 3);

  const list = await env.getCacheEntry(TILE_CACHE, lruKey).json();
  expect(list.length, '同一個 url 重複 touch 不應該讓索引長度增加').toBe(2);
  expect(list[list.length - 1], '重複 touch 的 url 應該被移到最新（陣列尾端）位置').toBe('url-a');
});

/* ---------------------------------------------------------
   opaque 回應：地址搜尋探測（new Image()，no-cors）拿到的 opaque 回應不可以被快取，
   否則之後 OpenLayers 用 CORS 模式（crossOrigin='anonymous'）載入「同一個網址」的
   圖磚會被 SW 回傳 opaque 回應而變成網路錯誤（sinica 的探測網址就是實際圖磚網址）。
   實測（瀏覽器）：探測後同網址 CORS 載入失敗；沒探測過的直接載入成功。
--------------------------------------------------------- */
const SINICA_TILE = 'https://gis.sinica.edu.tw/tileserver/file-exists.php?img=JM20K_1904-jpg-15-27445-14028';

test('no-cors 探測拿到的 opaque 回應照常回傳給頁面，但不寫進快取', async () => {
  const env = createSWEnv();
  env.setFetchImpl(async () => new FakeResponse('opaque圖磚', { status: 0, ok: false, type: 'opaque' }));

  const res = await env.triggerFetch(new FakeRequest(SINICA_TILE, { destination: 'image', mode: 'no-cors' })).promise;

  expect(await res.text(), '頁面仍要拿到回應').toBe('opaque圖磚');
  expect(env.getCacheEntry(TILE_CACHE, SINICA_TILE), 'opaque 回應不可進快取').toBeUndefined();
});

test('舊版殘留的 opaque 快取遇到 CORS 請求：略過它、重新抓取，並用 cors 回應覆蓋（自我修復）', async () => {
  const env = createSWEnv();
  env.presetCache(TILE_CACHE, SINICA_TILE, new FakeResponse('舊的opaque', { status: 0, ok: false, type: 'opaque' }));
  env.setFetchImpl(async () => new FakeResponse('正常圖磚', { status: 200, type: 'cors' }));

  const res = await env.triggerFetch(new FakeRequest(SINICA_TILE, { destination: 'image', mode: 'cors' })).promise;

  expect(await res.text(), 'CORS 請求不可拿到 opaque 快取').toBe('正常圖磚');
  expect(env.getFetchCallCount(), '應該重新打網路').toBe(1);
  expect(env.getCacheEntry(TILE_CACHE, SINICA_TILE).type, '快取被換成 cors 回應').toBe('cors');
});

test('舊版殘留的 opaque 快取遇到 no-cors 請求：照舊直接回傳，不打網路', async () => {
  const env = createSWEnv();
  env.presetCache(TILE_CACHE, SINICA_TILE, new FakeResponse('舊的opaque', { status: 0, ok: false, type: 'opaque' }));
  env.setFetchImpl(async () => { throw new Error('no-cors 請求命中 opaque 快取時不該打網路'); });

  const res = await env.triggerFetch(new FakeRequest(SINICA_TILE, { destination: 'image', mode: 'no-cors' })).promise;
  expect(await res.text()).toBe('舊的opaque');
});

test('CORS 請求的 cors 200 回應照常快取，下次快取命中不打網路', async () => {
  const env = createSWEnv();
  env.setFetchImpl(async () => new FakeResponse('正常圖磚', { status: 200, type: 'cors' }));
  await env.triggerFetch(new FakeRequest(SINICA_TILE, { destination: 'image', mode: 'cors' })).promise;
  expect(env.getCacheEntry(TILE_CACHE, SINICA_TILE), '應該寫進快取').toBeTruthy();

  env.setFetchImpl(async () => { throw new Error('快取命中時不該打網路'); });
  const res = await env.triggerFetch(new FakeRequest(SINICA_TILE, { destination: 'image', mode: 'cors' })).promise;
  expect(await res.text()).toBe('正常圖磚');
});

/* ---------------------------------------------------------
   快取寫入失敗（配額滿等）不可以讓圖磚載入失敗
--------------------------------------------------------- */
function makeCachePutFail(env){
  const ctx = env.getContext();
  const originalOpen = ctx.caches.open;
  ctx.caches.open = async (name) => {
    const cache = await originalOpen(name);
    return { ...cache, put: async () => { throw new Error('QuotaExceededError（模擬）'); } };
  };
}

test('cache.put 失敗（例如配額滿）：圖磚照常回傳，不丟例外', async () => {
  const env = createSWEnv();
  makeCachePutFail(env);
  env.setFetchImpl(async () => new FakeResponse('正常圖磚', { status: 200, type: 'cors' }));

  const res = await env.triggerFetch(new FakeRequest(SINICA_TILE, { destination: 'image', mode: 'cors' })).promise;
  expect(await res.text(), '快取寫入失敗不能讓圖磚載入失敗').toBe('正常圖磚');
});

test('快取命中時 LRU 更新失敗：仍回傳快取的圖磚', async () => {
  const env = createSWEnv();
  env.presetCache(TILE_CACHE, SINICA_TILE, new FakeResponse('快取圖磚', { status: 200, type: 'cors' }));
  makeCachePutFail(env); // touchTileLRU 會用 put 寫索引，讓它失敗
  env.setFetchImpl(async () => { throw new Error('不該打網路'); });

  const res = await env.triggerFetch(new FakeRequest(SINICA_TILE, { destination: 'image', mode: 'cors' })).promise;
  expect(await res.text()).toBe('快取圖磚');
});

/* ---------------------------------------------------------
   LRU 索引的並行安全與效能（見 public/sw.js 的 touchTileLRU() 檔頭說明）：
   在這份測試環境裡，FakeCache 的操作雖然都是「立即」resolve 的 Promise，
   但仍然是非同步的——await 一定會讓出控制權到下一個 microtask，這正是
   舊版程式碼「兩筆並行 touch 各自讀到同一份舊索引、後寫覆蓋先寫」這個
   race 會發生的根本原因，不需要額外插入人工延遲就能重現。
--------------------------------------------------------- */
test('touchTileLRU()：並行呼叫（模擬同時有多筆圖磚請求）不會遺失更新，兩筆都留在索引裡', async () => {
  const env = createSWEnv();
  const ctx = env.getContext();
  const cache = await ctx.caches.open(TILE_CACHE);
  const lruKey = 'https://tile-lru.local/__test_concurrent__';

  await Promise.all([
    ctx.touchTileLRU(cache, lruKey, 'url-x', 10),
    ctx.touchTileLRU(cache, lruKey, 'url-y', 10),
  ]);

  const list = await env.getCacheEntry(TILE_CACHE, lruKey).json();
  expect(list.includes('url-x'), '並行寫入不能遺失 url-x').toBeTruthy();
  expect(list.includes('url-y'), '並行寫入不能遺失 url-y').toBeTruthy();
  expect(list.length, '兩筆都要留下，不能只剩一筆（舊版「後寫覆蓋先寫」的 lost update）').toBe(2);
});

test('touchTileLRU()：20 筆並行 touch、上限 5：最終索引剛好 5 筆，且都是最後成功寫入的 url（沒有因為競態算錯逐出對象）', async () => {
  const env = createSWEnv();
  const ctx = env.getContext();
  const cache = await ctx.caches.open(TILE_CACHE);
  const lruKey = 'https://tile-lru.local/__test_concurrent_evict__';
  const urls = Array.from({ length: 20 }, (_, i) => `url-${i}`);
  urls.forEach(u => env.presetCache(TILE_CACHE, u, new FakeResponse(u)));

  await Promise.all(urls.map(u => ctx.touchTileLRU(cache, lruKey, u, 5)));

  const list = await env.getCacheEntry(TILE_CACHE, lruKey).json();
  expect(list.length, '並行逐出後索引長度仍要精準等於上限').toBe(5);
  expect(new Set(list).size, '索引內不可有重複 url').toBe(5);
  // 被逐出的 url 對應的快取本體也要真的被刪除，不能因為競態漏刪
  const survivors = new Set(list);
  const evicted = urls.filter(u => !survivors.has(u));
  expect(evicted.length).toBe(15);
  evicted.forEach(u => expect(env.getCacheEntry(TILE_CACHE, u), `${u} 應該已被逐出快取`).toBeFalsy());
});

test('touchTileLRU()：同一個索引在多次 touch 之間只真的讀取 Cache Storage 一次（記憶體內權威副本）', async () => {
  const env = createSWEnv();
  const ctx = env.getContext();
  const lruKey = 'https://tile-lru.local/__test_readonce__';

  // 監看底層 store 的 match 呼叫次數，只計這個索引 key 被讀取的次數
  const originalOpen = ctx.caches.open;
  let matchCount = 0;
  ctx.caches.open = async (name) => {
    const c = await originalOpen(name);
    return {
      ...c,
      async match(request){
        const url = typeof request === 'string' ? request : request.url;
        if(url === lruKey) matchCount++;
        return c.match(request);
      },
    };
  };
  const cache = await ctx.caches.open(TILE_CACHE);

  await ctx.touchTileLRU(cache, lruKey, 'url-1', 10);
  await ctx.touchTileLRU(cache, lruKey, 'url-2', 10);
  await ctx.touchTileLRU(cache, lruKey, 'url-3', 10);

  expect(matchCount, '三次 touch 應該只真的讀取索引一次，其餘兩次用記憶體內的副本').toBe(1);
});

test('touchTileLRU()：兩個不同的索引 key（例如歷史 WMTS／OSM）互相獨立上鎖，不會互相排隊等待', async () => {
  const env = createSWEnv();
  const ctx = env.getContext();
  const cache = await ctx.caches.open(TILE_CACHE);

  await Promise.all([
    ctx.touchTileLRU(cache, 'https://tile-lru.local/__key_a__', 'url-a1', 10),
    ctx.touchTileLRU(cache, 'https://tile-lru.local/__key_b__', 'url-b1', 10),
  ]);

  const listA = await env.getCacheEntry(TILE_CACHE, 'https://tile-lru.local/__key_a__').json();
  const listB = await env.getCacheEntry(TILE_CACHE, 'https://tile-lru.local/__key_b__').json();
  expect(listA).toEqual(['url-a1']);
  expect(listB).toEqual(['url-b1']);
});

test('touchTileLRU()：其中一次寫入失敗（例如配額滿），不會卡住鎖，後續 touch 仍能正常進行', async () => {
  const env = createSWEnv();
  const ctx = env.getContext();
  const lruKey = 'https://tile-lru.local/__test_lock_recovery__';

  const originalOpen = ctx.caches.open;
  let putCount = 0;
  ctx.caches.open = async (name) => {
    const c = await originalOpen(name);
    return {
      ...c,
      async put(request, response){
        putCount++;
        if(putCount === 1) throw new Error('QuotaExceededError（模擬第一次寫入失敗）');
        return c.put(request, response);
      },
    };
  };
  const cache = await ctx.caches.open(TILE_CACHE);

  await expect(ctx.touchTileLRU(cache, lruKey, 'url-1', 10)).rejects.toThrow();
  await ctx.touchTileLRU(cache, lruKey, 'url-2', 10); // 鎖沒有被第一次失敗卡死，這筆應該能正常完成

  const list = await env.getCacheEntry(TILE_CACHE, lruKey).json();
  expect(list.includes('url-2'), '鎖恢復後的 touch 應該正常寫入').toBeTruthy();
});

/* ---------------------------------------------------------
   Network-First 逾時保護（見 public/sw.js 的 fetchWithTimeout() 檔頭說明）：
   fetch() 本身沒有內建逾時，網路存在但半死不活時 Promise 可能永遠不 resolve，
   即使明明有快取版本可以立刻 fallback。HTML／Data 各自的逾時秒數不同
   （8 秒／15 秒，Data 較長是因為 place-names.json 有 9.9MB），這裡驗證：
   逾時後真的中止了底層請求（fetch 收到的 signal 被 abort）、逾時後走既有的
   「退回快取」邏輯（不需要另外處理），以及還沒逾時前不會被提早判定失敗。
--------------------------------------------------------- */
function makeAbortError(){
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

// 模擬「網路存在但完全沒回應」：fetchImpl 回傳的 promise 不會自己 resolve，
// 只有 signal 被 abort 時才會 reject（如同真的 fetch() 在逾時中止後的行為）。
function hangingFetchImpl({ onAbort } = {}){
  return (request, init) => new Promise((resolve, reject) => {
    const signal = init?.signal;
    if(!signal) return; // 沒有 signal 就真的永遠掛著，不該發生（代表 fetchWithTimeout 沒接上）
    if(signal.aborted){ onAbort?.(); reject(makeAbortError()); return; }
    signal.addEventListener('abort', () => { onAbort?.(); reject(makeAbortError()); });
  });
}

test('data/*.json：網路完全沒回應時，逾時（15 秒）後真的中止底層請求，並退回快取版本', async () => {
  vi.useFakeTimers();
  try{
    const env = createSWEnv();
    const url = 'https://example.local/data/layers.bundle.json';
    env.presetCache(DATA_CACHE, url, new FakeResponse('{"cached":true}'));
    let aborted = false;
    env.setFetchImpl(hangingFetchImpl({ onAbort: () => { aborted = true; } }));

    const { promise } = env.triggerFetch(new FakeRequest(url, { destination: '' }));
    await vi.advanceTimersByTimeAsync(15000);
    const res = await promise;

    expect(aborted, '逾時應該真的中止底層 fetch（signal.aborted）').toBe(true);
    expect(await res.text(), '逾時後應該退回快取版本').toBe('{"cached":true}');
  }finally{
    vi.useRealTimers();
  }
});

test('HTML navigate：網路完全沒回應時，逾時（8 秒，比 data 短）後退回快取版本', async () => {
  vi.useFakeTimers();
  try{
    const env = createSWEnv();
    const url = 'https://example.local/';
    env.presetCache(APP_CACHE, url, new FakeResponse('<html>舊版</html>'));
    env.setFetchImpl(hangingFetchImpl());

    const { promise } = env.triggerFetch(new FakeRequest(url, { mode: 'navigate' }));
    await vi.advanceTimersByTimeAsync(8000);
    const res = await promise;

    expect(await res.text(), '逾時後應該退回快取的舊版 HTML').toBe('<html>舊版</html>');
  }finally{
    vi.useRealTimers();
  }
});

test('data/*.json：8 秒時（HTML 的逾時秒數）還不該逾時，因為 data 用的是 15 秒；15 秒後才真的逾時', async () => {
  vi.useFakeTimers();
  try{
    const env = createSWEnv();
    const url = 'https://example.local/data/place-names.json';
    env.presetCache(DATA_CACHE, url, new FakeResponse('{"cached":true}'));
    let aborted = false;
    env.setFetchImpl(hangingFetchImpl({ onAbort: () => { aborted = true; } }));

    env.triggerFetch(new FakeRequest(url, { destination: '' }));
    await vi.advanceTimersByTimeAsync(8000);
    expect(aborted, 'data 請求的逾時是 15 秒，8 秒時不該被中止').toBe(false);

    await vi.advanceTimersByTimeAsync(7001); // 累積到 15001ms
    expect(aborted, '滿 15 秒後應該中止').toBe(true);
  }finally{
    vi.useRealTimers();
  }
});

test('data/*.json：在逾時之前就拿到回應，不會被誤判逾時、內容正常更新快取', async () => {
  vi.useFakeTimers();
  try{
    const env = createSWEnv();
    const url = 'https://example.local/data/source-map.json';
    env.setFetchImpl(async () => new FakeResponse('{"fresh":true}', { status: 200 }));

    const { promise } = env.triggerFetch(new FakeRequest(url, { destination: '' }));
    const res = await promise; // fetchImpl 立即 resolve，不需要推進計時器
    await vi.advanceTimersByTimeAsync(20000); // 就算之後時間continue推進，也不該有任何副作用

    expect(await res.text()).toBe('{"fresh":true}');
    expect(env.getCacheEntry(DATA_CACHE, url), '應該正常寫進快取').toBeTruthy();
  }finally{
    vi.useRealTimers();
  }
});
