/* ---------------------------------------------------------
   public/sw.js — Service Worker（App Shell / Data / Tile 快取分開管理）
   ---------------------------------------------------------
   五個快取各自對應一種資源與更新策略，彼此的版本號、清除時機互不影響：

     1. TILE_CACHE — 歷史 WMTS 圖磚／衛星底圖，Cache-First，並用簡易
        LRU（上限 TILE_LRU_LIMIT 筆）避免無限長大。這層是磁碟持久快取
        （L2），跟 src/core/layerCache.js 的記憶體 Image 快取（L1）
        互補，SW 重啟、分頁關閉都不會清空。**刻意用獨立的
        TILE_CACHE_VERSION**：網站程式（App Shell／data）改版很頻繁，
        但歷史地圖圖磚本身沒變，不應該因為部署新版網站就要使用者
        重新下載大量圖磚——只有圖磚快取的資料結構本身要改（例如
        LRU 索引格式）才需要動這個版本號。

     1.5 OSM_TILE_CACHE／SAT_TILE_CACHE — 現代地圖底圖（OpenStreetMap／
        Esri 衛星影像）圖磚，快取策略跟 TILE_CACHE 完全一樣，差別只在
        快取空間、LRU 名額三邊各自獨立算，原因見下方常數定義處的說明；
        都跟 TILE_CACHE 共用 TILE_CACHE_VERSION（儲存格式一致，沒有分開
        版號的必要）。

     2. DATA_CACHE — data/*.json（layers.bundle.json、
        historical-names.json 等圖層與地名資料），Network-First：
        永遠先嘗試打網路拿最新版、成功就直接用並更新快取，只有網路
        失敗才退回快取。理由：這些資料會隨部署改變（新圖層、新
        bbox、新地名對照），不能讓使用者被鎖在舊版 JSON 上，否則會
        出現「新圖層搜尋不到」「bbox 篩選規則沒更新」這類版本不一致
        的問題。

     3. APP_CACHE — 同源的 HTML／JS／CSS。HTML（navigate 請求）用
        Network-First：有網路就一定拿新版 index.html，離線才退回
        快取版本，避免使用者部署新版後還一直看到舊頁面。JS／CSS
        則維持 Cache-First——Vite build 預設會產生帶 content hash
        的檔名（如 assets/index-abc123.js），新版部署後檔名一定不同，
        不會有「快取到舊 JS」的問題，Cache-First 純粹是省一次不必要
        的網路請求。

   TILE_LRU 索引持久化的地方是一筆固定 key 的 JSON Response，存在 TILE_CACHE
   裡本身，因為 Service Worker 隨時可能被瀏覽器終止、下次事件才醒來，只放在
   記憶體變數活不過重啟。**但每次讀寫都真的操作 Cache Storage 曾經是效能與
   正確性問題的根源**（見 touchTileLRU() 檔頭說明）：SW 存活期間會在記憶體
   （lruListCache）保留一份權威副本，只在第一次真的讀取，並用 withLruLock()
   序列化同一個索引 key 的所有讀寫，排除並行請求互相覆蓋（lost update）的
   競態；每次成功修改仍會寫回 Cache Storage，SW 重啟後下次讀到的還是最後
   一次成功持久化的版本。

   Cache Version 集中在最上面兩個常數管理，不要在檔案其他地方另外
   寫死版本字串：
     - CACHE_VERSION：App Shell／Data 共用，這兩塊改版時一起手動遞增
       （例如 fetch 策略、快取的資源範圍有變動時）。
     - TILE_CACHE_VERSION：只在圖磚快取的儲存格式本身需要變動時才
       遞增，跟網站程式改版頻率脫鉤。

   activate 清除舊快取時，只依前綴比對「本專案管理的 App/Data 快取」
   （含這次改版前的舊快取命名 shell-cache- / meta-cache-，做一次性
   遷移清理），TILE_CACHE／OSM_TILE_CACHE 的名稱都不落在這些前綴內，
   不會被誤刪。
--------------------------------------------------------- */

const CACHE_VERSION = 'v2';
const TILE_CACHE_VERSION = 'v1';

