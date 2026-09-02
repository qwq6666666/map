/* ---------------------------------------------------------
   searchUI.js — 地址搜尋：輸入地址 → 定位地圖，並列出「此地點目前可
   套疊」的歷史地圖圖層

   運作方式：
   1. 地理編碼：使用 OpenStreetMap Nominatim 公用 API，將輸入的地址轉換成
      經緯度（countrycodes=tw 限制在台灣範圍內）。Nominatim 是免費公用服務、
      有使用量限制（官方建議約每秒 1 次請求），這裡已用輸入防抖（550ms）
      與「捨棄過期查詢」機制來避免過度呼叫；若要用在正式或高流量的網站，
      建議改用自建 Nominatim，或改用有 API Key 的商用地理編碼服務
      （例如 Google Geocoding、TGOS 全國圖資中心）。
   2. 圖層來源篩選：依地理編碼回傳的縣市／鄉鎮名稱，先從全部 1500+ 筆歷史
      圖層中，篩出「地理範圍上可能相關」的圖資來源（例如查「基隆」會篩出
      基隆百年歷史地圖），全臺涵蓋的「台灣百年歷史地圖」來源則一律列入候選，
      藉此把逐筆確認的範圍縮小到合理數量。
   2.5 文字比對候選圖層（僅作用在單一來源內部，不依賴任何邊界圖資）：
      像「桃竹苗舊地籍圖」(thm) 這種以「堡→庄」細分、單一來源底下就有數百筆
      圖層的情況，2. 篩出來源後仍然筆數過多。這裡改用 Nominatim 回傳的鄉鎮
      ／村里／鄰里等地址元件（例如「新埔鎮」「香山區」），去掉常見的行政區
      詞尾取出地名核心字（「新埔」「香山」），再跟該來源內每個圖層的標題
      （例如「新竹廳竹北二堡新埔街」）做子字串比對，命中的才留在第一輪候選。
      若某個來源完全沒有任何圖層標題命中，就退回原本「這個來源全部圖層都要
      檢查」當備援，確保不會因為地名對不上而漏掉圖層。這只是文字層級的粗篩，
      不是精準的地理邊界判斷（新舊地名不一定完全對得上），純粹用來減少下一
      步要發送的圖磚請求數量。
   3. 逐筆資料驗證：經過 2. 與 2.5 篩選後的候選圖層，會在該地點對應的圖磚
      座標實際各發送一次圖磚請求，沿用各圖資 file-exists 圖磚服務「有資料
      才回傳有效影像」的特性，只列出真的成功回傳影像的圖層，而不是只靠地區
      概略推算或文字比對的結果來斷定有沒有資料。文字比對命中率高的地址，
      這一步要檢查的筆數會比未篩選前少很多；完全靠備援（全部檢查）時則跟
      原本行為一樣。
--------------------------------------------------------- */
import { state } from './state.js';
import {
  LAYER_SOURCES, REGION_EXTENTS,
  matchSourceIdsForAddress, extractPlaceKeywords, prefilterLayersByPlaceName
} from './data.js';
import { geocodeAddress, reverseGeocode } from './geocode.js';
import { buildCategoryList } from './uiTree.js';
import { map, showLocateToast, setMode, selectHistoryLayer } from './mapCore.js';

const SEARCH_ZOOM = 15;

