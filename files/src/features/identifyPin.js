/* ---------------------------------------------------------
   features/identifyPin.js — 免開關地圖自由落點探針 (Identify Pin)
   ---------------------------------------------------------
   一般瀏覽模式下，直接點擊地圖任意處即可釘上一個 Pin 並跳出
   Popup，顯示座標資訊（WGS84／TWD97）、地址反查結果，以及一個
   「搜尋涵蓋此點之歷史圖層」的按鈕，不需要另外開關任何工具列。

   方案 A：分級點擊防禦（三態狀態機）——Pin 是否存在、彈窗是否開啟
   是兩個獨立的狀態：
     狀態一（Pin 存在＋彈窗開）：點地圖空白處只關彈窗，Pin 不動。
     狀態二（Pin 存在＋彈窗關）：點 Pin 本體重開彈窗（用快取資料，
       不重打地址反查 API）；點地圖空白處什麼都不做。
     狀態三（無 Pin）：點地圖空白處才會建立新 Pin；唯有彈窗內的
       「清除標記」按鈕能讓 Pin 消失、回到狀態三。
   identifyOverlay 用 stopEvent:true（刻意跟 location.js／
   ui/search.js 的既有 marker 不同），讓彈窗內任何點擊（關閉、
   複製、搜尋、清除標記）都不會冒泡到地圖 viewport，map 的
   singleclick 因此只會在「真正點擊地圖空白處」時觸發。

   跟其他模式（雙圖比對／多重疊加／時間軸特殊模式／繪圖工具啟用中／
   比對模式分隔線拖曳中）互斥：只要不是單純的一般瀏覽模式，點擊
   一律直接略過，不觸發落點，避免搶走那些模式原本的點擊行為。
--------------------------------------------------------- */
import { map } from '../core/map.js';
import { state as store } from '../store.js';
import { runtime } from '../runtime.js';
import { isDrawToolActive } from '../drawTool.js';
import { buildCoordInfoElement } from './search.js';
import { reverseGeocode } from '../geocode.js';

let identifyPinEl, identifyOverlay, identifyPopupEl, identifyPopupBody, identifyPopupCloseBtn, identifyPinMarkerBtn;

// Pin／地址反查的快取狀態：pinCoordinate 為 null 代表「無 Pin」（狀態三）。
let pinCoordinate = null;
let pinLonLat = null;
let addressState = { status: 'idle', text: '' };
let addressRequestId = 0;
let currentAddressEl = null;

function openPopup(){
  if(identifyPopupEl) identifyPopupEl.hidden = false;
}

function closePopup(){
  if(identifyPopupEl) identifyPopupEl.hidden = true;
}

function clearPin(){
  pinCoordinate = null;
  pinLonLat = null;
  addressState = { status: 'idle', text: '' };
  addressRequestId++; // 讓仍在飛行中的舊地址反查請求作廢
  currentAddressEl = null;
  if(identifyOverlay) identifyOverlay.setPosition(undefined);
  if(identifyPinEl) identifyPinEl.classList.remove('show');
  if(identifyPopupBody) identifyPopupBody.innerHTML = '';
  closePopup();
}

// Nominatim display_name 是逗點分隔、由小到大（"7號, 忠孝東路四段, 大安區, 台北市, 106, 臺灣"），
// 轉成台灣慣用的由大到小閱讀順序（"台北市大安區忠孝東路四段7號"）。
function formatTaiwanAddress(displayName){
  if(!displayName) return displayName;
  const parts = displayName.split(',')
    .map(s => s.trim())
    .filter(s => s && !/^\d+$/.test(s) && s !== '臺灣' && s !== '台灣');
  const formatted = parts.reverse().join('');
  return formatted || displayName;
}

function renderAddress(el, lon, lat, { forceFetch }){
  currentAddressEl = el;

  if(!forceFetch && (addressState.status === 'ok' || addressState.status === 'error')){
    el.textContent = addressState.text;
    return;
  }
  if(!forceFetch && addressState.status === 'loading'){
    // 上一次的請求還在飛行中，等它自己回來更新 currentAddressEl，不重送請求。
    el.textContent = '查詢地址中…';
    el.classList.add('loading');
    return;
  }

  addressState = { status: 'loading', text: '' };
  el.textContent = '查詢地址中…';
  el.classList.add('loading');
  const id = ++addressRequestId;
  reverseGeocode(lon, lat)
    .then(data => {
      if(id !== addressRequestId) return; // 已過期（清除或重新釘點了）
      const text = (data && data.display_name) ? formatTaiwanAddress(data.display_name) : '查無地址資訊';
      addressState = { status: 'ok', text, addr: (data && data.address) || null };
      if(currentAddressEl){ currentAddressEl.textContent = text; currentAddressEl.classList.remove('loading'); }
    })
    .catch(() => {
      if(id !== addressRequestId) return;
      addressState = { status: 'error', text: '地址查詢失敗' };
      if(currentAddressEl){ currentAddressEl.textContent = addressState.text; currentAddressEl.classList.remove('loading'); }
    });
}

function buildAddressBlock(lon, lat, forceFetch){
  const p = document.createElement('p');
  p.className = 'identify-address';
  renderAddress(p, lon, lat, { forceFetch });
  return p;
}

