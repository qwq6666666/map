/* ---------------------------------------------------------
   sidebarUI.js — 側邊欄：WMTS 圖資來源 → 分類(→ 堡等次分類) → 圖層
   手風琴建置
--------------------------------------------------------- */
import { DATA, layerKey, titleForKey, resolveOverlayKey } from './data.js';
import { buildCategoryList, layerCountForSource } from './uiTree.js';
import {
  selectOverlayLayer, state as store, subscribe,
  toggleFavoriteLayer, isFavoriteLayer, setMode, clearRecentLayers
} from './store.js';
import { flyToSourceExtent, flyToCategoryExtent } from './mapCore.js';

// 這幾個來源的「分類」是城市（例如日本的「函館」「神戶」、東南亞的
// 「曼谷」），跟其他來源「分類＝地圖系列」不同——展開分類時飛到對應
// 城市的地理位置才有意義，其他來源不套用這個行為（見下方呼叫端）。
const FLY_TO_CATEGORY_SOURCE_IDS = new Set(['japan', 'korea', 'southeast_asia']);
import { createCountryFilterBar } from './ui/countryFilter.js';
import { buildMobileTwBrowseUI, macroRegionForSource, MACRO_REGION_ORDER } from './ui/mobileTwBrowse.js';
import { buildMobileCnBrowseUI } from './ui/mobileCnBrowse.js';
import { buildMobileOtherBrowseUI } from './ui/mobileOtherBrowse.js';

// 手機版（<=768px）「台灣」「中國」分頁改用大區域→地區→來源手風琴
// 瀏覽（分別是 src/ui/mobileTwBrowse.js／src/ui/mobileCnBrowse.js），
// 「其他」分頁改用來源→分類/圖層二段式瀏覽（src/ui/mobileOtherBrowse.js，
// 目前只有 japan／korea／ls／southeast_asia 四個彼此獨立的來源，不像
// 台灣、中國內部有「同一國家多來源合併成地區」的關係，故不套三段式）；
// 取代原本的來源手風琴；桌機不受影響，一律靠這個
// matchMedia 判斷式決定要不要顯示，比照 src/ui/mobileLayout.js 的既有寫法。
// 保留 typeof 防呆：tests/env-stub.mjs 的假 window 沒有 matchMedia
// （mobileLayout.js 目前沒有任何測試會 import 到，沒踩過這個問題；
// sidebarUI.js 幾乎每份整合測試都會 import，沒防呆會讓一大片既有
// 測試檔案直接拋例外），退化成「永遠桌面版」不影響邏輯正確性，
// 真的瀏覽器環境一律有 matchMedia，不受影響。
const mq = (typeof window.matchMedia === 'function')
  ? window.matchMedia('(max-width:768px)')
  : { matches: false, addEventListener(){}, addListener(){} };

/* 動態量測「歷史圖層透明度」吸附區塊的實際高度，寫成 CSS 變數，
   讓 .source-head / .category-head 的 scroll-snap-margin-top 精準對齊
   吸附區塊底部，捲動時清單只會停在標題完整可見的位置，
   不會停在被吸附區塊腰斬一半的中間狀態。 */
function updateStickyOffset(){
  const ob = document.querySelector('.opacity-block');
  if(!ob) return;
  // 兩個不同用途、不能共用同一個數字：
  //   --opacity-block-height：只有 .opacity-block 自己的高度，給
  //     .country-filter 的 sticky top 用（它疊在 .opacity-block 正
  //     下方，只需要知道「上面那塊」多高，不能把自己的高度也算進去，
  //     不然會跟 .opacity-block 之間永遠留一道等於自己高度的縫）。
  //   --sticky-offset：.opacity-block + .country-filter 兩者加總，給
  //     .source-head/.category-head 的 scroll-margin-top 用（展開來源
  //     時 scrollIntoView 要避開的是「整疊」吸附區塊，不只是其中一個）。
  const obHeight = Math.ceil(ob.getBoundingClientRect().height);
  document.documentElement.style.setProperty('--opacity-block-height', obHeight + 'px');

  let h = obHeight;
  // #categories／#multiCategories 只會有一個在目前這個模式下顯示，
  // 隱藏那份的高度量出來是 0，直接加總即可。
  document.querySelectorAll('#categories > .country-filter, #multiCategories > .country-filter').forEach(el=>{
    const r = el.getBoundingClientRect();
    if(r.height > 0) h += Math.ceil(r.height);
  });
  document.documentElement.style.setProperty('--sticky-offset', h + 'px');
}

