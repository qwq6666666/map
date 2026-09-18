/* ---------------------------------------------------------
   ui/availableLayers.js — 搜尋結果「可用圖層」面板
   ---------------------------------------------------------
   從 ui/search.js 拆出來的結果面板渲染：依搜尋到的可用圖層建立
   分類瀏覽檢視，以及「自訂時間軸多選模式」（浮動操作列的全選／清除／
   確認建立）。只認得 #layerAvailPanel 與 #searchBatch* 這組 DOM，不碰
   地址輸入框或地名卡片；何時該重畫、何時該清空仍由 ui/search.js 決定。

   多選模式用 4 個跨 render 生命週期的函式指標（exitSelectionModeFn 等）：
   renderAvailableLayers() 每次新搜尋都會重新建立區域變數，但「輸入框
   打字」「按清除」「浮動操作列按鈕」這幾個只綁一次事件的 handler 拿不到
   最新一次 render 的 closure，所以由這裡的模組頂層指標轉接；沒有進行中的
   多選 session 時就是 null，一律用 ?.() 呼叫。
--------------------------------------------------------- */
import { buildCategoryList, appendLayerList, buildAccordionHeadContent } from '../uiTree.js';
import { syncActiveLayerItemClasses } from '../core/layerManager.js';
import { activateFromSearch, sortAvailableByYear, groupAvailableByType, splitAvailableByYearKnown } from '../features/search.js';
import { layerKey } from '../data.js';
import { createCustomTimelineFromSelection, previewLayerOnMap, clearPreviewLayer } from '../features/customTimeline.js';

let layerAvailPanelEl, searchBatchBarEl, searchBatchCountEl, searchBatchConfirmBtn;
let exitSelectionModeFn = null;
let selectAllFn = null;
let clearSelectionFn = null;
let confirmCustomTimelineFn = null;

// 取得面板／浮動操作列 DOM 並綁定操作列按鈕，由 ui/search.js 的 initSearchUI() 呼叫一次。
export function initAvailableLayers(){
  layerAvailPanelEl = document.getElementById('layerAvailPanel');
  searchBatchBarEl = document.getElementById('searchBatchBar');
  searchBatchCountEl = document.getElementById('searchBatchCount');
  searchBatchConfirmBtn = document.getElementById('searchBatchConfirmBtn');
  const searchBatchSelectAllBtn = document.getElementById('searchBatchSelectAllBtn');
  const searchBatchClearBtn = document.getElementById('searchBatchClearBtn');
  searchBatchSelectAllBtn.addEventListener('click', ()=> selectAllFn?.());
  searchBatchClearBtn.addEventListener('click', ()=> clearSelectionFn?.());
  searchBatchConfirmBtn.addEventListener('click', ()=> confirmCustomTimelineFn?.());
}

// 離開多選模式（沒有進行中的 session 時不做事）。地址輸入框一有輸入就會呼叫。
export function exitSelectionMode(){
  exitSelectionModeFn?.();
}

// 離開多選模式並清掉所有指標，避免殘留上一輪 render 的 closure。
export function endSelectionSession(){
  exitSelectionModeFn?.();
  exitSelectionModeFn = null;
  selectAllFn = null;
  clearSelectionFn = null;
  confirmCustomTimelineFn = null;
}

// 清空結果面板與多選浮動操作列（DOM 層級，不含指標重設，見 endSelectionSession）。
export function clearAvailableLayersPanel(){
  layerAvailPanelEl.innerHTML = '';
  layerAvailPanelEl.classList.remove('selection-mode');
  searchBatchBarEl?.classList.remove('show');
}

// 篩選單一 group 底下「目前可用」的圖層；從 renderAllView() 的巢狀
// map/filter 中抽出，降低巢狀層數。
function filterGroupLayers(g, availableIdSet){
  return { ...g, layers: g.layers.filter(ly => availableIdSet.has(ly.id)) };
}

// 篩選單一分類（含次分類 groups）底下「目前可用」的圖層，回傳篩後的
// 分類物件，若該分類篩完沒有任何圖層則回傳 null。同樣是從 renderAllView()
// 抽出的獨立函式，供 renderAllView() 的 .map(cat=>...) 呼叫。
function filterCategoryForAvailable(cat, availableIdSet){
  if(cat.groups){
    const groups = cat.groups
      .map(g => filterGroupLayers(g, availableIdSet))
      .filter(g => g.layers.length > 0);
    return groups.length ? { ...cat, groups } : null;
  }
  const layers = cat.layers.filter(ly => availableIdSet.has(ly.id));
  return layers.length ? { ...cat, layers } : null;
}

