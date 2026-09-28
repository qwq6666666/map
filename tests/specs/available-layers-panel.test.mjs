import '../env-stub.mjs';
import { test, expect, beforeAll, afterAll } from 'vitest';
import { loadAppData } from '../../src/data.js';
import { initMapCore } from '../../src/mapCore.js';
import { initSidebar } from '../../src/sidebarUI.js';
import { initSearchUI, showLocationAndFindLayers } from '../../src/ui/search.js';
import { resetAvailCollapse } from '../../src/ui/availCollapse.js';

/* ---------------------------------------------------------
   tests/specs/available-layers-panel.test.mjs
   ---------------------------------------------------------
   ui/availableLayers.js 原本完全沒有任何測試檔引用過（全站掃描發現的
   缺口）：renderAvailableLayers() 本體（全部／類型／年代三個頁籤、收合鈕）
   已經被 search-token-race.test.mjs 這類端對端搜尋測試間接跑過，但「自訂
   時間軸多選模式」（進入/退出、全選、清除、勾選、確認鈕啟用狀態）完全沒有
   任何測試踩過。比照 search-token-race.test.mjs 的作法：真的開機（loadAppData
   ／initMapCore／initSidebar／initSearchUI）＋真的呼叫 showLocationAndFindLayers()
   取得一輪真實的 available 清單，而不是自己捏造假資料——這個模組跟
   uiTree.js／data.js／customTimeline.js／availCollapse.js 耦合較深，捏造假
   資料很容易漏掉真實資料形狀，端對端撈一次比較不會失真。
--------------------------------------------------------- */

await loadAppData();
initMapCore();
initSidebar();
initSearchUI();

const layerAvailPanelEl = document.getElementById('layerAvailPanel');
const searchBatchBarEl = document.getElementById('searchBatchBar');
const searchBatchCountEl = document.getElementById('searchBatchCount');
const searchBatchConfirmBtn = document.getElementById('searchBatchConfirmBtn');
const searchBatchSelectAllBtn = document.getElementById('searchBatchSelectAllBtn');
const searchBatchClearBtn = document.getElementById('searchBatchClearBtn');

// 台北車站附近：sinica 主機在這一帶收錄的圖層很多，確保 available 清單
// 有足夠筆數可以測多選（全選/清除/計數）。
const TAIPEI_LON = 121.5170;
const TAIPEI_LAT = 25.0478;

let availableCount = 0;

function checkedItems(){
  return layerAvailPanelEl.querySelectorAll('.avail-select-item.checked');
}

beforeAll(async () => {
  await showLocationAndFindLayers(TAIPEI_LON, TAIPEI_LAT, '測試：台北車站', {});
});

afterAll(() => { resetAvailCollapse(); });

test('前置條件：這個座標應該找得到至少一筆可用圖層，且有「自訂時間軸」按鈕', () => {
  const multiSelectBtn = layerAvailPanelEl.querySelector('.avail-multiselect-btn');
  expect(multiSelectBtn, '應該渲染出多選按鈕，代表 available.length > 0').toBeTruthy();
});

test('點「自訂時間軸」進入多選模式：切換成扁平勾選清單、隱藏頁籤、顯示浮動操作列', () => {
  const multiSelectBtn = layerAvailPanelEl.querySelector('.avail-multiselect-btn');
  multiSelectBtn.click();

  expect(layerAvailPanelEl.classList.contains('selection-mode')).toBe(true);
  expect(searchBatchBarEl.classList.contains('show')).toBe(true);
  expect(searchBatchConfirmBtn.disabled).toBe(true); // 還沒勾選任何一筆
  expect(searchBatchCountEl.textContent).toBe('已選取 0 筆圖資');

  const items = layerAvailPanelEl.querySelectorAll('.avail-select-item');
  expect(items.length).toBeGreaterThan(0);
  availableCount = items.length;

  multiSelectBtn.click(); // 還原：退出多選模式，不影響後面的獨立測試
  expect(layerAvailPanelEl.classList.contains('selection-mode')).toBe(false);
});

