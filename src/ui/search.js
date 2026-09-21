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
import { map } from '../core/map.js';
import { showLocateToast, describeAccuracy } from '../features/location.js';
import { preloadOverlayKeys } from '../core/layerManager.js';
import { findAvailableLayersAt, bumpSearchToken, isSearchStale, SEARCH_ZOOM, buildCoordInfoElement } from '../features/search.js';
import { layerKey } from '../data.js';
import { findPlaceNameCandidates, findNearbyPlaceNamesAsync, setActivePlaceNameMatch, clearActivePlaceNameMatch, sourceTypeLabel, summarizeDescription } from '../features/placeNames.js';
import { initPlaceNameCard, hidePlaceNameCard, renderPlaceNameCard, focusPlaceNameCard } from './placeNameCard.js';
import { initAvailableLayers, renderAvailableLayers, exitSelectionMode, endSelectionSession, clearAvailableLayersPanel } from './availableLayers.js';

// 既有的 import 路徑（main.js、tests）從這裡取這三個函式，re-export 讓它們不用改。
export { hidePlaceNameCard, renderPlaceNameCard, focusPlaceNameCard };

// 搜尋結果背景預載的圖層筆數上限，見 findAndRenderAvailableLayers() 內說明。
const SEARCH_PRELOAD_CAP = 20;
// 地址輸入框自動建議清單的最短觸發字數（含地名今昔對照精確比對與一般地理編碼）。
const ADDRESS_SUGGEST_MIN_QUERY_LENGTH = 2;
// debounce 延遲：Nominatim 使用政策明文要求 search-as-you-type 情境要「妥善
// 節流」，建議不超過約 1 req/秒，原本 550ms 太短，快速輸入/修改時容易在
// 1~2 秒內連發超過一次請求；拉長到 1000ms 並搭配 geocode.js 的查詢快取。
const ADDRESS_SUGGEST_DEBOUNCE_MS = 1000;

let addressInput, addressSearchBtn, addressSuggestEl, addressInputClearBtn, locationResultEl, locationNameEl,
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

// 程式化設定 addressInput.value（選定建議清單項目／定位成功／清空）不會
// 觸發 input 事件，`#addressInputClearBtn` 的顯示狀態要在這些地方手動同步。
function syncAddressInputClearBtn(){
  if(addressInputClearBtn) addressInputClearBtn.hidden = (addressInput.value.trim().length === 0);
}

// #addressSuggest 的桌面版 CSS 是 `position:absolute; top:100%` 相對於
// `.search-block`（見 style.css），這個定位祖先同時也包住 `#locationResult`——
// 一旦已經有一次搜尋結果／地名今昔對照卡展開，`.search-block` 的總高度會
// 被撐得很高，導致建議清單／候選清單整個跑到目前這輪結果面板下方、捲動
// 範圍外，使用者完全看不到。手機版（`#mobileSearchBar .address-suggest`）
// 不受影響，因為那邊的定位祖先只是頂部搜尋列，不包含 `#locationResult`，
// 所以這裡只在桌面版（`#addressSuggest` 還留在 `.search-block` 底下，
// 不是被搬進 `#mobileSearchBar`）才動態改寫 `top`，改成「輸入框那一列
// 實際的位置＋高度」，不再依賴會變動的 `.search-block` 總高度；手機版
// 完全不設 inline style，讓既有的 CSS 規則照常生效。
function repositionSuggestBelowInputRow(){
  if(addressSuggestEl.parentElement?.id === 'mobileSearchBar'){
    addressSuggestEl.style.top = '';
    return;
  }
  const row = document.querySelector('.address-search-row');
  if(row && row.offsetParent === addressSuggestEl.offsetParent){
    addressSuggestEl.style.top = `${row.offsetTop + row.offsetHeight + 2}px`;
  }
}

// 建立單一「一般地址地理編碼建議」項目 DOM（不負責 append），供
// renderSuggestList() 與合併清單的 renderMergedSuggestList() 共用，
// 避免同一段建立邏輯重複兩份。
function buildAddressSuggestItem(r){
  const item = document.createElement('div');
  item.className = 'address-suggest-item';
  item.textContent = r.display_name;
  item.addEventListener('click', ()=> selectGeocodeResult(r));
  return item;
}

