/* ---------------------------------------------------------
   ui/search.js — 地址搜尋介面
   ---------------------------------------------------------
   從 searchUI.js 拆出來的 UI 部分：輸入框、搜尋／定位按鈕、
   建議清單、結果面板（分類瀏覽檢視）。只負責 input／
   button／result list／loading／error message／DOM 更新，實際
   的地理編碼交給 geocode.js，候選來源篩選與逐筆圖磚驗證交給
   features/search.js，這裡不自己做任何 GIS 判斷。

   注意：搜尋結果面板不再提供「時間軸」檢視切換（原本跟「分類瀏覽」
   並列的第二種檢視方式已移除，只保留分類瀏覽）。app 另外還有一個
   獨立的「時間軸模式」（見 timelineMode.js），跟搜尋功能是不同的
   進入點，這裡拿掉的只是搜尋結果面板內部那個切換按鈕，不影響
   timelineMode.js／timelineUI.js 的 buildTimeline()，時間軸模式本身
   仍然正常運作。
--------------------------------------------------------- */
import { runtime } from '../runtime.js';
import { geocodeAddress, reverseGeocode } from '../geocode.js';
import { buildCategoryList, appendLayerList } from '../uiTree.js';
import { map } from '../core/map.js';
import { showLocateToast } from '../features/location.js';
import { syncActiveLayerItemClasses } from '../core/layerManager.js';
import { findAvailableLayersAt, activateFromSearch, bumpSearchToken, isSearchStale, SEARCH_ZOOM, sortAvailableByYear, groupAvailableByType, splitAvailableByYearKnown, buildCoordInfoElement } from '../features/search.js';
import { layerKey } from '../data.js';
import { createCustomTimelineFromSelection, previewLayerOnMap, clearPreviewLayer } from '../features/customTimeline.js';

let addressInput, addressSearchBtn, addressSuggestEl, locationResultEl, locationNameEl,
    layerAvailPanelEl, clearLocationBtn, addressMarkerEl, addressMarkerOverlay, locateSearchBtn,
    searchBatchBarEl, searchBatchCountEl, searchBatchConfirmBtn;

// 搜尋結果面板「自訂時間軸多選模式」用的跨 render 生命週期函式指標。
// renderAvailableLayers() 每次新搜尋都會重新建立區域變數（available／
// tabsEl／contentEl／selectedKeys...），但「輸入框打字」「按清除」
// 「浮動操作列的全選／清除選取／確認建立」這幾個只綁一次事件的
// handler 沒辦法直接拿到最新一次 render 的 closure，所以改成呼叫這幾個
// 模組頂層指標（由 renderAvailableLayers() 內部隨時指到目前這輪的實作），
// 沒有進行中的多選 session 時就是 null，呼叫端一律用 ?.() 呼叫。
let exitSelectionModeFn = null;
let selectAllFn = null;
let clearSelectionFn = null;
let confirmCustomTimelineFn = null;

function showAddressMarker(coord){
  addressMarkerOverlay.setPosition(coord);
  addressMarkerEl.classList.add('show');
}
function hideAddressMarker(){
  addressMarkerOverlay.setPosition(undefined);
  addressMarkerEl.classList.remove('show');
}

function hideSuggest(){
  addressSuggestEl.classList.remove('show');
  addressSuggestEl.innerHTML = '';
}

function renderSuggestList(results){
  addressSuggestEl.innerHTML = '';
  if(!results || results.length === 0){
    const empty = document.createElement('div');
    empty.className = 'address-suggest-empty';
    empty.textContent = '找不到符合的地址，請換個關鍵字試試。';
    addressSuggestEl.appendChild(empty);
    addressSuggestEl.classList.add('show');
    return;
  }
  results.forEach(r=>{
    const item = document.createElement('div');
    item.className = 'address-suggest-item';
    item.textContent = r.display_name;
    item.addEventListener('click', ()=> selectGeocodeResult(r));
    addressSuggestEl.appendChild(item);
  });
  addressSuggestEl.classList.add('show');
}

async function runImmediateSearch(){
  const q = addressInput.value.trim();
  if(!q) return;
  if(runtime.addressDebounceTimer) clearTimeout(runtime.addressDebounceTimer);
  const myToken = bumpSearchToken();
  addressSearchBtn.classList.add('loading');
  try{
    const results = await geocodeAddress(q);
    if(isSearchStale(myToken)) return;
    if(results.length === 1){
      hideSuggest();
      await selectGeocodeResult(results[0]);
    } else {
      renderSuggestList(results);
    }
  }catch(e){
    if(!isSearchStale(myToken)) hideSuggest();
  }finally{
    if(!isSearchStale(myToken)) addressSearchBtn.classList.remove('loading');
  }
}

