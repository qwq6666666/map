/* ---------------------------------------------------------
   features/location.js — 定位功能
   ---------------------------------------------------------
   從 mapCore.js 拆出來的定位功能：取得目前位置、在地圖上標示
   藍點、定位失敗時的提示訊息，以及「持續追蹤（跟隨我）」。跟「目前
   顯示哪個歷史圖層」完全無關，所以獨立成一個 feature 模組，只依賴
   core/map.js 的 map 實例。

   兩種定位並存、互不取代：
     - 一次性定位（#locateBtn）：getCurrentPosition() 抓一次、飛過去、
       跳出座標彈窗。
     - 持續追蹤（#trackBtn）：watchPosition() 持續更新藍點；地圖跟著
       移動（跟隨），使用者自己拖曳／縮放／搜尋離開後暫停跟隨，按鈕
       變成「回到目前位置」。三態（off／following／paused）的轉換用純函式
       nextTrackState() 表達，方便單元測試。追蹤期間用 Screen Wake Lock
       讓螢幕保持亮起（走路時螢幕待機，追蹤會被瀏覽器暫停）。

   showLocateToast 額外匯出，因為 searchUI.js 的「定位搜尋」
   失敗時也會共用同一顆提示。
--------------------------------------------------------- */
import { runtime } from '../runtime.js';
import { map } from '../core/map.js';
import { toTWD97, formatWGS84, formatTWD97 } from '../core/tileGeo.js';
import { buildCoordRow } from './coordCopy.js';

let locateMarkerEl, locateOverlay, locateBtn, locateToast;
let locatePopupEl, locatePopupBody, locatePopupCloseBtn;

// 只隱藏彈窗、不清除藍點標記（關閉彈窗跟清除 Pin 是兩件事，比照 identifyPin.js 的 closePopup()）。
export function closeLocatePopup(){
  if(locatePopupEl) locatePopupEl.hidden = true;
}

export function showLocateToast(msg){
  locateToast.textContent = msg;
  locateToast.classList.add('show');
  if(runtime.locateToastTimer) clearTimeout(runtime.locateToastTimer);
  runtime.locateToastTimer = setTimeout(()=> locateToast.classList.remove('show'), 4500);
}

// 複製座標文字／座標列 DOM 工廠已抽到 coordCopy.js（跟 search.js 共用），
// 避免兩邊各自維護逐漸分歧。

/* ---------- 純函式（不碰 DOM／地圖，單元測試直接呼叫） ---------- */

const WEAK_ACCURACY_METERS = 100;

// 定位精度的顯示文字；沒有數值（測試環境／少數瀏覽器）回傳空字串。
// 超過 100 公尺多半是室內或訊號被遮蔽，特別標示，田野調查者才知道
// 這個藍點不能當準確位置用。
export function describeAccuracy(accuracy){
  if(!Number.isFinite(accuracy)) return '';
  const text = `精度 ±${Math.round(accuracy)} 公尺`;
  return accuracy > WEAK_ACCURACY_METERS ? `${text}（訊號較弱）` : text;
}

// 追蹤三態：off 沒在追蹤／following 追蹤並讓地圖跟著走／paused 仍在追蹤
// 藍點，但使用者移開了地圖，不再自動置中。
//   toggle    按追蹤鈕：off→following、paused→following（回到目前位置）、
//             following→off（停止）
//   userMoved 使用者自己動了地圖：following→paused，其他狀態不變
//   denied／stop 一律回到 off
export function nextTrackState(state, event){
  switch(event){
    case 'toggle': return state === 'following' ? 'off' : 'following';
    case 'userMoved': return state === 'following' ? 'paused' : state;
    case 'denied':
    case 'stop': return 'off';
    default: return state;
  }
}

/* ---------- 座標彈窗 ---------- */

// 定位成功後，在獨立的彈窗卡片（#locatePopup）顯示座標資訊（WGS84／TWD97 各一行＋複製按鈕），
// 而非塞進 0 寬高的 #locateMarker（比照 identifyPin.js 的彈窗模式，避免版面被擠壓變形）。
// 每一列第一次建立後就「原地更新文字」、不重建 DOM：持續追蹤時座標約每秒更新一次，
// 若每次都重建，使用者正要按「複製」的按鈕會在手指底下被換掉、點擊落空。
// reveal=true（預設）會重新顯示彈窗（一次性定位：就算使用者先前手動關閉過也一樣，
// 跟原有行為一致）；持續追蹤的後續更新傳 false，使用者關掉彈窗就不再跳出來。
let coordText = { wgs84: '', twd97: '' };
let coordRows = null; // { wgs84Row, twd97Row, accuracyEl }