const APP_CACHE = `app-shell-${CACHE_VERSION}`;
const DATA_CACHE = `data-${CACHE_VERSION}`;
const TILE_CACHE = `tile-cache-${TILE_CACHE_VERSION}`;
// OSM／衛星影像現代地圖底圖圖磚各自獨立一份快取空間＋獨立 LRU，不跟
// 歷史 WMTS 圖磚共用同一份 LRU 名單：地址搜尋一次會對上百筆候選歷史
// 圖層送出探測用的圖磚請求（見 src/tileChecker.js），這些探測請求如果
// 跟畫面上一直看得到、反覆重繪的現代底圖擠在同一份 LRU 裡，搜尋密集時
// 會把底圖圖磚排擠掉、需要重新下載，體感上就是「一直在看的底圖也跟著
// 變慢」。OSM／衛星影像兩者也彼此分開（而非合併成一份「現代底圖」快取），
// 因為使用者切換底圖來回瀏覽不同地區時，兩者 LRU 名額互不影響才不會
// 互相擠掉。三邊都跟 TILE_CACHE 一樣用 TILE_CACHE_VERSION。
const OSM_TILE_CACHE = `tile-cache-osm-${TILE_CACHE_VERSION}`;
const SAT_TILE_CACHE = `tile-cache-sat-${TILE_CACHE_VERSION}`;

// activate 時只清除這些前綴開頭、且不是目前版本的快取；shell-cache- /
// meta-cache- 是這次改版之前的舊命名，一併列入做一次性遷移清理。
// tile-cache- 前綴刻意不在這份清單裡（TILE_CACHE、OSM_TILE_CACHE、
// SAT_TILE_CACHE 三者皆是），確保圖磚快取不會因為 App Shell／Data
// 改版而被清掉。
const MANAGED_CACHE_PREFIXES = ['app-shell-', 'data-', 'shell-cache-', 'meta-cache-'];