function renderSuggestList(results){
  repositionSuggestBelowInputRow();
  addressSuggestEl.innerHTML = '';
  if(!results || results.length === 0){
    const empty = document.createElement('div');
    empty.className = 'address-suggest-empty';
    empty.textContent = '找不到符合的地址，請換個關鍵字試試。';
    addressSuggestEl.appendChild(empty);
    addressSuggestEl.classList.add('show');
    return;
  }
  results.forEach(r=> addressSuggestEl.appendChild(buildAddressSuggestItem(r)));
  addressSuggestEl.classList.add('show');
}

async function runImmediateSearch(){
  const q = addressInput.value.trim();
  if(!q) return;
  // 比照 locateSearchBtn：防止同一顆按鈕在前一次查詢還沒完成時被重複觸發
  // （快速按兩次 Enter／點兩次搜尋鈕），避免兩輪流程共用同一個 loading
  // 狀態卻互相干擾。
  if(addressSearchBtn.classList.contains('loading')) return;
  if(runtime.addressDebounceTimer) clearTimeout(runtime.addressDebounceTimer);
  const myToken = bumpSearchToken();
  addressSearchBtn.classList.add('loading');
  try{
    const placeCandidates = await findPlaceNameCandidates(q);
    if(isSearchStale(myToken)) return;
    if(placeCandidates.length === 1){
      hideSuggest();
      await selectPlaceNameCandidate(placeCandidates[0]);
      return;
    }
    if(placeCandidates.length > 1){
      renderPlaceNameCandidateList(placeCandidates);
      return;
    }

    const results = await geocodeAddress(q);
    if(isSearchStale(myToken)) return;
    if(results.length === 1){
      hideSuggest();
      await selectGeocodeResult(results[0]);
    } else {
      renderSuggestList(results);
    }
  }catch(e){
    // 地理編碼請求失敗（網路錯誤、逾時等）在輸入過程中很常見，靜默隱藏建議
    // 清單即可，不需要跳錯誤訊息打斷使用者輸入；仍記錄到 console 方便除錯。
    console.warn('地址搜尋（Enter／按鈕觸發）地理編碼失敗：', e);
    if(!isSearchStale(myToken)) hideSuggest();
  }finally{
    // 不能用 isSearchStale(myToken) 判斷要不要清 loading：這次流程往下走的
    // showLocationAndFindLayers()/findAndRenderAvailableLayers()/
    // selectGeocodeResult() 內部都會各自再呼叫一次 bumpSearchToken()（是
    // 同一輪流程自己的巢狀呼叫，不是被別的搜尋取代），跑到這裡時
    // myToken 幾乎必定已經被自己的巢狀呼叫比過去，導致 isSearchStale()
    // 恆為 true、.loading 永遠不會被移除（已修正的 bug：成功搜尋到單筆
    // 結果時放大鏡圖示卡死轉圈）。比照 locateSearchBtn 的寫法，這裡直接
    // 無條件移除，靠函式開頭的 loading class 重入防護擋掉真正重疊的情況。
    addressSearchBtn.classList.remove('loading');
  }
}