function setRowValue(row, text){
  const valueEl = row.querySelector?.('.coord-info-value');
  if(!valueEl) return false;
  valueEl.textContent = text;
  return true;
}

function renderLocateCoordInfo(lat, lon, accuracy, { reveal = true } = {}){
  coordText = { wgs84: formatWGS84(lat, lon), twd97: '' };
  const { x, y } = toTWD97(lat, lon);
  coordText.twd97 = formatTWD97(x, y);

  const updatedInPlace = coordRows
    && setRowValue(coordRows.wgs84Row, coordText.wgs84)
    && setRowValue(coordRows.twd97Row, coordText.twd97);
  if(!updatedInPlace){
    locatePopupBody.innerHTML = '';
    const wgs84Row = buildCoordRow('WGS84', coordText.wgs84, () => coordText.wgs84);
    const twd97Row = buildCoordRow('TWD97', coordText.twd97, () => coordText.twd97);
    const accuracyEl = document.createElement('div');
    accuracyEl.className = 'locate-accuracy';
    locatePopupBody.appendChild(wgs84Row);
    locatePopupBody.appendChild(twd97Row);
    locatePopupBody.appendChild(accuracyEl);
    coordRows = { wgs84Row, twd97Row, accuracyEl };
  }
  coordRows.accuracyEl.textContent = describeAccuracy(accuracy);
  if(reveal) locatePopupEl.hidden = false;
}

/* ---------- 持續追蹤 ---------- */

const TRACK_TITLES = {
  off: '持續追蹤目前位置（地圖會跟著你移動）',
  following: '停止追蹤位置',
  paused: '回到目前位置並繼續跟隨'
};
const TRACK_MIN_ZOOM = 16;
const TRACK_FOLLOW_MS = 300;
// 跟隨中，地圖停下來後畫面中心離最後一筆定位點超過這個像素數，就當成使用者
// 把地圖移開了（滾輪縮放、鍵盤、拖曳以外的操作）。縮放按鈕是繞著畫面中心
// 縮放、不會位移，所以不會誤判。
const FOLLOW_DRIFT_PX = 40;

let trackBtn = null;
let trackState = 'off';
let trackWatchId = null;
let trackFirstFix = true;
let trackErrorShown = false;
let lastTrackCoord = null;
let pendingSelfAnims = 0; // 我們自己發起、還沒結束的地圖動畫數
let wakeLock = null;

export function getTrackState(){ return trackState; }

function setTrackState(next){
  trackState = next;
  if(locateMarkerEl) locateMarkerEl.classList.toggle('tracking', next !== 'off');
  if(!trackBtn) return;
  trackBtn.classList.toggle('tracking', next === 'following');
  trackBtn.classList.toggle('paused', next === 'paused');
  trackBtn.setAttribute('aria-pressed', next === 'off' ? 'false' : 'true');
  trackBtn.setAttribute('aria-label', TRACK_TITLES[next]);
  trackBtn.title = TRACK_TITLES[next];
}

function pauseFollowing(){
  setTrackState(nextTrackState(trackState, 'userMoved'));
}

// 自己讓地圖動畫移動，並記下「這支動畫是我們發起的」。callback 在動畫結束
// 或被下一支動畫打斷時都會被 OpenLayers 呼叫，計數才不會漏。刻意不用「這段
// 時間內的地圖移動都算自己的」這種時間窗口：畫面被暫停渲染（螢幕鎖定、切
// 分頁）時動畫會晚很久才真的跑完，時間窗口早就過了，會誤判成使用者操作。
function selfAnimate(view, options){
  pendingSelfAnims++;
  view.animate(options, () => { pendingSelfAnims = Math.max(0, pendingSelfAnims - 1); });
}

