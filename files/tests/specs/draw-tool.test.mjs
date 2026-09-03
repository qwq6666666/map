import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import { loadAppData } from '../../src/data.js';
import { initMapCore, map } from '../../src/mapCore.js';
import { initSidebar } from '../../src/sidebarUI.js';
import { initSearchUI } from '../../src/searchUI.js';
import { initDrawTool, exportGeoJSON } from '../../src/drawTool.js';

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
  assertTrue(map._interactions.length > before, '應該多一個 interaction');
});

test('畫完一條線，自動算出長度並顯示（例如 1234.5 公尺 → 1.23 公里）', () => {
  globalThis.prompt = () => ''; // 不輸入名稱
  ensureToolActive('line');
  const drawInteraction = map._interactions[map._interactions.length - 1];
  const feature = makeFakeFeature({ _length: 1234.5 });
  drawInteraction.simulateDrawEnd(feature);
  assertEqual(feature.get('kind'), 'line', 'kind');
  assertEqual(feature.get('label'), '1.23 公里', 'label 應該是自動算出的長度');
});

test('畫線時輸入名稱，會跟長度合併顯示成「名稱（長度）」', () => {
  globalThis.prompt = () => '西門溝';
  ensureToolActive('line');
  const drawInteraction = map._interactions[map._interactions.length - 1];
  const feature = makeFakeFeature({ _length: 500 });
  drawInteraction.simulateDrawEnd(feature);
  assertEqual(feature.get('name'), '西門溝', 'name');
  assertEqual(feature.get('label'), '西門溝（500.0 公尺）', 'label 應該合併名稱與長度');
});

test('畫完一個面，自動算出面積（25000 平方公尺 → 2.50 公頃）', () => {
  globalThis.prompt = () => '';
  ensureToolActive('polygon');
  const drawInteraction = map._interactions[map._interactions.length - 1];
  const feature = makeFakeFeature({ _area: 25000 });
  drawInteraction.simulateDrawEnd(feature);
  assertEqual(feature.get('kind'), 'polygon', 'kind');
  assertEqual(feature.get('label'), '2.50 公頃', 'label 應該是自動算出的面積');
});

test('畫點時輸入的說明文字，直接當作 label', () => {
  globalThis.prompt = () => '這是一個標記';
  ensureToolActive('point');
  const drawInteraction = map._interactions[map._interactions.length - 1];
  const feature = makeFakeFeature({});
  drawInteraction.simulateDrawEnd(feature);
  assertEqual(feature.get('kind'), 'point', 'kind');
  assertEqual(feature.get('label'), '這是一個標記', 'label');
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
  assertTrue(!!downloadedContent, '應該有產生下載內容');
  const parsed = JSON.parse(downloadedContent);
  assertEqual(parsed.opts.featureProjection, 'EPSG:3857', 'featureProjection');
  assertEqual(parsed.opts.dataProjection, 'EPSG:4326', 'dataProjection');
  assertTrue(parsed.features.length > 0, '應該有至少一筆圖形（前面測試已經畫了好幾筆）');
});

await run();
