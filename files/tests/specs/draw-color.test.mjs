import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
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
  globalThis.prompt = () => '';
  selectColor('#2980B9');
  ensureToolActive('point');
  const drawInteraction = map._interactions[map._interactions.length - 1];
  const feature = makeFakeFeature({});
  drawInteraction.simulateDrawEnd(feature);
  assertEqual(feature.get('marker-color'), '#2980B9', 'marker-color');
});

test('選了靛藍色票後畫線，stroke/stroke-width/stroke-opacity 正確', () => {
  globalThis.prompt = () => '';
  selectColor('#2980B9');
  ensureToolActive('line');
  const drawInteraction = map._interactions[map._interactions.length - 1];
  const feature = makeFakeFeature({ _length: 100 });
  drawInteraction.simulateDrawEnd(feature);
  assertEqual(feature.get('stroke'), '#2980B9', 'stroke');
  assertEqual(feature.get('stroke-width'), 3, 'stroke-width');
  assertEqual(feature.get('stroke-opacity'), 0.8, 'stroke-opacity');
});

test('選了靛藍色票後畫面，stroke/fill/fill-opacity 正確', () => {
  globalThis.prompt = () => '';
  selectColor('#2980B9');
  ensureToolActive('polygon');
  const drawInteraction = map._interactions[map._interactions.length - 1];
  const feature = makeFakeFeature({ _area: 100 });
  drawInteraction.simulateDrawEnd(feature);
  assertEqual(feature.get('stroke'), '#2980B9', 'stroke');
  assertEqual(feature.get('fill'), '#2980B9', 'fill');
  assertEqual(feature.get('fill-opacity'), 0.35, 'fill-opacity');
});

test('不特別選色時，預設用 DEFAULT_COLOR（朱紅）畫點', () => {
  globalThis.prompt = () => '';
  selectColor(DEFAULT_COLOR); // 明確切回預設色，避免受前面測試殘留的 currentColor 影響
  ensureToolActive('point');
  const drawInteraction = map._interactions[map._interactions.length - 1];
  const feature = makeFakeFeature({});
  drawInteraction.simulateDrawEnd(feature);
  assertEqual(feature.get('marker-color'), DEFAULT_COLOR, 'marker-color 應為預設朱紅色');
});

/* ---------- 2. 二次改色覆寫既有屬性與樣式 ---------- */

test('applyColorToFeature 二次改色會覆寫既有 SimpleStyle 屬性（不是疊加殘留）', () => {
  const feature = makeFakeFeature({});
  feature.set('kind', 'polygon');

  applyColorToFeature(feature, '#27AE60'); // 墨綠
  assertEqual(feature.get('stroke'), '#27AE60', 'stroke 應為墨綠');
  assertEqual(feature.get('fill'), '#27AE60', 'fill 應為墨綠');

  applyColorToFeature(feature, '#8E44AD'); // 紫藤
  assertEqual(feature.get('stroke'), '#8E44AD', 'stroke 應被覆寫成紫藤，而非殘留墨綠');
  assertEqual(feature.get('fill'), '#8E44AD', 'fill 應被覆寫成紫藤，而非殘留墨綠');

  const styleResult = featureStyleFn(feature);
  assertEqual(styleResult.opts.stroke.opts.color, '#8E44AD', 'featureStyleFn 應即時讀取最新的屬性顏色');
});

/* ---------- 3. 匯出 GeoJSON 包含正確顏色屬性 ---------- */

test('匯出 GeoJSON 會包含畫圖時各自選用的正確顏色屬性', () => {
  globalThis.prompt = () => '';

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

  assertTrue(!!downloadedContent, '應該有產生下載內容');
  const parsed = JSON.parse(downloadedContent);
  const exportedPoint = parsed.features.find(f => f.properties['marker-color'] === '#D35400');
  const exportedLine = parsed.features.find(f => f.properties['stroke'] === '#2C3E50');
  assertTrue(!!exportedPoint, '匯出結果應包含南瓜橘的點，且 marker-color 正確');
  assertTrue(!!exportedLine, '匯出結果應包含深藍灰的線，且 stroke 正確');
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
  assertEqual(count, 1, '應成功匯入 1 個圖形');
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
  assertEqual(imported.properties.stroke, '#D35400', '匯入的線應保留原本的 stroke 顏色，不被 DEFAULT_COLOR 蓋掉');
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
  assertEqual(count, 1, '應成功匯入 1 個圖形');
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
  assertEqual(imported.properties.kind, 'point', 'kind 應依幾何類型自動判斷為 point');
  assertEqual(imported.properties['marker-color'], DEFAULT_COLOR, '沒有顏色屬性的匯入點，marker-color 應回退成 DEFAULT_COLOR');
});

await run();