// 將經緯度換算成標準 Web Mercator（EPSG:3857）Slippy Map 圖磚座標
function lonLatToTileXY(lon, lat, z){
  const n = Math.pow(2, z);
  const x = Math.floor((lon + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return {
    x: Math.max(0, Math.min(n - 1, x)),
    y: Math.max(0, Math.min(n - 1, y)),
    z
  };
}

// 實際載入圖磚圖片來確認該座標是否有資料（載入失敗或回傳極小的空白圖，視為無資料）
function checkTileHasData(url, timeoutMs){
  return new Promise((resolve)=>{
    let done = false;
    const img = new Image();
    const finish = (ok)=>{ if(done) return; done = true; resolve(ok); };
    img.onload = ()=> finish(img.naturalWidth > 2 && img.naturalHeight > 2);
    img.onerror = ()=> finish(false);
    setTimeout(()=> finish(false), timeoutMs || 6000);
    img.src = url;
  });
}

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
  if(state.addressDebounceTimer) clearTimeout(state.addressDebounceTimer);
  const myToken = ++state.searchToken;
  addressSearchBtn.classList.add('loading');
  try{
    const results = await geocodeAddress(q);
    if(myToken !== state.searchToken) return;
    if(results.length === 1){
      hideSuggest();
      await selectGeocodeResult(results[0]);
    } else {
      renderSuggestList(results);
    }
  }catch(e){
    if(myToken === state.searchToken) hideSuggest();
  }finally{
    if(myToken === state.searchToken) addressSearchBtn.classList.remove('loading');
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
  await findAvailableLayersAt(lon, lat, addr || {});
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

// 用搜尋到的經緯度，跟每個來源的概略 bounding box（REGION_EXTENTS）比對，
// 完全落在範圍外的來源可以直接跳過，不用等它進到圖磚探測階段才知道沒資料。
// 這是純數學運算、沒有任何網路請求，跟 matchSourceIdsForAddress()（用 Nominatim
// 回傳的縣市／鄉鎮文字比對）互補：文字比對可能因為新舊地名對不上而漏篩，
// 座標 bbox 則是幾何上的保險，兩者同時通過才視為候選來源。
//
// EXTENT_BUFFER_DEG 是刻意保留的容許誤差：REGION_EXTENTS 只是概略行政區
// 範圍，跟實際歷史圖資邊界可能有些微落差，加一點緩衝可以避免把邊界附近、
// 其實還是有資料的來源誤判排除掉。沒有 bbox 資料的來源則保守地不排除，
// 維持跟原本一樣「寧可多檢查、不要漏掉」的行為。
const EXTENT_BUFFER_DEG = 0.05; // 約 5 公里的容許誤差
function isPointNearExtent(lon, lat, ext){
  if(!ext) return true;
  const [minLon, minLat, maxLon, maxLat] = ext;
  return lon >= minLon - EXTENT_BUFFER_DEG && lon <= maxLon + EXTENT_BUFFER_DEG &&
         lat >= minLat - EXTENT_BUFFER_DEG && lat <= maxLat + EXTENT_BUFFER_DEG;
}

async function findAvailableLayersAt(lon, lat, addr){
  const mySearch = state.searchToken;
  layerAvailPanelEl.innerHTML = '';
  const sourceIds = matchSourceIdsForAddress(addr);
  const bboxExcluded = []; // 記錄被座標 bbox 排除掉的來源名稱，僅供進度顯示參考
  const candidateSources = LAYER_SOURCES.filter(s=>{
    if(!sourceIds.includes(s.id)) return false;
    const nearby = isPointNearExtent(lon, lat, REGION_EXTENTS[s.id]);
    if(!nearby) bboxExcluded.push(s.name);
    return nearby;
  });
  const placeKeywords = extractPlaceKeywords(addr);

  const candidates = [];
  let textFilteredSourceCount = 0; // 有多少個來源是靠文字比對縮小範圍的（僅供進度顯示參考）
  candidateSources.forEach(src=>{
    const srcCandidates = [];
    src.categories.forEach(cat=>{
      const layersArr = cat.groups ? cat.groups.flatMap(g=>g.layers) : cat.layers;
      layersArr.forEach(layer => srcCandidates.push({ src, layer }));
    });

    // 先用地址文字（鄉鎮／村里等）比對這個來源內的圖層標題，命中就只排入
    // 命中的候選；完全沒命中（或這個地址沒有可用關鍵字）就退回檢查這個
    // 來源的全部圖層，行為與篩選前一致，不會漏掉圖層。
    const textFiltered = prefilterLayersByPlaceName(srcCandidates, placeKeywords);
    if(textFiltered){
      textFilteredSourceCount++;
      candidates.push(...textFiltered);
    } else {
      candidates.push(...srcCandidates);
    }
  });

  if(candidates.length === 0){
    const empty = document.createElement('p');
    empty.className = 'avail-empty';
    empty.textContent = '此地點附近沒有可比對的歷史地圖圖資來源。';
    layerAvailPanelEl.appendChild(empty);
    return;
  }

  const progressEl = document.createElement('div');
  progressEl.className = 'avail-progress';
  const noteParts = [];
  if(bboxExcluded.length > 0) noteParts.push(`已用座標排除 ${bboxExcluded.length} 個範圍不重疊的來源`);
  if(textFilteredSourceCount > 0) noteParts.push(`已用地址文字比對縮小 ${textFilteredSourceCount} 個來源的候選範圍`);
  const filterNote = noteParts.length > 0 ? `（${noteParts.join('；')}）` : '';
  progressEl.textContent = `正在確認 0 / ${candidates.length} 筆圖層是否有資料…${filterNote}`;
  layerAvailPanelEl.appendChild(progressEl);

  const tile = lonLatToTileXY(lon, lat, SEARCH_ZOOM);
  let checkedCount = 0;
  const available = [];
  let cursor = 0;
  const CONCURRENCY = 10;

  async function worker(){
    while(cursor < candidates.length){
      const myIdx = cursor++;
      const c = candidates[myIdx];
      let url = null;
      try{
        url = c.src.tileUrl(c.layer).replace('{z}', tile.z).replace('{x}', tile.x).replace('{y}', tile.y);
      }catch(e){ url = null; }
      const ok = url ? await checkTileHasData(url, 6000) : false;
      checkedCount++;
      if(mySearch === state.searchToken) progressEl.textContent = `正在確認 ${checkedCount} / ${candidates.length} 筆圖層是否有資料…${filterNote}`;
      if(ok) available.push(c);
    }
  }
  const runners = Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, worker);
  await Promise.all(runners);

  if(mySearch !== state.searchToken) return; // 使用者已經開始下一次搜尋或清除，捨棄這次結果
  renderAvailableLayers(available, candidates.length);
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
  summary.textContent = `此地點目前可套疊 ${available.length} 筆歷史地圖圖層（已逐筆確認有資料，依原本分類整理如下，點選標題可展開／收合分類）：`;
  layerAvailPanelEl.appendChild(summary);

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
        layerAvailPanelEl.querySelectorAll('.source-group.open').forEach(g=>{
          if(g !== srcWrap) g.classList.remove('open');
        });
      }
      srcWrap.classList.toggle('open');
    });

    const srcBody = document.createElement('div');
    srcBody.className = 'source-body';
    buildCategoryList(filteredCategories, srcBody, (layer, itemEl)=> activateFromSearch(src, layer, itemEl), false);

    srcWrap.appendChild(srcHead);
    srcWrap.appendChild(srcBody);
    layerAvailPanelEl.appendChild(srcWrap);
  });

  // 若目前已有套疊中的歷史圖層，於搜尋結果中同步標示為 active，並展開其所在的分類層級
  if(state.activeLayerId){
    const activeItem = layerAvailPanelEl.querySelector(`.layer-item[data-layer-id="${state.activeLayerId}"]`);
    if(activeItem){
      activeItem.classList.add('active');
      let p = activeItem.parentElement;
      while(p && p !== layerAvailPanelEl){
        if(p.classList.contains('category') || p.classList.contains('subcategory') || p.classList.contains('source-group')) p.classList.add('open');
        p = p.parentElement;
      }
    }
  }
}

