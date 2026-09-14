/* ---------------------------------------------------------
   features/location.js — 定位功能
   ---------------------------------------------------------
   從 mapCore.js 拆出來的定位功能：取得目前位置、在地圖上標示
   藍點、定位失敗時的提示訊息。跟「目前顯示哪個歷史圖層」完全
   無關，所以獨立成一個 feature 模組，只依賴 core/map.js 的
   map 實例。

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

// 定位成功後，在獨立的彈窗卡片（#locatePopup）顯示座標資訊（WGS84／TWD97 各一行＋複製按鈕），
// 而非塞進 0 寬高的 #locateMarker（比照 identifyPin.js 的彈窗模式，避免版面被擠壓變形）。
// 每次定位成功都先清空 popup body，避免重複點擊定位按鈕時越疊越多，並重新顯示彈窗
// （就算使用者先前手動關閉過也一樣，跟現有行為一致）。
function renderLocateCoordInfo(lat, lon){
  locatePopupBody.innerHTML = '';
  locatePopupBody.appendChild(buildCoordRow('WGS84', formatWGS84(lat, lon)));
  const { x, y } = toTWD97(lat, lon);
  locatePopupBody.appendChild(buildCoordRow('TWD97', formatTWD97(x, y)));
  locatePopupEl.hidden = false;
}

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
        renderLocateCoordInfo(pos.coords.latitude, pos.coords.longitude);
        const view = map.getView();
        view.animate({ center: coord, zoom: Math.max(view.getZoom(), 15), duration: 600 });
      },
      (err)=>{
        locateBtn.classList.remove('loading');
        let msg = '無法取得目前位置，請稍後再試。';
        if(err.code === err.PERMISSION_DENIED) msg = '已拒絕位置權限，請至瀏覽器或系統設定允許此網站存取位置後再試一次。';
        else if(err.code === err.POSITION_UNAVAILABLE) msg = '目前無法判斷您的位置。';
        else if(err.code === err.TIMEOUT) msg = '定位逾時，請再試一次。';
        showLocateToast(msg);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });
}
