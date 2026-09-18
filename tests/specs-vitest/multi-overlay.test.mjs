import '../env-stub.mjs';
import { test, expect } from 'vitest';
import { sleep } from '../assert.mjs';
import { loadAppData, DATA } from '../../src/data.js';
import { initMapCore } from '../../src/mapCore.js';
import { initSidebar } from '../../src/sidebarUI.js';
import { initSearchUI } from '../../src/searchUI.js';
import {
  state as store, setMode,
  toggleMultiOverlayLayer, removeMultiOverlayLayer,
  setMultiOverlayOpacity, moveMultiOverlayLayer, reorderMultiOverlayLayer, clearMultiOverlayLayers,
  selectOverlayLayer, addCustomSource, clearCustomSources
} from '../../src/store.js';
import { hasCachedLayer } from '../../src/core/layerCache.js';

await loadAppData();
initMapCore();
initSidebar();
initSearchUI();

const sinica = DATA.LAYER_SOURCES.find(s => s.id === 'sinica');
const layerA = sinica.categories[0].layers[0];
const layerB = sinica.categories[0].layers[1];
const layerC = sinica.categories[0].layers[2];
const keyA = `hist:sinica:${layerA.id}:${layerA.fmt}`;
const keyB = `hist:sinica:${layerB.id}:${layerB.fmt}`;
const keyC = `hist:sinica:${layerC.id}:${layerC.fmt}`;

test('勾選圖層會加入 multiOverlayLayers，預設透明度 100', () => {
  clearMultiOverlayLayers();
  toggleMultiOverlayLayer(keyA);
  expect(store.multiOverlayLayers.length, '應該有 1 筆').toBe(1);
  expect(store.multiOverlayLayers[0].key, 'key 正確').toBe(keyA);
  expect(store.multiOverlayLayers[0].opacity, '預設透明度 100').toBe(100);
});

test('再次勾選同一張圖層會移出清單（toggle）', () => {
  clearMultiOverlayLayers();
  toggleMultiOverlayLayer(keyA);
  toggleMultiOverlayLayer(keyA);
  expect(store.multiOverlayLayers.length, '應該回到空清單').toBe(0);
});

test('新加入的圖層疊在最上層（陣列尾端）', () => {
  clearMultiOverlayLayers();
  toggleMultiOverlayLayer(keyA);
  toggleMultiOverlayLayer(keyB);
  expect(store.multiOverlayLayers[0].key, '第一筆是 A').toBe(keyA);
  expect(store.multiOverlayLayers[1].key, '第二筆（最上層）是 B').toBe(keyB);
});

test('setMultiOverlayOpacity 只改動對應 key 的透明度', () => {
  clearMultiOverlayLayers();
  toggleMultiOverlayLayer(keyA);
  toggleMultiOverlayLayer(keyB);
  setMultiOverlayOpacity(keyA, 40);
  expect(store.multiOverlayLayers.find(e => e.key === keyA).opacity, 'A 透明度').toBe(40);
  expect(store.multiOverlayLayers.find(e => e.key === keyB).opacity, 'B 透明度不受影響').toBe(100);
});

test('moveMultiOverlayLayer 可以調整疊放順序，超出範圍不動作', () => {
  clearMultiOverlayLayers();
  toggleMultiOverlayLayer(keyA); // index 0
  toggleMultiOverlayLayer(keyB); // index 1（最上層）
  moveMultiOverlayLayer(keyA, 1); // A 往上疊一層，應該變成 [B, A]
  expect(store.multiOverlayLayers[0].key, '交換後第一筆是 B').toBe(keyB);
  expect(store.multiOverlayLayers[1].key, '交換後第二筆是 A').toBe(keyA);
  moveMultiOverlayLayer(keyA, 1); // 已經在最上層，不該動作（陣列長度只有 2）
  expect(store.multiOverlayLayers[1].key, '已在最上層，move(+1) 不動作').toBe(keyA);
});

test('reorderMultiOverlayLayer 可以搬到任意位置（非相鄰），拖曳排序用', () => {
  clearMultiOverlayLayers();
  toggleMultiOverlayLayer(keyA); // index 0
  toggleMultiOverlayLayer(keyB); // index 1
  toggleMultiOverlayLayer(keyC); // index 2（最上層）
  reorderMultiOverlayLayer(keyC, 0); // 把最上層的 C 直接搬到最底層
  expect(store.multiOverlayLayers.map(e => e.key).join(','), 'C 應該搬到 index 0').toBe([keyC, keyA, keyB].join(','));
  reorderMultiOverlayLayer(keyA, 2); // 把目前 index 1 的 A 搬到最上層
  expect(store.multiOverlayLayers.map(e => e.key).join(','), 'A 應該搬到 index 2（最上層）').toBe([keyC, keyB, keyA].join(','));
  reorderMultiOverlayLayer('hist:not-exist', 0); // 不存在的 key，不動作也不拋錯
  expect(store.multiOverlayLayers.length, '不存在的 key 不影響清單').toBe(3);
  reorderMultiOverlayLayer(keyB, 99); // 超出範圍夾在合法區間內（最上層）
  expect(store.multiOverlayLayers[store.multiOverlayLayers.length - 1].key, '超出範圍會夾在最上層').toBe(keyB);
});