test('勾選單一項目：itemEl 加上 .checked、確認鈕啟用、計數文字更新', () => {
  layerAvailPanelEl.querySelector('.avail-multiselect-btn').click(); // 重新進入多選模式
  const item = layerAvailPanelEl.querySelector('.avail-select-item');
  const checkbox = item.querySelector('.avail-select-checkbox');

  checkbox.checked = true;
  checkbox._listeners.change[0]();

  expect(item.classList.contains('checked')).toBe(true);
  expect(searchBatchConfirmBtn.disabled).toBe(false);
  expect(searchBatchCountEl.textContent).toBe('已選取 1 筆圖資');

  checkbox.checked = false;
  checkbox._listeners.change[0]();
  expect(item.classList.contains('checked')).toBe(false);
  expect(searchBatchConfirmBtn.disabled).toBe(true);
});

test('「全選當前結果」勾滿所有項目；「清除選取」全部取消，確認鈕跟著停用', () => {
  searchBatchSelectAllBtn.click();
  expect(checkedItems().length).toBe(availableCount);
  expect(searchBatchConfirmBtn.disabled).toBe(false);
  expect(searchBatchCountEl.textContent).toBe(`已選取 ${availableCount} 筆圖資`);

  searchBatchClearBtn.click();
  expect(checkedItems().length).toBe(0);
  expect(searchBatchConfirmBtn.disabled).toBe(true);
});

test('確認鈕在沒有勾選時點擊不會做任何事（不會退出多選模式）', () => {
  expect(layerAvailPanelEl.classList.contains('selection-mode')).toBe(true);
  searchBatchConfirmBtn.click(); // disabled 但直接呼叫 handler 模擬（假 DOM 的 click() 不擋 disabled）
  expect(layerAvailPanelEl.classList.contains('selection-mode')).toBe(true); // 仍在多選模式，沒被清空
});

test('確認鈕在有勾選時點擊：退出多選模式（不深入驗證自訂時間軸 dock，那部分已有 custom-timeline.test.mjs 覆蓋）', () => {
  searchBatchSelectAllBtn.click();
  expect(searchBatchConfirmBtn.disabled).toBe(false);
  expect(() => searchBatchConfirmBtn.click()).not.toThrow();
  expect(layerAvailPanelEl.classList.contains('selection-mode')).toBe(false);
  expect(searchBatchBarEl.classList.contains('show')).toBe(false);
});

test('「全部／類型／年代」頁籤可以互相切換而不噴例外，切回全部後仍看得到來源清單', () => {
  const tabButtons = layerAvailPanelEl.querySelectorAll('.avail-tab-btn');
  expect(tabButtons.length).toBe(3);
  const [allBtn, typeBtn, yearBtn] = tabButtons;

  expect(() => typeBtn.click()).not.toThrow();
  expect(typeBtn.classList.contains('active')).toBe(true);
  expect(allBtn.classList.contains('active')).toBe(false);

  expect(() => yearBtn.click()).not.toThrow();
  expect(yearBtn.classList.contains('active')).toBe(true);
  // 年代頁籤應該有「新至舊／舊至新」排序切換鈕
  const sortBtns = layerAvailPanelEl.querySelectorAll('.avail-year-sort-btn');
  expect(sortBtns.length).toBe(2);
  expect(() => sortBtns[1].click()).not.toThrow(); // 切成「舊至新」

  allBtn.click();
  expect(allBtn.classList.contains('active')).toBe(true);
  expect(layerAvailPanelEl.querySelector('.source-group')).toBeTruthy();
});

test('收合鈕：點擊後面板加上收合狀態 class（實際 class 名稱見 availCollapse.js），再點一次恢復', () => {
  const collapseBtn = layerAvailPanelEl.querySelector('.avail-collapse-btn');
  expect(collapseBtn).toBeTruthy();
  const before = layerAvailPanelEl.className;
  expect(() => collapseBtn.click()).not.toThrow();
  expect(layerAvailPanelEl.className).not.toBe(before);
  expect(() => collapseBtn.click()).not.toThrow();
  expect(layerAvailPanelEl.className).toBe(before);
});
