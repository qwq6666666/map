import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue, sleep } from '../assert.mjs';
import { loadAppData, LAYER_SOURCES } from '../../src/data.js';
import { initMapCore } from '../../src/mapCore.js';
import { initSidebar } from '../../src/sidebarUI.js';
import { initSearchUI } from '../../src/searchUI.js';
import { state as store, setMode, setBaseLayer, selectOverlayLayer } from '../../src/store.js';

await loadAppData();
initMapCore();
initSidebar();
initSearchUI();

test('初始狀態是 overlay 模式、osm 底圖', () => {
  assertEqual(store.mode, 'overlay', '初始模式');
  assertEqual(store.baseLayer, 'osm', '初始底圖');
});

test('三種模式可以互相切換，不會拋出例外', async () => {
  setMode('compare');
  assertEqual(store.mode, 'compare', '切到 compare');
  setMode('timeline');
  await sleep(300);
  assertEqual(store.mode, 'timeline', '切到 timeline');
  setMode('overlay');
  assertEqual(store.mode, 'overlay', '切回 overlay');
});

test('選擇歷史圖層後，activeOverlayKey 正確更新', () => {
  const sinica = LAYER_SOURCES.find(s => s.id === 'sinica');
  const layer = sinica.categories[0].layers[0];
  const key = `hist:sinica:${layer.id}:${layer.fmt}`;
  selectOverlayLayer(key);
  assertEqual(store.activeOverlayKey, key, 'activeOverlayKey');
});

test('再次選擇同一個圖層會 toggle 關閉', () => {
  const sinica = LAYER_SOURCES.find(s => s.id === 'sinica');
  const layer = sinica.categories[0].layers[0];
  const key = `hist:sinica:${layer.id}:${layer.fmt}`;
  selectOverlayLayer(null); // 先確保是關閉狀態，不依賴前面測試殘留的狀態
  selectOverlayLayer(key); // 開
  selectOverlayLayer(key); // 再選一次應該關閉
  assertEqual(store.activeOverlayKey, null, 'activeOverlayKey 應該變回 null');
});

test('activeOverlayKey 在切換模式之間會保留，不會被清掉', async () => {
  const sinica = LAYER_SOURCES.find(s => s.id === 'sinica');
  const layer = sinica.categories[0].layers[0];
  const key = `hist:sinica:${layer.id}:${layer.fmt}`;
  setMode('overlay');
  selectOverlayLayer(null); // 先重設，確保下面是乾淨地從「未選取」切到「選取」
  selectOverlayLayer(key);
  setMode('timeline');
  await sleep(300);
  assertEqual(store.activeOverlayKey, key, '切到 timeline 後 activeOverlayKey 應該還在');
  setMode('overlay');
  assertEqual(store.activeOverlayKey, key, '切回 overlay 後 activeOverlayKey 應該還在');
});

test('進入比對模式時，compareA 會自動帶入目前的 activeOverlayKey', async () => {
  const sinica = LAYER_SOURCES.find(s => s.id === 'sinica');
  const layer = sinica.categories[0].layers[0];
  const key = `hist:sinica:${layer.id}:${layer.fmt}`;
  setMode('overlay');
  selectOverlayLayer(null); // 先重設，確保下面 selectOverlayLayer(key) 一定是「選取」而不是誤觸發 toggle 關閉
  selectOverlayLayer(key);
  setMode('compare');
  assertEqual(store.compareA, key, 'compareA 應該等於剛才選的圖層');
  setMode('overlay');
});

test('底圖切換正常運作', () => {
  setBaseLayer('sat');
  assertEqual(store.baseLayer, 'sat', '底圖應該變成 sat');
  setBaseLayer('osm');
  assertEqual(store.baseLayer, 'osm', '底圖應該變回 osm');
});

await run();