// 共用流程：把地圖移到指定經緯度、標示圖釘、顯示搜尋結果面板，再逐筆確認可用圖層。
// 地址搜尋（selectGeocodeResult）與定位搜尋（locateSearchBtn）最終都會走到這裡，
// 差別只在座標與地址元件的來源不同（Nominatim 正向地理編碼 vs. 瀏覽器定位+反向地理編碼）。
// 回傳這一輪搜尋的 token（供呼叫端用 isSearchStale() 判斷之後是否已有新搜尋）。
// accuracy（公尺）只有瀏覽器定位會傳，地址搜尋／地名比對沒有：桌面沒有 GPS，
// Wi-Fi／IP 定位常差數百公尺以上，圖釘看起來精準卻可能離很遠，要讓使用者看得到。
export async function showLocationAndFindLayers(lon, lat, label, addr, accuracy){
  // 每次重新定位（地址搜尋／目前位置定位／identify pin 的「搜尋涵蓋此點之
  // 歷史圖層」按鈕）都先清掉上一輪可能殘留的地名今昔對照卡與作用中比對
  // 結果；只有 selectPlaceNameCandidate() 會在這之後重新設定並顯示。
  clearActivePlaceNameMatch();
  hidePlaceNameCard();
  // 「附近歷史地名」清單只在 selectGeocodeResult() 那條路徑重新渲染
  // （見該函式），但清空動作放在這裡統一處理，確保 identify pin／定位
  // 搜尋／地名精確比對三條路徑都不會殘留上一輪的附近地名清單。
  locationResultEl.querySelector('.nearby-place-names')?.remove();

  const coord = ol.proj.fromLonLat([lon, lat]);
  const view = map.getView();
  view.animate({ center: coord, zoom: Math.max(view.getZoom(), SEARCH_ZOOM), duration: 600 });
  showAddressMarker(coord);

  locationResultEl.style.display = 'block';
  locationNameEl.textContent = label;
  // 存下 Nominatim 回傳的國別碼（小寫），給手機版分頁的
  // guessRegionFromLastLocation() 比對用，避免地址搜尋固定只查台灣
  // （見 src/geocode.js 的 countrycodes=tw）卻被拿去誤判成其他國家的地區。
  locationResultEl.dataset.countryCode = (addr && addr.country_code) ? String(addr.country_code).toLowerCase() : '';
  // 每次重新搜尋都要先移除舊的座標資訊區塊，避免重複搜尋時在卡片內堆疊。
  // 用 insertBefore 而非 appendChild：#layerAvailPanel 是寫死在 index.html
  // 裡的固定節點，appendChild 只會把座標資訊排到它後面，跟
  // renderNearbyPlaceNames() 註解宣稱的「座標資訊之後、可用圖層清單之前」
  // 順序不符（座標資訊會被擠到附近地名清單之後）。
  locationResultEl.querySelector('.coord-info')?.remove();
  locationResultEl.insertBefore(buildCoordInfoElement(lat, lon), layerAvailPanelEl);
  locationResultEl.querySelector('.locate-accuracy')?.remove();
  const accuracyText = describeAccuracy(accuracy);
  if(accuracyText){
    const accuracyEl = document.createElement('div');
    accuracyEl.className = 'locate-accuracy';
    accuracyEl.textContent = accuracyText;
    locationResultEl.insertBefore(accuracyEl, layerAvailPanelEl);
  }
  return findAndRenderAvailableLayers(lon, lat, addr || {});
}

async function selectGeocodeResult(result){
  hideSuggest();
  addressInput.value = result.display_name;
  syncAddressInputClearBtn();
  const lon = Number.parseFloat(result.lon);
  const lat = Number.parseFloat(result.lat);
  // 沿用 showLocationAndFindLayers 這一輪的 token，不能在 await 之後再自己 bump：
  // 探測期間使用者若開始了新搜尋 B，這裡再 bump 會把 B 的 token 蓋掉，B 的結果被當成
  // 過期丟棄，A 的附近地名清單還會插進 B 的結果面板。
  const myToken = await showLocationAndFindLayers(lon, lat, result.display_name, result.address || {});
  if(isSearchStale(myToken)) return;
  // 只有「一般地址」這條路徑才順帶列出附近歷史地名候選；地名今昔對照
  // 精確比對（selectPlaceNameCandidate）命中時已經直接顯示完整對照卡，
  // 不需要再疊加這份清單造成畫面雜訊。
  const nearby = await findNearbyPlaceNamesAsync(lon, lat);
  if(isSearchStale(myToken)) return;
  renderNearbyPlaceNames(nearby);
}

// 地名今昔對照：使用者從候選清單（或唯一命中）選定 place 後，走跟一般
// 地址搜尋相同的「地圖飛過去＋顯示可用圖層」流程，完成後才記錄目前
// 作用中的比對結果、渲染「地名今昔對照卡」（showLocationAndFindLayers()
// 開頭會先清掉上一輪的卡片與作用中比對，這裡要在它之後才重新設定）。
async function selectPlaceNameCandidate(place){
  hideSuggest();
  addressInput.value = place.name;
  syncAddressInputClearBtn();
  await showLocationAndFindLayers(place.longitude, place.latitude, place.name, { county: place.county, town: place.town });
  setActivePlaceNameMatch(place);
  renderPlaceNameCard(place);
}