export function renderAvailableLayers(available, totalChecked){
  // 每次重新搜尋都是全新一輪 render，不延續上一輪的多選 session。
  exitSelectionModeFn = null;
  selectAllFn = null;
  clearSelectionFn = null;
  confirmCustomTimelineFn = null;
  layerAvailPanelEl.classList.remove('selection-mode');
  searchBatchBarEl?.classList.remove('show');
  // 避免上一輪搜尋若沒有正常經過 exitSelectionMode() 就跳下一輪搜尋，
  // 殘留一張瞬態預覽圖層卡在地圖上。
  clearPreviewLayer();

  layerAvailPanelEl.innerHTML = '';
  if(available.length === 0){
    const empty = document.createElement('p');
    empty.className = 'avail-empty';
    empty.textContent = `已確認 ${totalChecked} 筆相關圖層，此地點目前沒有找到有資料的歷史地圖圖層。可能是這個地點在該圖資範圍之外，或該圖資此區塊尚未建置資料。`;
    layerAvailPanelEl.appendChild(empty);
    return;
  }

  const summaryRow = document.createElement('div');
  summaryRow.className = 'avail-summary-row';
  layerAvailPanelEl.appendChild(summaryRow);

  const summary = document.createElement('p');
  summary.className = 'avail-empty';
  summary.textContent = `此地點目前可套疊 ${available.length} 筆歷史地圖圖層（已逐筆確認有資料）：`;
  summaryRow.appendChild(summary);

  const multiSelectBtn = document.createElement('button');
  multiSelectBtn.type = 'button';
  multiSelectBtn.className = 'avail-multiselect-btn';
  multiSelectBtn.textContent = '＋ 自訂時間軸 (多選)';
  summaryRow.appendChild(multiSelectBtn);

  // 「全部／類型／年代」頁籤列：純前端在已取得的 available 陣列上重新
  // 分組／排序、切換要顯示哪種瀏覽方式，不重新呼叫 findAvailableLayersAt、
  // 不觸發任何新的網路請求，只重畫 contentEl。
  const tabsEl = document.createElement('div');
  tabsEl.className = 'avail-tabs';
  layerAvailPanelEl.appendChild(tabsEl);

  const contentEl = document.createElement('div');
  layerAvailPanelEl.appendChild(contentEl);

  let currentTab = 'all'; // 'all' | 'type' | 'year'
  let yearSortDirection = 'desc'; // 'desc'新到舊(預設) / 'asc'舊到新，只在「年代」頁籤內使用

  // 自訂時間軸多選模式狀態：只作用於這次搜尋命中的 available 清單，
  // 跟「全部／類型／年代」三個既有頁籤各自獨立，互不影響。
  let selectionMode = false;
  const selectedKeys = new Set();
  // 多選模式下「點卡片內容」觸發的地圖瞬態預覽，跟 checkbox 勾選狀態
  // 完全分開：checkbox 只管要不要納入自訂時間軸，這裡記錄目前正在
  // 地圖上預覽哪一筆，重繪清單（refreshSelectionList）時要跨重繪保留。
  let previewedKey = null;

  const TAB_DEFS = [['all', '全部'], ['type', '類型'], ['year', '年代']];
  const tabButtons = new Map();
  TAB_DEFS.forEach(([key, label])=>{
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'avail-tab-btn';
    btn.textContent = label;
    if(key === currentTab) btn.classList.add('active');
    btn.addEventListener('click', ()=>{
      if(currentTab === key) return;
      currentTab = key;
      tabButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderTabContent();
    });
    tabButtons.set(key, btn);
    tabsEl.appendChild(btn);
  });

  // 三個頁籤共用的「可收合區塊」：標題列沿用主清單既有的
  // source-group/source-head/chevron/count 這套視覺語彙，維持整個
  // 搜尋結果面板一致的手風琴外觀。buildBody(bodyEl) 負責把內容畫進區塊主體。
  function buildAccordionBlock(container, label, count, buildBody, openInitially){
    const wrap = document.createElement('div');
    wrap.className = 'source-group';
    if(openInitially) wrap.classList.add('open');

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'source-head';
    buildAccordionHeadContent(head, label, count);
    head.addEventListener('click', ()=> wrap.classList.toggle('open'));

    const body = document.createElement('div');
    body.className = 'source-body';
    buildBody(body);

    wrap.appendChild(head);
    wrap.appendChild(body);
    container.appendChild(wrap);
    return wrap;
  }

  // 【全部】頁籤：依「來源 → 分類 →（次分類 →）圖層」重建可用圖層的巢狀結構，
  // 沿用主清單同一套 source-group/category 手風琴樣式與 buildCategoryList()，
  // 讓搜尋結果維持原本的分類方式，可以逐層摺疊／展開，而不是攤平成一長串清單。
  function renderAllView(){
    const availableIdSet = new Set(available.map(c => c.layer.id));
    const order = [];
    const seenSrc = {};
    available.forEach(c=>{
      if(!seenSrc[c.src.id]){ seenSrc[c.src.id] = c.src; order.push(c.src.id); }
    });

    order.forEach(srcId=>{
      const src = seenSrc[srcId];

      const filteredCategories = src.categories
        .map(cat => filterCategoryForAvailable(cat, availableIdSet))
        .filter(Boolean);

      if(filteredCategories.length === 0) return;

      const total = filteredCategories.reduce((s,c)=> s + (c.groups ? c.groups.reduce((gs,g)=>gs+g.layers.length,0) : c.layers.length), 0);

      buildAccordionBlock(contentEl, src.name, total, (srcBody)=>{
        buildCategoryList(filteredCategories, srcBody, (layer)=> activateFromSearch(src, layer), false);
      }, false); // 預設收合，行為與主清單一致，改由使用者點擊來源才展開
    });
  }

  // 【類型】頁籤：依 SEARCH_RESULT_TYPES 分組（地形圖／地籍圖／海圖／
  // 行政區劃圖／其他，見 features/search.js），跳過空群組，每組攤平列出
  // 圖層（不再依來源／分類巢狀，因為使用者是依類型瀏覽，不是依來源瀏覽），
  // 第一個非空群組預設展開。
  function renderTypeView(){
    const groups = groupAvailableByType(available).filter(g => g.items.length > 0);
    groups.forEach((g, idx)=>{
      const srcById = new Map(g.items.map(item => [item.layer.id, item.src]));
      buildAccordionBlock(contentEl, g.type, g.items.length, (body)=>{
        body.classList.add('avail-layer-list');
        appendLayerList(body, g.items.map(item => item.layer), (layer)=>{
          activateFromSearch(srcById.get(layer.id), layer);
        });
      }, idx === 0);
    });
  }

  // 【年代】頁籤：年代已知的圖層依 yearSortDirection 排序後攤平列出；
  // 年代不明的圖層收在最下方一個預設收合的區塊裡，維持原始順序。
  function renderYearView(){
    const { known, unknown } = splitAvailableByYearKnown(available);

    const sortRow = document.createElement('div');
    sortRow.className = 'avail-year-sort';
    [['desc', '年代（新至舊）'], ['asc', '年代（舊至新）']].forEach(([key, label])=>{
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'avail-year-sort-btn';
      btn.textContent = label;
      if(key === yearSortDirection) btn.classList.add('active');
      btn.addEventListener('click', ()=>{
        if(yearSortDirection === key) return;
        yearSortDirection = key;
        renderTabContent();
      });
      sortRow.appendChild(btn);
    });
    contentEl.appendChild(sortRow);

    const sorted = sortAvailableByYear(known, yearSortDirection);
    const sortedSrcById = new Map(sorted.map(item => [item.layer.id, item.src]));
    const listWrap = document.createElement('div');
    listWrap.className = 'avail-layer-list';
    appendLayerList(listWrap, sorted.map(item => item.layer), (layer)=>{
      activateFromSearch(sortedSrcById.get(layer.id), layer);
    });
    contentEl.appendChild(listWrap);

    if(unknown.length > 0){
      const unknownSrcById = new Map(unknown.map(item => [item.layer.id, item.src]));
      buildAccordionBlock(contentEl, '年代不明', unknown.length, (body)=>{
        body.classList.add('avail-layer-list');
        appendLayerList(body, unknown.map(item => item.layer), (layer)=>{
          activateFromSearch(unknownSrcById.get(layer.id), layer);
        });
      }, false); // 預設收合
    }
  }

  // 若目前已有套疊中的歷史圖層，於搜尋結果中同步標示為 active。搜尋結果
  // 面板每次都是重新建立的 DOM，store 的 activeOverlayKey 不會因為重新
  // 搜尋而改變，modeManager 的訂閱者不會被觸發，所以每次重畫 contentEl
  // （不論是切頁籤還是切年代排序方向）都要手動呼叫一次跟主清單共用的
  // 同步函式，補上剛建好的 DOM。
  function renderTabContent(){
    contentEl.innerHTML = '';
    if(currentTab === 'all') renderAllView();
    else if(currentTab === 'type') renderTypeView();
    else renderYearView();
    syncActiveLayerItemClasses();
  }

  // ---------------------------------------------------------------
  // 自訂時間軸多選模式：獨立的扁平卡片清單，完全不透過 uiTree.js 的
  // buildCategoryList/appendLayerList，只在 contentEl 裡渲染，退出時
  // 呼叫既有的 renderTabContent() 換回原本的頁籤檢視。
  // ---------------------------------------------------------------

  function updateBatchBarCount(){
    if(searchBatchCountEl) searchBatchCountEl.textContent = `已選取 ${selectedKeys.size} 筆圖資`;
    if(searchBatchConfirmBtn) searchBatchConfirmBtn.disabled = selectedKeys.size === 0;
  }

  function toggleSelection(key, itemEl, cbEl){
    if(cbEl.checked){ selectedKeys.add(key); itemEl.classList.add('checked'); }
    else { selectedKeys.delete(key); itemEl.classList.remove('checked'); }
    updateBatchBarCount();
  }

  function buildSelectionList(){
    const listEl = document.createElement('div');
    listEl.className = 'avail-select-list';

    available.forEach(c=>{
      const key = layerKey(c.src, c.layer);
      const item = document.createElement('div');
      item.className = 'avail-select-item';
      if(selectedKeys.has(key)) item.classList.add('checked');
      if(previewedKey === key) item.classList.add('is-previewing');

      const cbWrap = document.createElement('span');
      cbWrap.className = 'avail-select-checkbox-wrap';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'avail-select-checkbox';
      cb.checked = selectedKeys.has(key);
      cb.addEventListener('change', ()=> toggleSelection(key, item, cb));
      cbWrap.appendChild(cb);

      const info = document.createElement('div');
      info.className = 'avail-select-info';
      const title = document.createElement('div');
      title.className = 'avail-select-title';
      title.textContent = c.layer.title;
      const meta = document.createElement('div');
      meta.className = 'avail-select-meta';
      meta.textContent = `${c.layer.year || '年代不明'} · ${c.src.name}`;
      info.appendChild(title);
      info.appendChild(meta);

      item.appendChild(cbWrap);
      item.appendChild(info);

      // 點卡片內容（checkbox 以外的區域）改成觸發地圖「瞬態預覽」，
      // 不切換勾選狀態；checkbox 區域交給它自己的 change 事件處理。
      item.addEventListener('click', (e)=>{
        if(e.target === cb || cbWrap.contains(e.target)) return;
        const prev = contentEl.querySelector('.avail-select-item.is-previewing');
        if(prev) prev.classList.remove('is-previewing');
        previewLayerOnMap(c.src, c.layer);
        item.classList.add('is-previewing');
        previewedKey = key;
      });

      listEl.appendChild(item);
    });

    contentEl.appendChild(listEl);
    // checkbox 的「平滑展開」動畫：先以收合寬度插入 DOM，下一影格再加
    // .ready 觸發 CSS transition，避免用 display:none 硬切。
    requestAnimationFrame(()=> listEl.classList.add('ready'));
  }

  function refreshSelectionList(){
    contentEl.innerHTML = '';
    buildSelectionList();
    updateBatchBarCount();
  }

  function enterSelectionMode(){
    selectionMode = true;
    multiSelectBtn.innerHTML = '<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#close"></use></svg> 取消多選';
    layerAvailPanelEl.classList.add('selection-mode');
    tabsEl.style.display = 'none';
    refreshSelectionList();
    searchBatchBarEl?.classList.add('show');
  }

  function exitSelectionMode(){
    clearPreviewLayer();
    previewedKey = null;
    selectionMode = false;
    selectedKeys.clear();
    multiSelectBtn.textContent = '＋ 自訂時間軸 (多選)';
    layerAvailPanelEl.classList.remove('selection-mode');
    tabsEl.style.display = '';
    searchBatchBarEl?.classList.remove('show');
    renderTabContent();
  }

  function selectAllCurrent(){
    if(!selectionMode) return;
    available.forEach(c => selectedKeys.add(layerKey(c.src, c.layer)));
    refreshSelectionList();
  }

  function clearCurrentSelection(){
    if(!selectionMode) return;
    selectedKeys.clear();
    refreshSelectionList();
  }

  function confirmCustomTimeline(){
    if(!selectionMode || selectedKeys.size === 0) return;
    const selected = available.filter(c => selectedKeys.has(layerKey(c.src, c.layer)));
    exitSelectionMode(); // 一定要先執行，清掉多選期間的瞬態預覽跟多選 UI
    createCustomTimelineFromSelection(selected); // 再開自訂時間軸 dock，dock 會顯示自己的第一張預覽
  }

  multiSelectBtn.addEventListener('click', ()=>{
    if(selectionMode) exitSelectionMode();
    else enterSelectionMode();
  });

  // 供 initSearchUI() 裡只綁一次事件的靜態元素（輸入框、清除按鈕、
  // 浮動操作列按鈕）呼叫，讓它們能操作到「目前這一輪」render 的狀態。
  exitSelectionModeFn = exitSelectionMode;
  selectAllFn = selectAllCurrent;
  clearSelectionFn = clearCurrentSelection;
  confirmCustomTimelineFn = confirmCustomTimeline;

  renderTabContent();
}
