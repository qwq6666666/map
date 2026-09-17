/* ---------------------------------------------------------
   uiTree.js — 共用：建立「分類 → (堡等次分類 →) 圖層」手風琴清單
   ---------------------------------------------------------
   側邊欄主清單、比對模式的圖層選擇器、搜尋結果清單，三個地方都要
   畫同一種「來源/分類/次分類/圖層」手風琴，所以獨立成共用模組，
   不屬於任何單一功能模組，避免 mapCore / sidebarUI / searchUI
   互相 import 對方造成循環依賴。

   cat.groups 存在時，代表該分類（例：XX廳）底下還要再依
   cat.groups[].name（例：堡）分一層，才會到最底層的圖層清單；
   沒有 cat.groups 時則沿用「分類 → 圖層」兩層結構。

   singleOpen（預設 true）：是否在「分類」「次分類」這兩層也採用
   手風琴行為——展開某一項時，先收合同層其他已展開的項目。
   最上層「來源」的手風琴收合邏輯由各呼叫端（sidebarUI.js／
   search.js／compareMode.js）自行處理，這裡管的是分類／次分類這
   兩層，避免使用者展開多個分類、次分類後清單無限往下疊、越滑越長。

   multiOverlay.js 的 checkbox 多選圖層樹是例外：使用者常需要同時
   打開好幾個分類跨著勾選圖層，若也強制收合同層其他項目，勾到一半
   清單就會收起來、體驗反而更差，所以該呼叫端會傳入 singleOpen =
   false，維持「可同時展開多個」的原行為。
--------------------------------------------------------- */

