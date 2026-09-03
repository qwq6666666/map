import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue, sleep } from '../assert.mjs';
import { loadAppData, LAYER_SOURCES } from '../../src/data.js';
import { initMapCore } from '../../src/mapCore.js';
import { initSidebar } from '../../src/sidebarUI.js';
import { initSearchUI } from '../../src/searchUI.js';
import {
  state as store, setMode,
  toggleMultiOverlayLayer, removeMultiOverlayLayer,
  setMultiOverlayOpacity, moveMultiOverlayLayer, clearMultiOverlayLayers,
  selectOverlayLayer
} from '../../src/store.js';

await loadAppData();
initMapCore();
initSidebar();
initSearchUI();

const sinica = LAYER_SOURCES.find(s => s.id === 'sinica');
const layerA = sinica.categories[0].layers[0];
const layerB = sinica.categories[0].layers[1];
const keyA = `hist:sinica:${layerA.id}:${layerA.fmt}`;
const keyB = `hist:sinica:${layerB.id}:${layerB.fmt}`;

test('勾選圖層會加入 multiOverlayLayers，預設透明度 100', () => {
  clearMultiOverlayLayers();
  toggleMultiOverlayLayer(keyA);
  assertEqual(store.multiOverlayLayers.length, 1, '應該有 1 筆');
  assertEqual(store.multiOverlayLayers[0].key, keyA, 'key 正確');
  assertEqual(store.multiOverlayLayers[0].opacity, 100, '預設透明度 100');
});

test('再次勾選同一張圖層會移出清單（toggle）', () => {
  clearMultiOverlayLayers();
  toggleMultiOverlayLayer(keyA);
  toggleMultiOverlayLayer(keyA);
  assertEqual(store.multiOverlayLayers.length, 0, '應該回到空清單');
});

test('新加入的圖層疊在最上層（陣列尾端）', () => {
  clearMultiOverlayLayers();
  toggleMultiOverlayLayer(keyA);
  toggleMultiOverlayLayer(keyB);
  assertEqual(store.multiOverlayLayers[0].key, keyA, '第一筆是 A');
  assertEqual(store.multiOverlayLayers[1].key, keyB, '第二筆（最上層）是 B');
});

test('setMultiOverlayOpacity 只改動對應 key 的透明度', () => {
  clearMultiOverlayLayers();
  toggleMultiOverlayLayer(keyA);
  toggleMultiOverlayLayer(keyB);
  setMultiOverlayOpacity(keyA, 40);
  assertEqual(store.multiOverlayLayers.find(e => e.key === keyA).opacity, 40, 'A 透明度');
  assertEqual(store.multiOverlayLayers.find(e => e.key === keyB).opacity, 100, 'B 透明度不受影響');
});

test('moveMultiOverlayLayer 可以調整疊放順序，超出範圍不動作', () => {
  clearMultiOverlayLayers();
  toggleMultiOverlayLayer(keyA); // index 0
  toggleMultiOverlayLayer(keyB); // index 1（最上層）
  moveMultiOverlayLayer(keyA, 1); // A 往上疊一層，應該變成 [B, A]
  assertEqual(store.multiOverlayLayers[0].key, keyB, '交換後第一筆是 B');
  assertEqual(store.multiOverlayLayers[1].key, keyA, '交換後第二筆是 A');
  moveMultiOverlayLayer(keyA, 1); // 已經在最上層，不該動作（陣列長度只有 2）
  assertEqual(store.multiOverlayLayers[1].key, keyA, '已在最上層，move(+1) 不動作');
});

test('removeMultiOverlayLayer 移除指定 key，其餘保留', () => {
  clearMultiOverlayLayers();
  toggleMultiOverlayLayer(keyA);
  toggleMultiOverlayLayer(keyB);
  removeMultiOverlayLayer(keyA);
  assertEqual(store.multiOverlayLayers.length, 1, '剩 1 筆');
  assertEqual(store.multiOverlayLayers[0].key, keyB, '剩下的是 B');
});

test('clearMultiOverlayLayers 清空整份清單', () => {
  toggleMultiOverlayLayer(keyA);
  toggleMultiOverlayLayer(keyB);
  clearMultiOverlayLayers();
  assertEqual(store.multiOverlayLayers.length, 0, '應該清空');
});

test('multiOverlayLayers 在切換模式之間會保留，不會被清掉', async () => {
  clearMultiOverlayLayers();
  setMode('multi');
  toggleMultiOverlayLayer(keyA);
  toggleMultiOverlayLayer(keyB);
  setMode('overlay');
  assertEqual(store.multiOverlayLayers.length, 2, '切離 multi 模式後清單應該還在');
  setMode('timeline');
  await sleep(300);
  assertEqual(store.multiOverlayLayers.length, 2, '切到 timeline 模式後清單應該還在');
  setMode('multi');
  assertEqual(store.multiOverlayLayers.length, 2, '切回 multi 模式後清單應該還在');
  setMode('overlay');
  clearMultiOverlayLayers();
});

test('複合疊圖模式跟疊圖模式的單選狀態互不干擾', () => {
  clearMultiOverlayLayers();
  selectOverlayLayer(null);
  setMode('overlay');
  selectOverlayLayer(keyA);
  setMode('multi');
  toggleMultiOverlayLayer(keyB);
  assertEqual(store.activeOverlayKey, keyA, 'activeOverlayKey 不受複合疊圖模式的勾選影響');
  assertEqual(store.multiOverlayLayers.length, 1, 'multiOverlayLayers 不受疊圖模式的單選影響');
  setMode('overlay');
  selectOverlayLayer(null);
  clearMultiOverlayLayers();
});

test('四種模式可以互相切換，不會拋出例外', async () => {
  setMode('overlay');
  assertEqual(store.mode, 'overlay', '切到 overlay');
  setMode('compare');
  assertEqual(store.mode, 'compare', '切到 compare');
  setMode('timeline');
  await sleep(300);
  assertEqual(store.mode, 'timeline', '切到 timeline');
  setMode('multi');
  assertEqual(store.mode, 'multi', '切到 multi');
  setMode('overlay');
  assertEqual(store.mode, 'overlay', '切回 overlay');
});

await run();
