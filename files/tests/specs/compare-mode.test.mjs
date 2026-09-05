import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import { loadAppData } from '../../src/data.js';
import { initMapCore } from '../../src/mapCore.js';
import { initSidebar } from '../../src/sidebarUI.js';
import { initSearchUI } from '../../src/searchUI.js';
import {
  state as store,
  setMode,
  setSwipePercent,
  setCompareSide,
  selectOverlayLayer,
  toggleMultiOverlayLayer,
  clearMultiOverlayLayers,
} from '../../src/store.js';
import { runtime } from '../../src/runtime.js';
import { getProtectedKeys } from '../../src/core/protectedKeys.js';

await loadAppData();
initMapCore();
initSidebar();
initSearchUI();

test('進入比對模式：分隔線與左右容器顯示、左右裁切圖層建立', () => {
  setMode('overlay'); // 確保從乾淨狀態切入
  setMode('compare');
  assertEqual(store.mode, 'compare', '模式應該切到 compare');
  assertTrue(document.getElementById('swipeDivider').classList.contains('show'), 'swipeDivider 應該顯示');
  assertTrue(document.getElementById('compareWrapA').classList.contains('show'), 'compareWrapA 應該顯示');
  assertTrue(document.getElementById('compareWrapB').classList.contains('show'), 'compareWrapB 應該顯示');
  assertTrue(runtime.swipeLayerA !== null, '左側裁切圖層應該已建立');
  assertTrue(runtime.swipeLayerB !== null, '右側裁切圖層應該已建立');
});

test('離開比對模式：分隔線收起、左右裁切圖層清除', () => {
  setMode('compare');
  assertTrue(runtime.swipeLayerA !== null, '前置條件：先確認左側圖層存在');
  setMode('overlay');
  assertEqual(store.mode, 'overlay', '模式應該切回 overlay');
  assertTrue(!document.getElementById('swipeDivider').classList.contains('show'), 'swipeDivider 應該收起');
  assertTrue(!document.getElementById('compareWrapA').classList.contains('show'), 'compareWrapA 應該收起');
  assertTrue(!document.getElementById('compareWrapB').classList.contains('show'), 'compareWrapB 應該收起');
  assertTrue(runtime.swipeLayerA === null, '左側裁切圖層應該被清除');
  assertTrue(runtime.swipeLayerB === null, '右側裁切圖層應該被清除');
});

test('positionDivider：分隔線位置依 swipePercent 與容器寬度計算（假環境預設寬度 800px）', () => {
  setMode('compare');
  setSwipePercent(25);
  assertEqual(document.getElementById('swipeDivider').style.left, '200px', 'swipePercent=25 時應該落在 200px');
  setSwipePercent(75);
  assertEqual(document.getElementById('swipeDivider').style.left, '600px', 'swipePercent=75 時應該落在 600px');
  setSwipePercent(50); // 還原預設值，避免影響其他測試檔的初始假設
  setMode('overlay');
});

test('compareA/compareB 切換時，非比對模式不會重建裁切圖層；切回比對模式才建立', () => {
  setMode('overlay');
  runtime.swipeLayerA = null; // 明確歸零，確保下面斷言不是殘留舊物件
  setCompareSide('A', 'hist:sinica:JM20K_1904:jpg');
  assertTrue(runtime.swipeLayerA === null, '非比對模式下切換 compareA 不應該建立裁切圖層');
  setMode('compare');
  assertTrue(runtime.swipeLayerA !== null, '切回比對模式後應該補建左側裁切圖層');
  setMode('overlay');
});

test('getProtectedKeys 保護名單涵蓋 compareA/compareB/activeOverlayKey/multiOverlayLayers/historyLayerKey', () => {
  const overlayKey = 'hist:sinica:JM25K_1921:jpg';
  const compareAKey = 'hist:sinica:JM20K_1904:jpg';
  const multiKey = 'hist:sinica:JM50K_1929:jpg';
  const historyKey = 'hist:sinica:JM100K_1932:jpg';

  selectOverlayLayer(null); // 先重設，避免 toggle 語意誤判
  selectOverlayLayer(overlayKey);
  setCompareSide('A', compareAKey);
  setCompareSide('B', 'base:osm'); // 非 hist: 開頭，不應該被當成需要保護的歷史圖層 key
  toggleMultiOverlayLayer(multiKey);
  runtime.historyLayerKey = historyKey;

  const keys = getProtectedKeys();
  assertTrue(keys.has(overlayKey), '應包含 activeOverlayKey');
  assertTrue(keys.has(compareAKey), '應包含 compareA（hist: 開頭）');
  assertTrue(!keys.has('base:osm'), 'compareB 是 base:osm，非歷史圖層 key，不應該被視為需要保護');
  assertTrue(keys.has(multiKey), '應包含 multiOverlayLayers 裡的 key');
  assertTrue(keys.has(historyKey), '應包含 runtime.historyLayerKey');

  // 還原狀態，避免污染同一份檔案裡後續（若有）測試
  selectOverlayLayer(null);
  clearMultiOverlayLayers();
  runtime.historyLayerKey = null;
});

await run();
