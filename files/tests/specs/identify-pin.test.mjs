import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue, sleep } from '../assert.mjs';

/* ---------------------------------------------------------
   env-stub.mjs 的假 ol.Map 只實作了 on('moveend', ...)（見
   tests/env-stub.mjs 的 FakeMap.on()），沒有一般化到任意事件，
   而 identifyPin.js 用的是 map.on('singleclick', ...)。

   這裡在「匯入任何會建立 map 單例的模組之前」，先把
   ol.Map.prototype.on 補成通用版本（同時保留原本行為，讓
   moveend 監聽依舊照舊被存進 _moveendHandlers，不影響其他測試檔
   案已經驗證過的行為），額外把每個事件的監聽函式都存進
   map._handlers[事件名稱]，讓測試可以之後手動觸發
   map._handlers.singleclick 裡註冊的 handler，等同「模擬使用者
   點擊地圖」。這只是這份測試檔內的區域性補強，並未更動
   tests/env-stub.mjs 檔案本身，也沒有改動 src/ 任何一行程式碼。

   之所以要用 dynamic import() 而不是一般的 import 語句：ESM 的
   import 宣告會在模組求值最前面就先跑完，如果用一般 import 去載入
   drawTool.js／identifyPin.js（兩者都會連帶匯入 core/map.js、
   在匯入當下就 new 出唯一一顆 map 實例），會搶在下面這段補丁套用
   之前就先建立好 map，屆時再補丁就來不及了。
--------------------------------------------------------- */
const originalOn = globalThis.ol.Map.prototype.on;
globalThis.ol.Map.prototype.on = function(ev, fn){
  this._handlers = this._handlers || {};
  (this._handlers[ev] = this._handlers[ev] || []).push(fn);
  return originalOn.call(this, ev, fn);
};

const { state: store, setMode } = await import('../../src/store.js');
const { runtime } = await import('../../src/runtime.js');
const { isDrawToolActive, initDrawTool } = await import('../../src/drawTool.js');
const { initIdentifyPin } = await import('../../src/features/identifyPin.js');
const { map } = await import('../../src/core/map.js');

// 模擬 index.html 裡 #drawToolbar 底下「點」工具的按鈕結構，跟
// tests/specs/draw-tool.test.mjs 用同一套手法。
const toolbar = document.getElementById('drawToolbar');
const pointBtn = document.createElement('button');
pointBtn.className = 'draw-tool-btn';
pointBtn.dataset.tool = 'point';
toolbar.appendChild(pointBtn);
initDrawTool();

function clickPointTool(){
  pointBtn._listeners['click'][0]();
}

const searchCalls = [];
initIdentifyPin({
  onSearchLayers: (lon, lat, label, addr) => searchCalls.push({ lon, lat, label, addr })
});

const identifyPinEl = document.getElementById('identifyPin');
const identifyPopupBody = document.getElementById('identifyPopupBody');
const identifyPopupCloseBtn = document.getElementById('identifyPopupClose');
const identifyPopupEl = document.getElementById('identifyPopup');
const identifyPinMarkerBtn = document.getElementById('identifyPinMarker');
const identifyPopupClearBtn = document.getElementById('identifyPopupClear');

// 包一層 fetch 呼叫次數計數器，用來驗證「重開彈窗時沿用快取，不重打
// reverseGeocode（地址反查）API」——env-stub.mjs 的 fetch 對非本機檔案
// 的網址（Nominatim 那種 https:// 網址）一定會擲出例外變成 rejected
// promise，identifyPin.js 內部會 catch 起來變成「地址查詢失敗」的快取
// 文字，不影響這裡只在意「呼叫次數有沒有增加」的檢查。
let fetchCallCount = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (...args) => {
  fetchCallCount++;
  return originalFetch(...args);
};

const COORD = [121.5, 25.05]; // ol.proj.toLonLat 在假環境裡是原樣傳回，等同 [lon, lat]

function triggerSingleClick(coordinate = COORD){
  (map._handlers.singleclick || []).forEach(fn => fn({ coordinate }));
}

