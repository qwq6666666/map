/* ---------------------------------------------------------
   core/layerCache.js — WMTS Layer Cache（歷史圖層快取管理器）
   ---------------------------------------------------------
   目標：歷史圖資第一次使用時才建立 OL TileLayer／Source；建立後
   保留並重複使用，避免使用者在時間軸／比對模式來回切換時反覆
   new TileLayer() / new Source()，造成不必要的重建與 tile request。

   請嚴格區分（跟本檔案的關係）：
     A. Layer Cache（這個檔案）：由網站 JS 自己管理，保存
        { key, source, layer, metadata, createdAt, lastUsedAt }，
        目的是避免重新建立 OpenLayers TileLayer / Source 物件本身。
     B. Tile Cache：由 OpenLayers、瀏覽器、HTTP cache 管理，保存的是
        實際下載的圖磚圖片。這裡完全不碰、不自行用 localStorage／
        IndexedDB 存 PNG／JPEG——那些交給瀏覽器與 OL 內建機制即可。

   Cache 策略：
     - Lazy：網站啟動時不建立任何歷史圖層，只在第一次真的被選到
       （或被預先載入）時才建立。
     - softLimit（30）：0~30 筆直接保留，不主動淘汰。
     - hardLimit（50）：超過才真正執行 LRU 淘汰，且絕不淘汰目前
       正在使用中的圖層（由呼叫端傳入 protectedKeys 表達「現在正在
       用哪幾個 key」，例如疊圖模式目前顯示的、Compare 模式 A/B
       兩側目前顯示的）。
     - preload: 0：Cache 只負責「保留物件」，不因為保留而主動搶跑
       下載一大堆圖磚；圖磚何時下載仍由 OL 依實際 viewport 決定。

   對外 API：getOrCreateLayer／getOrCreateSource／showLayer／
   hideLayer／setLayerOpacity／getCachedLayer／getCachedSource／
   hasCachedLayer／removeCachedLayer／clearCache／getCacheStats。
--------------------------------------------------------- */
import { map } from './map.js';
import { makeSourceForKey } from '../data.js';

let DEBUG_CACHE = false; // 開發時可在 console 呼叫 window.__layerCacheDebug(true) 開啟

export const CACHE_CONFIG = {
  softLimit: 30, // 0~30 筆：直接保留，不主動淘汰
  hardLimit: 50  // 超過 50 筆才開始 LRU 淘汰（不寫死成單一 MAX，因為圖資會持續增加）
};

const cache = new Map(); // key -> { key, source, layer, metadata, createdAt, lastUsedAt }

function log(tag, key){
  if(!DEBUG_CACHE) return;
  console.log(`[${tag}] ${key}`);
}

function touch(entry){
  entry.lastUsedAt = Date.now();
}

/* ---------------------------------------------------------
   建立一筆全新的 cache entry：只在真的沒有現成的可以重用時才呼叫。
   layer 建立時 opacity 先設 0（隱形但仍然是 visible layer，會照常
   讓 OL 依 viewport 需要背景下載圖磚——這是刻意的，時間軸／疊圖
   模式的交叉淡出淡入效果需要新圖層能提前暖機）；preload 固定為 0，
   避免「保留 Layer」被誤會成「主動預抓一大堆圖磚」，這兩件事必須
   分開（見檔頭說明）。
--------------------------------------------------------- */
function createEntry(key){
  const source = makeSourceForKey(key);
  const layer = new ol.layer.Tile({ source, preload: 0 });
  layer.setOpacity(0);
  map.addLayer(layer);
  const entry = { key, source, layer, metadata: { key }, createdAt: Date.now(), lastUsedAt: Date.now() };
  cache.set(key, entry);
  log('CACHE CREATE', key);
  return entry;
}

/* ---------------------------------------------------------
   超過 hardLimit 才淘汰，且只淘汰不在 protectedKeys 裡的項目，
   依 lastUsedAt 由舊到新排序（LRU：淘汰最久沒用到的）。
   注意：因為 createEntry() 全程同步（沒有 await），同一個 key
   不可能在還沒被塞進 cache 前又被要求建立第二次，天生不會有
   「重複建立」的競爭問題，不需要另外用 Promise 上鎖。
--------------------------------------------------------- */
function evictIfNeeded(protectedKeys){
  if(cache.size <= CACHE_CONFIG.hardLimit) return;
  const protect = protectedKeys || new Set();
  const candidates = [...cache.values()]
    .filter(e => !protect.has(e.key))
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  let i = 0;
  while(cache.size > CACHE_CONFIG.hardLimit && i < candidates.length){
    const entry = candidates[i++];
    map.removeLayer(entry.layer);
    cache.delete(entry.key);
    log('CACHE EVICT', entry.key);
  }
}

