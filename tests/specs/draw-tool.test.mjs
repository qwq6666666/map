import '../env-stub.mjs';
import { test, expect, vi } from 'vitest';
import { sleep } from '../helpers.mjs';
import { loadAppData } from '../../src/data.js';
import { initMapCore, map } from '../../src/mapCore.js';
import { initSidebar } from '../../src/sidebarUI.js';
import { initSearchUI } from '../../src/searchUI.js';
import { initDrawTool, exportGeoJSON, exportImage, shareImage } from '../../src/drawTool.js';
import { setRendercompleteAutoFire } from '../env-stub.mjs';
import { runtime } from '../../src/runtime.js';

// 站內對話框（ui/dialog.js）在假 DOM 裡沒有人會去點按鈕，這裡換成可控的
// 假實作：dialogMock.answer 就是使用者在名稱對話框輸入的文字（null＝略過）。
// 對話框本身的行為由 dialog.test.mjs 驗證。
const dialogMock = vi.hoisted(() => ({ answer: '', lastMessage: null, alerts: [] }));
vi.mock('../../src/ui/dialog.js', () => ({
  showPrompt: async (message) => { dialogMock.lastMessage = message; return dialogMock.answer; },
  showConfirm: async () => true,
  showAlert: async (message) => { dialogMock.alerts.push(message); },
}));

await loadAppData();
initMapCore();
initSidebar();
initSearchUI();

// 模擬 index.html 裡 #drawToolbar 底下的按鈕結構（測試環境沒有真的
// HTML 解析器，正式瀏覽器會自動處理）
const toolbar = document.getElementById('drawToolbar');
const toolBtns = {};
['point', 'line', 'polygon', 'select'].forEach(t => {
  const b = document.createElement('button');
  b.className = 'draw-tool-btn';
  b.dataset.tool = t;
  toolbar.appendChild(b);
  toolBtns[t] = b;
});
initDrawTool();

function makeFakeFeature(geomProps){
  return {
    _props: {},
    set(k, v){ this._props[k] = v; },
    get(k){ return this._props[k]; },
    getGeometry(){ return geomProps; },
  };
}

// 點工具按鈕會「再點一次取消」，測試之間不能只靠單純點擊一次去假設
// 一定會選中；用這個小工具確保不管前面測試留下什麼狀態，選完之後
// 這個工具一定是啟用中的。
function ensureToolActive(tool){
  toolBtns[tool]._listeners['click'][0]();
  if(!toolBtns[tool].classList.contains('active')){
    toolBtns[tool]._listeners['click'][0]();
  }
}

test('點擊「線」工具後，地圖上會加上對應的繪圖 interaction', () => {
  const before = map._interactions.length;
  ensureToolActive('line');
  expect(map._interactions.length > before, '應該多一個 interaction').toBeTruthy();
});

test('畫完一條線，自動算出長度並顯示（例如 1234.5 公尺 → 1.23 公里）', async () => {
  dialogMock.answer = ''; // 不輸入名稱
  ensureToolActive('line');
  const drawInteraction = map._interactions[map._interactions.length - 1];
  const feature = makeFakeFeature({ _length: 1234.5 });
  drawInteraction.simulateDrawEnd(feature);
  await sleep(0);
  expect(feature.get('kind'), 'kind').toBe('line');
  expect(feature.get('label'), 'label 應該是自動算出的長度').toBe('1.23 公里');
});

test('畫線時輸入名稱，會跟長度合併顯示成「名稱（長度）」', async () => {
  dialogMock.answer = '西門溝';
  ensureToolActive('line');
  const drawInteraction = map._interactions[map._interactions.length - 1];
  const feature = makeFakeFeature({ _length: 500 });
  drawInteraction.simulateDrawEnd(feature);
  await sleep(0);
  expect(feature.get('name'), 'name').toBe('西門溝');
  expect(feature.get('label'), 'label 應該合併名稱與長度').toBe('西門溝（500.0 公尺）');
});