// 地名今昔對照命中多筆候選時的清單，重用既有的 #addressSuggest 容器
// （見 CLAUDE.md／任務說明：手機版 relocateSearchBar() 只搬移這個既有
// 節點，另外新增容器會出現「候選清單出現在看不到的地方」的 bug），
// 用 .place-name-suggest-item 疊加地名專屬樣式與點擊行為區分。
// 有 export：供 tests/specs/place-name-card-ui.test.mjs 直接呼叫驗證，
// 純粹讓函式可測試化，不影響原本模組內部呼叫方式或行為。
// 建立單一「地名今昔對照精確比對」候選項目 DOM（不負責 append），供
// renderPlaceNameCandidateList() 與合併清單的 renderMergedSuggestList()
// 共用，避免同一段建立邏輯重複兩份。
function buildPlaceNameSuggestItem(place){
  const item = document.createElement('div');
  item.className = 'address-suggest-item place-name-suggest-item';

  const nameEl = document.createElement('span');
  nameEl.className = 'place-name-suggest-name';
  nameEl.textContent = place.name;

  const locEl = document.createElement('span');
  locEl.className = 'place-name-suggest-loc';
  locEl.textContent = `${place.county}${place.town || ''}`;

  const typeEl = document.createElement('span');
  typeEl.className = 'place-name-suggest-type';
  typeEl.textContent = sourceTypeLabel(place.sourceType);

  item.appendChild(nameEl);
  item.appendChild(locEl);
  item.appendChild(typeEl);

  // 說明摘要：同鄉鎮同名的候選（例如竹山鎮三個由來各異的「過溪」）名稱、位置、
  // 類別都一樣，沒有這一行使用者只能逐個點開才知道差別。沒有說明就不加這一行。
  const { summary } = summarizeDescription(place.description);
  if(summary){
    const descEl = document.createElement('span');
    descEl.className = 'place-name-suggest-desc';
    descEl.textContent = summary;
    item.appendChild(descEl);
  }
  item.addEventListener('click', ()=> selectPlaceNameCandidate(place));
  return item;
}

export function renderPlaceNameCandidateList(candidates){
  repositionSuggestBelowInputRow();
  addressSuggestEl.innerHTML = '';
  candidates.forEach(place=> addressSuggestEl.appendChild(buildPlaceNameSuggestItem(place)));
  addressSuggestEl.classList.add('show');
}

// 輸入框 debounce handler 專用：同時合併「地名今昔對照精確比對」與
// 「一般地址地理編碼」兩種建議來源，畫進同一個 #addressSuggest 容器——
// 地名項目固定排在最上方，地址項目排在下方；兩邊都槓龜時才顯示原本的
// 空狀態訊息。重用上面兩個 build*SuggestItem() helper，不複製渲染邏輯；
// renderPlaceNameCandidateList()／renderSuggestList() 這兩支既有 export
// 函式維持原樣可單獨呼叫（供 runImmediateSearch() 與既有測試使用）。
// 有 export：供 tests/specs/place-name-card-ui.test.mjs 直接呼叫驗證合併
// 排序（地名在上、地址在下）與空狀態，純粹讓函式可測試化，不影響原本
// 模組內部（輸入框 debounce handler）呼叫方式或行為。
export function renderMergedSuggestList(placeCandidates, geocodeResults){
  repositionSuggestBelowInputRow();
  addressSuggestEl.innerHTML = '';
  const hasPlace = placeCandidates && placeCandidates.length > 0;
  const hasGeocode = geocodeResults && geocodeResults.length > 0;
  if(!hasPlace && !hasGeocode){
    const empty = document.createElement('div');
    empty.className = 'address-suggest-empty';
    empty.textContent = '找不到符合的地址，請換個關鍵字試試。';
    addressSuggestEl.appendChild(empty);
    addressSuggestEl.classList.add('show');
    return;
  }
  if(hasPlace) placeCandidates.forEach(place=> addressSuggestEl.appendChild(buildPlaceNameSuggestItem(place)));
  if(hasGeocode) geocodeResults.forEach(r=> addressSuggestEl.appendChild(buildAddressSuggestItem(r)));
  addressSuggestEl.classList.add('show');
}