// 讓地圖跟到 coord。force=true（使用者主動按「回到目前位置」）時不檢查別人的動畫。
// 回傳是否真的移動了地圖。
function followTo(coord, { duration = TRACK_FOLLOW_MS, zoom, force = false } = {}){
  const view = map.getView();
  const animating = !!view.getAnimating?.();
  if(!animating) pendingSelfAnims = 0; // 沒有任何動畫在跑，殘留的計數一律歸零
  // 地圖正被「不是我們發起的」動畫移動（例如地址搜尋剛飛到別的地方）：不要
  // 把它搶回來，改成暫停跟隨，讓使用者看完他要看的地方。
  if(!force && animating && pendingSelfAnims === 0){
    pauseFollowing();
    return false;
  }
  const options = { center: coord, duration };
  if(zoom !== undefined) options.zoom = zoom;
  selfAnimate(view, options);
  return true;
}

async function acquireWakeLock(){
  try{
    if(!navigator.wakeLock || wakeLock) return;
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener?.('release', () => { wakeLock = null; });
  }catch{ wakeLock = null; /* 省電模式等情況會被拒絕，沒有螢幕常亮只是體驗差一點，不影響追蹤 */ }
}

function releaseWakeLock(){
  const lock = wakeLock;
  wakeLock = null;
  try{ lock?.release?.()?.catch?.(() => {}); }catch{ /* 略過 */ }
}

function onTrackFix(pos){
  const { latitude, longitude, accuracy } = pos.coords;
  const coord = ol.proj.fromLonLat([longitude, latitude]);
  lastTrackCoord = coord;
  trackErrorShown = false;
  trackBtn?.classList.remove('acquiring');
  locateOverlay.setPosition(coord);
  locateMarkerEl.classList.add('show');

  const first = trackFirstFix;
  trackFirstFix = false;
  // 只有第一筆定位才主動打開座標彈窗；之後只更新內容，使用者關掉就不再跳出來。
  renderLocateCoordInfo(latitude, longitude, accuracy, { reveal: first });
  if(trackState === 'following'){
    if(first) followTo(coord, { duration: 600, zoom: Math.max(map.getView().getZoom(), TRACK_MIN_ZOOM) });
    else followTo(coord);
  }
}

function geolocationErrorMessage(err){
  if(err.code === err.PERMISSION_DENIED) return '已拒絕位置權限，請至瀏覽器或系統設定允許此網站存取位置後再試一次。';
  if(err.code === err.POSITION_UNAVAILABLE) return '目前無法判斷您的位置。';
  if(err.code === err.TIMEOUT) return '定位逾時，請再試一次。';
  return '無法取得目前位置，請稍後再試。';
}

function onTrackError(err){
  if(err.code === err.PERMISSION_DENIED){
    stopTracking();
    showLocateToast(geolocationErrorMessage(err));
    return;
  }
  // 訊號時好時壞是常態（進隧道、樹林），watchPosition 會自己繼續嘗試，
  // 只在一段連續失敗的開頭提示一次，不要每次逾時都跳。
  if(!trackErrorShown){
    trackErrorShown = true;
    showLocateToast('定位訊號不穩，仍在嘗試取得位置…');
  }
}

function startTracking(){
  if(!navigator.geolocation?.watchPosition){
    showLocateToast('您的瀏覽器不支援定位功能。');
    return;
  }
  trackFirstFix = true;
  trackErrorShown = false;
  lastTrackCoord = null; // 上一次追蹤留下的位置已經過時，不能拿來判斷這次有沒有被移開
  trackBtn?.classList.add('acquiring');
  trackWatchId = navigator.geolocation.watchPosition(onTrackFix, onTrackError, {
    enableHighAccuracy: true, maximumAge: 5000, timeout: 20000
  });
  setTrackState('following');
  acquireWakeLock();
  showLocateToast('持續追蹤中，螢幕會保持亮起。拖曳地圖可暫停跟隨。');
}

function stopTracking(){
  if(trackWatchId !== null){
    navigator.geolocation.clearWatch(trackWatchId);
    trackWatchId = null;
  }
  trackBtn?.classList.remove('acquiring');
  releaseWakeLock();
  setTrackState(nextTrackState(trackState, 'stop'));
}