test('名稱對話框還沒回應時，圖形已經先有量測值；按「略過」（null）維持只顯示量測值', async () => {
  dialogMock.answer = null;
  ensureToolActive('line');
  const drawInteraction = map._interactions[map._interactions.length - 1];
  const feature = makeFakeFeature({ _length: 500 });
  drawInteraction.simulateDrawEnd(feature);
  expect(feature.get('label'), '對話框 await 之前就該有量測值').toBe('500.0 公尺');
  await sleep(0);
  expect(feature.get('name'), '略過後不該有名稱').toBe('');
  expect(feature.get('label'), '略過後仍只顯示量測值').toBe('500.0 公尺');
});

test('名稱前後空白會被去掉；全空白視同沒輸入', async () => {
  ensureToolActive('line');
  const drawInteraction = map._interactions[map._interactions.length - 1];

  dialogMock.answer = '  舊鐵道  ';
  const named = makeFakeFeature({ _length: 500 });
  drawInteraction.simulateDrawEnd(named);
  await sleep(0);
  expect(named.get('name'), 'name 應去除前後空白').toBe('舊鐵道');

  dialogMock.answer = '   ';
  const blank = makeFakeFeature({ _length: 500 });
  drawInteraction.simulateDrawEnd(blank);
  await sleep(0);
  expect(blank.get('name'), '全空白視同沒輸入').toBe('');
});

test('畫完一個面，自動算出面積（25000 平方公尺 → 2.50 公頃）', async () => {
  dialogMock.answer = '';
  ensureToolActive('polygon');
  const drawInteraction = map._interactions[map._interactions.length - 1];
  const feature = makeFakeFeature({ _area: 25000 });
  drawInteraction.simulateDrawEnd(feature);
  await sleep(0);
  expect(feature.get('kind'), 'kind').toBe('polygon');
  expect(feature.get('label'), 'label 應該是自動算出的面積').toBe('2.50 公頃');
});

test('畫點時輸入的說明文字，直接當作 label', async () => {
  dialogMock.answer = '這是一個標記';
  ensureToolActive('point');
  const drawInteraction = map._interactions[map._interactions.length - 1];
  const feature = makeFakeFeature({});
  drawInteraction.simulateDrawEnd(feature);
  await sleep(0);
  expect(feature.get('kind'), 'kind').toBe('point');
  expect(feature.get('label'), 'label').toBe('這是一個標記');
});

test('名稱對話框開著時切換工具，圖形的 kind 仍是畫的當下那個（不受之後切換影響）', async () => {
  dialogMock.answer = '';
  ensureToolActive('line');
  const drawInteraction = map._interactions[map._interactions.length - 1];
  const feature = makeFakeFeature({ _length: 100 });
  drawInteraction.simulateDrawEnd(feature);
  ensureToolActive('point'); // 對話框還沒回應（await 之前）就切換工具
  await sleep(0);
  expect(feature.get('kind'), 'kind 應維持 line').toBe('line');
});

test('匯出 GeoJSON 會產生正確的座標系設定（EPSG:3857 -> EPSG:4326）', () => {
  let downloadedContent = null;
  const OriginalBlob = globalThis.Blob;
  globalThis.Blob = class extends OriginalBlob {
    constructor(parts, opts){ super(parts, opts); downloadedContent = parts[0]; }
  };
  const originalCreateElement = document.createElement;
  document.createElement = function(tag){
    const el = originalCreateElement.call(document, tag);
    if(tag === 'a') el.click = () => {};
    return el;
  };
  exportGeoJSON();
  document.createElement = originalCreateElement;
  expect(!!downloadedContent, '應該有產生下載內容').toBeTruthy();
  const parsed = JSON.parse(downloadedContent);
  expect(parsed.opts.featureProjection, 'featureProjection').toBe('EPSG:3857');
  expect(parsed.opts.dataProjection, 'dataProjection').toBe('EPSG:4326');
  expect(parsed.features.length > 0, '應該有至少一筆圖形（前面測試已經畫了好幾筆）').toBeTruthy();
});