test('removeMultiOverlayLayer 移除指定 key，其餘保留', () => {
  clearMultiOverlayLayers();
  toggleMultiOverlayLayer(keyA);
  toggleMultiOverlayLayer(keyB);
  removeMultiOverlayLayer(keyA);
  expect(store.multiOverlayLayers.length, '剩 1 筆').toBe(1);
  expect(store.multiOverlayLayers[0].key, '剩下的是 B').toBe(keyB);
});

test('clearMultiOverlayLayers 清空整份清單', () => {
  toggleMultiOverlayLayer(keyA);
  toggleMultiOverlayLayer(keyB);
  clearMultiOverlayLayers();
  expect(store.multiOverlayLayers.length, '應該清空').toBe(0);
});

test('multiOverlayLayers 在切換模式之間會保留，不會被清掉', async () => {
  clearMultiOverlayLayers();
  setMode('multi');
  toggleMultiOverlayLayer(keyA);
  toggleMultiOverlayLayer(keyB);
  setMode('overlay');
  expect(store.multiOverlayLayers.length, '切離 multi 模式後清單應該還在').toBe(2);
  setMode('timeline');
  await sleep(300);
  expect(store.multiOverlayLayers.length, '切到 timeline 模式後清單應該還在').toBe(2);
  setMode('multi');
  expect(store.multiOverlayLayers.length, '切回 multi 模式後清單應該還在').toBe(2);
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
  expect(store.activeOverlayKey, 'activeOverlayKey 不受複合疊圖模式的勾選影響').toBe(keyA);
  expect(store.multiOverlayLayers.length, 'multiOverlayLayers 不受疊圖模式的單選影響').toBe(1);
  setMode('overlay');
  selectOverlayLayer(null);
  clearMultiOverlayLayers();
});

test('syncMultiLayerCheckedClasses：不同來源剛好有相同 layer.id 時，高亮只套用到勾選的那個來源（data-source-id 隔離）', () => {
  // sinica／chiayi／tainan 三個來源剛好都有一張 id 為 JM20K_1904、fmt 為
  // jpg 的圖層（真實資料裡的巧合），拿來驗證 syncMultiLayerCheckedClasses()
  // 用 `.source-group[data-source-id] .layer-item[data-layer-id]` 這組
  // CSS selector 查詢時，不會因為 layer.id 相同就誤觸發到別的來源。
  const sameId = 'JM20K_1904';
  const keyChiayi = `hist:chiayi:${sameId}:jpg`;
  clearMultiOverlayLayers();
  setMode('multi');
  toggleMultiOverlayLayer(keyChiayi);

  const multiCategoriesEl = document.getElementById('multiCategories');
  const chiayiItem = multiCategoriesEl.querySelector(`.source-group[data-source-id="chiayi"] .layer-item[data-layer-id="${sameId}"]`);
  const tainanItem = multiCategoriesEl.querySelector(`.source-group[data-source-id="tainan"] .layer-item[data-layer-id="${sameId}"]`);
  expect(!!chiayiItem, '應該找得到 chiayi 對應的圖層節點').toBeTruthy();
  expect(!!tainanItem, '應該找得到 tainan 對應的圖層節點（用來確認沒被誤觸發）').toBeTruthy();
  expect(chiayiItem.classList.contains('active'), '勾選的 chiayi 圖層應該高亮').toBeTruthy();
  expect(!tainanItem.classList.contains('active'), 'tainan 剛好有相同 layer.id，不應該被誤觸發高亮').toBeTruthy();

  setMode('overlay');
  clearMultiOverlayLayers();
});

test('自訂圖層在側邊欄面板按「刪除」後，layerCache 對應的地圖圖層也要一併移除（不是只從清單移除，見 store.js removeCustomSource() 的職責邊界說明）', () => {
  clearMultiOverlayLayers();
  clearCustomSources();
  setMode('multi');

  const entry = addCustomSource({ name: '刪除測試圖層', urlTemplate: 'https://example.com/{z}/{x}/{y}.png' });
  const key = `custom:${entry.id}`;
  toggleMultiOverlayLayer(key); // 勾選讓 applyMultiOverlayLayers() 真的透過 layerCache 建立圖層
  expect(hasCachedLayer(key), '勾選後應該已經在 layerCache 裡建立對應圖層').toBeTruthy();

  const removeBtn = document.getElementById('customSourceList').querySelector('.custom-source-remove');
  expect(!!removeBtn, '應該找得到這筆自訂圖層的刪除按鈕').toBeTruthy();
  removeBtn.click();

  expect(store.customSources.length, '自訂來源應該已經從 store 移除').toBe(0);
  expect(!hasCachedLayer(key), '刪除後 layerCache 也要一併移除，不能留下孤兒圖層持續背景下載圖磚').toBeTruthy();

  setMode('overlay');
});

test('四種模式可以互相切換，不會拋出例外', async () => {
  setMode('overlay');
  expect(store.mode, '切到 overlay').toBe('overlay');
  setMode('compare');
  expect(store.mode, '切到 compare').toBe('compare');
  setMode('timeline');
  await sleep(300);
  expect(store.mode, '切到 timeline').toBe('timeline');
  setMode('multi');
  expect(store.mode, '切到 multi').toBe('multi');
  setMode('overlay');
  expect(store.mode, '切回 overlay').toBe('overlay');
});