function onTrackButtonClick(){
  const next = nextTrackState(trackState, 'toggle');
  if(next === 'off'){
    stopTracking();
    showLocateToast('已停止追蹤位置');
  } else if(trackState === 'off'){
    startTracking();
  } else { // paused → following：立刻回到最後一次收到的位置
    setTrackState(next);
    if(lastTrackCoord) followTo(lastTrackCoord, { zoom: Math.max(map.getView().getZoom(), TRACK_MIN_ZOOM), force: true });
  }
}

function initTracking(){
  trackBtn = document.getElementById('trackBtn');
  if(!trackBtn) return;
  trackBtn.addEventListener('click', onTrackButtonClick);
  setTrackState('off');

  // 使用者自己動了地圖就要暫停跟隨，否則下一筆定位會把地圖硬拉回來，
  // 根本沒辦法看別處。三條偵測路徑，都不靠時間窗口：
  //   1. pointerdrag：拖曳的當下就暫停（等放開才判斷的話，拖到一半下一筆定位
  //      就會在手指底下把地圖拉走）。
  //   2. followTo() 發現別人的動畫在跑（例如地址搜尋飛過去）：見 followTo()。
  //   3. moveend：地圖停下來後，畫面中心離最後定位點太遠（滾輪縮放、鍵盤等）。
  map.on('pointerdrag', () => {
    if(trackState === 'following') pauseFollowing();
  });
  map.on('moveend', () => {
    if(trackState !== 'following' || !lastTrackCoord) return;
    const view = map.getView();
    if(view.getAnimating?.()) return;
    const center = view.getCenter();
    const resolution = view.getResolution?.();
    if(!center || !resolution) return;
    const driftPx = Math.hypot(center[0] - lastTrackCoord[0], center[1] - lastTrackCoord[1]) / resolution;
    if(driftPx > FOLLOW_DRIFT_PX) pauseFollowing();
  });

  // 螢幕鎖定／切到別的分頁時瀏覽器會自動釋放 Wake Lock，回來要重新要。
  document.addEventListener('visibilitychange', () => {
    if(document.visibilityState === 'visible' && trackState !== 'off') acquireWakeLock();
  });
}

/* ---------- 一次性定位 ---------- */

export function initLocateButton(){
  locateMarkerEl = document.getElementById('locateMarker');
  locateOverlay = new ol.Overlay({
    element: locateMarkerEl,
    positioning: 'center-center',
    stopEvent: false
  });
  map.addOverlay(locateOverlay);

  locateBtn = document.getElementById('locateBtn');
  locateToast = document.getElementById('locateToast');
  locatePopupEl = document.getElementById('locatePopup');
  locatePopupBody = document.getElementById('locatePopupBody');
  locatePopupCloseBtn = document.getElementById('locatePopupClose');
  if(locatePopupCloseBtn) locatePopupCloseBtn.addEventListener('click', closeLocatePopup);

  initTracking();

  locateBtn.addEventListener('click', ()=>{
    // 重入防護：上一次定位還在等待瀏覽器回應時（.loading 尚未移除）直接
    // 忽略這次點擊，避免快速連點同時發出多個 getCurrentPosition() 請求，
    // 導致畫面最終顯示哪個座標取決於「哪個請求最後回來」而非使用者最後
    // 一次點擊的意圖。
    if(locateBtn.classList.contains('loading')) return;
    if(!navigator.geolocation){
      showLocateToast('您的瀏覽器不支援定位功能。');
      return;
    }
    locateBtn.classList.add('loading');
    navigator.geolocation.getCurrentPosition(
      (pos)=>{
        locateBtn.classList.remove('loading');
        const coord = ol.proj.fromLonLat([pos.coords.longitude, pos.coords.latitude]);
        locateOverlay.setPosition(coord);
        locateMarkerEl.classList.add('show');
        renderLocateCoordInfo(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
        const view = map.getView();
        // 追蹤中按一次性定位＝使用者要看自己在哪：這支置中動畫算我們自己的，
        // 下一筆追蹤定位才不會把它當成別人的動畫而暫停跟隨。
        selfAnimate(view, { center: coord, zoom: Math.max(view.getZoom(), 15), duration: 600 });
      },
      (err)=>{
        locateBtn.classList.remove('loading');
        showLocateToast(geolocationErrorMessage(err));
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });
}
