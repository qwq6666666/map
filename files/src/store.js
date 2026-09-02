/* ---------------------------------------------------------
   store.js — 輕量狀態收納箱（Vanilla JS Pub/Sub）
   ---------------------------------------------------------
   只放「使用者意圖／目前應該顯示什麼」這種可序列化的狀態，例如
   目前模式、目前底圖、目前套疊中的歷史圖層 key、比對模式左右兩側
   選了哪個 key、分隔線位置。UI（sidebarUI／searchUI／mapCore 自己
   的按鈕）要換圖層或換模式時，一律呼叫 setState()，不直接呼叫
   map.addLayer()／map.removeLayer()；真正碰地圖圖層的動作，統一
   由 mapCore.js 訂閱 store 之後集中處理（見 mapCore.js 的
   `render(state, prevState, changedKeys)`）。

   不放進 store 的東西：OL 圖層物件本身（historyLayer／
   swipeLayerA/B）、計時器、searchToken 這類「執行期內部狀態」──
   這些不是使用者意圖，是 mapCore 根據 store 狀態算出來的結果，
   繼續放在 state.js（改名 runtime.js 以跟這裡的 store 狀態區分）。
--------------------------------------------------------- */

export const state = {
  mode: 'overlay',        // 'overlay'（透明疊圖）或 'compare'（左右比對）
  baseLayer: 'osm',       // 'osm' 或 'sat'，兩種模式共用的底圖
  activeOverlayKey: null, // 透明疊圖模式目前套疊的歷史圖層 key（null 代表沒有）
  compareA: 'hist:sinica:JM20K_1904:jpg', // 比對模式左側 key
  compareB: 'base:osm',                    // 比對模式右側 key
  swipePercent: 50        // 比對模式分隔線位置（0~100）
};

const listeners = [];

// 訂閱狀態變化。listener(state, prevState, changedKeys) 會在每次
// setState() 真的改到值的時候被呼叫；changedKeys 是這次變動的欄位
// 名稱陣列，訂閱者可以只處理自己在意的欄位，不用每次都全部重算。
export function subscribe(listener){
  listeners.push(listener);
  return () => {
    const idx = listeners.indexOf(listener);
    if(idx !== -1) listeners.splice(idx, 1);
  };
}

export function setState(patch){
  const prev = { ...state };
  Object.assign(state, patch);
  const changedKeys = Object.keys(patch).filter(k => prev[k] !== state[k]);
  if(changedKeys.length === 0) return; // 沒有實際改變就不廣播，避免多餘重繪
  listeners.forEach(listener => listener(state, prev, changedKeys));
}

/* ---------------------------------------------------------
   意圖動作（actions）── sidebarUI／searchUI／mapCore 自己的按鈕
   一律呼叫這些函式表達「使用者想要什麼」，不直接碰地圖圖層。
   真正的地圖操作統一在 mapCore.js 訂閱 store 之後集中處理。
--------------------------------------------------------- */

// 點選歷史圖層：再次點擊目前已啟用的同一個圖層 -> 取消（回到未套疊狀態）。
export function selectOverlayLayer(key){
  setState({ activeOverlayKey: state.activeOverlayKey === key ? null : key });
}

export function clearOverlayLayer(){
  setState({ activeOverlayKey: null });
}

export function setMode(mode){
  setState({ mode });
}

export function setBaseLayer(id){
  setState({ baseLayer: id });
}

export function setCompareSide(side, key){
  setState(side === 'A' ? { compareA: key } : { compareB: key });
}

export function setSwipePercent(percent){
  setState({ swipePercent: percent });
}
