/* ---------------------------------------------------------
   ui/search.js — 地址搜尋介面
   ---------------------------------------------------------
   從 searchUI.js 拆出來的 UI 部分：輸入框、搜尋／定位按鈕、
   建議清單、結果面板（分類瀏覽／時間軸兩種檢視）。只負責 input／
   button／result list／loading／error message／DOM 更新，實際
   的地理編碼交給 geocode.js，候選來源篩選與逐筆圖磚驗證交給
   features/search.js，這裡不自己做任何 GIS 判斷。
--------------------------------------------------------- */
import { runtime } from '../runtime.js';
import { geocodeAddress, reverseGeocode } from '../geocode.js';
import { buildCategoryList } from '../uiTree.js';
import { buildTimeline } from '../timelineUI.js';
import { map } from '../core/map.js';
import { showLocateToast } from '../features/location.js';
import { syncActiveLayerItemClasses } from '../core/layerManager.js';
import { findAvailableLayersAt, activateFromSearch, bumpSearchToken, isSearchStale, SEARCH_ZOOM } from '../features/search.js';

let addressInput, addressSearchBtn, addressSuggestEl, locationResultEl, locationNameEl,
    layerAvailPanelEl, clearLocationBtn, addressMarkerEl, addressMarkerOverlay, locateSearchBtn;

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
async function showLocationAndFindLayers(lon, lat, label, addr){
  const coord = ol.proj.fromLonLat([lon, lat]);
  const view = map.getView();
  view.animate({ center: coord, zoom: Math.max(view.getZoom(), SEARCH_ZOOM), duration: 600 });
  showAddressMarker(coord);

  locationResultEl.style.display = 'block';
  locationNameEl.textContent = label;
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
  layerAvailPanelEl.innerHTML = '';
  if(available.length === 0){
    const empty = document.createElement('p');
    empty.className = 'avail-empty';
    empty.textContent = `已確認 ${totalChecked} 筆相關圖層，此地點目前沒有找到有資料的歷史地圖圖層。可能是這個地點在該圖資範圍之外，或該圖資此區塊尚未建置資料。`;
    layerAvailPanelEl.appendChild(empty);
    return;
  }

  const summary = document.createElement('p');
  summary.className = 'avail-empty';
  summary.textContent = `此地點目前可套疊 ${available.length} 筆歷史地圖圖層（已逐筆確認有資料）：`;
  layerAvailPanelEl.appendChild(summary);

  // 檢視切換：分類瀏覽（原本的手風琴）／時間軸（依年代排列，原型功能）。
  // 兩種檢視操作的是同一份 available 資料，切換不會重新搜尋。
  const viewToggle = document.createElement('div');
  viewToggle.className = 'avail-view-toggle';
  const catViewBtn = document.createElement('button');
  catViewBtn.type = 'button';
  catViewBtn.className = 'avail-view-btn active';
  catViewBtn.textContent = '分類瀏覽';
  const timelineViewBtn = document.createElement('button');
  timelineViewBtn.type = 'button';
  timelineViewBtn.className = 'avail-view-btn';
  timelineViewBtn.textContent = '時間軸';
  viewToggle.appendChild(catViewBtn);
  viewToggle.appendChild(timelineViewBtn);
  layerAvailPanelEl.appendChild(viewToggle);

  const contentEl = document.createElement('div');
  layerAvailPanelEl.appendChild(contentEl);

  function renderCategoryView(){
    contentEl.innerHTML = '';
    // 依「來源 → 分類 →（次分類 →）圖層」重建可用圖層的巢狀結構，
    // 沿用主清單同一套 source-group/category 手風琴樣式與 buildCategoryList()，
    // 讓搜尋結果維持原本的分類方式，可以逐層摺疊／展開，而不是攤平成一長串清單。
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

      const srcWrap = document.createElement('div');
      srcWrap.className = 'source-group'; // 預設收合，行為與主清單一致，改由使用者點擊來源才展開

      const srcHead = document.createElement('button');
      srcHead.type = 'button';
      srcHead.className = 'source-head';
      srcHead.innerHTML = `<span><span class="chevron">▸</span>${src.name}</span><span class="count">${total}</span>`;
      srcHead.addEventListener('click', ()=>{
        const opening = !srcWrap.classList.contains('open');
        if(opening){
          // 手風琴行為：與主清單一致，展開這個來源時先收合搜尋結果內其他已展開的來源，
          // 一次只保留一個最大階層是開啟的狀態。
          contentEl.querySelectorAll('.source-group.open').forEach(g=>{
            if(g !== srcWrap) g.classList.remove('open');
          });
        }
        srcWrap.classList.toggle('open');
      });

      const srcBody = document.createElement('div');
      srcBody.className = 'source-body';
      buildCategoryList(filteredCategories, srcBody, (layer)=> activateFromSearch(src, layer), false);

      srcWrap.appendChild(srcHead);
      srcWrap.appendChild(srcBody);
      contentEl.appendChild(srcWrap);
    });

    syncActiveLayerItemClasses();
  }

  function renderTimelineView(){
    contentEl.innerHTML = '';
    buildTimeline(available, contentEl, (src, layer) => activateFromSearch(src, layer));
    syncActiveLayerItemClasses();
  }

  catViewBtn.addEventListener('click', ()=>{
    catViewBtn.classList.add('active');
    timelineViewBtn.classList.remove('active');
    renderCategoryView();
  });
  timelineViewBtn.addEventListener('click', ()=>{
    timelineViewBtn.classList.add('active');
    catViewBtn.classList.remove('active');
    renderTimelineView();
  });

  // 若目前已有套疊中的歷史圖層，於搜尋結果中同步標示為 active，並展開其所在的分類層級。
  // 搜尋結果面板每次都是重新建立的 DOM，store 的 activeOverlayKey 不會因為
  // 重新搜尋而改變，modeManager 的訂閱者不會被觸發，所以要手動呼叫一次
  // 跟主清單共用的同步函式，補上這次剛建好的 DOM。
  renderCategoryView(); // 預設顯示分類瀏覽
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

  addressMarkerEl = document.getElementById('addressMarker');
  addressMarkerOverlay = new ol.Overlay({
    element: addressMarkerEl,
    positioning: 'bottom-center',
    stopEvent: false
  });
  map.addOverlay(addressMarkerOverlay);

  addressInput.addEventListener('input', ()=>{
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
    bumpSearchToken(); // 讓仍在進行中的逐筆確認直接放棄，不再更新畫面
    hideAddressMarker();
    locationResultEl.style.display = 'none';
    layerAvailPanelEl.innerHTML = '';
    addressInput.value = '';
    hideSuggest();
  });
}