// 從搜尋結果點選圖層：若目前在左右比對模式，先切回透明疊圖模式，
// 再沿用既有的 selectHistoryLayer（會一併同步主清單裡的高亮狀態）
function activateFromSearch(src, layer, itemEl){
  if(state.currentMode !== 'overlay'){
    const overlayBtn = document.querySelector('#modeSwitch button[data-mode="overlay"]');
    if(overlayBtn) overlayBtn.click();
  }
  selectHistoryLayer(src, layer, itemEl);
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
    if(state.addressDebounceTimer) clearTimeout(state.addressDebounceTimer);
    if(q.length < 3){ hideSuggest(); return; }
    state.addressDebounceTimer = setTimeout(async ()=>{
      const myToken = ++state.searchToken;
      try{
        const results = await geocodeAddress(q);
        if(myToken !== state.searchToken) return;
        renderSuggestList(results);
      }catch(e){
        if(myToken === state.searchToken) hideSuggest();
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
    const myToken = ++state.searchToken; // 立即讓先前（不論是地址搜尋或前一次定位搜尋）還在跑的查詢失效
    locateSearchBtn.classList.add('loading');
    hideSuggest();
    try{
      const pos = await getCurrentPositionAsync();
      if(myToken !== state.searchToken) return; // 使用者在等待定位權限期間已經開始別的搜尋

      const lon = pos.coords.longitude;
      const lat = pos.coords.latitude;
      let label = `目前位置（${lat.toFixed(5)}, ${lon.toFixed(5)}）`;
      let addr = {};
      try{
        const rev = await reverseGeocode(lon, lat);
        if(myToken !== state.searchToken) return;
        if(rev && rev.display_name) label = rev.display_name;
        addr = (rev && rev.address) || {};
      }catch(e){
        // 反向地理編碼失敗（例如離線）時，退回用座標當標籤；
        // 圖層來源篩選會因為沒有縣市／鄉鎮資訊而保守地不排除，
        // 交由 findAvailableLayersAt 內建的逐筆圖磚確認機制去判斷有沒有資料。
      }
      if(myToken !== state.searchToken) return;

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
    state.searchToken++; // 讓仍在進行中的逐筆確認直接放棄，不再更新畫面
    hideAddressMarker();
    locationResultEl.style.display = 'none';
    layerAvailPanelEl.innerHTML = '';
    addressInput.value = '';
    hideSuggest();
  });
}
