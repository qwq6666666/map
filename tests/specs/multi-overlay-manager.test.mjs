/* ---------------------------------------------------------
   multi-overlay-manager.test.mjs — core/multiOverlayManager.js 回歸測試
   ---------------------------------------------------------
   DEVELOPMENT.md 明文警告：離開複合疊圖模式若忘記把共用 layer 物件的
   zIndex 重設回 undefined，會殘留污染疊圖／比對模式依賴的疊放順序
   假設。這裡直接測 applyMultiOverlayLayers()／hideMultiOverlayLayers()
   對快取圖層 zIndex 的設定與重設，不透過完整 UI 初始化
   （不需要 initMapCore()／initSidebar()：core/map.js 的 `map` 是
   import 時就建立好的單例，multiOverlayManager.js 依賴的
   layerCache.js／protectedKeys.js 也都只需要 store 與 DATA 就位）。
--------------------------------------------------------- */
import { test, expect } from 'vitest';
import '../env-stub.mjs';
import { loadAppData, DATA } from '../../src/data.js';
import { toggleMultiOverlayLayer, clearMultiOverlayLayers } from '../../src/store.js';
import { applyMultiOverlayLayers, hideMultiOverlayLayers } from '../../src/core/multiOverlayManager.js';
import { getCachedLayer, hasCachedLayer } from '../../src/core/layerCache.js';
import { previewLayerOnMap, clearPreviewLayer, getPreviewedKey } from '../../src/features/customTimeline.js';

await loadAppData();

const sinica = DATA.LAYER_SOURCES.find(s => s.id === 'sinica');
const layerA = sinica.categories[0].layers[0];
const layerB = sinica.categories[0].layers[1];
const keyA = `hist:sinica:${layerA.id}:${layerA.fmt}`;
const keyB = `hist:sinica:${layerB.id}:${layerB.fmt}`;

test('applyMultiOverlayLayers 依序設定 zIndex（BASE_Z_INDEX + 陣列 index）', () => {
  clearMultiOverlayLayers();
  toggleMultiOverlayLayer(keyA);
  toggleMultiOverlayLayer(keyB);
  applyMultiOverlayLayers();
  expect(getCachedLayer(keyA).getZIndex(), 'A 是第一筆，zIndex 應為 BASE_Z_INDEX(1)+0').toBe(1);
  expect(getCachedLayer(keyB).getZIndex(), 'B 是第二筆（疊在上層），zIndex 應為 BASE_Z_INDEX(1)+1').toBe(2);
  clearMultiOverlayLayers();
  applyMultiOverlayLayers();
});

test('hideMultiOverlayLayers 會把目前顯示中圖層的 zIndex 重設回 undefined（核心回歸案例）', () => {
  clearMultiOverlayLayers();
  toggleMultiOverlayLayer(keyA);
  toggleMultiOverlayLayer(keyB);
  applyMultiOverlayLayers();
  // 進場後應該真的有設定非 undefined 的 zIndex，否則下面「重設回 undefined」
  // 的斷言即使 hideMultiOverlayLayers() 整個沒動作也會誤判成通過。
  expect(getCachedLayer(keyA).getZIndex(), '進場後 A 應該有 zIndex').toBe(1);
  expect(getCachedLayer(keyB).getZIndex(), '進場後 B 應該有 zIndex').toBe(2);

  hideMultiOverlayLayers();

  expect(getCachedLayer(keyA).getZIndex(), '離開複合疊圖模式後，A 的 zIndex 應重設回 undefined').toBe(undefined);
  expect(getCachedLayer(keyB).getZIndex(), '離開複合疊圖模式後，B 的 zIndex 應重設回 undefined').toBe(undefined);
  expect(getCachedLayer(keyA).getOpacity(), '離開後 A 也應該被隱藏（opacity 0）').toBe(0);
  expect(getCachedLayer(keyB).getOpacity(), '離開後 B 也應該被隱藏（opacity 0）').toBe(0);

  clearMultiOverlayLayers();
});

