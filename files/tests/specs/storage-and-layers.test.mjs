import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
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
  assertTrue(ok === true, 'saveUserFeatures 正常大小的資料應該回傳 true');

  const loaded = loadUserFeatures();
  assertTrue(!!loaded, 'loadUserFeatures 應該讀得到剛剛存的資料');
  assertEqual(loaded.type, 'FeatureCollection', '型別應該是 FeatureCollection');
  assertEqual(loaded.features.length, 1, '應該有 1 筆 feature');
  const props = loaded.features[0].properties;
  assertEqual(props.stroke, '#C0392B', 'stroke 屬性不能遺失');
  assertEqual(props.fill, '#2980B9', 'fill 屬性不能遺失');
  assertEqual(props['marker-color'], '#27AE60', 'marker-color 屬性不能遺失');
});

test('loadUserFeatures：完全沒存過資料時回傳 null', () => {
  reset();
  assertEqual(loadUserFeatures(), null, '沒有快取時應該回傳 null');
});

test('clearUserFeatures：清除後 loadUserFeatures 回傳 null', () => {
  reset();
  saveUserFeatures({ type: 'FeatureCollection', features: [] });
  assertTrue(loadUserFeatures() !== null, '清除前應該讀得到資料');

  const cleared = clearUserFeatures();
  assertTrue(cleared === true, 'clearUserFeatures 應該回傳 true');
  assertEqual(loadUserFeatures(), null, '清除後應該回傳 null');
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
  assertTrue(ok === false, '超過上限時應該回傳 false');
  assertEqual(loadUserFeatures(), null, '超過上限時不應該寫入 localStorage');
});

// ---------------------------------------------------------
// config/baseLayers.js
// ---------------------------------------------------------

test('BASE_LAYERS 是陣列，且至少有 osm／sat 兩筆', () => {
  assertTrue(Array.isArray(BASE_LAYERS), 'BASE_LAYERS 應該是陣列');
  assertTrue(BASE_LAYERS.length >= 2, 'BASE_LAYERS 至少要有 2 筆（osm、sat）');
});

test('BASE_LAYERS 每一筆都有必要欄位且型別正確', () => {
  for(const layer of BASE_LAYERS){
    assertTrue(typeof layer.id === 'string' && layer.id.length > 0, `id 應該是非空字串（${JSON.stringify(layer)}）`);
    assertTrue(typeof layer.name === 'string' && layer.name.length > 0, `name 應該是非空字串（${layer.id}）`);
    assertTrue(layer.urlTemplate === null || typeof layer.urlTemplate === 'string', `urlTemplate 應該是字串或 null（${layer.id}）`);
    assertTrue(typeof layer.minZoom === 'number', `minZoom 應該是數字（${layer.id}）`);
    assertTrue(typeof layer.maxZoom === 'number', `maxZoom 應該是數字（${layer.id}）`);
    assertTrue(typeof layer.attribution === 'string' && layer.attribution.length > 0, `attribution 應該是非空字串（${layer.id}）`);
  }
});

test('getBaseLayerConfig("sat")：能找到衛星影像設定，urlTemplate 含 {z}/{x}/{y} 樣板', () => {
  const sat = getBaseLayerConfig('sat');
  assertTrue(!!sat, '應該找得到 sat 設定');
  assertEqual(sat.id, 'sat', 'id 應該是 sat');
  assertTrue(typeof sat.urlTemplate === 'string', 'sat 的 urlTemplate 應該是字串');
  assertTrue(sat.urlTemplate.includes('{z}'), 'urlTemplate 應該包含 {z} 樣板');
  assertTrue(sat.urlTemplate.includes('{x}'), 'urlTemplate 應該包含 {x} 樣板');
  assertTrue(sat.urlTemplate.includes('{y}'), 'urlTemplate 應該包含 {y} 樣板');
});

test('getBaseLayerConfig：找不到對應 id 時回傳 undefined', () => {
  assertEqual(getBaseLayerConfig('不存在的id'), undefined, '找不到時應該回傳 undefined');
});

await run();