/* ---------------------------------------------------------
   側邊欄可摺疊區塊（.side-section / .side-section-head / .side-section-body）
   通用 toggle 邏輯：跟 .source-head／.category-head 的手風琴各自獨立，
   這裡包的是整個功能區塊（目前只剩「地圖模式」#modeSection 還在用這套
   摺疊語彙），互不影響、可以同時展開多個。
--------------------------------------------------------- */
function initCollapsibleSections(){
  document.querySelectorAll('.side-section-head').forEach(head => {
    head.addEventListener('click', () => {
      const section = head.closest('.side-section');
      if(!section) return;
      section.classList.toggle('open');
      updateStickyOffset();
    });
  });
}

/* ---------------------------------------------------------
   「圖資／收藏／最近使用」分頁：同一時間只顯示一個 .sidebar-tab-panel，
   純粹切換 active class／hidden attribute，不清除任何既有狀態（不重置
   已展開的來源分類、不重新整理清單）。切換後重新量測一次 --sticky-offset：
   切走「圖資」分頁時 #categories 內的 .country-filter 因祖先 hidden 而
   量到高度 0，切回來時要重新量測才會恢復正確的吸附偏移量。
--------------------------------------------------------- */
function initSidebarTabs(){
  const bar = document.getElementById('sidebarTabBar');
  if(!bar) return;
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('.sidebar-tab-btn');
    if(!btn) return;
    const tab = btn.dataset.tab;
    document.querySelectorAll('.sidebar-tab-btn').forEach(b => {
      const active = b === btn;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('.sidebar-tab-panel').forEach(panel => {
      panel.hidden = panel.dataset.tabPanel !== tab;
    });
    updateStickyOffset();
  });
}

/* ---------------------------------------------------------
   「目前圖層」名稱與收藏星號：訂閱 store，activeOverlayKey／
   favoriteLayers 改變時同步畫面。
--------------------------------------------------------- */
function renderCurrentLayer(){
  const nameEl = document.getElementById('currentLayerName');
  const favBtn = document.getElementById('currentLayerFavBtn');
  const opacityBlockEl = document.getElementById('opacityBlock');
  if(!nameEl || !favBtn) return;
  const key = store.activeOverlayKey;
  const title = key ? titleForKey(key) : '';
  nameEl.textContent = key ? title : '尚未選取圖層';
  nameEl.title = title;
  // #opacityBlock 只顯示透明度／收藏星號（右側的圖示），不顯示圖層
  // 名稱本身（.current-layer-name 已用 hidden 屬性隱藏），改把名稱掛在
  // 整個區塊的 title 屬性上，滑鼠移過去仍看得到完整名稱。
  if(opacityBlockEl) opacityBlockEl.title = title;
  favBtn.hidden = !key;
  const fav = key ? isFavoriteLayer(key) : false;
  setFavIconState(favBtn, fav);
  favBtn.classList.toggle('active', fav);

  // 手機版「目前圖層」浮動列（#floatingOpacity 內的 .floating-layer-name，
  // 見 style.css Mobile Responsive Layout／src/ui/mobileLayout.js）跟桌面版
  // 側邊欄共用同一份 activeOverlayKey，這裡只是多同步一個文字節點跟
  // 顯示與否的 class，不是另一套圖層邏輯。桌面版此 class 恆為 CSS 隱藏，不受影響。
  const floatingNameEl = document.getElementById('floatingLayerName');
  const floatingOpacityEl = document.getElementById('floatingOpacity');
  if(floatingNameEl){
    floatingNameEl.textContent = title;
    floatingNameEl.title = title;
  }
  if(floatingOpacityEl){
    floatingOpacityEl.classList.toggle('has-layer', !!key);
    floatingOpacityEl.title = title; // 桌面版名稱隱藏，滑鼠移過去用 title 看完整名稱
  }

  // 手機版 #opacityBlock 整條隱藏（見 style.css），收藏功能唯一入口
  // 改成浮動列裡的 #floatingLayerFavBtn，跟 #currentLayerFavBtn 同步同一份
  // 收藏狀態，桌面版此按鈕恆為 CSS 隱藏，不受影響。
  const floatingFavBtn = document.getElementById('floatingLayerFavBtn');
  if(floatingFavBtn){
    floatingFavBtn.hidden = !key;
    setFavIconState(floatingFavBtn, fav);
    floatingFavBtn.classList.toggle('active', fav);
  }
}

