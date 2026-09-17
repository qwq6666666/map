import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue, waitFor } from '../assert.mjs';
import { loadAppData, DATA } from '../../src/data.js';
import { initMapCore } from '../../src/mapCore.js';
import { initSidebar } from '../../src/sidebarUI.js';
import { initSearchUI } from '../../src/searchUI.js';
import { state as store, setMode, setBaseLayer, selectOverlayLayer } from '../../src/store.js';
import { activateFromSearch } from '../../src/features/search.js';
import { getCacheStats } from '../../src/core/layerManager.js';

await loadAppData();
initMapCore();
initSidebar();
initSearchUI();

// setMode('timeline') 會透過 core/modeManager.js 觸發 timelineMode.js 的
// activateTimelineMode()/refreshNow()，這是背景逐筆圖磚探測、完成後才
// buildTimeline() 的 fire-and-forget 流程，呼叫端沒有回傳可以 await 的
// Promise。這裡的三個呼叫點都只是想確保「進入 timeline 模式後，背景
// 探測真的跑完了」再繼續下一步（避免這個 fire-and-forget 流程晚一步
// 才 resolve、把畫面更新／預載動作延伸到下一筆測試案例才發生），改成
// 輪詢「.timeline-dot 真的渲染出來」這個可觀察條件，取代原本賭一個
// 經驗值夠不夠長的 sleep(300)。env-stub.mjs 預設的假 Image 一律成功，
// sinica 方案 A 系列一定會探測到資料，不會卡在「沒有找到資料」的分支。
function waitForTimelineRefresh(){
  return waitFor(() => document.getElementById('mapTimelineBarInner').querySelectorAll('.timeline-dot').length > 0, {
    message: '進入時間軸模式後，逾時仍未渲染出任何 .timeline-dot（背景圖磚探測流程可能卡住）'
  });
}

test('初始狀態是 overlay 模式、osm 底圖', () => {
  assertEqual(store.mode, 'overlay', '初始模式');
  assertEqual(store.baseLayer, 'osm', '初始底圖');
});

test('三種模式可以互相切換，不會拋出例外', async () => {
  setMode('compare');
  assertEqual(store.mode, 'compare', '切到 compare');
  setMode('timeline');
  await waitForTimelineRefresh();
  assertEqual(store.mode, 'timeline', '切到 timeline');
  setMode('overlay');
  assertEqual(store.mode, 'overlay', '切回 overlay');
});

test('選擇歷史圖層後，activeOverlayKey 正確更新', () => {
  const sinica = DATA.LAYER_SOURCES.find(s => s.id === 'sinica');
  const layer = sinica.categories[0].layers[0];
  const key = `hist:sinica:${layer.id}:${layer.fmt}`;
  selectOverlayLayer(key);
  assertEqual(store.activeOverlayKey, key, 'activeOverlayKey');
});

test('再次選擇同一個圖層會 toggle 關閉', () => {
  const sinica = DATA.LAYER_SOURCES.find(s => s.id === 'sinica');
  const layer = sinica.categories[0].layers[0];
  const key = `hist:sinica:${layer.id}:${layer.fmt}`;
  selectOverlayLayer(null); // 先確保是關閉狀態，不依賴前面測試殘留的狀態
  selectOverlayLayer(key); // 開
  selectOverlayLayer(key); // 再選一次應該關閉
  assertEqual(store.activeOverlayKey, null, 'activeOverlayKey 應該變回 null');
});

test('activeOverlayKey 在切換模式之間會保留，不會被清掉', async () => {
  const sinica = DATA.LAYER_SOURCES.find(s => s.id === 'sinica');
  const layer = sinica.categories[0].layers[0];
  const key = `hist:sinica:${layer.id}:${layer.fmt}`;
  setMode('overlay');
  selectOverlayLayer(null); // 先重設，確保下面是乾淨地從「未選取」切到「選取」
  selectOverlayLayer(key);
  setMode('timeline');
  await waitForTimelineRefresh();
  assertEqual(store.activeOverlayKey, key, '切到 timeline 後 activeOverlayKey 應該還在');
  setMode('overlay');
  assertEqual(store.activeOverlayKey, key, '切回 overlay 後 activeOverlayKey 應該還在');
});

test('進入比對模式時，compareA 會自動帶入目前的 activeOverlayKey', async () => {
  const sinica = DATA.LAYER_SOURCES.find(s => s.id === 'sinica');
  const layer = sinica.categories[0].layers[0];
  const key = `hist:sinica:${layer.id}:${layer.fmt}`;
  setMode('overlay');
  selectOverlayLayer(null); // 先重設，確保下面 selectOverlayLayer(key) 一定是「選取」而不是誤觸發 toggle 關閉
  selectOverlayLayer(key);
  setMode('compare');
  assertEqual(store.compareA, key, 'compareA 應該等於剛才選的圖層');
  setMode('overlay');
});

test('activateFromSearch：時間軸模式下套用搜尋結果不會被強制切回 overlay，也不會清空時間軸圖層快取', async () => {
  const sinica = DATA.LAYER_SOURCES.find(s => s.id === 'sinica');
  const layerA = sinica.categories[0].layers[0];
  const layerB = sinica.categories[0].layers[1];
  const keyA = `hist:sinica:${layerA.id}:${layerA.fmt}`;
  const keyB = `hist:sinica:${layerB.id}:${layerB.fmt}`;

  setMode('overlay');
  selectOverlayLayer(null);
  selectOverlayLayer(keyA); // 先在疊圖模式套用一張圖層，讓它被放進 layerCache
  assertTrue(getCacheStats().keys.includes(keyA), '前置條件：keyA 應該已經在 layerCache 裡');

  setMode('timeline');
  await waitForTimelineRefresh();
  assertTrue(getCacheStats().keys.includes(keyA), '前置條件：切到 timeline 模式不應該清掉 keyA 的快取');

  activateFromSearch(sinica, layerB);

  assertEqual(store.mode, 'timeline', '套用搜尋結果不應該把模式強制切回 overlay，應該留在 timeline');
  assertEqual(store.activeOverlayKey, keyB, 'activeOverlayKey 應該更新成搜尋選的圖層');
  assertTrue(getCacheStats().keys.includes(keyA), 'keyA 的快取不應該因為這次搜尋套用而被清空（clearLayerPool 不應該被誤觸發）');

  setMode('overlay');
});

test('底圖切換正常運作', () => {
  setBaseLayer('sat');
  assertEqual(store.baseLayer, 'sat', '底圖應該變成 sat');
  setBaseLayer('osm');
  assertEqual(store.baseLayer, 'osm', '底圖應該變回 osm');
});

await run();