export function hasCachedLayer(key){
  return cache.has(key);
}

export function getCachedLayer(key){
  const entry = cache.get(key);
  return entry ? entry.layer : null;
}

export function getCachedSource(key){
  const entry = cache.get(key);
  return entry ? entry.source : null;
}

/**
 * 取得（或視需要建立）一張可以直接加進地圖顯示的 TileLayer。
 * 適用情境：疊圖模式／時間軸模式——只需要「一張圖層，切換時交叉
 * 淡出淡入」的地方。
 * @param {string} key 唯一圖資 key（例："hist:sinica:JM25K_1921:jpg"）
 * @param {Set<string>} [protectedKeys] 目前正在使用中、絕不能被 LRU 淘汰的 key 集合
 */
export function getOrCreateLayer(key, protectedKeys){
  const cached = cache.get(key);
  if(cached){
    touch(cached);
    log('CACHE HIT', key);
    return cached.layer;
  }
  log('CACHE MISS', key);
  const entry = createEntry(key);
  evictIfNeeded(protectedKeys);
  return entry.layer;
}

/**
 * 取得（或視需要建立）某個 key 的底層 Source，但不回傳／不強迫使用
 * 快取好的那張主要 Layer。適用情境：Compare（左右比對）模式——
 * 每一側需要自己專屬的 TileLayer 物件（掛左右裁切用的
 * prerender/postrender 監聽器），沒辦法直接共用同一個 Layer 物件，
 * 但底層的 Source（也就是真正花網路成本、真正持有圖磚快取的東西）
 * 仍然可以、也應該共用——這樣切換 A/B 側到「時間軸模式已經看過的
 * 同一張歷史圖」時，不會重新對 WMTS 服務發送請求。
 */
export function getOrCreateSource(key, protectedKeys){
  const cached = cache.get(key);
  if(cached){
    touch(cached);
    log('CACHE HIT', key);
    return cached.source;
  }
  log('CACHE MISS', key);
  const entry = createEntry(key);
  evictIfNeeded(protectedKeys);
  return entry.source;
}

/** 立即顯示（opacity 1），不做動畫；需要淡入淡出效果的地方請自行控制 opacity。 */
export function showLayer(key){
  const entry = cache.get(key);
  if(!entry) return;
  touch(entry);
  entry.layer.setOpacity(1);
}

/** 立即隱藏（opacity 0）。圖層物件本身不會被移除，繼續留在 Cache 裡。 */
export function hideLayer(key){
  const entry = cache.get(key);
  if(!entry) return;
  entry.layer.setOpacity(0);
}

export function setLayerOpacity(key, opacity){
  const entry = cache.get(key);
  if(!entry) return;
  entry.layer.setOpacity(opacity);
}

export function removeCachedLayer(key){
  const entry = cache.get(key);
  if(!entry) return;
  map.removeLayer(entry.layer);
  cache.delete(key);
}

export function clearCache(){
  cache.forEach(entry => map.removeLayer(entry.layer));
  cache.clear();
}

export function getCacheStats(){
  return {
    size: cache.size,
    softLimit: CACHE_CONFIG.softLimit,
    hardLimit: CACHE_CONFIG.hardLimit,
    keys: [...cache.keys()],
    visible: [...cache.values()].filter(e => e.layer.getOpacity() > 0).map(e => e.key)
  };
}

export function setCacheDebug(enabled){
  DEBUG_CACHE = !!enabled;
}

// 開發方便：console 直接呼叫 __layerCacheDebug(true) / __layerCacheStats()，
// 不需要另外開一個 debug 面板 UI。正式環境預設 DEBUG_CACHE=false，不會洗版。
if(typeof window !== 'undefined'){
  window.__layerCacheDebug = setCacheDebug;
  window.__layerCacheStats = getCacheStats;
}
