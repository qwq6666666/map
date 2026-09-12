/* ---------------------------------------------------------
   ui/mobileOtherBrowse.js — 手機版「其他」分頁專用：來源→分類/圖層 二段式
   ---------------------------------------------------------
   服務 sidebarUI.js 的手機版（<=768px）「其他」分頁瀏覽方式。跟
   src/ui/mobileTwBrowse.js／mobileCnBrowse.js 的「大區域→地區→來源」
   三段式不同——「其他」分頁目前只有 japan／korea／ls／southeast_asia
   四個彼此獨立的國家/主題來源，不像台灣、中國內部有「同一國家多來源
   合併成地區」的關係，硬套三段式會產生沒有意義的中間層，所以刻意不
   重用 buildMobileRegionBrowseUI（那支函式的資料模型是為「多來源合併
   進同一地區」設計的），改成單純的「來源 chip → 該來源的分類/圖層
   手風琴」二段式。

   第二層一樣直接重用 sidebarUI.js 抽出的 buildSourceGroup()（跟桌機
   「來源(機構)→分類→次分類→圖層」手風琴共用同一套建置邏輯），不自己
   刻一份圖層清單渲染邏輯。第一層 chip 數字沿用
   src/ui/mobileRegionBrowse.js 已 export 的 layerCountForSource()。

   DOM 結構與 CSS class 刻意直接沿用 mobileTwBrowse.js／
   mobileCnBrowse.js 那組（mobile-tw-browse／mobile-tw-macro-row／
   mobile-tw-macro-btn／mobile-tw-hint／mobile-tw-sources）——雖然
   class 名稱歷史上帶了「macro」（大區域）字樣，但 style.css 對應規則
   本身是純結構性的（chip 列橫向排列＋徽章數字、手風琴容器排版），跟
   語意無關，兩種瀏覽方式共用完全沒問題，不需要另外發明一套樣式語言，
   也不需要新增 rootClassName。跟 mobileCnBrowse.js 沿用 mobileTwBrowse.js
   那組 class 的作法一致（見該檔案開頭註解）。

   buildMobileOtherBrowseUI() 回傳的容器由呼叫端自行決定何時
   append／顯示（見 sidebarUI.js 的 syncMobileBrowseView()，用 hidden
   attribute 控制），不會自行 append。
--------------------------------------------------------- */
import { layerCountForSource } from './mobileRegionBrowse.js';

/**
 * 建立手機版「其他」分頁的來源→分類/圖層二段式瀏覽 UI，回傳可直接
 * append 進 #categories 的容器（不會自行 append，由呼叫端決定時機）。
 * @param {Array} otherSources LAYER_SOURCES 篩過 country==='other' 的子集
 *   （不寫死來源 id，跑迴圈渲染，未來這個分類再增加來源不用改這支檔案）。
 * @param {(src:object) => HTMLElement} buildSourceGroup
 *   sidebarUI.js 抽出的單一來源手風琴建置函式（跟桌機共用同一套邏輯，
 *   每次呼叫都會 document.createElement 全新建立一份獨立 DOM，不會跟
 *   桌機那份手風琴共用節點，也不需要手動同步兩者的展開狀態）。
 */
export function buildMobileOtherBrowseUI(otherSources, buildSourceGroup){
  const root = document.createElement('div');
  root.className = 'mobile-tw-browse';

  const sourceRow = document.createElement('div');
  sourceRow.className = 'mobile-tw-macro-row';

  const hint = document.createElement('div');
  hint.className = 'mobile-tw-hint';
  hint.textContent = '請先選擇來源';

  const sourcesWrap = document.createElement('div');
  sourcesWrap.className = 'mobile-tw-sources';

  let selectedSrc = null; // null = 尚未選擇任何來源
  const buttons = new Map(); // src.id -> btn

  function renderSources(){
    sourcesWrap.innerHTML = '';
    if(!selectedSrc){
      hint.hidden = false;
      return;
    }
    hint.hidden = true;
    sourcesWrap.appendChild(buildSourceGroup(selectedSrc));
  }

  function selectSource(src){
    // 單選 toggle：再點一次已選中的來源 = 取消選取（收合）
    selectedSrc = (selectedSrc === src) ? null : src;
    buttons.forEach((btn, id) => btn.classList.toggle('active', !!selectedSrc && id === selectedSrc.id));
    renderSources();
  }

  otherSources.forEach(src => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'avail-year-sort-btn mobile-tw-macro-btn';
    btn.textContent = `${src.name} ${layerCountForSource(src)}`;
    btn.addEventListener('click', () => selectSource(src));
    buttons.set(src.id, btn);
    sourceRow.appendChild(btn);
  });

  root.appendChild(sourceRow);
  root.appendChild(hint);
  root.appendChild(sourcesWrap);

  return root;
}
