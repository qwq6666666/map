import '../env-stub.mjs';
import { test, expect, vi } from 'vitest';
import { loadAppData } from '../../src/data.js';
import { initMapCore, map } from '../../src/mapCore.js';
import { initSidebar } from '../../src/sidebarUI.js';
import { initSearchUI } from '../../src/searchUI.js';
import {
  initDrawTool,
  exportGeoJSON,
  importGeoJSON,
  applyColorToFeature,
  featureStyleFn,
  PALETTE_COLORS,
  DEFAULT_COLOR,
} from '../../src/drawTool.js';
import { runtime } from '../../src/runtime.js';

// 站內對話框在假 DOM 裡沒人會點按鈕，換成立刻回覆「不輸入名稱」的假實作
// （本檔只驗證顏色屬性，顏色是在名稱對話框 await 之前同步寫入的）。
vi.mock('../../src/ui/dialog.js', () => ({
  showPrompt: async () => '',
  showConfirm: async () => true,
  showAlert: async () => {},
}));

await loadAppData();
initMapCore();
initSidebar();
initSearchUI();

// 模擬 index.html 裡 #drawToolbar 底下的按鈕結構
const toolbar = document.getElementById('drawToolbar');
const toolBtns = {};
['point', 'line', 'polygon', 'select'].forEach(t => {
  const b = document.createElement('button');
  b.className = 'draw-tool-btn';
  b.dataset.tool = t;
  toolbar.appendChild(b);
  toolBtns[t] = b;
});

// 模擬 #drawColorPalette 底下 6 顆色票 + #drawColorCustom
const colorPalette = document.getElementById('drawColorPalette');
const swatchBtns = {};
PALETTE_COLORS.forEach(color => {
  const b = document.createElement('button');
  b.className = 'draw-color-swatch';
  b.dataset.color = color;
  colorPalette.appendChild(b);
  swatchBtns[color] = b;
});
document.getElementById('drawColorCustom'); // get-or-create，不需要額外掛節點

// 匯入按鈕與隱藏 file input（initDrawTool() 會 addEventListener，不強制要有子節點）
document.getElementById('drawImportGeoJSONBtn');
document.getElementById('drawImportFileInput');

initDrawTool();

function makeFakeFeature(geomProps){
  return {
    _props: {},
    set(k, v){ this._props[k] = v; },
    get(k){ return this._props[k]; },
    getGeometry(){ return geomProps; },
    changed(){},
  };
}

function ensureToolActive(tool){
  toolBtns[tool]._listeners['click'][0]();
  if(!toolBtns[tool].classList.contains('active')){
    toolBtns[tool]._listeners['click'][0]();
  }
}

function selectColor(color){
  swatchBtns[color]._listeners['click'][0]({ stopPropagation(){} });
}

/* ---------- 1. 建立時寫入 SimpleStyle 屬性 ---------- */

test('選了靛藍色票後畫點，marker-color 會是選到的顏色', () => {
  selectColor('#2980B9');
  ensureToolActive('point');
  const drawInteraction = map._interactions[map._interactions.length - 1];
  const feature = makeFakeFeature({});
  drawInteraction.simulateDrawEnd(feature);
  expect(feature.get('marker-color'), 'marker-color').toBe('#2980B9');
});

test('選了靛藍色票後畫線，stroke/stroke-width/stroke-opacity 正確', () => {
  selectColor('#2980B9');
  ensureToolActive('line');
  const drawInteraction = map._interactions[map._interactions.length - 1];
  const feature = makeFakeFeature({ _length: 100 });
  drawInteraction.simulateDrawEnd(feature);
  expect(feature.get('stroke'), 'stroke').toBe('#2980B9');
  expect(feature.get('stroke-width'), 'stroke-width').toBe(3);
  expect(feature.get('stroke-opacity'), 'stroke-opacity').toBe(0.8);
});

test('選了靛藍色票後畫面，stroke/fill/fill-opacity 正確', () => {
  selectColor('#2980B9');
  ensureToolActive('polygon');
  const drawInteraction = map._interactions[map._interactions.length - 1];
  const feature = makeFakeFeature({ _area: 100 });
  drawInteraction.simulateDrawEnd(feature);
  expect(feature.get('stroke'), 'stroke').toBe('#2980B9');
  expect(feature.get('fill'), 'fill').toBe('#2980B9');
  expect(feature.get('fill-opacity'), 'fill-opacity').toBe(0.35);
});

test('不特別選色時，預設用 DEFAULT_COLOR（朱紅）畫點', () => {
  selectColor(DEFAULT_COLOR); // 明確切回預設色，避免受前面測試殘留的 currentColor 影響
  ensureToolActive('point');
  const drawInteraction = map._interactions[map._interactions.length - 1];
  const feature = makeFakeFeature({});
  drawInteraction.simulateDrawEnd(feature);
  expect(feature.get('marker-color'), 'marker-color 應為預設朱紅色').toBe(DEFAULT_COLOR);
});