test('沒有選取任何圖形時點擊「刪除」，會顯示提示 toast 而不是靜默無反應', () => {
  const toast = document.getElementById('drawStorageToast');
  toast.classList.remove('show');
  toast.textContent = '';
  ensureToolActive('select'); // 確保有進入 select 工具、selectInteraction 已建立，但沒有任何圖形被選取
  document.getElementById('drawDeleteBtn').click();
  expect(toast.classList.contains('show'), '應該顯示提示 toast').toBeTruthy();
  expect(toast.textContent.length > 0, '提示文字不應該是空字串').toBeTruthy();
});

test('exportImage()：rendercomplete 事件沒有觸發時，400ms 逾時保險仍會擷取畫面', async () => {
  const originalCreateObjectURL = globalThis.URL.createObjectURL;
  let createObjectURLCalled = false;
  globalThis.URL.createObjectURL = (...args) => { createObjectURLCalled = true; return originalCreateObjectURL(...args); };
  setRendercompleteAutoFire(false);
  try{
    exportImage();
    await new Promise(r => setTimeout(r, 450)); // 等超過 400ms 逾時保險觸發
    expect(createObjectURLCalled, '逾時保險應該還是有觸發 doCapture()，走到下載流程呼叫 URL.createObjectURL').toBeTruthy();
  } finally {
    setRendercompleteAutoFire(true);
    globalThis.URL.createObjectURL = originalCreateObjectURL;
  }
});

test('exportImage()：rendercomplete 事件正常觸發時，會立即擷取畫面（不用等逾時保險）', async () => {
  const originalCreateObjectURL = globalThis.URL.createObjectURL;
  let createObjectURLCalled = false;
  globalThis.URL.createObjectURL = (...args) => { createObjectURLCalled = true; return originalCreateObjectURL(...args); };
  try{
    exportImage(); // FakeMap.once('rendercomplete', fn) 預設同步立即觸發
    expect(createObjectURLCalled, 'rendercomplete 同步觸發時應該立刻呼叫 doCapture()，不用等 setTimeout').toBeTruthy();
  } finally {
    globalThis.URL.createObjectURL = originalCreateObjectURL;
  }
});

// 截圖「出處資訊列」：輸出圖片比純地圖畫面更高；開關偏好存 localStorage。
// FakeCanvas.toBlob 回傳 { size: 寬×高 }，經 downloadBlob() 傳給
// URL.createObjectURL，這裡攔下來就能比較輸出尺寸。
function captureExportedSize(){
  const originalCreateObjectURL = globalThis.URL.createObjectURL;
  let size = null;
  globalThis.URL.createObjectURL = (blob) => { size = blob.size; return 'blob:fake'; };
  try{ exportImage(); } // rendercomplete 預設同步觸發
  finally{ globalThis.URL.createObjectURL = originalCreateObjectURL; }
  return size;
}

test('截圖預設附出處資訊列（輸出圖片比純地圖畫面高）；按「附出處資訊列」關閉後恢復純地圖尺寸並記住偏好', () => {
  const toggle = document.getElementById('drawExportInfoToggle');
  expect(toggle.classList.contains('active'), '預設開啟').toBe(true);
  expect(toggle.getAttribute('aria-pressed')).toBe('true');
  const withBand = captureExportedSize();

  toggle.click();
  expect(toggle.classList.contains('active'), '關閉後取消 active').toBe(false);
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  expect(localStorage.getItem('hundredYearMap:exportInfoBand')).toBe('0');
  const withoutBand = captureExportedSize();
  expect(withBand > withoutBand, `有資訊列 ${withBand} 應大於純地圖 ${withoutBand}`).toBe(true);

  toggle.click(); // 還原，不影響其他測試
  expect(localStorage.getItem('hundredYearMap:exportInfoBand')).toBe('1');
  expect(captureExportedSize()).toBe(withBand);
});

/* ---------- shareImage()：叫出系統分享面板傳送截圖 ---------- */

