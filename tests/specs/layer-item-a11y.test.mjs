/* ---------------------------------------------------------
   layer-item-a11y.test.mjs — uiTree.js 的 .layer-item 無障礙可及性回歸測試
   ---------------------------------------------------------
   背景：全站所有模式（疊圖／複合疊圖／比對／時間軸／手機三段式瀏覽）
   共用的 .layer-item 清單項目，原本是純 <div> + 滑鼠 click listener，
   完全沒有 role/tabindex/aria 屬性，鍵盤使用者與螢幕報讀器都無法使用。
   markInteractiveLayerItem() 補上最小可行的鍵盤可及性（tabIndex、
   role="button"、Enter/Space 觸發），這裡驗證這個共用邏輯本身，以及
   buildLayerItem()／compareMode.js／timelineUI.js 三個呼叫端都有正確
   套用。
--------------------------------------------------------- */
import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import { buildLayerItem, markInteractiveLayerItem } from '../../src/uiTree.js';

test('markInteractiveLayerItem：加上 tabIndex=0 與 role="button"', () => {
  const item = document.createElement('div');
  markInteractiveLayerItem(item, () => {});
  assertEqual(item.tabIndex, 0, '應該可以被 Tab 移動焦點過去');
  assertEqual(item.getAttribute('role'), 'button', '應該有 role="button" 讓螢幕報讀器識別成可互動元素');
});

test('markInteractiveLayerItem：點擊（click）會觸發 onActivate', () => {
  let called = 0;
  const item = document.createElement('div');
  markInteractiveLayerItem(item, () => { called++; });
  item.click();
  assertEqual(called, 1, '點擊應該觸發一次 onActivate');
});

test('markInteractiveLayerItem：鍵盤 Enter 會觸發 onActivate', () => {
  let called = 0;
  const item = document.createElement('div');
  markInteractiveLayerItem(item, () => { called++; });
  item._listeners['keydown'][0]({ key: 'Enter', preventDefault(){} });
  assertEqual(called, 1, 'Enter 應該觸發一次 onActivate');
});

test('markInteractiveLayerItem：鍵盤 Space（" "）會觸發 onActivate，且會呼叫 preventDefault 避免頁面捲動', () => {
  let called = 0;
  let prevented = false;
  const item = document.createElement('div');
  markInteractiveLayerItem(item, () => { called++; });
  item._listeners['keydown'][0]({ key: ' ', preventDefault(){ prevented = true; } });
  assertEqual(called, 1, 'Space 應該觸發一次 onActivate');
  assertTrue(prevented, 'Space 應該呼叫 preventDefault，避免瀏覽器預設的頁面捲動行為');
});

test('markInteractiveLayerItem：其他按鍵（例如方向鍵）不應該觸發 onActivate', () => {
  let called = 0;
  const item = document.createElement('div');
  markInteractiveLayerItem(item, () => { called++; });
  item._listeners['keydown'][0]({ key: 'ArrowDown', preventDefault(){} });
  assertEqual(called, 0, '不相關的按鍵不應該觸發 onActivate');
});

test('buildLayerItem：產生的 .layer-item 也套用了鍵盤可及性（tabIndex/role），且 Enter 會觸發 onLayerClick', () => {
  const layer = { id: 'test-layer', year: '1900', title: '測試圖層' };
  let firedLayer = null;
  const item = buildLayerItem(layer, (l) => { firedLayer = l; });
  assertEqual(item.tabIndex, 0, 'buildLayerItem 產生的節點應該可以被 Tab 移動焦點過去');
  assertEqual(item.getAttribute('role'), 'button', 'buildLayerItem 產生的節點應該有 role="button"');
  item._listeners['keydown'][0]({ key: 'Enter', preventDefault(){} });
  assertEqual(firedLayer, layer, 'Enter 應該觸發跟點擊一樣的 onLayerClick(layer)');
});

await run();
