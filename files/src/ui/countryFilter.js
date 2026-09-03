/* ---------------------------------------------------------
   ui/countryFilter.js — 「台灣／中國／其他」來源篩選列
   ---------------------------------------------------------
   側邊欄的 30 個 WMTS 來源（.source-group 手風琴）攤開列在一起，
   捲動範圍很長。這個模組提供一條共用的篩選按鈕列，依 src.country
   （見 data.js 的 SOURCE_COUNTRY 對照表）決定要顯示哪些 .source-group，
   單選、按鈕語意跟既有 .segmented／.mode-switch 一致。

   同一份邏輯被疊圖模式（sidebarUI.js #categories）、複合疊圖模式
   （features/multiOverlay.js #multiCategories）、左右比對模式的
   來源選單（features/compareMode.js）三個地方共用，所以獨立成一個
   模組，避免三邊各自維護一份幾乎一樣的按鈕列程式碼。
--------------------------------------------------------- */

const COUNTRY_LABELS = [
  ['tw', '台灣'],
  ['cn', '中國'],
  ['other', '其他']
];

/**
 * 建立一條篩選按鈕列，回傳 { bar, refresh }。
 * @param {() => Array<{src:object, wrap:HTMLElement}>} getEntries
 *   回傳目前所有「來源物件＋對應的 .source-group DOM」配對的函式。
 *   用函式而不是直接傳陣列，是因為呼叫端（例如 multiOverlay.js）
 *   建立來源列表跟建立篩選列不一定同時發生，用函式可以延後查詢，
 *   永遠拿到當下最新的清單。
 */
export function createCountryFilterBar(getEntries){
  const bar = document.createElement('div');
  bar.className = 'segmented country-filter';

  let current = COUNTRY_LABELS[0][0];
  const buttons = new Map();

  function refresh(){
    const entries = getEntries();
    entries.forEach(({ src, wrap }) => {
      const show = src.country === current;
      wrap.classList.toggle('country-hidden', !show);
      // 篩掉的來源如果原本是展開狀態，收合起來，避免切回其他分類時
      // 畫面一次全部展開、又變回捲動很長的狀態。
      if(!show) wrap.classList.remove('open');
    });
  }

  COUNTRY_LABELS.forEach(([key, label]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    if(key === current) btn.classList.add('active');
    btn.addEventListener('click', () => {
      if(current === key) return;
      current = key;
      buttons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      refresh();
    });
    buttons.set(key, btn);
    bar.appendChild(btn);
  });

  return { bar, refresh };
}