const errorNamed = (name) => Object.assign(new Error(name), { name });

// 攔下下載（URL.createObjectURL）與分享（navigator.share）兩條出口，回傳結果供斷言。
// share=null 代表環境完全沒有 navigator.share。
async function runShareImage({ share }){
  const originalCreateObjectURL = globalThis.URL.createObjectURL;
  const out = { downloads: 0, shared: null, blobSize: null };
  globalThis.URL.createObjectURL = (blob) => { out.downloads++; out.blobSize = blob.size; return 'blob:fake'; };
  if(share){
    navigator.share = async (data) => { out.shared = data; await share(data); };
    navigator.canShare = () => true;
  }
  dialogMock.alerts.length = 0;
  try{
    shareImage();
    await sleep(20); // 截圖 → File → navigator.share → 備援，全是微任務，給一點時間跑完
  } finally {
    globalThis.URL.createObjectURL = originalCreateObjectURL;
    delete navigator.share;
    delete navigator.canShare;
  }
  return out;
}

test('shareImage：支援檔案分享時把 PNG 交給分享面板，不下載也不跳提示', async () => {
  const r = await runShareImage({ share: async () => {} });
  expect(r.shared.files.length).toBe(1);
  expect(r.shared.files[0].type).toBe('image/png');
  expect(r.shared.files[0].name).toMatch(/^地圖截圖_\d{8}_\d{4}\.png$/);
  expect(r.downloads).toBe(0);
  expect(dialogMock.alerts).toEqual([]);
});

test('shareImage：使用者關掉分享面板（AbortError）＝取消，不下載也不提示', async () => {
  const r = await runShareImage({ share: async () => { throw errorNamed('AbortError'); } });
  expect(r.downloads).toBe(0);
  expect(dialogMock.alerts).toEqual([]);
});

test('shareImage：手勢過期被擋下（NotAllowedError）時改為下載圖片並告知', async () => {
  const r = await runShareImage({ share: async () => { throw errorNamed('NotAllowedError'); } });
  expect(r.downloads).toBe(1);
  expect(dialogMock.alerts.length).toBe(1);
  expect(dialogMock.alerts[0]).toContain('已改為下載圖片');
});

test('shareImage：環境不支援分享（沒有 navigator.share）時改為下載圖片並告知', async () => {
  const r = await runShareImage({ share: null });
  expect(r.shared).toBeNull();
  expect(r.downloads).toBe(1);
  expect(dialogMock.alerts[0]).toContain('已改為下載圖片');
});

test('shareImage 與「地圖截圖」走同一條截圖流程：出處資訊列開關同樣影響分享的圖片尺寸', async () => {
  // FakeCanvas 的 blob 大小＝寬×高。走下載備援（share:null）才拿得到 blob 尺寸。
  const toggle = document.getElementById('drawExportInfoToggle');
  const withBand = (await runShareImage({ share: null })).blobSize;
  toggle.click(); // 關閉資訊列
  const withoutBand = (await runShareImage({ share: null })).blobSize;
  toggle.click(); // 還原
  expect(withBand > withoutBand, `有資訊列 ${withBand} 應大於純地圖 ${withoutBand}`).toBe(true);
});

// 手機專屬：工具列標題列的關閉鈕（#drawToolbarCloseBtn）。手機的 #drawToggleBtn 浮動鈕
// 被 CSS 藏起來，原本要關閉繪圖只能再打開「地圖工具」選單點一次；現在工具列自己就能關。
test('工具列關閉鈕：關掉工具列、浮動鈕回到非啟用，並結束目前選的繪圖工具', () => {
  const toggleBtn = document.getElementById('drawToggleBtn');
  const closeBtn = document.getElementById('drawToolbarCloseBtn');
  expect(closeBtn._listeners?.click?.length, '關閉鈕應該綁了點擊事件').toBeGreaterThan(0);

  if(!toolbar.classList.contains('show')) toggleBtn._listeners['click'][0]();
  expect(toolbar.classList.contains('show')).toBe(true);
  ensureToolActive('line');
  expect(toolBtns.line.classList.contains('active')).toBe(true);

  closeBtn._listeners['click'][0]();
  expect(toolbar.classList.contains('show'), '工具列應該關閉').toBe(false);
  expect(toggleBtn.classList.contains('active'), '浮動鈕不再是啟用狀態').toBe(false);
  expect(toolBtns.line.classList.contains('active'), '目前工具應該一併結束').toBe(false);

  // 已經關著再點關閉鈕不會又打開（不是切換，是「關閉」）
  closeBtn._listeners['click'][0]();
  expect(toolbar.classList.contains('show')).toBe(false);
});

