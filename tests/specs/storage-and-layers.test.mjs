import { test, expect } from 'vitest';
import '../env-stub.mjs';

import { saveUserFeatures, loadUserFeatures, clearUserFeatures } from '../../src/features/storage.js';
import { BASE_LAYERS, getBaseLayerConfig } from '../../src/config/baseLayers.js';

const STORAGE_KEY = 'taiwan_map_user_features';

function reset(){
  localStorage.removeItem(STORAGE_KEY);
}

// ---------------------------------------------------------
// storage.js
// ---------------------------------------------------------

test('saveUserFeatures／loadUserFeatures：SimpleStyle 屬性完整往返，不遺失', () => {
  reset();
  const fc = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { stroke: '#C0392B', fill: '#2980B9', 'marker-color': '#27AE60' },
        geometry: { type: 'Point', coordinates: [121.5, 25.05] }
      }
    ]
  };
  const ok = saveUserFeatures(fc);
  expect(ok === true, 'saveUserFeatures 正常大小的資料應該回傳 true').toBeTruthy();

  const loaded = loadUserFeatures();
  expect(!!loaded, 'loadUserFeatures 應該讀得到剛剛存的資料').toBeTruthy();
  expect(loaded.type, '型別應該是 FeatureCollection').toBe('FeatureCollection');
  expect(loaded.features.length, '應該有 1 筆 feature').toBe(1);
  const props = loaded.features[0].properties;
  expect(props.stroke, 'stroke 屬性不能遺失').toBe('#C0392B');
  expect(props.fill, 'fill 屬性不能遺失').toBe('#2980B9');
  expect(props['marker-color'], 'marker-color 屬性不能遺失').toBe('#27AE60');
});

test('loadUserFeatures：完全沒存過資料時回傳 null', () => {
  reset();
  expect(loadUserFeatures(), '沒有快取時應該回傳 null').toBe(null);
});

test('clearUserFeatures：清除後 loadUserFeatures 回傳 null', () => {
  reset();
  saveUserFeatures({ type: 'FeatureCollection', features: [] });
  expect(loadUserFeatures() !== null, '清除前應該讀得到資料').toBeTruthy();

  const cleared = clearUserFeatures();
  expect(cleared === true, 'clearUserFeatures 應該回傳 true').toBeTruthy();
  expect(loadUserFeatures(), '清除後應該回傳 null').toBe(null);
});

test('saveUserFeatures：序列化後超過內部上限時回傳 false，且不寫入', () => {
  reset();
  // MAX_BYTES 是模組內部常數（4.5MB），不匯出，這裡直接塞一個超大字串屬性
  // 讓 JSON.stringify 後的長度確實超過門檻，驗證公開行為（回傳 false 且不寫入）。
  const bigString = 'x'.repeat(5 * 1024 * 1024);
  const fc = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { note: bigString }, geometry: { type: 'Point', coordinates: [0, 0] } }
    ]
  };
  const ok = saveUserFeatures(fc);
  expect(ok === false, '超過上限時應該回傳 false').toBeTruthy();
  expect(loadUserFeatures(), '超過上限時不應該寫入 localStorage').toBe(null);
});

// ---------------------------------------------------------
// config/baseLayers.js
// ---------------------------------------------------------

test('BASE_LAYERS 是陣列，且至少有 osm／sat 兩筆', () => {
  expect(Array.isArray(BASE_LAYERS), 'BASE_LAYERS 應該是陣列').toBeTruthy();
  expect(BASE_LAYERS.length >= 2, 'BASE_LAYERS 至少要有 2 筆（osm、sat）').toBeTruthy();
});

test('BASE_LAYERS 每一筆都有必要欄位且型別正確', () => {
  for(const layer of BASE_LAYERS){
    expect(typeof layer.id === 'string' && layer.id.length > 0, `id 應該是非空字串（${JSON.stringify(layer)}）`).toBeTruthy();
    expect(typeof layer.name === 'string' && layer.name.length > 0, `name 應該是非空字串（${layer.id}）`).toBeTruthy();
    expect(layer.urlTemplate === null || typeof layer.urlTemplate === 'string', `urlTemplate 應該是字串或 null（${layer.id}）`).toBeTruthy();
    expect(typeof layer.minZoom === 'number', `minZoom 應該是數字（${layer.id}）`).toBeTruthy();
    expect(typeof layer.maxZoom === 'number', `maxZoom 應該是數字（${layer.id}）`).toBeTruthy();
    expect(typeof layer.attribution === 'string' && layer.attribution.length > 0, `attribution 應該是非空字串（${layer.id}）`).toBeTruthy();
  }
});

test('getBaseLayerConfig("sat")：能找到衛星影像設定，urlTemplate 含 {z}/{x}/{y} 樣板', () => {
  const sat = getBaseLayerConfig('sat');
  expect(!!sat, '應該找得到 sat 設定').toBeTruthy();
  expect(sat.id, 'id 應該是 sat').toBe('sat');
  expect(typeof sat.urlTemplate === 'string', 'sat 的 urlTemplate 應該是字串').toBeTruthy();
  expect(sat.urlTemplate.includes('{z}'), 'urlTemplate 應該包含 {z} 樣板').toBeTruthy();
  expect(sat.urlTemplate.includes('{x}'), 'urlTemplate 應該包含 {x} 樣板').toBeTruthy();
  expect(sat.urlTemplate.includes('{y}'), 'urlTemplate 應該包含 {y} 樣板').toBeTruthy();
});

test('getBaseLayerConfig：找不到對應 id 時回傳 undefined', () => {
  expect(getBaseLayerConfig('不存在的id'), '找不到時應該回傳 undefined').toBe(undefined);
});