function buildSearchButton(lon, lat, addressEl, onSearchLayers){
  if(!onSearchLayers) return null;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'identify-search-btn';
  btn.textContent = '搜尋涵蓋此點之歷史圖層';
  btn.addEventListener('click', () => {
    const addrText = addressEl ? addressEl.textContent : '';
    const label = addrText && addrText !== '查詢地址中…' && addrText !== '查無地址資訊' && addrText !== '地址查詢失敗'
      ? addrText
      : `經緯度 ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    onSearchLayers(lon, lat, label, addressState.addr || {});
  });
  return btn;
}

let onSearchLayersCb = null;

// 重繪彈窗內容：forceFetch=true 代表全新落點（一定要重打地址反查），
// forceFetch=false 代表重開已存在的 Pin（沿用快取，見 renderAddress）。
function renderPopupContent({ forceFetch }){
  if(!identifyPopupBody || !pinLonLat) return;
  const [lon, lat] = pinLonLat;
  identifyPopupBody.innerHTML = '';
  identifyPopupBody.appendChild(buildCoordInfoElement(lat, lon));

  const addressEl = buildAddressBlock(lon, lat, forceFetch);
  identifyPopupBody.appendChild(addressEl);

  const searchBtn = buildSearchButton(lon, lat, addressEl, onSearchLayersCb);
  if(searchBtn) identifyPopupBody.appendChild(searchBtn);
}

function createPinAt(coordinate){
  pinCoordinate = coordinate;
  pinLonLat = ol.proj.toLonLat(coordinate);
  addressState = { status: 'idle', text: '' };
  addressRequestId++; // 讓任何仍在飛行中的舊請求作廢

  map.getView().animate({ center: coordinate, duration: 250 });
  identifyOverlay.setPosition(coordinate);
  identifyPinEl.classList.add('show');

  renderPopupContent({ forceFetch: true });
  openPopup();
}

function reopenPopup(){
  if(!pinLonLat) return; // 沒有 Pin 就沒東西可以重開
  renderPopupContent({ forceFetch: false });
  openPopup();
}

/** main.js 啟動流程呼叫一次即可。
 * @param {{ onSearchLayers?: (lon:number, lat:number, label:string, addr:object) => void }} opts
 *   onSearchLayers：點擊「搜尋涵蓋此點之歷史圖層」按鈕時呼叫，實際的搜尋渲染
 *   邏輯屬於 ui 層，由 main.js 組裝時注入，這裡不 import 任何 src/ui/*。
 *   addr 務必傳 Nominatim addressdetails=1 回傳的結構化地址元件物件
 *   （例如 {county, city, town, village, ...}），不能傳格式化過的顯示字串，
 *   否則 matchSourceIdsForAddress／extractPlaceKeywords 的文字比對會全部失效。
 */
export function initIdentifyPin({ onSearchLayers } = {}){
  identifyPinEl = document.getElementById('identifyPin');
  if(!identifyPinEl) return; // DOM 尚未加入，靜默跳過

  onSearchLayersCb = onSearchLayers || null;
  identifyPopupEl = document.getElementById('identifyPopup');
  identifyPopupBody = document.getElementById('identifyPopupBody');
  identifyPopupCloseBtn = document.getElementById('identifyPopupClose');
  identifyPinMarkerBtn = document.getElementById('identifyPinMarker');

  identifyOverlay = new ol.Overlay({
    element: identifyPinEl,
    positioning: 'center-center',
    stopEvent: true
  });
  map.addOverlay(identifyOverlay);

  if(identifyPopupCloseBtn){
    identifyPopupCloseBtn.addEventListener('click', closePopup);
  }
  const identifyPopupClearBtn = document.getElementById('identifyPopupClear');
  if(identifyPopupClearBtn){
    identifyPopupClearBtn.addEventListener('click', clearPin);
  }
  if(identifyPinMarkerBtn){
    identifyPinMarkerBtn.addEventListener('click', reopenPopup);
  }

  // 地圖右鍵點擊：判斷依據改為「Pin 點資訊欄位（Popup）目前是否開啟」，
  // 而非側邊欄收合狀態。規則：Popup 開啟時右鍵只關閉 Popup（跟左鍵點擊
  // 地圖空白處關閉 Popup 的行為一致）；只有在 Popup 已關閉的情況下再次
  // 右鍵，才真的清除 Pin（跟「清除標記」按鈕共用同一個 clearPin，避免
  // 重寫一份清除邏輯）。沒有 Pin 時右鍵不做任何事。OL Map 本身不會轉發
  // contextmenu 事件，需直接對 viewport 掛原生事件監聽。
  map.getViewport().addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if(!pinCoordinate) return;
    if(identifyPopupEl && !identifyPopupEl.hidden){
      closePopup();
    } else {
      clearPin();
    }
  });

  map.on('singleclick', (e) => {
    // 模式互斥避讓：非一般瀏覽模式／繪圖工具啟用中／比對模式分隔線拖曳中
    // 一律不觸發落點，避免搶走這些模式原本的點擊行為。
    if(store.mode !== 'overlay') return;
    if(isDrawToolActive()) return;
    if(runtime.dragging) return;

    // 方案 A 三態狀態機：Pin 已存在時，點地圖空白處絕不能移動/重建 Pin，
    // 頂多順手關掉彈窗（狀態一 -> 狀態二）；彈窗已關時則完全不動作（狀態二）。
    // 只有在完全沒有 Pin 的狀態三，點空白處才會建立新落點。
    if(pinCoordinate){
      if(identifyPopupEl && !identifyPopupEl.hidden) closePopup();
      return;
    }

    createPinAt(e.coordinate);
  });
}