// 共用流程：把地圖移到指定經緯度、標示圖釘、顯示搜尋結果面板，再逐筆確認可用圖層。
// 地址搜尋（selectGeocodeResult）與定位搜尋（locateSearchBtn）最終都會走到這裡，
// 差別只在座標與地址元件的來源不同（Nominatim 正向地理編碼 vs. 瀏覽器定位+反向地理編碼）。
export async function showLocationAndFindLayers(lon, lat, label, addr){
  const coord = ol.proj.fromLonLat([lon, lat]);
  const view = map.getView();
  view.animate({ center: coord, zoom: Math.max(view.getZoom(), SEARCH_ZOOM), duration: 600 });
  showAddressMarker(coord);

  locationResultEl.style.display = 'block';
  locationNameEl.textContent = label;
  // 每次重新搜尋都要先移除舊的座標資訊區塊，避免重複搜尋時在卡片內堆疊。
  locationResultEl.querySelector('.coord-info')?.remove();
  locationResultEl.appendChild(buildCoordInfoElement(lat, lon));
  await findAndRenderAvailableLayers(lon, lat, addr || {});
}

async function selectGeocodeResult(result){
  hideSuggest();
  addressInput.value = result.display_name;
  const lon = parseFloat(result.lon);
  const lat = parseFloat(result.lat);
  await showLocationAndFindLayers(lon, lat, result.display_name, result.address || {});
}

function getCurrentPositionAsync(){
  return new Promise((resolve, reject)=>{
    if(!navigator.geolocation){
      reject({ message: '您的瀏覽器不支援定位功能。' });
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  });
}

// 呼叫 features/search.js 的搜尋邏輯，並把過程中的進度／結果畫進
// layerAvailPanelEl。這支函式只管「畫面長什麼樣子」，候選來源怎麼
// 篩、圖磚怎麼驗證完全交給 findAvailableLayersAt。
async function findAndRenderAvailableLayers(lon, lat, addr){
  const mySearch = bumpSearchToken();
  layerAvailPanelEl.innerHTML = '';

  const progressEl = document.createElement('div');
  progressEl.className = 'avail-progress';
  let progressInserted = false; // 只有真的有候選來源、開始檢查時才把進度元素插入畫面

  const result = await findAvailableLayersAt(lon, lat, addr, {
    isStale: () => isSearchStale(mySearch),
    onProgress: (text) => {
      if(isSearchStale(mySearch)) return;
      if(!progressInserted){ layerAvailPanelEl.appendChild(progressEl); progressInserted = true; }
      progressEl.textContent = text;
    }
  });

  if(isSearchStale(mySearch)) return; // 使用者已經開始下一次搜尋或清除，捨棄這次結果

  if(result.status === 'no-source'){
    layerAvailPanelEl.innerHTML = '';
    const empty = document.createElement('p');
    empty.className = 'avail-empty';
    empty.textContent = '此地點附近沒有可比對的歷史地圖圖資來源。';
    layerAvailPanelEl.appendChild(empty);
    return;
  }
  if(result.status === 'stale') return;

  renderAvailableLayers(result.available, result.totalChecked);
}

function renderAvailableLayers(available, totalChecked){
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
    head.innerHTML = `<span><span class="chevron">▸</span>${label}</span><span class="count">${count}</span>`;
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

      const filteredCategories = src.categories.map(cat=>{
        if(cat.groups){
          const groups = cat.groups
            .map(g => ({ ...g, layers: g.layers.filter(ly => availableIdSet.has(ly.id)) }))
            .filter(g => g.layers.length > 0);
          return groups.length ? { ...cat, groups } : null;
        }
        const layers = cat.layers.filter(ly => availableIdSet.has(ly.id));
        return layers.length ? { ...cat, layers } : null;
      }).filter(Boolean);

      if(filteredCategories.length === 0) return;

      const total = filteredCategories.reduce((s,c)=> s + (c.groups ? c.groups.reduce((gs,g)=>gs+g.layers.length,0) : c.layers.length), 0);

      buildAccordionBlock(contentEl, src.name, total, (srcBody)=>{
        buildCategoryList(filteredCategories, srcBody, (layer)=> activateFromSearch(src, layer), false);
      }, false); // 預設收合，行為與主清單一致，改由使用者點擊來源才展開
    });
  }

  // 【類型】頁籤：依類型分成固定 4 組（地形圖／地籍圖／行政區劃圖／其他），
  // 跳過空群組，每組攤平列出圖層（不再依來源／分類巢狀，因為使用者是
  // 依類型瀏覽，不是依來源瀏覽），第一個非空群組預設展開。
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
    multiSelectBtn.textContent = '✕ 取消多選';
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

