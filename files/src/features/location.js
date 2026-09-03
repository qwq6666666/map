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

let locateMarkerEl, locateOverlay, locateBtn, locateToast;

export function showLocateToast(msg){
  locateToast.textContent = msg;
  locateToast.classList.add('show');
  if(runtime.locateToastTimer) clearTimeout(runtime.locateToastTimer);
  runtime.locateToastTimer = setTimeout(()=> locateToast.classList.remove('show'), 4500);
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

  locateBtn.addEventListener('click', ()=>{
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
