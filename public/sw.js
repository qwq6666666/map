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

     1.5 OSM_TILE_CACHE — 現代地圖底圖（OpenStreetMap）圖磚，快取策略
        跟 TILE_CACHE 完全一樣，差別只在快取空間、LRU 名額各自獨立算，
        原因見下方常數定義處的說明；跟 TILE_CACHE 共用
        TILE_CACHE_VERSION（儲存格式一致，沒有分開版號的必要）。

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

   TILE_LRU 索引用一筆固定 key 的 JSON Response 存在 TILE_CACHE 裡本身
   （而不是 SW 的記憶體變數），因為 Service Worker 隨時可能被瀏覽器
   終止、下次事件才醒來，記憶體變數活不過重啟，Cache Storage 才是
   真的持久。

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
// OSM 現代地圖底圖圖磚獨立一份快取空間＋獨立 LRU，不跟歷史 WMTS／衛星
// 圖磚共用同一份 LRU 名單：地址搜尋一次會對上百筆候選歷史圖層送出探測
// 用的圖磚請求（見 src/tileChecker.js），這些探測請求如果跟畫面上一直
// 看得到、反覆重繪的 OSM 底圖擠在同一份 LRU 裡，搜尋密集時會把底圖圖磚
// 排擠掉、需要重新下載，體感上就是「一直在看的底圖也跟著變慢」。分開
// 後兩邊 LRU 名額互不影響，跟 TILE_CACHE 一樣用 TILE_CACHE_VERSION。
const OSM_TILE_CACHE = `tile-cache-osm-${TILE_CACHE_VERSION}`;

// activate 時只清除這些前綴開頭、且不是目前版本的快取；shell-cache- /
// meta-cache- 是這次改版之前的舊命名，一併列入做一次性遷移清理。
// tile-cache- 前綴刻意不在這份清單裡（TILE_CACHE、OSM_TILE_CACHE 兩者
// 皆是），確保圖磚快取不會因為 App Shell／Data 改版而被清掉。
const MANAGED_CACHE_PREFIXES = ['app-shell-', 'data-', 'shell-cache-', 'meta-cache-'];

const TILE_LRU_LIMIT = 5000;
const TILE_LRU_KEY = new Request('https://tile-lru.local/__index__');
const OSM_TILE_LRU_KEY = new Request('https://tile-lru.local/__osm_index__');

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([APP_CACHE, DATA_CACHE, TILE_CACHE, OSM_TILE_CACHE]);
    const names = await caches.keys();
    await Promise.all(
      names
        .filter(n => MANAGED_CACHE_PREFIXES.some(p => n.startsWith(p)) && !keep.has(n))
        .map(n => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

async function readTileLRU(cache, lruKey){
  const res = await cache.match(lruKey);
  if(!res) return [];
  try{ return await res.json(); }catch{ return []; }
}

async function writeTileLRU(cache, lruKey, list){
  await cache.put(lruKey, new Response(JSON.stringify(list), {
    headers: { 'Content-Type': 'application/json' }
  }));
}

async function touchTileLRU(cache, lruKey, url){
  const list = await readTileLRU(cache, lruKey);
  const idx = list.indexOf(url);
  if(idx !== -1) list.splice(idx, 1);
  list.push(url);
  while(list.length > TILE_LRU_LIMIT){
    const oldest = list.shift();
    await cache.delete(oldest);
  }
  await writeTileLRU(cache, lruKey, list);
}

function isTileRequest(request){
  return request.destination === 'image';
}

// OSM 底圖圖磚（ol.source.OSM 預設打 a/b/c.tile.openstreetmap.org）
// 走獨立的 OSM_TILE_CACHE，跟其他圖磚請求（歷史 WMTS、衛星底圖）分開。
function isOsmTileRequest(url){
  return /(^|\.)tile\.openstreetmap\.org$/.test(url.hostname);
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

async function cacheFirstTile(request, url){
  const isOsm = isOsmTileRequest(url);
  const cache = await caches.open(isOsm ? OSM_TILE_CACHE : TILE_CACHE);
  const lruKey = isOsm ? OSM_TILE_LRU_KEY : TILE_LRU_KEY;
  const cached = await cache.match(request);
  if(cached){
    await touchTileLRU(cache, lruKey, request.url);
    return cached;
  }
  const res = await fetch(request);
  if(res && (res.ok || res.type === 'opaque')){
    await cache.put(request, res.clone());
    await touchTileLRU(cache, lruKey, request.url);
  }
  return res;
}

async function networkFirstData(request){
  const cache = await caches.open(DATA_CACHE);
  try{
    const res = await fetch(request);
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
    const res = await fetch(request);
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
