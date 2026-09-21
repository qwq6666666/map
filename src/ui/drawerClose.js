// src/ui/drawerClose.js
// 右側抽屜（使用指南／圖資來源狀態）共用的「帶淡出滑出動畫的關閉」。
// 動畫本身寫在 styles/base.css（桌面與手機共用、且使用者沒開「減少動態效果」
// 時才有）；這裡不自己判斷寬度或偏好，而是加上 .is-closing 後讀
// getComputedStyle 的 animationName：沒有動畫（減少動態效果、
// 測試用的假環境）就當場移除，跟改版前行為一致，不會多等。

// 關閉動畫最長約 200ms；animationend 沒觸發（分頁在背景、動畫被系統
// 中止）時，用這個逾時保底移除，避免遮罩卡在畫面上擋住整個地圖。
const CLOSE_FALLBACK_MS = 400;

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