/* ---------------------------------------------------------
   進入點：所有依賴 LAYER_SOURCES／REGION_EXTENTS 已載入完成的
   初始化動作，由 main.js 在 loadAppData() 完成後呼叫。
--------------------------------------------------------- */
export function initSearchUI(){
  addressInput = document.getElementById('addressInput');
  addressSearchBtn = document.getElementById('addressSearchBtn');
  addressSuggestEl = document.getElementById('addressSuggest');
  locationResultEl = document.getElementById('locationResult');
  locationNameEl = document.getElementById('locationName');
  layerAvailPanelEl = document.getElementById('layerAvailPanel');
  clearLocationBtn = document.getElementById('clearLocationBtn');

  searchBatchBarEl = document.getElementById('searchBatchBar');
  searchBatchCountEl = document.getElementById('searchBatchCount');
  searchBatchConfirmBtn = document.getElementById('searchBatchConfirmBtn');
  const searchBatchSelectAllBtn = document.getElementById('searchBatchSelectAllBtn');
  const searchBatchClearBtn = document.getElementById('searchBatchClearBtn');
  searchBatchSelectAllBtn.addEventListener('click', ()=> selectAllFn?.());
  searchBatchClearBtn.addEventListener('click', ()=> clearSelectionFn?.());
  searchBatchConfirmBtn.addEventListener('click', ()=> confirmCustomTimelineFn?.());

  addressMarkerEl = document.getElementById('addressMarker');
  addressMarkerOverlay = new ol.Overlay({
    element: addressMarkerEl,
    positioning: 'bottom-center',
    stopEvent: false
  });
  map.addOverlay(addressMarkerOverlay);

  addressInput.addEventListener('input', ()=>{
    exitSelectionModeFn?.();
    const q = addressInput.value.trim();
    if(runtime.addressDebounceTimer) clearTimeout(runtime.addressDebounceTimer);
    if(q.length < 3){ hideSuggest(); return; }
    runtime.addressDebounceTimer = setTimeout(async ()=>{
      const myToken = bumpSearchToken();
      try{
        const results = await geocodeAddress(q);
        if(isSearchStale(myToken)) return;
        renderSuggestList(results);
      }catch(e){
        if(!isSearchStale(myToken)) hideSuggest();
      }
    }, 550);
  });

  addressSearchBtn.addEventListener('click', runImmediateSearch);
  addressInput.addEventListener('keydown', (e)=>{
    if(e.key === 'Enter'){ e.preventDefault(); runImmediateSearch(); }
    else if(e.key === 'Escape'){ hideSuggest(); }
  });
  document.addEventListener('click', (e)=>{
    if(!e.target.closest('.search-block')) hideSuggest();
  });

  locateSearchBtn = document.getElementById('locateSearchBtn');
  locateSearchBtn.addEventListener('click', async ()=>{
    if(locateSearchBtn.classList.contains('loading')) return;
    const myToken = bumpSearchToken(); // 立即讓先前（不論是地址搜尋或前一次定位搜尋）還在跑的查詢失效
    locateSearchBtn.classList.add('loading');
    hideSuggest();
    try{
      const pos = await getCurrentPositionAsync();
      if(isSearchStale(myToken)) return; // 使用者在等待定位權限期間已經開始別的搜尋

      const lon = pos.coords.longitude;
      const lat = pos.coords.latitude;
      let label = `目前位置（${lat.toFixed(5)}, ${lon.toFixed(5)}）`;
      let addr = {};
      try{
        const rev = await reverseGeocode(lon, lat);
        if(isSearchStale(myToken)) return;
        if(rev && rev.display_name) label = rev.display_name;
        addr = (rev && rev.address) || {};
      }catch(e){
        // 反向地理編碼失敗（例如離線）時，退回用座標當標籤；
        // 圖層來源篩選會因為沒有縣市／鄉鎮資訊而保守地不排除，
        // 交由 findAvailableLayersAt 內建的逐筆圖磚確認機制去判斷有沒有資料。
      }
      if(isSearchStale(myToken)) return;

      addressInput.value = label;
      await showLocationAndFindLayers(lon, lat, label, addr);
    }catch(err){
      let msg = '無法取得目前位置，請稍後再試。';
      if(err && err.code === err.PERMISSION_DENIED) msg = '已拒絕位置權限，請至瀏覽器或系統設定允許此網站存取位置後再試一次。';
      else if(err && err.code === err.POSITION_UNAVAILABLE) msg = '目前無法判斷您的位置。';
      else if(err && err.code === err.TIMEOUT) msg = '定位逾時，請再試一次。';
      else if(err && err.message) msg = err.message;
      showLocateToast(msg);
    }finally{
      locateSearchBtn.classList.remove('loading');
    }
  });

  clearLocationBtn.addEventListener('click', ()=>{
    exitSelectionModeFn?.();
    // 避免殘留上一輪 render 的 closure：DOM 都清空了，狀態指標一併重設。
    exitSelectionModeFn = null;
    selectAllFn = null;
    clearSelectionFn = null;
    confirmCustomTimelineFn = null;
    bumpSearchToken(); // 讓仍在進行中的逐筆確認直接放棄，不再更新畫面
    hideAddressMarker();
    locationResultEl.style.display = 'none';
    layerAvailPanelEl.innerHTML = '';
    layerAvailPanelEl.classList.remove('selection-mode');
    searchBatchBarEl?.classList.remove('show');
    addressInput.value = '';
    hideSuggest();
  });
}
