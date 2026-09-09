/* ---------------------------------------------------------
   sidebarUI.js — 側邊欄：WMTS 圖資來源 → 分類(→ 堡等次分類) → 圖層
   手風琴建置
--------------------------------------------------------- */
import { DATA, layerKey, titleForKey, resolveOverlayKey } from './data.js';
import { buildCategoryList } from './uiTree.js';
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
import { buildMobileTwBrowseUI } from './ui/mobileTwBrowse.js';
import { buildMobileCnBrowseUI } from './ui/mobileCnBrowse.js';

// 手機版（<=768px）「台灣」「中國」分頁改用大區域→地區→來源手風琴
// 瀏覽（分別是 src/ui/mobileTwBrowse.js／src/ui/mobileCnBrowse.js），
// 取代原本的來源手風琴；桌機／其他分頁不受影響，一律靠這個
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
   這裡包的是整個功能區塊（地圖模式／圖資／目前圖層…），互不影響、
   可以同時展開多個。
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
   「目前圖層」名稱與收藏星號：訂閱 store，activeOverlayKey／
   favoriteLayers 改變時同步畫面。
--------------------------------------------------------- */
function renderCurrentLayer(){
  const nameEl = document.getElementById('currentLayerName');
  const favBtn = document.getElementById('currentLayerFavBtn');
  if(!nameEl || !favBtn) return;
  const key = store.activeOverlayKey;
  nameEl.textContent = key ? titleForKey(key) : '尚未選取圖層';
  favBtn.hidden = !key;
  const fav = key ? isFavoriteLayer(key) : false;
  favBtn.textContent = fav ? '★' : '☆';
  favBtn.classList.toggle('active', fav);

  // 手機版「目前圖層」浮動列（#floatingOpacity 內的 .floating-layer-name，
  // 見 style.css Mobile Responsive Layout／src/ui/mobileLayout.js）跟桌面版
  // 側邊欄共用同一份 activeOverlayKey，這裡只是多同步一個文字節點跟
  // 顯示與否的 class，不是另一套圖層邏輯。桌面版此 class 恆為 CSS 隱藏，不受影響。
  const floatingNameEl = document.getElementById('floatingLayerName');
  const floatingOpacityEl = document.getElementById('floatingOpacity');
  if(floatingNameEl) floatingNameEl.textContent = key ? titleForKey(key) : '';
  if(floatingOpacityEl) floatingOpacityEl.classList.toggle('has-layer', !!key);

  // 手機版 #opacityBlock 整條隱藏（見 style.css），收藏功能唯一入口
  // 改成浮動列裡的 #floatingLayerFavBtn，跟 #currentLayerFavBtn 同步同一份
  // 收藏狀態，桌面版此按鈕恆為 CSS 隱藏，不受影響。
  const floatingFavBtn = document.getElementById('floatingLayerFavBtn');
  if(floatingFavBtn){
    floatingFavBtn.hidden = !key;
    floatingFavBtn.textContent = fav ? '★' : '☆';
    floatingFavBtn.classList.toggle('active', fav);
  }
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
    removeBtn.textContent = '★';
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
  const total = src.categories.reduce((s,c)=> s + (c.groups ? c.groups.reduce((gs,g)=>gs+g.layers.length,0) : c.layers.length), 0);
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
// 抽成獨立函式：桌機所有分頁、以及手機版「其他」分頁都還是要顯示這份
// 手風琴，只有手機版「台灣」「中國」分頁改顯示三段式瀏覽（見
// syncMobileBrowseView()），內容邏輯本身不變。
function renderSourceAccordion(categoriesEl, sourceWraps){
  DATA.LAYER_SOURCES.forEach((src) => {
    const srcWrap = buildSourceGroup(src);
    categoriesEl.appendChild(srcWrap);
    sourceWraps.push({ src, wrap: srcWrap });
  });
}

export function initSidebar(){
  const categoriesEl = document.getElementById('categories');

  window.addEventListener('resize', updateStickyOffset);
  window.addEventListener('load', updateStickyOffset);

  const sourceWraps = []; // [{ src, wrap }]，篩選列用來知道要顯示／隱藏哪些來源

  // syncMobileBrowseView() 要在 createCountryFilterBar() 的 onChange 裡呼叫，
  // 但 mobileTwBrowseEl／mobileCnBrowseEl 要等 renderSourceAccordion() 之後
  // 才會建立，用可以延後綁定的變數承接，避免兩者互相依賴的宣告順序問題。
  let mobileTwBrowseEl = null;
  let mobileCnBrowseEl = null;
  function syncMobileBrowseView(){
    if(!mobileTwBrowseEl && !mobileCnBrowseEl) return;
    const current = getCurrentCountry();
    const showMobileTw = mq.matches && current === 'tw';
    const showMobileCn = mq.matches && current === 'cn';
    if(mobileTwBrowseEl) mobileTwBrowseEl.hidden = !showMobileTw;
    if(mobileCnBrowseEl) mobileCnBrowseEl.hidden = !showMobileCn;
    sourceWraps.forEach(({ src, wrap }) => {
      if(src.country === 'tw') wrap.classList.toggle('mobile-tw-accordion-hidden', showMobileTw);
      if(src.country === 'cn') wrap.classList.toggle('mobile-tw-accordion-hidden', showMobileCn);
    });
  }

  const { bar: filterBar, refresh: refreshCountryFilter, getCurrent: getCurrentCountry } =
    createCountryFilterBar(() => sourceWraps, () => syncMobileBrowseView());
  categoriesEl.appendChild(filterBar);

  renderSourceAccordion(categoriesEl, sourceWraps);

  const twSources = DATA.LAYER_SOURCES.filter(s => s.country === 'tw');
  mobileTwBrowseEl = buildMobileTwBrowseUI(twSources, buildSourceGroup);
  categoriesEl.appendChild(mobileTwBrowseEl);

  const cnSources = DATA.LAYER_SOURCES.filter(s => s.country === 'cn');
  mobileCnBrowseEl = buildMobileCnBrowseUI(cnSources, buildSourceGroup);
  categoriesEl.appendChild(mobileCnBrowseEl);

  refreshCountryFilter();
  updateStickyOffset();
  syncMobileBrowseView(); // 初始化同步：onChange 只在使用者「切換」分頁時觸發，這裡補一次

  // 跨越 768px 門檻時（即使沒有切換國家分頁）也要重新同步顯示狀態，
  // 比照 src/ui/mobileLayout.js 監聽 matchMedia 變化的既有寫法。
  // mq.addListener 是刻意保留給不支援 addEventListener 的舊版 Safari 的 fallback，SonarQube 的棄用警告可以忽略
  if(mq.addEventListener) mq.addEventListener('change', syncMobileBrowseView);
  else mq.addListener(syncMobileBrowseView);

  initCollapsibleSections();
  initCurrentLayerFavButton();
  initRecentClearButton();

  renderCurrentLayer();
  renderFavoritesList();
  renderRecentList();

  subscribe((state, prevState, changedKeys) => {
    if(changedKeys.includes('activeOverlayKey') || changedKeys.includes('favoriteLayers')){
      renderCurrentLayer();
    }
    // 點圖資選到新的一層時，就算使用者之前手動收合過「目前圖層」，
    // 也自動展開讓他看得到剛選到什麼，不用再手動點開。
    if(changedKeys.includes('activeOverlayKey') && state.activeOverlayKey){
      const opacityBlock = document.getElementById('opacityBlock');
      if(opacityBlock && !opacityBlock.classList.contains('open')){
        opacityBlock.classList.add('open');
        updateStickyOffset();
      }
    }
    if(changedKeys.includes('favoriteLayers')){
      renderFavoritesList();
    }
    if(changedKeys.includes('recentLayers')){
      renderRecentList();
    }
  });
}