// 刪除/清空快取等操作會觸發 drawTool.js 的 showStorageToast()，留下一顆
// 真實的 setTimeout(2500ms)。不清掉的話 Node process 要等它自然到期
// 才會結束，讓這支測試檔平白多花 2.5 秒 wall time 卻沒有驗證任何額外
// 邏輯。
if(runtime.drawStorageToastTimer) clearTimeout(runtime.drawStorageToastTimer);

/* ---------------------------------------------------------
   改名、拖動節點都要存檔（重新整理後才不會還原成舊值）
--------------------------------------------------------- */
const SAVED_KEY = 'taiwan_map_user_features';

test('拖動節點（Modify）結束後，長度與顯示標籤跟著重算並存檔', async () => {
  dialogMock.answer = '測試線';
  ensureToolActive('line');
  const drawInteraction = map._interactions[map._interactions.length - 1];
  const feature = makeFakeFeature({ _length: 1234.5 });
  drawInteraction.simulateDrawEnd(feature);
  await sleep(20);
  expect(feature.get('label')).toBe('測試線（1.23 公里）');

  ensureToolActive('select');
  const modify = map._interactions.find(i => i instanceof globalThis.ol.interaction.Modify);
  expect(modify, '選取工具啟用時應該有 Modify interaction').toBeTruthy();

  feature.getGeometry()._length = 5000;
  modify.simulateModifyEnd([feature]);

  expect(feature.get('measure')).toBe('5.00 公里');
  expect(feature.get('label'), '名稱保留、長度換成新值').toBe('測試線（5.00 公里）');
  expect(localStorage.getItem(SAVED_KEY), '拖動後要已寫入 localStorage').toContain('5.00 公里');
});

test('拖動點（沒有量測值）的 Modify 結束後不會壞掉，也不會亂寫 measure', async () => {
  dialogMock.answer = '';
  ensureToolActive('point');
  const drawInteraction = map._interactions[map._interactions.length - 1];
  const feature = makeFakeFeature({});
  drawInteraction.simulateDrawEnd(feature);
  await sleep(20);

  ensureToolActive('select');
  const modify = map._interactions.find(i => i instanceof globalThis.ol.interaction.Modify);
  modify.simulateModifyEnd([feature]);
  expect(feature.get('measure'), '點沒有量測值').toBeUndefined();
});

test('在要素編輯彈窗改名後立即存檔', async () => {
  dialogMock.answer = '';
  ensureToolActive('point');
  const drawInteraction = map._interactions[map._interactions.length - 1];
  const feature = makeFakeFeature({});
  drawInteraction.simulateDrawEnd(feature);
  await sleep(20);

  ensureToolActive('select');
  const vectorLayer = map._layers.find(l => l instanceof globalThis.ol.layer.Vector);
  map.forEachFeatureAtPixel = (pixel, cb) => cb(feature, vectorLayer);
  map._trigger('singleclick', { pixel: [0, 0] });

  const nameInput = document.getElementById('drawFeaturePopupName');
  nameInput.value = '改過的名字';
  nameInput._listeners['input'][0]({ stopPropagation(){} });

  expect(feature.get('name')).toBe('改過的名字');
  expect(localStorage.getItem(SAVED_KEY), '改名後要已寫入 localStorage').toContain('改過的名字');
  delete map.forEachFeatureAtPixel;
});
