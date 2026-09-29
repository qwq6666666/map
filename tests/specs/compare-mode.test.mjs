import '../env-stub.mjs';
import { test, expect } from 'vitest';
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
import { resolveSourceForCompareKey } from '../../src/features/compareMode.js';

await loadAppData();
initMapCore();
initSidebar();
initSearchUI();

test('進入比對模式：分隔線與左右容器顯示、左右裁切圖層建立', () => {
  setMode('overlay'); // 確保從乾淨狀態切入
  setMode('compare');
  expect(store.mode, '模式應該切到 compare').toBe('compare');
  expect(document.getElementById('swipeDivider').classList.contains('show'), 'swipeDivider 應該顯示').toBeTruthy();
  expect(document.getElementById('compareWrapA').classList.contains('show'), 'compareWrapA 應該顯示').toBeTruthy();
  expect(document.getElementById('compareWrapB').classList.contains('show'), 'compareWrapB 應該顯示').toBeTruthy();
  expect(runtime.swipeLayerA !== null, '左側裁切圖層應該已建立').toBeTruthy();
  expect(runtime.swipeLayerB !== null, '右側裁切圖層應該已建立').toBeTruthy();
});

test('離開比對模式：分隔線收起、左右裁切圖層清除', () => {
  setMode('compare');
  expect(runtime.swipeLayerA !== null, '前置條件：先確認左側圖層存在').toBeTruthy();
  setMode('overlay');
  expect(store.mode, '模式應該切回 overlay').toBe('overlay');
  expect(!document.getElementById('swipeDivider').classList.contains('show'), 'swipeDivider 應該收起').toBeTruthy();
  expect(!document.getElementById('compareWrapA').classList.contains('show'), 'compareWrapA 應該收起').toBeTruthy();
  expect(!document.getElementById('compareWrapB').classList.contains('show'), 'compareWrapB 應該收起').toBeTruthy();
  expect(runtime.swipeLayerA === null, '左側裁切圖層應該被清除').toBeTruthy();
  expect(runtime.swipeLayerB === null, '右側裁切圖層應該被清除').toBeTruthy();
});

test('positionDivider：分隔線位置依 swipePercent 與容器寬度計算（假環境預設寬度 800px）', () => {
  setMode('compare');
  setSwipePercent(25);
  expect(document.getElementById('swipeDivider').style.left, 'swipePercent=25 時應該落在 200px').toBe('200px');
  setSwipePercent(75);
  expect(document.getElementById('swipeDivider').style.left, 'swipePercent=75 時應該落在 600px').toBe('600px');
  setSwipePercent(50); // 還原預設值，避免影響其他測試檔的初始假設
  setMode('overlay');
});

test('compareA/compareB 切換時，非比對模式不會重建裁切圖層；切回比對模式才建立', () => {
  setMode('overlay');
  runtime.swipeLayerA = null; // 明確歸零，確保下面斷言不是殘留舊物件
  setCompareSide('A', 'hist:sinica:JM20K_1904:jpg');
  expect(runtime.swipeLayerA === null, '非比對模式下切換 compareA 不應該建立裁切圖層').toBeTruthy();
  setMode('compare');
  expect(runtime.swipeLayerA !== null, '切回比對模式後應該補建左側裁切圖層').toBeTruthy();
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
  setCompareSide('B', 'base:osm'); // 非 hist: 開頭，但 compareB 仍應無條件被保護（見下方斷言說明）
  toggleMultiOverlayLayer(multiKey);
  runtime.historyLayerKey = historyKey;

  const keys = getProtectedKeys();
  expect(keys.has(overlayKey), '應包含 activeOverlayKey').toBeTruthy();
  expect(keys.has(compareAKey), '應包含 compareA（hist: 開頭）').toBeTruthy();
  // compareA/compareB 無條件加入保護名單，不判斷字首：layerCache 的保護名單只是
  // 「跳過淘汰」，對沒有對應 cache entry 的 key（例如 base: 開頭，不會進
  // layerCache）完全無害。若在 protectedKeys.js 這裡另外判斷字首，等於跟
  // compareMode.js「只對 hist:/custom: 呼叫 getOrCreateSource()」的假設重複維護
  // 同一份子集邏輯，一旦 compareMode.js 之後改變快取策略卻忘記同步，就會讓比對
  // 模式正在用的圖層被誤淘汰——所以這裡刻意連 base:osm 也一併保護。
  expect(keys.has('base:osm'), 'compareB 即使非 hist: 開頭，也應該無條件被保護').toBeTruthy();
  expect(keys.has(multiKey), '應包含 multiOverlayLayers 裡的 key').toBeTruthy();
  expect(keys.has(historyKey), '應包含 runtime.historyLayerKey').toBeTruthy();

  // 還原狀態，避免污染同一份檔案裡後續（若有）測試
  selectOverlayLayer(null);
  clearMultiOverlayLayers();
  runtime.historyLayerKey = null;
});