// 圖例預覽 Modal：全站共用同一個 DOM（lazy singleton），桌機／手機都走
// 這一套，只靠 CSS media query 切換置中卡片／全螢幕呈現，避免維護兩套邏輯。
let legendModalEls = null;
function ensureLegendModal(){
  if (legendModalEls) return legendModalEls;
  const overlay = document.createElement('div');
  overlay.className = 'legend-modal-overlay';
  overlay.style.display = 'none';
  overlay.innerHTML = `
    <div class="legend-modal-card">
      <button type="button" class="legend-modal-close" aria-label="關閉圖例"><svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#close"></use></svg></button>
      <div class="legend-modal-body">
        <img class="legend-modal-img" alt="圖例">
        <p class="legend-modal-error" style="display:none;">圖例載入失敗</p>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const card = overlay.querySelector('.legend-modal-card');
  const img = overlay.querySelector('.legend-modal-img');
  const errorMsg = overlay.querySelector('.legend-modal-error');
  const closeBtn = overlay.querySelector('.legend-modal-close');

  const close = () => { overlay.style.display = 'none'; img.src = ''; };
  overlay.addEventListener('click', close); // 點擊遮罩關閉
  card.addEventListener('click', (e) => e.stopPropagation()); // 卡片本身不觸發遮罩關閉
  closeBtn.addEventListener('click', close);

  legendModalEls = { overlay, img, errorMsg, close };
  return legendModalEls;
}

function showLegendModal(url){
  const { overlay, img, errorMsg } = ensureLegendModal();
  errorMsg.style.display = 'none';
  img.style.display = '';
  img.onerror = () => { img.style.display = 'none'; errorMsg.style.display = ''; };
  img.src = url;
  overlay.style.display = 'flex';
}

// 某個「來源」底下總共有幾筆圖層（含 cat.groups 巢狀次分類）。
// sidebarUI.js 的 buildSourceGroup() 手風琴標題數字、mobileRegionBrowse.js
// 的地區 chip 排序都需要同一套算法，抽在這個沒有任何 UI/功能模組依賴的
// 共用檔案裡，兩邊都能安全 import、不會造成循環依賴。
export function layerCountForSource(src){
  return src.categories.reduce((s, c) =>
    s + (c.groups ? c.groups.reduce((gs, g) => gs + g.layers.length, 0) : c.layers.length), 0);
}

// 建立手風琴標題列的內容（chevron + 標題文字 + 數量徽章），append 進呼叫端
// 傳入的 headEl（通常是一個 <button class="xxx-head">）。三個呼叫端
// （uiTree.js 自己的 buildCategoryList() 分類/次分類標題、sidebarUI.js
// 的 buildSourceGroup() 來源標題、ui/search.js 的 buildAccordionBlock()
// 搜尋結果分組標題）原本各自重複實作幾乎相同的 DOM 樣板，抽成這個共用
// 函式後，之後要調整無障礙屬性（例如補 aria-expanded）等共通行為只需
// 要改這裡一處。只負責建立內容並 append 進 headEl，不建立 headEl 本身
// （className／click handler 等仍由各呼叫端自行決定，因為三邊的行為
// 不完全相同，例如展開時是否要「先收合其他已展開項目」）。
export function buildAccordionHeadContent(headEl, label, count){
  const labelEl = document.createElement('span');
  const chevronEl = document.createElement('span');
  chevronEl.className = 'chevron';
  chevronEl.textContent = '▸';
  const labelTextEl = document.createElement('span');
  labelTextEl.textContent = label;
  labelEl.appendChild(chevronEl);
  labelEl.appendChild(labelTextEl);
  const countEl = document.createElement('span');
  countEl.className = 'count';
  countEl.textContent = String(count);
  headEl.appendChild(labelEl);
  headEl.appendChild(countEl);
}

export function buildLayerItem(layer, onLayerClick){
  const item = document.createElement('div');
  item.className = 'layer-item';
  item.dataset.layerId = layer.id;
  markInteractiveLayerItem(item, () => onLayerClick(layer, item));
  const yearEl = document.createElement('span');
  yearEl.className = 'layer-year';
  yearEl.textContent = layer.year;
  const titleEl = document.createElement('span');
  titleEl.className = 'layer-title';
  titleEl.textContent = layer.title;
  item.appendChild(yearEl);
  item.appendChild(titleEl);
  if (layer.legend) {
    const legendBtn = document.createElement('button');
    legendBtn.type = 'button';
    legendBtn.className = 'layer-legend-btn';
    legendBtn.title = '圖例';
    legendBtn.setAttribute('aria-label', '圖例');
    legendBtn.innerHTML = '<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#info"></use></svg>';
    legendBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showLegendModal(layer.legend);
    });
    item.appendChild(legendBtn);
  }
  return item;
}

// 讓 .layer-item（以及其他手刻、沒有透過 buildLayerItem() 建立的同類項目，
// 例如 compareMode.js 的底圖選項、timelineUI.js 的「年代不明」chip）能被
// 鍵盤操作、被螢幕報讀器正確識別成可互動元素。這些項目原本是純 <div> +
// 滑鼠 click listener：滑鼠使用者點得到，但無法 Tab 移動焦點過去、Enter/
// Space 也無法觸發，螢幕報讀器唸出來只是一段沒有互動語意的文字。
//
// 用 role="button" 而不是更精確的 role="checkbox"（multiOverlay.js 的
// 複合疊圖多選清單、實際語意其實是「勾選/取消勾選」）：這個函式是給所有
// 呼叫端共用的最小改動，不知道呼叫端是單選（點了就切換到這張圖）還是
// 多選（點了是勾選/取消），統一用 role="button" 是保守但正確的最小公倍數
// ——螢幕報讀器至少會唸出「按鈕，圖層名稱」並且可以用 Enter/Space 觸發，
// 比完全沒有 role 好非常多。要讓複合疊圖模式正確唸出「已勾選/未勾選」
// （aria-checked），需要另外讓 multiOverlay.js 的 syncMultiLayerCheckedClasses()
// 在切換 .active class 的同時也同步 aria-checked，屬於後續加強項目、
// 不在這次最小風險的修正範圍內。
export function markInteractiveLayerItem(item, onActivate){
  item.tabIndex = 0;
  item.setAttribute('role', 'button');
  item.addEventListener('click', onActivate);
  item.addEventListener('keydown', (e) => {
    if(e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault(); // 避免 Space 順便捲動頁面
    onActivate();
  });
}

// 把一批圖層項目掛進 container，超過 threshold 筆時預設只顯示前 threshold 筆，
// 其餘加上 'layer-item-overflow' class 並隱藏，清單底部加一顆「展開其餘 N 筆
// 圖資 ▾」／「收合 ▴」的切換按鈕。不使用 overflow-y:auto 局部捲軸，純粹用
// display 切換元素可見度（交給 CSS 的 .expanded 規則統一控制），讓外層容器
// 自然撐開高度，交由外層主捲軸捲動，避免側邊欄內出現雙重捲軸。
export function appendLayerList(container, layers, onLayerClick, threshold = 8){
  layers.forEach((layer, i) => {
    const item = buildLayerItem(layer, onLayerClick);
    if(i >= threshold) item.classList.add('layer-item-overflow');
    container.appendChild(item);
  });
  if(layers.length <= threshold) return;

  const remaining = layers.length - threshold;
  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'layer-list-toggle';
  toggleBtn.textContent = `展開其餘 ${remaining} 筆圖資 ▾`;
  toggleBtn.addEventListener('click', ()=>{
    const expanding = !container.classList.contains('expanded');
    container.classList.toggle('expanded', expanding);
    toggleBtn.textContent = expanding ? '收合 ▴' : `展開其餘 ${remaining} 筆圖資 ▾`;
  });
  container.appendChild(toggleBtn);
}

export function buildCategoryList(categories, container, onLayerClick, openFirst, singleOpen = true, onCategoryOpen = null){
  categories.forEach((cat, ci) => {
    const wrap = document.createElement('div');
    wrap.className = 'category';

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'category-head';
    const catCount = cat.groups ? cat.groups.reduce((s,g)=>s+g.layers.length, 0) : cat.layers.length;
    buildAccordionHeadContent(head, cat.category, catCount);
    head.addEventListener('click', ()=>{
      const opening = !wrap.classList.contains('open');
      if(opening && singleOpen){
        // 手風琴行為：展開這個分類時，先收合同一個來源底下
        // 其他已展開的分類，一次只保留一個分類是開啟的狀態。
        container.querySelectorAll(':scope > .category.open').forEach(c=>{
          if(c !== wrap) c.classList.remove('open');
        });
      }
      wrap.classList.toggle('open');
      if(opening && singleOpen){
        // 比照 sidebarUI.js 展開「來源」時的行為：展開分類後自動捲動，
        // 讓分類標題貼齊側邊欄可視範圍頂端（.category-head 的
        // scroll-margin-top 已避開吸附的透明度區塊，見 style.css）。
        head.scrollIntoView({ behavior:'smooth', block:'start' });
        // 只有呼叫端明確傳入 onCategoryOpen 才會觸發（目前只有
        // sidebarUI.js 對日本／韓國／東南亞這幾個「分類＝城市」的
        // 來源傳入，把地圖移到該分類的地理範圍；其他呼叫端不傳、
        // 其他來源不受影響）。
        if(onCategoryOpen) onCategoryOpen(cat);
      }
    });

    const body = document.createElement('div');
    body.className = 'category-body';

    if(cat.groups){
      cat.groups.forEach(group => {
        const gWrap = document.createElement('div');
        gWrap.className = 'subcategory';

        const gHead = document.createElement('button');
        gHead.type = 'button';
        gHead.className = 'subcategory-head';
        buildAccordionHeadContent(gHead, group.name, group.layers.length);
        gHead.addEventListener('click', ()=>{
          const opening = !gWrap.classList.contains('open');
          if(opening && singleOpen){
            // 手風琴行為：展開這個次分類（例如「堡」）時，先收合
            // 同一個分類底下其他已展開的次分類。
            body.querySelectorAll(':scope > .subcategory.open').forEach(g=>{
              if(g !== gWrap) g.classList.remove('open');
            });
          }
          gWrap.classList.toggle('open');
        });

        const gBody = document.createElement('div');
        gBody.className = 'subcategory-body';
        appendLayerList(gBody, group.layers, onLayerClick);

        gWrap.appendChild(gHead);
        gWrap.appendChild(gBody);
        body.appendChild(gWrap);
      });
    } else {
      appendLayerList(body, cat.layers, onLayerClick);
    }

    wrap.appendChild(head);
    wrap.appendChild(body);
    container.appendChild(wrap);
    if(openFirst && ci === 0) wrap.classList.add('open');
  });
}
