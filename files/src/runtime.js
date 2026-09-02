/* ---------------------------------------------------------
   runtime.js — 執行期內部狀態（非使用者意圖，不放進 store）
   ---------------------------------------------------------
   這些是 mapCore 根據 store 狀態「算出來」的結果（實際的 OL 圖層
   物件），或跟畫面顯示無關的執行期輔助值（計時器、拖曳中旗標、
   搜尋 token）。因為不是使用者意圖，也不需要被廣播通知其他模組，
   所以不放進 store.js，仍用最簡單的共用可變物件即可。
--------------------------------------------------------- */
export const runtime = {
  historyLayer: null,   // 疊圖模式：目前套疊在地圖上的歷史圖層（OL layer 實例）
  swipeLayerA: null,    // 比對模式：左側圖層（OL layer 實例）
  swipeLayerB: null,    // 比對模式：右側圖層（OL layer 實例）
  dragging: false,      // 左右比對模式的分隔線是否正在拖曳
  addressDebounceTimer: null,
  searchToken: 0,        // 每次新查詢遞增，避免較舊、較慢的查詢結果覆蓋掉新結果
  locateToastTimer: null,
  layerPool: new Map()  // key（"hist:sourceId:id:fmt"）-> 已預先加進地圖、opacity 0 的 OL 圖層實例，
                         // 用來預先載入時間軸即將用到的圖層，見 mapCore.js 的 preloadOverlayKeys()
};