test('applyMultiOverlayLayers 對「這一輪被移出清單」的圖層，也會重設 zIndex（不是只有整體離開才處理）', () => {
  clearMultiOverlayLayers();
  toggleMultiOverlayLayer(keyA);
  toggleMultiOverlayLayer(keyB);
  applyMultiOverlayLayers();
  expect(getCachedLayer(keyA).getZIndex(), '兩者都在清單中，A 應有 zIndex').toBe(1);

  // 移除 A，只剩 B，重新套用一次（比照使用者在複合疊圖模式中取消勾選 A）。
  toggleMultiOverlayLayer(keyA); // 再次 toggle＝移出清單
  applyMultiOverlayLayers();

  expect(getCachedLayer(keyA).getZIndex(), '被移出清單的 A，zIndex 應重設回 undefined').toBe(undefined);
  expect(getCachedLayer(keyA).getOpacity(), '被移出清單的 A，應被隱藏').toBe(0);
  expect(getCachedLayer(keyB).getZIndex(), '仍在清單中的 B 應該重新算過 zIndex（此時只剩它一筆，index 0）').toBe(1);
  expect(getCachedLayer(keyB).getOpacity(), '仍在清單中的 B 應維持顯示（opacity 100%）').toBe(1);

  clearMultiOverlayLayers();
  applyMultiOverlayLayers();
});

/* ---------------------------------------------------------
   跨功能交互：複合疊圖模式跟「自訂時間軸」（features/customTimeline.js）
   共用同一份 core/layerCache.js 物件——同一個 key 不管被誰用到，都只會
   有一個 TileLayer 實例。若使用者剛好在自訂時間軸播放／預覽的圖層，
   同時也被勾選進複合疊圖清單，離開複合疊圖模式或取消勾選那一筆時，
   resetLayerVisual() 不能直接把它隱藏——自訂時間軸的 dock 完全不知道
   複合疊圖模式做了什麼，會讓使用者看到 dock 仍顯示「正在預覽這一張」，
   地圖上卻已經空白。
--------------------------------------------------------- */

test('hideMultiOverlayLayers 不會隱藏「自訂時間軸」正在預覽的同一張圖層（回歸案例）', () => {
  clearMultiOverlayLayers();
  clearPreviewLayer();
  toggleMultiOverlayLayer(keyA);
  applyMultiOverlayLayers();
  expect(getCachedLayer(keyA).getOpacity(), '進場後 A 應該顯示（opacity 100%）').toBe(1);

  // 自訂時間軸也正在預覽同一張圖層（例如使用者搜尋到同一張圖層，
  // 另外開了自訂時間軸 dock 並播放到它）。
  previewLayerOnMap({ id: 'sinica' }, { id: layerA.id, fmt: layerA.fmt }, 70);
  expect(getPreviewedKey(), 'previewedKey 應該等於 keyA').toBe(keyA);
  expect(getCachedLayer(keyA).getOpacity(), '預覽套用 70% 透明度').toBeCloseTo(0.7);

  hideMultiOverlayLayers(); // 使用者離開複合疊圖模式

  expect(getCachedLayer(keyA).getOpacity(), '正被自訂時間軸預覽中，不應該被複合疊圖模式隱藏').toBeCloseTo(0.7);

  clearPreviewLayer(); // 自訂時間軸自己結束預覽，才真的隱藏
  expect(getCachedLayer(keyA).getOpacity(), '自訂時間軸結束預覽後應該歸零').toBe(0);
  clearMultiOverlayLayers();
});

test('applyMultiOverlayLayers 取消勾選「自訂時間軸」正在預覽的同一張圖層時，同樣不會被隱藏', () => {
  clearMultiOverlayLayers();
  clearPreviewLayer();
  toggleMultiOverlayLayer(keyA);
  applyMultiOverlayLayers();

  previewLayerOnMap({ id: 'sinica' }, { id: layerA.id, fmt: layerA.fmt }, 40);
  expect(getCachedLayer(keyA).getOpacity(), '預覽套用 40% 透明度').toBeCloseTo(0.4);

  toggleMultiOverlayLayer(keyA); // 使用者在複合疊圖清單取消勾選 A
  applyMultiOverlayLayers();

  expect(getCachedLayer(keyA).getOpacity(), '取消勾選但仍被自訂時間軸預覽中，不應該被隱藏').toBeCloseTo(0.4);

  clearPreviewLayer();
  expect(getCachedLayer(keyA).getOpacity(), '自訂時間軸結束預覽後應該歸零').toBe(0);
  clearMultiOverlayLayers();
});

test('hasCachedLayer：applyMultiOverlayLayers 呼叫過的 key 一定會建立快取圖層', () => {
  clearMultiOverlayLayers();
  toggleMultiOverlayLayer(keyA);
  applyMultiOverlayLayers();
  expect(hasCachedLayer(keyA), 'A 應該已經被建立進 layerCache').toBe(true);
  clearMultiOverlayLayers();
  applyMultiOverlayLayers();
});
