/* ---------------------------------------------------------
   state.js — 跨模組共用的可變狀態
   ---------------------------------------------------------
   透明疊圖／左右比對模式底下，有些狀態會被好幾個模組同時讀寫
  （例如目前套疊中的歷史圖層、目前模式、搜尋 token 等）。
   ES module 的 `export let` 雖然支援 live binding（其他模組讀取到
   的值會自動更新），但只有「匯出的那個模組自己」能重新賦值；
   其他模組沒辦法直接改。與其每個狀態都額外寫一組 getter/setter，
   這裡統一用一個永遠不重新賦值、只修改內部欄位的物件 `state`，
   讓 mapCore.js / sidebarUI.js / searchUI.js 都能直接
   `state.xxx = ...` 互相讀寫，行為等同原本 script 內共用的
   上層變數。
--------------------------------------------------------- */
export const state = {
  historyLayer: null,     // 疊圖模式：目前疊加的歷史圖層
  swipeLayerA: null,      // 比對模式：左側圖層（疊在底圖上，僅裁切顯示左側）
  swipeLayerB: null,      // 比對模式：右側圖層（疊在底圖上，僅裁切顯示右側）
  currentMode: 'overlay',
  swipePercent: 50,
  activeOverlayKey: null, // 透明疊圖模式目前選擇的歷史圖層 key（沒有選則為 null，代表僅底圖）
  activeLayerId: null,
  dragging: false,        // 左右比對模式的分隔線是否正在拖曳
  addressDebounceTimer: null,
  searchToken: 0,          // 每次新查詢遞增，避免較舊、較慢的查詢結果覆蓋掉新結果
  locateToastTimer: null
};