// 三邊上限各自估算（實測平均磚體積 OSM ~14KB、衛星 ~15KB）：
// - TILE_LRU_LIMIT（歷史 WMTS，12000，約 170MB）：全站核心內容（2425
//   筆圖層，見 spatial-index.test.mjs），史料圖磚永久不變、快取越久越
//   划算；地址搜尋的 bbox 探測（tileChecker.js）也會對候選圖層送出
//   probe 請求佔用這份 LRU，上限抓高一點可緩解「探測把剛瀏覽過的圖磚
//   擠掉」的 thrashing。
// - OSM_TILE_LRU_LIMIT（10000，約 140MB）：常駐底圖，使用者常在多個
//   地區間快速縮放切換，抓較高上限避免來回瀏覽時舊地區被擠掉重下載。
// - SAT_TILE_LRU_LIMIT（8000，約 120MB）：切換頻率通常低於 OSM、Esri
//   影像更新週期也慢，抓比 OSM 略低但同量級的上限。
const TILE_LRU_LIMIT = 12000;
const OSM_TILE_LRU_LIMIT = 10000;
const SAT_TILE_LRU_LIMIT = 8000;
const TILE_LRU_KEY = new Request('https://tile-lru.local/__index__');
const OSM_TILE_LRU_KEY = new Request('https://tile-lru.local/__osm_index__');
const SAT_TILE_LRU_KEY = new Request('https://tile-lru.local/__sat_index__');

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([APP_CACHE, DATA_CACHE, TILE_CACHE, OSM_TILE_CACHE, SAT_TILE_CACHE]);
    const names = await caches.keys();
    await Promise.all(
      names
        .filter(n => MANAGED_CACHE_PREFIXES.some(p => n.startsWith(p)) && !keep.has(n))
        .map(n => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

// touchTileLRU() 原本每次都重新 cache.match()＋JSON.parse() 整份索引（TILE_CACHE
// 上限 12000 筆，約 1MB），每一顆圖磚請求（不論快取命中或未命中）都要付這個成本；
// 更嚴重的是，多筆並行請求（地址搜尋一次對上百個候選送出探測、地圖平移時多顆圖磚
// 同時載入，OL 全域最多 16 顆同時 LOADING）會各自獨立讀到「同一份舊索引」，後寫的
// 覆蓋掉先寫的（lost update）——索引因此跟 Cache Storage 實際內容脫鉤，逐出機制
// 失準，快取可能悄悄超出原本設計的上限。
//
// 修法兩層：
//   1. lruListCache：索引在同一個 SW 存活期間只真的讀取一次，之後都在記憶體裡直接
//      修改同一個陣列參照。SW 被瀏覽器終止後這份記憶體會清空，下次事件喚醒時重新
//      從 Cache Storage 讀最後一次成功寫入的版本，不會有跨重啟的一致性問題。
//   2. withLruLock：同一個索引 key 的讀取-修改-寫入，用 promise chain 實作的簡易
//      mutex 強制序列化，同一時間只有一筆在跑，徹底排除並行寫入互相覆蓋的可能——
//      不是靠「盡量少衝突」，是結構上不可能衝突。
// 三個索引 key（歷史 WMTS／OSM／衛星）各自獨立上鎖，彼此不互相排隊。
const lruLocks = new Map(); // 索引 key 字串 -> 目前排隊中的 promise chain 尾端
const lruListCache = new Map(); // 索引 key 字串 -> 記憶體內的權威副本（陣列參照）

function lruIndexKey(lruKey){
  return typeof lruKey === 'string' ? lruKey : lruKey.url;
}

function withLruLock(key, fn){
  const prevTail = lruLocks.get(key) || Promise.resolve();
  const result = prevTail.then(fn, fn); // 不論前一輪成功或失敗，這一輪都要接著跑
  lruLocks.set(key, result.catch(() => {})); // 鎖本身絕不能卡死；真正的失敗留給呼叫端处理
  return result;
}

async function loadTileLRU(cache, lruKey, key){
  // 呼叫這支函式時一定已經在 withLruLock 的鎖內，同一個 key 不會有第二筆並行呼叫，
  // 不需要額外的「載入中」去重機制。
  if(lruListCache.has(key)) return lruListCache.get(key);
  const res = await cache.match(lruKey);
  let list = [];
  if(res){ try{ list = await res.json(); }catch{ list = []; } }
  lruListCache.set(key, list);
  return list;
}

async function writeTileLRU(cache, lruKey, list){
  await cache.put(lruKey, new Response(JSON.stringify(list), {
    headers: { 'Content-Type': 'application/json' }
  }));
}

async function touchTileLRU(cache, lruKey, url, limit){
  const key = lruIndexKey(lruKey);
  return withLruLock(key, async () => {
    const list = await loadTileLRU(cache, lruKey, key);
    const idx = list.indexOf(url);
    if(idx !== -1) list.splice(idx, 1);
    list.push(url);
    while(list.length > limit){
      const oldest = list.shift();
      await cache.delete(oldest);
    }
    await writeTileLRU(cache, lruKey, list);
  });
}

function isTileRequest(request){
  return request.destination === 'image';
}

// OSM 底圖圖磚（ol.source.OSM 預設打 a/b/c.tile.openstreetmap.org）
// 走獨立的 OSM_TILE_CACHE，跟其他圖磚請求（歷史 WMTS、衛星底圖）分開。
function isOsmTileRequest(url){
  return /(^|\.)tile\.openstreetmap\.org$/.test(url.hostname);
}

// 衛星影像底圖圖磚（見 src/config/baseLayers.js 的 'sat' urlTemplate）
// 走獨立的 SAT_TILE_CACHE，同樣跟歷史 WMTS 圖磚分開。
function isSatTileRequest(url){
  return url.hostname === 'server.arcgisonline.com';
}

function isDataRequest(url){
  return url.pathname.endsWith('.json') && url.pathname.includes('/data/');
}

function isNavigationRequest(request){
  return request.mode === 'navigate';
}

function isHashedAssetRequest(request, url){
  return url.origin === self.location.origin && (request.destination === 'script' || request.destination === 'style');
}

// sw.js 自己的更新檢查是瀏覽器原生機制（跟頁面的 fetch 事件無關），
// 這裡明確排除、不套用任何快取策略，純粹是防禦性寫法：避免以後不小心
// 把這個請求納入 isHashedAssetRequest 之類的規則，導致瀏覽器拿到被
// SW 自己攔截過的回應而誤判版本沒變。
function isOwnScriptRequest(url){
  return url.origin === self.location.origin && url.pathname.endsWith('/sw.js');
}

function tileCacheConfig(url){
  if(isOsmTileRequest(url)) return { cacheName: OSM_TILE_CACHE, lruKey: OSM_TILE_LRU_KEY, limit: OSM_TILE_LRU_LIMIT };
  if(isSatTileRequest(url)) return { cacheName: SAT_TILE_CACHE, lruKey: SAT_TILE_LRU_KEY, limit: SAT_TILE_LRU_LIMIT };
  return { cacheName: TILE_CACHE, lruKey: TILE_LRU_KEY, limit: TILE_LRU_LIMIT };
}

// 快取的圖磚能不能拿來回應這個請求。opaque（跨來源、沒帶 CORS 標頭的 no-cors 請求拿到的）
// 回應只能回給 no-cors 請求：Fetch 規格規定 CORS 模式的請求（OpenLayers 顯示圖磚用
// crossOrigin='anonymous'）拿到 opaque 回應會變成網路錯誤，圖磚就成了破洞。舊版 SW 會把
// 地址搜尋探測（new Image()，no-cors）的 opaque 回應存進快取——sinica 的探測網址就是實際
// 圖磚網址——所以使用者的快取裡可能有這種殘留；遇到 CORS 請求要略過、重新抓取並覆蓋。
function isCachedTileUsable(cached, request){
  return cached.type !== 'opaque' || request.mode === 'no-cors';
}

// 快取寫入／LRU 維護都是「盡力而為」：配額滿（QuotaExceededError）、儲存空間被清掉等失敗
// 不可以讓圖磚本身載入失敗，否則使用者的地圖會因為快取問題出現破洞。
async function bestEffort(label, fn){
  try{ await fn(); }catch(err){ console.warn(`[sw] ${label}失敗（不影響圖磚回應）`, err); }
}

async function cacheFirstTile(request, url){
  const { cacheName, lruKey, limit } = tileCacheConfig(url);
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if(cached && isCachedTileUsable(cached, request)){
    await bestEffort('更新 LRU', () => touchTileLRU(cache, lruKey, request.url, limit));
    return cached;
  }
  const res = await fetch(request);
  // 只快取 res.ok 的回應，不快取 opaque：opaque 的狀態碼看不到（可能是 500 錯誤頁），快取了
  // 會一直被當成圖磚回給使用者；而且 Chrome 對每個 opaque 回應的配額估算至少約 7MB，
  // 一次地址搜尋上百筆探測就會把配額吃光。代價是自訂圖層（沒設 crossOrigin）的圖磚不進快取。
  if(res && res.ok){
    await bestEffort('寫入圖磚快取', async () => {
      await cache.put(request, res.clone());
      await touchTileLRU(cache, lruKey, request.url, limit);
    });
  }
  return res;
}

// fetch() 本身沒有內建逾時：網路存在但半死不活時（訊號被基地台黑洞、公用 Wi-Fi
// 的登入頁攔截後不回應、連上了但伺服器完全不送資料），Promise 可能掛著不 resolve，
// 使用者會看到頁面／搜尋結果卡住不動，即使明明有快取版本可以立刻 fallback 用。
// 用 AbortController 包一層總時長上限：逾時就中止底層網路請求（真的把連線斷掉，
// 不是放著不管），並丟出 AbortError，直接匯入既有的 catch 分支走「退回快取」邏輯，
// 不需要另外處理——逾時在這裡的語意就是「當作網路失敗」。
//
// HTML／Data 兩者的逾時秒數不同、刻意分開：
//   - NETWORK_FIRST_HTML_TIMEOUT_MS（8 秒）：index.html 本身很小（gzip 約 12KB），
//     8 秒對任何還「堪用」的網路都綽綽有餘，純粹是拿掉「完全沒有上限」這個極端情況。
//   - NETWORK_FIRST_DATA_TIMEOUT_MS（15 秒）：data/*.json 涵蓋的檔案大小差異很大，
//     大多數（layers.bundle.json 約 572KB、source-map.json、historical-names.json）
//     都很小，但 place-names.json 有 9.9MB（GitHub Pages gzip 後約 2.4MB，見
//     「地名今昔對照卡」段落），真的在慢速行動網路上下載需要更久，逾時抓太短會誤傷
//     還在正常下載、只是比較慢的使用者。就算 15 秒對極端慢速網路仍不夠，
//     placeNames.js 的 ensurePlaceNamesLoaded() 本來就有失敗冷卻＋自動重試（見
//     「地名今昔對照卡」段落），這裡逾時退回快取（或沒有快取時把錯誤往上拋）
//     後，使用者體驗最差就是「這次搜尋查無結果，30 秒後自動能再查」，不是卡死。
const NETWORK_FIRST_HTML_TIMEOUT_MS = 8000;
const NETWORK_FIRST_DATA_TIMEOUT_MS = 15000;

async function fetchWithTimeout(request, timeoutMs){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try{
    return await fetch(request, { signal: controller.signal });
  }finally{
    clearTimeout(timer);
  }
}

async function networkFirstData(request){
  const cache = await caches.open(DATA_CACHE);
  try{
    const res = await fetchWithTimeout(request, NETWORK_FIRST_DATA_TIMEOUT_MS);
    if(res?.ok){
      await cache.put(request, res.clone());
      return res;
    }
    const cached = await cache.match(request);
    return cached || res;
  }catch(err){
    const cached = await cache.match(request);
    if(cached) return cached;
    throw err;
  }
}

async function networkFirstShellHTML(request){
  const cache = await caches.open(APP_CACHE);
  try{
    const res = await fetchWithTimeout(request, NETWORK_FIRST_HTML_TIMEOUT_MS);
    if(res?.ok){
      await cache.put(request, res.clone());
      return res;
    }
    const cached = await cache.match(request) || await cache.match(self.registration.scope);
    return cached || res;
  }catch(err){
    const cached = await cache.match(request) || await cache.match(self.registration.scope);
    if(cached) return cached;
    throw err;
  }
}

async function cacheFirstAsset(request){
  const cache = await caches.open(APP_CACHE);
  const cached = await cache.match(request);
  if(cached) return cached;
  const res = await fetch(request);
  if(res?.ok) await cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if(request.method !== 'GET') return;

  let url;
  try{ url = new URL(request.url); }catch{ return; }

  if(isOwnScriptRequest(url)) return;

  if(isTileRequest(request)){
    event.respondWith(cacheFirstTile(request, url));
    return;
  }
  if(isDataRequest(url)){
    event.respondWith(networkFirstData(request));
    return;
  }
  if(isNavigationRequest(request)){
    event.respondWith(networkFirstShellHTML(request));
    return;
  }
  if(isHashedAssetRequest(request, url)){
    event.respondWith(cacheFirstAsset(request));
  }
});

// 頁面端「清除圖磚快取」按鈕觸發（見 src/ui/sourceStatusUI.js），透過 MessageChannel
// 拿回執行結果。只清三份 tile cache（歷史 WMTS／OSM／衛星影像），刻意
// 不動 APP_CACHE／DATA_CACHE——那兩份本來就有版本號機制自動汰換，清掉
// 反而會讓使用者短暫離線時失去 fallback。
self.addEventListener('message', (event) => {
  if(event.data?.type !== 'CLEAR_TILE_CACHES') return;
  const port = event.ports?.[0];
  event.waitUntil((async () => {
    try{
      await Promise.all([TILE_CACHE, OSM_TILE_CACHE, SAT_TILE_CACHE].map(name => caches.delete(name)));
      port?.postMessage({ ok: true });
    }catch(err){
      port?.postMessage({ ok: false, error: String(err) });
    }
  })());
});
