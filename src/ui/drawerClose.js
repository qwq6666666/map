// src/ui/drawerClose.js
// 右側抽屜（使用指南／圖資來源狀態）共用的「帶淡出滑出動畫的關閉」。
// 動畫本身寫在 styles/base.css（桌面與手機共用、且使用者沒開「減少動態效果」
// 時才有）；這裡不自己判斷寬度或偏好，而是加上 .is-closing 後讀
// getComputedStyle 的 animationName：沒有動畫（減少動態效果、
// 測試用的假環境）就當場移除，跟改版前行為一致，不會多等。

// 關閉動畫最長約 200ms；animationend 沒觸發（分頁在背景、動畫被系統
// 中止）時，用這個逾時保底移除，避免遮罩卡在畫面上擋住整個地圖。
const CLOSE_FALLBACK_MS = 400;

// ---------------------------------------------------------
// 共用的「Esc 只關最上層」堆疊。
//
// 使用指南／來源狀態／我的軌跡三個抽屜各自獨立管理、彼此不互相檢查
// 有沒有開別的抽屜（例如先開「使用指南」，不關它、再從「⋯更多」開
// 「我的軌跡」，兩個會同時疊在畫面上）。若各自在 document 掛一個
// bubble-phase 的 keydown 監聽器處理 Esc，瀏覽器對同一個節點、同一個
// 事件階段的多個監聽器會依註冊順序全部觸發、彼此互不知情也無從
// stopPropagation 擋下對方——按一次 Esc 會把疊在一起的抽屜全部關掉，
// 而不是只關使用者看得到的最上層那個。
// 改成共用堆疊＋單一 document 監聽器：只有最後註冊（視覺上最上層，
// 因為後開的抽屜 DOM 也後插入、蓋在上面）的那個會回應 Esc。
const escapeStack = [];
let escapeListenerAttached = false;

function handleStackedEscape(e){
  if(e.key !== 'Escape' || escapeStack.length === 0) return;
  const top = escapeStack[escapeStack.length - 1];
  top();
}

/**
 * 把抽屜的關閉函式登記進「Esc 只關最上層」共用堆疊。開啟抽屜時呼叫，
 * 拿到的 unregister 要在該抽屜關閉時呼叫（不論是透過 Esc、按鈕或點遮罩），
 * 否則堆疊會殘留已經關閉的抽屜、擋住底下真正該回應 Esc 的那層。
 * @param {() => void} close 這個抽屜自己的關閉函式
 * @returns {() => void} unregister
 */
export function registerDrawerEscape(close){
  if(!escapeListenerAttached && typeof document !== 'undefined' && typeof document.addEventListener === 'function'){
    document.addEventListener('keydown', handleStackedEscape);
    escapeListenerAttached = true;
  }
  escapeStack.push(close);
  return function unregister(){
    const idx = escapeStack.indexOf(close);
    if(idx !== -1) escapeStack.splice(idx, 1);
  };
}

export function removeDrawerAnimated(overlay, drawer){
  if(drawer.classList.contains('is-closing')) return; // 動畫進行中重複觸發（連點、Esc）
  overlay.classList.add('is-closing');
  drawer.classList.add('is-closing');

  const finish = () => {
    overlay.remove();
    drawer.remove();
  };
  const animationName = typeof getComputedStyle === 'function'
    ? getComputedStyle(drawer).animationName
    : '';
  if(!animationName || animationName === 'none'){
    finish();
    return;
  }
  drawer.addEventListener('animationend', finish, { once: true });
  setTimeout(finish, CLOSE_FALLBACK_MS);
}