// 建立單一「附近歷史地名」項目 DOM（不負責 append），比照
// buildPlaceNameSuggestItem() 的寫法；點擊時不是選定搜尋座標，而是就地
// 展開該筆完整的今昔對照卡（重用既有 renderPlaceNameCard／
// focusPlaceNameCard，不重刻一份卡片渲染邏輯）。
function buildNearbyPlaceNameItem({ place, distanceMeters }){
  const item = document.createElement('div');
  item.className = 'nearby-place-name-item';

  const nameEl = document.createElement('span');
  nameEl.className = 'nearby-place-name-name';
  nameEl.textContent = place.name;

  const metaEl = document.createElement('span');
  metaEl.className = 'nearby-place-name-meta';
  metaEl.textContent = `${place.county}${place.town || ''}，距離約 ${distanceMeters} 公尺`;

  item.appendChild(nameEl);
  item.appendChild(metaEl);
  item.addEventListener('click', ()=>{
    renderPlaceNameCard(place);
    focusPlaceNameCard();
  });
  return item;
}

// 「附近歷史地名」清單：一般地址搜尋（selectGeocodeResult，非精確比對
// 古地名那條路徑）命中後，在搜尋結果卡片底下（座標資訊之後、可用圖層
// 清單之前）順帶列出附近的地名今昔對照候選。results 為空陣列時安靜
// 不顯示任何東西（不跳「查無附近地名」之類的訊息，避免畫面雜訊）。
// 每次呼叫都是全新一輪，呼叫前先確保上一輪已經被
// showLocationAndFindLayers() 開頭的清空動作移除。
function renderNearbyPlaceNames(results){
  if(!results || results.length === 0) return;

  const wrap = document.createElement('div');
  wrap.className = 'nearby-place-names';

  const title = document.createElement('div');
  title.className = 'nearby-place-names-title';
  title.textContent = '📍 附近歷史地名';
  wrap.appendChild(title);

  results.forEach(r => wrap.appendChild(buildNearbyPlaceNameItem(r)));

  locationResultEl.insertBefore(wrap, layerAvailPanelEl);
}

