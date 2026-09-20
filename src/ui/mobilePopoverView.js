/* ---------------------------------------------------------
   ui/mobilePopoverView.js — 手機「地圖工具」浮動選單的兩頁切換與狀態角標
   ---------------------------------------------------------
   選單分「主頁」（模式＋高頻工具）與「更多」（軌跡管理／分享／說明）兩個畫面，
   用 popover.dataset.view 表示目前是哪一頁，顯示切換純靠 CSS
   （#mobileModePopover[data-view=...]，見 styles/mobile.css）。這裡只管
   「目前是哪一頁」與「哪些按鈕會換頁」，不碰任何功能轉發（那是 mobileLayout.js）。
   純函式／只吃傳入節點，方便用假物件測試。
--------------------------------------------------------- */

export const POPOVER_VIEWS = ['main', 'more'];
export const DEFAULT_POPOVER_VIEW = 'main';

/**
 * @param {HTMLElement} popover 浮動選單根節點
 * @param {{ onChange?: (view:string) => void }} [opts] 換頁後呼叫（選單開著時要重新定位，高度變了）
 * 帶 data-popover-go="main|more" 的按鈕點下去就換到該頁。
 */
export function initPopoverViews(popover, { onChange } = {}){
  function show(view){
    const next = POPOVER_VIEWS.includes(view) ? view : DEFAULT_POPOVER_VIEW;
    if(popover.dataset.view === next) return;
    popover.dataset.view = next;
    popover.scrollTop = 0;
    onChange?.(next);
  }
  popover.dataset.view = DEFAULT_POPOVER_VIEW;
  popover.querySelectorAll('[data-popover-go]').forEach((el) => {
    el.addEventListener('click', () => show(el.dataset.popoverGo));
  });
  return {
    show,
    /** 每次開啟選單都回主頁，不要停在上次的次頁 */
    reset: () => show(DEFAULT_POPOVER_VIEW),
    current: () => popover.dataset.view
  };
}

/**
 * 「地圖工具」浮動按鈕上的小圓點：選單收起來時也看得出位置功能還開著。
 * 記錄軌跡優先（位置是隱私資料、會一直累積），其次是單純的持續追蹤。
 * @returns {'rec'|'track'|null}
 */
export function liveBadgeKind({ recording = false, tracking = false } = {}){
  if(recording) return 'rec';
  if(tracking) return 'track';
  return null;
}