// 收藏星號按鈕內是 <svg class="ui-icon"><use href="...#favorite-outline"></use></svg>，
// 切換收藏狀態改成切換 <use> 的 href（實心 #favorite／空心 #favorite-outline），
// 不能再用 textContent 賦值（會把整個 <svg> 節點清空)。
function setFavIconState(btn, fav){
  const use = btn.querySelector('use');
  if(!use) return;
  const symbol = fav ? 'favorite' : 'favorite-outline';
  use.setAttribute('href', `./assets/map-emoji-style-a-icons.svg#${symbol}`);
}

function initCurrentLayerFavButton(){
  const favBtn = document.getElementById('currentLayerFavBtn');
  const floatingFavBtn = document.getElementById('floatingLayerFavBtn');
  const toggle = () => { if(store.activeOverlayKey) toggleFavoriteLayer(store.activeOverlayKey); };
  favBtn?.addEventListener('click', toggle);
  floatingFavBtn?.addEventListener('click', toggle);
}

function initRecentClearButton(){
  const clearBtn = document.getElementById('recentClearBtn');
  if(!clearBtn) return;
  clearBtn.addEventListener('click', () => clearRecentLayers());
}

// 收藏／最近使用清單共用的套用邏輯：非複合疊圖模式下沿用主清單點擊的
// selectOverlayLayer()，若目前不在疊圖模式則先切過去，讓套用結果能
// 立刻在地圖上看到（比照 features/search.js 的 activateFromSearch()）。
function applyLayerFromList(key){
  if(store.mode !== 'overlay') setMode('overlay');
  selectOverlayLayer(key);
}

function renderFavoritesList(){
  const listEl = document.getElementById('favoritesList');
  if(!listEl) return;
  // 分頁標籤上的收藏數量小圓點徽章（「最近使用」分頁不需要對應徽章）。
  const badge = document.getElementById('favoritesTabBadge');
  if(badge){
    const count = store.favoriteLayers.length;
    badge.textContent = String(count);
    badge.hidden = count === 0;
  }
  listEl.innerHTML = '';
  if(store.favoriteLayers.length === 0){
    const empty = document.createElement('div');
    empty.className = 'favorites-empty';
    empty.textContent = '尚未收藏任何圖資';
    listEl.appendChild(empty);
    return;
  }
  store.favoriteLayers.forEach(key => {
    const resolved = resolveOverlayKey(key);
    if(!resolved) return; // 圖資後續被移除，直接跳過不渲染
    const { src, layer } = resolved;
    const item = document.createElement('div');
    item.className = 'favorites-item';

    const info = document.createElement('div');
    info.className = 'favorites-item-info';
    const title = document.createElement('div');
    title.className = 'favorites-item-title';
    title.textContent = layer.title;
    const meta = document.createElement('div');
    meta.className = 'favorites-item-meta';
    meta.textContent = `${layer.year || '年代不明'} · ${src.name}`;
    info.appendChild(title);
    info.appendChild(meta);
    info.addEventListener('click', () => applyLayerFromList(key));

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'favorites-item-remove';
    removeBtn.title = '取消收藏';
    removeBtn.innerHTML = '<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#favorite"></use></svg>';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFavoriteLayer(key);
    });

    item.appendChild(info);
    item.appendChild(removeBtn);
    listEl.appendChild(item);
  });
}

function renderRecentList(){
  const listEl = document.getElementById('recentList');
  if(!listEl) return;
  const clearBtn = document.getElementById('recentClearBtn');
  if(clearBtn) clearBtn.hidden = store.recentLayers.length === 0;
  listEl.innerHTML = '';
  if(store.recentLayers.length === 0){
    const empty = document.createElement('div');
    empty.className = 'recent-empty';
    empty.textContent = '尚未有使用紀錄';
    listEl.appendChild(empty);
    return;
  }
  store.recentLayers.forEach(key => {
    const resolved = resolveOverlayKey(key);
    if(!resolved) return;
    const { src, layer } = resolved;
    const item = document.createElement('div');
    item.className = 'recent-item';

    const info = document.createElement('div');
    info.className = 'recent-item-info';
    const title = document.createElement('div');
    title.className = 'recent-item-title';
    title.textContent = layer.title;
    const meta = document.createElement('div');
    meta.className = 'recent-item-meta';
    meta.textContent = `${layer.year || '年代不明'} · ${src.name}`;
    info.appendChild(title);
    info.appendChild(meta);

    item.appendChild(info);
    item.addEventListener('click', () => applyLayerFromList(key));
    listEl.appendChild(item);
  });
}