test('isDrawToolActive()：預設沒有選任何繪圖工具時回傳 false', () => {
  assertEqual(isDrawToolActive(), false, '預設不應有啟用中的繪圖工具');
});

test('isDrawToolActive()：點擊「點」工具啟用後回傳 true', () => {
  clickPointTool();
  assertEqual(isDrawToolActive(), true, '啟用點工具後應回傳 true');
  clickPointTool(); // 再點一次取消，恢復成單純瀏覽狀態，避免影響後面的測試
  assertEqual(isDrawToolActive(), false, '再點一次應取消選取');
});

test('非疊圖模式（store.mode !== "overlay"）時，點擊地圖不會顯示 Pin', () => {
  setMode('compare');
  triggerSingleClick();
  assertTrue(!identifyPinEl.classList.contains('show'), '非一般瀏覽模式不應顯示 Pin');
  setMode('overlay'); // 還原
});

test('繪圖工具啟用中時，點擊地圖不會顯示 Pin', () => {
  clickPointTool();
  assertEqual(isDrawToolActive(), true, '前置條件：點工具應為啟用中');
  triggerSingleClick();
  assertTrue(!identifyPinEl.classList.contains('show'), '繪圖工具啟用中不應顯示 Pin');
  clickPointTool(); // 還原
  assertEqual(isDrawToolActive(), false, '還原：點工具應已取消');
});

test('比對模式分隔線拖曳中（runtime.dragging）時，點擊地圖不會顯示 Pin', () => {
  runtime.dragging = true;
  triggerSingleClick();
  assertTrue(!identifyPinEl.classList.contains('show'), '拖曳分隔線中不應顯示 Pin');
  runtime.dragging = false; // 還原
});

test('一般瀏覽模式、無繪圖工具、無拖曳時，點擊地圖會顯示 Pin 並帶出座標資訊與搜尋按鈕', () => {
  assertEqual(store.mode, 'overlay', '前置條件：應為一般瀏覽模式');
  assertEqual(isDrawToolActive(), false, '前置條件：不應有啟用中的繪圖工具');
  assertEqual(runtime.dragging, false, '前置條件：不應在拖曳中');

  triggerSingleClick();

  assertTrue(identifyPinEl.classList.contains('show'), '應該顯示 Pin');
  const coordInfo = identifyPopupBody.querySelector('.coord-info');
  assertTrue(!!coordInfo, 'Popup 內應該有座標資訊區塊（.coord-info）');
  const searchBtn = identifyPopupBody.querySelector('.identify-search-btn');
  assertTrue(!!searchBtn, 'Popup 內應該有「搜尋涵蓋此點之歷史圖層」按鈕');
});

test('點擊關閉按鈕（×）：只關閉彈窗，Pin 本體與內容維持不變（狀態一 -> 狀態二）', () => {
  assertEqual(identifyPopupEl.hidden, false, '前置條件：Popup 應該是開啟中');
  const bodyHTMLBefore = identifyPopupBody.innerHTML;

  identifyPopupCloseBtn.click();

  assertEqual(identifyPopupEl.hidden, true, '關閉按鈕應該讓 Popup 隱藏');
  assertTrue(identifyPinEl.classList.contains('show'), '關閉彈窗後 Pin 本體應該維持顯示，不會被移除');
  assertEqual(identifyPopupBody.innerHTML, bodyHTMLBefore, '關閉彈窗不應該清空或改變 Popup 內容');
});

