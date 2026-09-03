/* ---------------------------------------------------------
   runtime.js — 執行期內部狀態（非使用者意圖，不放進 store）
   ---------------------------------------------------------
   這些是 mapCore 根據 store 狀態「算出來」的結果（實際的 OL 圖層
   物件），或跟畫面顯示無關的執行期輔助值（計時器、拖曳中旗標、
   搜尋 token）。因為不是使用者意圖，也不需要被廣播通知其他模組，
   所以不放進 store.js，仍用最簡單的共用可變物件即可。
--------------------------------------------------------- */
export const runtime = {
  historyLayer: null,    // 疊圖模式：目前套疊在地圖上的歷史圖層（OL layer 實例，來自 layerCache）
  historyLayerKey: null, // 目前 historyLayer 對應的 activeOverlayKey，供 layerManager.js 判斷
                          // 「前一張」是哪一張、以及組成 layerCache 的 protectedKeys（不被 LRU 淘汰）
  swipeLayerA: null,     // 比對模式：左側圖層（OL layer 實例，每次切換都重新包一層，
                          // 但底層 Source 透過 layerCache 共用，見 features/compareMode.js）
  swipeLayerB: null,     // 比對模式：右側圖層（同上）
  dragging: false,       // 左右比對模式的分隔線是否正在拖曳
  addressDebounceTimer: null,
  searchToken: 0,         // 每次新查詢遞增，避免較舊、較慢的查詢結果覆蓋掉新結果
  locateToastTimer: null
  // 註：歷史圖層的快取（曾經建立過的 TileLayer／Source）統一由
  // core/layerCache.js 的 WMTS Layer Cache 管理，不再放在這裡的
  // layerPool——runtime.js 只放「執行期內部狀態」，Cache 本身是
  // 長生命週期、跨 render 都要保留的東西，屬於獨立模組的職責。
};