test('resolveSourceForCompareKey：custom: 開頭的 key 跟 hist: 一樣走共用 layerCache（同一個 key 兩次呼叫拿到同一個 source）', () => {
  // 目前 UI 沒有入口讓自訂圖層被選進 compareA/compareB（見 CLAUDE.md「必須修正
  // 網站檔案.docx」第 31 項），這裡直接呼叫內部函式驗證快取行為本身一致，不需要
  // 真的存在對應的 customSources 項目——makeSourceForKey() 對解析不出來的 custom:
  // key 本來就會 fallback 成空白佔位 source（見 data.js），不會拋例外。
  const key = 'custom:not-a-real-id';
  const sourceA = resolveSourceForCompareKey(key);
  const sourceB = resolveSourceForCompareKey(key);
  expect(sourceA === sourceB, 'custom: key 應該走 getOrCreateSource() 共用快取，兩次呼叫拿到同一個 source 物件').toBeTruthy();
});

test('進入比對模式只隱藏疊圖模式的歷史圖層、不從地圖移除；切回疊圖後圖層仍在地圖上', async () => {
  const { map } = await import('../../src/core/map.js');
  const { DATA } = await import('../../src/data.js');
  const sinica = DATA.LAYER_SOURCES.find(s => s.id === 'sinica');
  const layer = sinica.categories[0].layers[0];
  const key = `hist:sinica:${layer.id}:${layer.fmt}`;

  setMode('overlay');
  selectOverlayLayer(key);
  const hist = runtime.historyLayer;
  expect(hist, '前置條件：疊圖模式應已建立歷史圖層').toBeTruthy();
  expect(map._layers.includes(hist), '前置條件：歷史圖層應在地圖上').toBe(true);

  setMode('compare');
  // layerCache 只在建立圖層時 addLayer；從地圖移除後切回疊圖模式就再也不會出現。
  expect(map._layers.includes(hist), '比對模式不可把共用快取圖層 removeLayer').toBe(true);
  expect(hist.getOpacity(), '比對模式下應隱藏（opacity 0）').toBe(0);

  setMode('overlay');
  expect(runtime.historyLayer, '切回疊圖後仍是同一張歷史圖層').toBe(hist);
  expect(map._layers.includes(hist), '切回疊圖後歷史圖層應仍在地圖上').toBe(true);
  setMode('overlay');
});

test('分隔線拖曳：第二根手指的 pointermove/pointerup 不會打斷正在拖曳中的第一根手指（多指觸控防呆）', () => {
  setMode('compare');
  setSwipePercent(50);

  const swipeHandle = document.getElementById('swipeHandle');
  const mapEl = document.getElementById('map');
  expect(mapEl.clientWidth, '前置條件：假環境 #map 寬度應為 800px').toBe(800);

  // 手指 1：在把手上按下，開始拖曳分隔線。
  swipeHandle._listeners['pointerdown'][0]({ pointerId: 1, preventDefault(){} });
  expect(runtime.dragging, '手指 1 按下後應進入拖曳中').toBe(true);

  // 手指 2：在畫面上其他地方（離分隔線很遠）觸碰後又提早放開——常見於
  // 手持裝置時手掌／另一手指誤觸。修正前 window 的 pointerup 監聽器完全
  // 不檢查 pointerId，任何手指放開都會把 runtime.dragging 清成 false，
  // 導致手指 1 明明還按著，卻再也拖不動分隔線。
  window._dispatch('pointerup', { pointerId: 2 });
  expect(runtime.dragging, '手指 2 放開不應該打斷手指 1 的拖曳').toBe(true);

  // 手指 2 中途移動：修正前 pointermove 同樣不比對 pointerId，會被誤當成
  // 拖曳中的手指，把分隔線拉到手指 2 的座標（790px ≈ 98.75%）。
  window._dispatch('pointermove', { pointerId: 2, clientX: 790 });
  expect(store.swipePercent, '手指 2 的移動不應該影響分隔線位置').toBe(50);

  // 手指 1 真正移動：分隔線應該正常跟著手指 1 走（400px = 50%，不必特地
  // 改變位置也能證明 store 沒有被手指 2 污染；這裡改到 200px = 25% 確認
  // 手指 1 仍然有效）。
  window._dispatch('pointermove', { pointerId: 1, clientX: 200 });
  expect(store.swipePercent, '手指 1 的移動應該正常更新分隔線位置').toBe(25);

  // 手指 1 放開：拖曳才真正結束。
  window._dispatch('pointerup', { pointerId: 1 });
  expect(runtime.dragging, '手指 1 放開後拖曳應該結束').toBe(false);

  setSwipePercent(50); // 還原預設值，避免影響其他測試檔的初始假設
  setMode('overlay');
});