test('彈窗關閉、Pin 存在時，點擊 Pin 本體會重開彈窗，且沿用快取不重打地址反查 API（狀態二 -> 狀態一）', async () => {
  assertEqual(identifyPopupEl.hidden, true, '前置條件：Popup 應該是關閉中');
  await sleep(50); // 讓上一輪必定失敗的地址反查先落定成快取文字，方便比對

  const addressElBefore = identifyPopupBody.querySelector('.identify-address');
  const cachedAddressText = addressElBefore ? addressElBefore.textContent : null;
  const fetchCountBefore = fetchCallCount;

  identifyPinMarkerBtn.click();

  assertEqual(identifyPopupEl.hidden, false, '點擊 Pin 本體應該重新開啟彈窗');
  assertEqual(fetchCallCount, fetchCountBefore, '重開彈窗不應該重新呼叫地址反查 API');
  const addressElAfter = identifyPopupBody.querySelector('.identify-address');
  assertTrue(!!addressElAfter, '重開後應該仍有地址資訊區塊');
  assertEqual(addressElAfter.textContent, cachedAddressText, '重開彈窗應該沿用快取的地址文字');
});

test('Pin 存在、彈窗開啟時，點擊地圖空白處只關閉彈窗，Pin 不受影響（狀態一 -> 狀態二）', () => {
  assertEqual(identifyPopupEl.hidden, false, '前置條件：Popup 應該是開啟中');
  const bodyHTMLBefore = identifyPopupBody.innerHTML;

  triggerSingleClick([121.6, 25.1]); // 模擬點擊地圖上的別處空白處

  assertEqual(identifyPopupEl.hidden, true, '點擊地圖空白處應該關閉彈窗');
  assertTrue(identifyPinEl.classList.contains('show'), 'Pin 本體不應該被移除');
  assertEqual(identifyPopupBody.innerHTML, bodyHTMLBefore, 'Pin 的內容不應該被重建（沒有重新反查地址）');
});

test('彈窗關閉、Pin 存在時，再次點擊地圖空白處什麼都不會發生（狀態二 -> 狀態二）', () => {
  assertEqual(identifyPopupEl.hidden, true, '前置條件：Popup 應該是關閉中');
  const bodyHTMLBefore = identifyPopupBody.innerHTML;

  triggerSingleClick([121.7, 25.2]); // 再次模擬點擊別處空白地圖

  assertTrue(identifyPinEl.classList.contains('show'), 'Pin 應該完全不受影響，維持顯示');
  assertEqual(identifyPopupEl.hidden, true, 'Popup 應該維持關閉狀態');
  assertEqual(identifyPopupBody.innerHTML, bodyHTMLBefore, 'Popup 內容不應該被改變');
});

test('點擊彈窗內「清除點位」按鈕會真正清除 Pin，之後點地圖才會建立新 Pin（狀態二 -> 狀態三 -> 狀態一）', () => {
  const clearBtn = identifyPopupClearBtn;
  assertTrue(!!clearBtn, '前置條件：Popup header 內應該要有清除點位按鈕');

  clearBtn.click();

  assertTrue(!identifyPinEl.classList.contains('show'), '點擊清除標記後 Pin 應該消失');
  assertEqual(identifyPopupBody.children.length, 0, '點擊清除標記後 Popup 內容應該被清空');
  assertEqual(identifyPopupEl.hidden, true, '點擊清除標記後 Popup 應該回到關閉狀態');

  triggerSingleClick(COORD); // 回到狀態三後，點擊地圖空白處應該要能建立新 Pin

  assertTrue(identifyPinEl.classList.contains('show'), '清除後再點地圖應該要能重新建立 Pin');
  assertEqual(identifyPopupEl.hidden, false, '重新建立的 Pin 應該會自動開啟彈窗');
});

test('點擊「搜尋涵蓋此點之歷史圖層」按鈕會呼叫 onSearchLayers，並帶入正確的經緯度', () => {
  const searchBtn = identifyPopupBody.querySelector('.identify-search-btn');
  assertTrue(!!searchBtn, '前置條件：應該有搜尋按鈕可以點擊');

  searchBtn.click();

  assertEqual(searchCalls.length, 1, '應該呼叫過一次 onSearchLayers');
  const [lon, lat] = COORD;
  assertEqual(searchCalls[0].lon, lon, 'onSearchLayers 帶入的經度');
  assertEqual(searchCalls[0].lat, lat, 'onSearchLayers 帶入的緯度');
});

await run();