function getCurrentPositionAsync(){
  return new Promise((resolve, reject)=>{
    if(!navigator.geolocation){
      reject(new Error('您的瀏覽器不支援定位功能。'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  });
}

// 定位成功後：反向地理編碼取得地址標籤 → 更新輸入框 → 查詢可用圖層。
// 從 locateSearchBtn 的 click handler 抽出，降低該 handler 的認知複雜度。
async function handleLocateSuccess(pos, myToken){
  const lon = pos.coords.longitude;
  const lat = pos.coords.latitude;
  let label = `目前位置（${lat.toFixed(5)}, ${lon.toFixed(5)}）`;
  let addr = {};
  try{
    const rev = await reverseGeocode(lon, lat);
    if(isSearchStale(myToken)) return;
    if(rev?.display_name) label = rev.display_name;
    addr = rev?.address || {};
  }catch{
    // 反向地理編碼失敗（例如離線）時，退回用座標當標籤；
    // 圖層來源篩選會因為沒有縣市／鄉鎮資訊而保守地不排除，
    // 交由 findAvailableLayersAt 內建的逐筆圖磚確認機制去判斷有沒有資料。
  }
  if(isSearchStale(myToken)) return;

  addressInput.value = label;
  syncAddressInputClearBtn();
  await showLocationAndFindLayers(lon, lat, label, addr, pos.coords.accuracy);
}

// 依 geolocation 錯誤的 code／message 組出對使用者友善的提示文字，
// 從 locateSearchBtn 的 click handler 抽出，降低該 handler 的認知複雜度。
// 注意：不能寫成 `err.code === err.PERMISSION_DENIED` 比對——這幾個常數只有
// 瀏覽器原生 GeolocationPositionError 才會帶（該物件把 PERMISSION_DENIED／
// POSITION_UNAVAILABLE／TIMEOUT 同時放在 instance 上），getCurrentPositionAsync()
// 在瀏覽器不支援定位時是自己 reject(new Error(...))，err 上沒有這些常數，
// 這種寫法會變成 `undefined === undefined` 恆真，永遠誤判成「已拒絕位置權限」。
// 改用 Geolocation API 規格定義的固定數字代碼（1/2/3）直接比對，兩種來源
// 的 err 都能正確判斷。
function describeLocateError(err){
  if(err?.code === 1) return '已拒絕位置權限，請至瀏覽器或系統設定允許此網站存取位置後再試一次。'; // PERMISSION_DENIED
  if(err?.code === 2) return '目前無法判斷您的位置。'; // POSITION_UNAVAILABLE
  if(err?.code === 3) return '定位逾時，請再試一次。'; // TIMEOUT
  if(err?.message) return err.message;
  return '無法取得目前位置，請稍後再試。';
}

// 呼叫 features/search.js 的搜尋邏輯，並把過程中的進度／結果畫進
// layerAvailPanelEl。這支函式只管「畫面長什麼樣子」，候選來源怎麼
// 篩、圖磚怎麼驗證完全交給 findAvailableLayersAt。
async function findAndRenderAvailableLayers(lon, lat, addr){
  const mySearch = bumpSearchToken();
  await runAvailableLayersSearch(lon, lat, addr, mySearch);
  // 回傳 mySearch：呼叫端據此判斷「我這輪之後是不是又有新搜尋」，不能自己再 bump 一次。
  return mySearch;
}

async function runAvailableLayersSearch(lon, lat, addr, mySearch){
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

  // 逐筆確認過真的有資料的圖層，背景預先建立（見 core/layerManager.js
  // preloadOverlayKeys），使用者從清單點開時圖磚往往已經在下載，減少
  // 切換等待感。跟 timelineMode.js 同一套機制，但這裡命中筆數可能遠多於
  // 時間軸模式（涵蓋所有類型來源，不只 sinica 一種），故意設一個上限，
  // 避免熱門地點一次背景暖機幾十張圖層、佔滿頻寬又把 layerCache 洗爆。
  preloadOverlayKeys(
    result.available.slice(0, SEARCH_PRELOAD_CAP).map(c => layerKey(c.src, c.layer))
  );
}

/* ---------------------------------------------------------
   進入點：所有依賴 LAYER_SOURCES／REGION_EXTENTS 已載入完成的
   初始化動作，由 main.js 在 loadAppData() 完成後呼叫。
--------------------------------------------------------- */
export function initSearchUI(){
  addressInput = document.getElementById('addressInput');
  addressSearchBtn = document.getElementById('addressSearchBtn');
  addressSuggestEl = document.getElementById('addressSuggest');
  addressInputClearBtn = document.getElementById('addressInputClearBtn');
  locationResultEl = document.getElementById('locationResult');
  locationNameEl = document.getElementById('locationName');
  layerAvailPanelEl = document.getElementById('layerAvailPanel');
  clearLocationBtn = document.getElementById('clearLocationBtn');
  initPlaceNameCard();
  initAvailableLayers();

  addressMarkerEl = document.getElementById('addressMarker');
  addressMarkerOverlay = new ol.Overlay({
    element: addressMarkerEl,
    positioning: 'bottom-center',
    stopEvent: false
  });
  map.addOverlay(addressMarkerOverlay);

  addressInput.addEventListener('input', ()=>{
    exitSelectionMode();
    const q = addressInput.value.trim();
    if(addressInputClearBtn) addressInputClearBtn.hidden = (q.length === 0);
    if(runtime.addressDebounceTimer) clearTimeout(runtime.addressDebounceTimer);
    if(q.length < ADDRESS_SUGGEST_MIN_QUERY_LENGTH){ hideSuggest(); return; }
    runtime.addressDebounceTimer = setTimeout(async ()=>{
      const myToken = bumpSearchToken();
      try{
        // 同時查地名今昔對照精確比對與一般地址地理編碼，合併渲染進同一個
        // 建議清單（地名項目在上、地址項目在下），讓使用者直接點建議清單
        // 裡的地名項目也能觸發地名今昔對照卡，不再只有 Enter／按搜尋鈕
        // 走的 runImmediateSearch() 才有這個效果。改用 Promise.allSettled
        // 而非 Promise.all：地理編碼逾時/失敗只會讓 geocodeResults 這一路
        // 落空，不會連帶把不依賴網路、已經成功解析的地名候選也一起丟掉
        // （Promise.all 任一個 reject 就整體 reject 的既有問題，Nominatim
        // 逾時/離線時打對精確古地名也看不到建議清單）。
        const [placeSettled, geocodeSettled] = await Promise.allSettled([
          findPlaceNameCandidates(q),
          geocodeAddress(q)
        ]);
        if(isSearchStale(myToken)) return;
        if(placeSettled.status === 'rejected'){
          console.warn('地名今昔對照比對失敗：', placeSettled.reason);
        }
        if(geocodeSettled.status === 'rejected'){
          console.warn('地址地理編碼失敗：', geocodeSettled.reason);
        }
        const placeCandidates = placeSettled.status === 'fulfilled' ? placeSettled.value : [];
        const geocodeResults = geocodeSettled.status === 'fulfilled' ? geocodeSettled.value : [];
        renderMergedSuggestList(placeCandidates, geocodeResults);
      }catch(e){
        // Promise.allSettled 本身不會 reject，這裡保留只是為了涵蓋
        // renderMergedSuggestList() 或其他同步程式碼萬一拋錯的情況。
        console.warn('地址輸入自動建議清單渲染失敗：', e);
        if(!isSearchStale(myToken)) hideSuggest();
      }
    }, ADDRESS_SUGGEST_DEBOUNCE_MS);
  });

  addressInputClearBtn?.addEventListener('click', ()=>{
    // 只清「正在輸入的文字」，不連帶清除已完成的搜尋結果（locationResult／
    // layerAvailPanel／placeNameCard），那些是 clearLocationBtn 的職責。
    addressInput.value = '';
    addressInputClearBtn.hidden = true;
    hideSuggest();
    addressInput.focus();
  });

  addressSearchBtn.addEventListener('click', runImmediateSearch);
  addressInput.addEventListener('keydown', (e)=>{
    if(e.key === 'Enter'){ e.preventDefault(); runImmediateSearch(); }
    else if(e.key === 'Escape'){ hideSuggest(); }
  });
  document.addEventListener('click', (e)=>{
    // 手機版 (<=768px) 時 mobileLayout.js 的 relocateSearchBar() 會把
    // .address-search-row／#addressSuggest 真的搬出 .search-block、移進
    // #mobileSearchBar（不是複製一份），所以 e.target.closest('.search-block')
    // 在手機版對輸入框本身、#addressSuggest 等元素恆為 null——會被誤判成
    //「點擊外部」，導致建議清單顯示中只要點回輸入框本身就立即被收起。
    // 加上 #mobileSearchBar 這個容器一併判斷，桌面版沒有這個元素或元素
    // 是空的，不影響原本行為。
    if(e.target.closest('.search-block')) return;
    if(e.target.closest('#mobileSearchBar')) return;
    hideSuggest();
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
      await handleLocateSuccess(pos, myToken);
    }catch(err){
      showLocateToast(describeLocateError(err));
    }finally{
      locateSearchBtn.classList.remove('loading');
    }
  });

  clearLocationBtn.addEventListener('click', ()=>{
    // 避免殘留上一輪 render 的 closure：DOM 都清空了，狀態指標一併重設。
    endSelectionSession();
    bumpSearchToken(); // 讓仍在進行中的逐筆確認直接放棄，不再更新畫面
    clearActivePlaceNameMatch();
    hidePlaceNameCard();
    hideAddressMarker();
    locationResultEl.style.display = 'none';
    clearAvailableLayersPanel();
    addressInput.value = '';
    syncAddressInputClearBtn();
    hideSuggest();
  });
}