// 建立單一來源的「分類→次分類→圖層」手風琴區塊（source-head 展開/收合、
// flyToSourceExtent、buildCategoryList），只建立、不 append、不 push 進
// sourceWraps，交由呼叫端決定要放進哪個容器。桌機的 renderSourceAccordion()
// 跟手機版「台灣」「中國」分頁三段式瀏覽（src/ui/mobileTwBrowse.js／
// src/ui/mobileCnBrowse.js 的 buildMobileTwBrowseUI()／buildMobileCnBrowseUI()
// 第二參數）共用同一份邏輯，各自呼叫會各自建立獨立的 DOM 節點，不會
// 互相搶節點或需要同步展開狀態。
function buildSourceGroup(src){
  const srcWrap = document.createElement('div');
  srcWrap.className = 'source-group';

  const srcHead = document.createElement('button');
  srcHead.type = 'button';
  srcHead.className = 'source-head';
  const total = layerCountForSource(src);
  srcHead.innerHTML = `<span><span class="chevron">▸</span>${src.name}</span><span class="count">${total}</span>`;
  srcHead.addEventListener('click', ()=>{
    const opening = !srcWrap.classList.contains('open');
    if(opening){
      // 手風琴行為：展開這個來源時，先收合其他已展開的來源，
      // 一次只保留一個最大階層是開啟的狀態。
      const container = srcWrap.parentElement;
      if(container){
        container.querySelectorAll('.source-group.open').forEach(g=>{
          if(g !== srcWrap) g.classList.remove('open');
        });
      }
    }
    srcWrap.classList.toggle('open');
    if(opening){
      flyToSourceExtent(src.id);
      // 展開後自動捲動，讓來源標題貼齊側邊欄可視範圍頂端
      // （已透過 .source-head 的 scroll-margin-top 自動避開吸附的透明度區塊）。
      srcHead.scrollIntoView({ behavior:'smooth', block:'start' });
    }
  });

  const srcBody = document.createElement('div');
  srcBody.className = 'source-body';
  buildCategoryList(src.categories, srcBody, (layer) => selectOverlayLayer(layerKey(src, layer)), false, true,
    FLY_TO_CATEGORY_SOURCE_IDS.has(src.id) ? (cat) => flyToCategoryExtent(cat) : null);

  srcWrap.appendChild(srcHead);
  srcWrap.appendChild(srcBody);
  return srcWrap;
}

// 原本 initSidebar() 內建立「來源(機構)→分類→次分類→圖層」手風琴的邏輯，
// 抽成獨立函式：桌機所有分頁都還是要顯示這份手風琴（手機版「台灣」
// 「中國」「其他」分頁改顯示 MOBILE_BROWSE_CONFIGS 對應的替代瀏覽方式，
// 見 syncMobileBrowseView()），內容邏輯本身不變；這份手風琴的 DOM 節點
// 也是替代瀏覽方式第二層 buildSourceGroup() 呼叫的同一支函式（各自重新
// 建立獨立實例，不共用節點）。
// 桌機清單原本直接照 DATA.LAYER_SOURCES 的順序畫——那個順序是
// data/layers.bundle.json 收錄來源的順序（大致等於新增圖層的時間先後），
// 跟地理或字母都無關，24 個台灣來源要捲很久才找得到。這裡重用手機版
// mobileTwBrowse.js 已經跟使用者確認過的 MACRO_REGION_MAP／
// MACRO_REGION_ORDER（北→中→南→東→離島）幫台灣來源排序，但刻意只排
// 序、不畫分類標題或加新的一層點擊；中國／其他分頁來源數少，維持原順
// 序不處理。
// 實作刻意不用「整體 sort、非台灣比較回傳 0」這種寫法：DATA.LAYER_SOURCES
// 裡台灣來源不保證彼此相鄰（曾實測發現確實有幾筆穿插在其他國家來源之間），
// 那種寫法的穩定排序只能保留「跟非台灣來源」的相對順序，台灣來源仍會卡在
// 原本分散的位置動不了。改成：先把台灣來源單獨取出依區域排序，再依序把
// 排好的結果一個個放回原本「是台灣來源」的那些位置——非台灣來源的位置
// 完全不動，台灣來源不管原本多分散，讀出來的相對順序都會是排序後的結果。
function sortedLayerSources(){
  const sortedTw = DATA.LAYER_SOURCES
    .filter(src => src.country === 'tw')
    .map(src => ({ src, rank: MACRO_REGION_ORDER.indexOf(macroRegionForSource(src)) }))
    .sort((a, b) => (a.rank < 0 ? MACRO_REGION_ORDER.length : a.rank) - (b.rank < 0 ? MACRO_REGION_ORDER.length : b.rank))
    .map(entry => entry.src);
  let twIdx = 0;
  return DATA.LAYER_SOURCES.map(src => src.country === 'tw' ? sortedTw[twIdx++] : src);
}

