/* ---------------------------------------------------------
   ui/availCollapse.js — 搜尋結果「可用圖層」面板的收合狀態
   ---------------------------------------------------------
   桌面版側邊欄是單一捲動區：地址搜尋的結果面板（座標＋可用圖層清單）夠長，
   會把下方的圖資搜尋、地圖模式、圖資清單整個推出畫面。收合後只剩一行摘要，
   把空間還給下面。

   收合狀態放在模組層級（整個 session 記住）：每次新搜尋面板都會重建 DOM，
   如果不記住，偏好收合的使用者每搜一次就被重新展開一次。
   純函式／只吃傳入節點，方便用假物件測試。
--------------------------------------------------------- */

const COLLAPSED_CLASS = 'avail-collapsed';

let collapsedPref = false;

/** 目前偏好（測試與 render 開頭讀取用）。 */
export function isAvailCollapsed(){
  return collapsedPref;
}

/** 測試用：回到預設展開。 */
export function resetAvailCollapse(){
  collapsedPref = false;
}

/**
 * 把收合鈕綁到面板上。每次 render 都會重新呼叫（面板 DOM 是重建的）。
 * @param {HTMLElement} panel 面板根節點，收合時加上 .avail-collapsed（CSS 負責藏頁籤與清單）
 * @param {HTMLElement} button 收合鈕
 * @returns {{ set:(v:boolean)=>void, expand:()=>void }}
 */
export function bindAvailCollapse(panel, button){
  function apply(){
    panel.classList.toggle(COLLAPSED_CLASS, collapsedPref);
    button.textContent = collapsedPref ? '▸' : '▾';
    button.setAttribute('aria-expanded', collapsedPref ? 'false' : 'true');
    button.title = collapsedPref ? '展開可用圖層清單' : '收合可用圖層清單';
  }
  function set(value){
    collapsedPref = !!value;
    apply();
  }
  button.addEventListener('click', () => set(!collapsedPref));
  apply();
  return {
    set,
    // 多選模式要用到清單，被收合時得先展開
    expand: () => { if(collapsedPref) set(false); }
  };
}
