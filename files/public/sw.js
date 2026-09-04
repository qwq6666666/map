/* ---------------------------------------------------------
   public/sw.js — Service Worker（二級快取架構）
   ---------------------------------------------------------
   三個獨立快取，各自對應一種資源與策略：
     1. TILE_CACHE  — WMTS / Tile 圖片，Cache-First，並用簡易 LRU
        （上限 TILE_LRU_LIMIT 筆）避免無限長大。這層是磁碟持久快取
        （L2），跟 src/core/layerCache.js 的記憶體 Image 快取（L1）
        互補，SW 重啟、分頁關閉都不會清空。
     2. META_CACHE  — layers.bundle.json 等圖層 JSON，
        Stale-While-Revalidate：先回舊資料讓地圖馬上能開，背景同時
        打一次網路更新快取，下次載入就是新的。
     3. SHELL_CACHE — 同源的 HTML / JS / CSS，Cache-First + Network
        fallback。

   LRU 索引用一筆固定 key 的 JSON Response 存在 TILE_CACHE 裡本身
   （而不是 SW 的記憶體變數），因為 Service Worker 隨時可能被瀏覽器
   終止、下次事件才醒來，記憶體變數活不過重啟，Cache Storage 才是
   真的持久。
--------------------------------------------------------- */

const VERSION = 'v1';
const TILE_CACHE = `tile-cache-${VERSION}`;
const META_CACHE = `meta-cache-${VERSION}`;
const SHELL_CACHE = `shell-cache-${VERSION}`;
const CACHE_NAMES = [TILE_CACHE, META_CACHE, SHELL_CACHE];

const TILE_LRU_LIMIT = 1200;
const TILE_LRU_KEY = new Request('https://tile-lru.local/__index__');

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set(CACHE_NAMES);
    const names = await caches.keys();
    await Promise.all(names.filter(n => !keep.has(n)).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

async function readTileLRU(cache){
  const res = await cache.match(TILE_LRU_KEY);
  if(!res) return [];
  try{ return await res.json(); }catch{ return []; }
}

async function writeTileLRU(cache, list){
  await cache.put(TILE_LRU_KEY, new Response(JSON.stringify(list), {
    headers: { 'Content-Type': 'application/json' }
  }));
}

async function touchTileLRU(cache, url){
  const list = await readTileLRU(cache);
  const idx = list.indexOf(url);
  if(idx !== -1) list.splice(idx, 1);
  list.push(url);
  while(list.length > TILE_LRU_LIMIT){
    const oldest = list.shift();
    await cache.delete(oldest);
  }
  await writeTileLRU(cache, list);
}

function isTileRequest(request){
  return request.destination === 'image';
}

function isMetaRequest(url){
  return url.pathname.endsWith('.json') && url.pathname.includes('/data/');
}

function isShellRequest(request, url){
  if(request.mode === 'navigate') return true;
  return url.origin === self.location.origin && (request.destination === 'script' || request.destination === 'style');
}

async function cacheFirstTile(request){
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);
  if(cached){
    await touchTileLRU(cache, request.url);
    return cached;
  }
  const res = await fetch(request);
  if(res && (res.ok || res.type === 'opaque')){
    await cache.put(request, res.clone());
    await touchTileLRU(cache, request.url);
  }
  return res;
}

async function staleWhileRevalidateMeta(request){
  const cache = await caches.open(META_CACHE);
  const cached = await cache.match(request);
  const networkFetch = fetch(request).then((res) => {
    if(res && res.ok) cache.put(request, res.clone());
    return res;
  }).catch(() => null);
  if(cached) return cached;
  const fromNetwork = await networkFetch;
  return fromNetwork || Response.error();
}

async function cacheFirstShell(request){
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if(cached) return cached;
  try{
    const res = await fetch(request);
    if(res && res.ok) cache.put(request, res.clone());
    return res;
  }catch(err){
    if(request.mode === 'navigate'){
      const fallback = await cache.match(self.registration.scope);
      if(fallback) return fallback;
    }
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if(request.method !== 'GET') return;

  let url;
  try{ url = new URL(request.url); }catch{ return; }

  if(isTileRequest(request)){
    event.respondWith(cacheFirstTile(request));
    return;
  }
  if(isMetaRequest(url)){
    event.respondWith(staleWhileRevalidateMeta(request));
    return;
  }
  if(isShellRequest(request, url)){
    event.respondWith(cacheFirstShell(request));
  }
});