function renderSourceAccordion(categoriesEl, sourceWraps){
  sortedLayerSources().forEach((src) => {
    const srcWrap = buildSourceGroup(src);
    categoriesEl.appendChild(srcWrap);
    sourceWraps.push({ src, wrap: srcWrap });
  });
}

// 手機版「台灣」「中國」「其他」分頁替代瀏覽方式的設定清單：以後要加
// 新分頁，只需要在這裡加一筆 { country, build }，initSidebar() 內的建立／
// 顯示切換邏輯都是依這份清單跑迴圈，不用再另外寫一份平行分支。
const MOBILE_BROWSE_CONFIGS = [
  { country: 'tw', build: buildMobileTwBrowseUI },
  { country: 'cn', build: buildMobileCnBrowseUI },
  { country: 'other', build: buildMobileOtherBrowseUI }
];

export function initSidebar(){
  const categoriesEl = document.getElementById('categories');

  window.addEventListener('resize', updateStickyOffset);
  window.addEventListener('load', updateStickyOffset);

  const sourceWraps = []; // [{ src, wrap }]，篩選列用來知道要顯示／隱藏哪些來源

  // syncMobileBrowseView() 要在 createCountryFilterBar() 的 onChange 裡呼叫，
  // 但 mobileBrowseEntries 要等 renderSourceAccordion() 之後、MOBILE_BROWSE_CONFIGS
  // 逐一建立完才會填入內容，用可以延後填入的陣列承接，避免跟
  // createCountryFilterBar() 互相依賴的宣告順序問題。
  const mobileBrowseEntries = []; // [{ country, el }]
  function syncMobileBrowseView(){
    if(mobileBrowseEntries.length === 0) return;
    const current = getCurrentCountry();
    mobileBrowseEntries.forEach(({ country, el }) => {
      const show = mq.matches && current === country;
      el.hidden = !show;
      sourceWraps.forEach(({ src, wrap }) => {
        if(src.country === country) wrap.classList.toggle('mobile-tw-accordion-hidden', show);
      });
    });
  }

  const { bar: filterBar, refresh: refreshCountryFilter, getCurrent: getCurrentCountry } =
    createCountryFilterBar(() => sourceWraps, () => syncMobileBrowseView());
  categoriesEl.appendChild(filterBar);

  renderSourceAccordion(categoriesEl, sourceWraps);

  MOBILE_BROWSE_CONFIGS.forEach(({ country, build }) => {
    const sources = DATA.LAYER_SOURCES.filter(s => s.country === country);
    const el = build(sources, buildSourceGroup);
    categoriesEl.appendChild(el);
    mobileBrowseEntries.push({ country, el });
  });

  refreshCountryFilter();
  updateStickyOffset();
  syncMobileBrowseView(); // 初始化同步：onChange 只在使用者「切換」分頁時觸發，這裡補一次

  // 跨越 768px 門檻時（即使沒有切換國家分頁）也要重新同步顯示狀態，
  // 比照 src/ui/mobileLayout.js 監聽 matchMedia 變化的既有寫法。
  // mq.addListener 是刻意保留給不支援 addEventListener 的舊版 Safari 的 fallback，SonarQube 的棄用警告可以忽略
  if(mq.addEventListener) mq.addEventListener('change', syncMobileBrowseView);
  else mq.addListener(syncMobileBrowseView);

  initCollapsibleSections();
  initSidebarTabs();
  initCurrentLayerFavButton();
  initRecentClearButton();

  renderCurrentLayer();
  renderFavoritesList();
  renderRecentList();

  subscribe((state, prevState, changedKeys) => {
    if(changedKeys.includes('activeOverlayKey') || changedKeys.includes('favoriteLayers')){
      renderCurrentLayer();
    }
    if(changedKeys.includes('favoriteLayers')){
      renderFavoritesList();
    }
    if(changedKeys.includes('recentLayers')){
      renderRecentList();
    }
  });
}