/* ---------- 2. 二次改色覆寫既有屬性與樣式 ---------- */

test('applyColorToFeature 二次改色會覆寫既有 SimpleStyle 屬性（不是疊加殘留）', () => {
  const feature = makeFakeFeature({});
  feature.set('kind', 'polygon');

  applyColorToFeature(feature, '#27AE60'); // 墨綠
  expect(feature.get('stroke'), 'stroke 應為墨綠').toBe('#27AE60');
  expect(feature.get('fill'), 'fill 應為墨綠').toBe('#27AE60');

  applyColorToFeature(feature, '#8E44AD'); // 紫藤
  expect(feature.get('stroke'), 'stroke 應被覆寫成紫藤，而非殘留墨綠').toBe('#8E44AD');
  expect(feature.get('fill'), 'fill 應被覆寫成紫藤，而非殘留墨綠').toBe('#8E44AD');

  const styleResult = featureStyleFn(feature);
  expect(styleResult.opts.stroke.opts.color, 'featureStyleFn 應即時讀取最新的屬性顏色').toBe('#8E44AD');
});

/* ---------- 3. 匯出 GeoJSON 包含正確顏色屬性 ---------- */

test('匯出 GeoJSON 會包含畫圖時各自選用的正確顏色屬性', () => {

  selectColor('#D35400'); // 南瓜橘
  ensureToolActive('point');
  let drawInteraction = map._interactions[map._interactions.length - 1];
  const pointFeature = makeFakeFeature({});
  drawInteraction.simulateDrawEnd(pointFeature);

  selectColor('#2C3E50'); // 深藍灰
  ensureToolActive('line');
  drawInteraction = map._interactions[map._interactions.length - 1];
  const lineFeature = makeFakeFeature({ _length: 50 });
  drawInteraction.simulateDrawEnd(lineFeature);

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
  globalThis.Blob = OriginalBlob;

  expect(!!downloadedContent, '應該有產生下載內容').toBeTruthy();
  const parsed = JSON.parse(downloadedContent);
  const exportedPoint = parsed.features.find(f => f.properties['marker-color'] === '#D35400');
  const exportedLine = parsed.features.find(f => f.properties['stroke'] === '#2C3E50');
  expect(!!exportedPoint, '匯出結果應包含南瓜橘的點，且 marker-color 正確').toBeTruthy();
  expect(!!exportedLine, '匯出結果應包含深藍灰的線，且 stroke 正確').toBeTruthy();
});

/* ---------- 4. 匯入 GeoJSON ---------- */

test('匯入帶 SimpleStyle 顏色屬性的 GeoJSON，顏色會被保留（不被 DEFAULT_COLOR 蓋掉）', () => {
  const geojson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { stroke: '#D35400', 'stroke-width': 3, 'stroke-opacity': 0.8 },
        geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
      },
    ],
  };
  const count = importGeoJSON(geojson);
  expect(count, '應成功匯入 1 個圖形').toBe(1);
  // 從匯出結果反查，確認剛匯入的顏色屬性有被保留
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
  globalThis.Blob = OriginalBlob;
  const parsed = JSON.parse(downloadedContent);
  // importGeoJSON() 是把 feature 用 addFeature 加進 vectorSource 尾端，
  // 匯出時 features 陣列順序跟加入順序一致，所以最後一筆就是剛匯入的這個。
  const imported = parsed.features[parsed.features.length - 1];
  expect(imported.properties.stroke, '匯入的線應保留原本的 stroke 顏色，不被 DEFAULT_COLOR 蓋掉').toBe('#D35400');
});

test('匯入沒有 SimpleStyle 顏色屬性的 GeoJSON，marker-color 會降級回退成 DEFAULT_COLOR', () => {
  const geojson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'Point', coordinates: [0, 0] },
      },
    ],
  };
  const count = importGeoJSON(geojson);
  expect(count, '應成功匯入 1 個圖形').toBe(1);
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
  globalThis.Blob = OriginalBlob;
  const parsed = JSON.parse(downloadedContent);
  // 同上，最後一筆就是剛匯入的這個點。
  const imported = parsed.features[parsed.features.length - 1];
  expect(imported.properties.kind, 'kind 應依幾何類型自動判斷為 point').toBe('point');
  expect(imported.properties['marker-color'], '沒有顏色屬性的匯入點，marker-color 應回退成 DEFAULT_COLOR').toBe(DEFAULT_COLOR);
});

// 匯入/匯出操作會觸發 drawTool.js 的 showStorageToast()，留下一顆真實的
// setTimeout(2500ms)。不清掉的話 Node process 要等它自然到期才會結束，
// 讓這支測試檔平白多花 2.5 秒 wall time 卻沒有驗證任何額外邏輯。
if(runtime.drawStorageToastTimer) clearTimeout(runtime.drawStorageToastTimer);
