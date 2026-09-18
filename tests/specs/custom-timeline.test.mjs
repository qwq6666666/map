import '../env-stub.mjs';
import { test, expect } from 'vitest';
import {
  extractYearNum,
  buildCustomTimelineCandidates,
  createCustomTimelineFromSelection,
  previewLayerOnMap,
  clearPreviewLayer,
} from '../../src/features/customTimeline.js';
import { closeCustomTimelineDock } from '../../src/features/customTimelineUI.js';
import { getCachedLayer } from '../../src/core/layerCache.js';
import { loadAppData } from '../../src/data.js';
import { initMapCore } from '../../src/mapCore.js';
import { initSidebar } from '../../src/sidebarUI.js';
import { initSearchUI } from '../../src/searchUI.js';
import { state as store, setMode } from '../../src/store.js';

await loadAppData();
initMapCore();
initSidebar();
initSearchUI();

/* ---------------------------------------------------------
   extractYearNum(layer)
--------------------------------------------------------- */

test('layer.yearNum 是數字時，優先權最高，直接回傳，不管 year/title 裡有沒有別的數字', () => {
  expect(extractYearNum({ yearNum: 1990, year: '明治34年(1801)', title: '1700年古地圖' })).toBe(1990);
});

test('yearNum 是 null 時視同沒有，改用 year/title 擷取', () => {
  expect(extractYearNum({ yearNum: null, year: '1904', title: '' })).toBe(1904);
});

test('yearNum 是 undefined 時視同沒有，改用 year/title 擷取', () => {
  expect(extractYearNum({ yearNum: undefined, year: '', title: '台北市舊航照(2002)' })).toBe(2002);
});

test('能從 year 欄位「明治28年(1895)」這種夾雜文字的格式擷取西元年', () => {
  expect(extractYearNum({ year: '明治28年(1895)', title: '' })).toBe(1895);
});

test('能從 year 欄位純西元年字串「1904」擷取', () => {
  expect(extractYearNum({ year: '1904', title: '' })).toBe(1904);
});

test('year 抓不到時，能從 title 欄位「台北市舊航照(2002)」擷取', () => {
  expect(extractYearNum({ year: '', title: '台北市舊航照(2002)' })).toBe(2002);
});

test('year 與 title 都沒有年份字樣時回傳 null', () => {
  expect(extractYearNum({ year: '未知年代', title: '無年代地圖' })).toBe(null);
});

test('邊界年份 1899／1900／2099 都能被正確擷取', () => {
  expect(extractYearNum({ year: '1899', title: '' })).toBe(1899);
  expect(extractYearNum({ year: '1900', title: '' })).toBe(1900);
  expect(extractYearNum({ year: '2099', title: '' })).toBe(2099);
});

test('三位數字不會被誤判成年份', () => {
  expect(extractYearNum({ year: '', title: '編號123號地圖' })).toBe(null);
});

test('五位數字（不含合法四位年份子字串）不會被誤判成年份', () => {
  expect(extractYearNum({ year: '99900', title: '' })).toBe(null);
});

/* ---------------------------------------------------------
   buildCustomTimelineCandidates(selected)
--------------------------------------------------------- */

function makeSelection(){
  const src = { name: 'srcA' };
  return [
    { src, layer: { id: 'L1', yearNum: 1950, title: '大久保地圖', year: '1950' } }, // 已有 yearNum
    { src, layer: { id: 'L2', title: '基隆地圖(1932)', year: '' } },                 // fallback 可抓到 1932
    { src, layer: { id: 'L3', title: '不明地圖A', year: '' } },                      // fallback 抓不到
    { src, layer: { id: 'L4', title: '不明地圖B', year: '' } },                      // fallback 抓不到
    { src, layer: { id: 'L5', yearNum: 1900, title: '日治初期', year: '' } },        // 已有 yearNum
  ];
}

test('依 layer.yearNum 由小到大排序，年代不明的排在最後', () => {
  const selected = makeSelection();
  const result = buildCustomTimelineCandidates(selected);
  expect(result.map(c => c.layer.id).join(','), '排序後的順序').toBe('L5,L2,L1,L3,L4');
});

test('年代不明的項目之間維持原始的相對順序（穩定排序）', () => {
  const selected = makeSelection();
  const result = buildCustomTimelineCandidates(selected);
  const undatedIds = result.filter(c => typeof c.layer.yearNum !== 'number').map(c => c.layer.id);
  expect(undatedIds.join(','), '不明年代項目相對順序').toBe('L3,L4');
});

test('原本沒有 yearNum、但 fallback 抓得到年份的項目，回傳結果裡 yearNum 真的被補上', () => {
  const selected = makeSelection();
  const result = buildCustomTimelineCandidates(selected);
  const l2 = result.find(c => c.layer.id === 'L2');
  expect(l2.layer.yearNum, 'L2 補上的 yearNum').toBe(1932);
});

test('不會 mutate 傳入的 selected 陣列本身', () => {
  const selected = makeSelection();
  const originalOrder = selected.map(c => c.layer.id).join(',');
  const originalL2YearNum = selected[1].layer.yearNum;
  const originalL3YearNum = selected[2].layer.yearNum;

  buildCustomTimelineCandidates(selected);

  expect(selected.map(c => c.layer.id).join(','), '原陣列順序未被更動').toBe(originalOrder);
  expect(selected[1].layer.yearNum, 'L2 原本物件的 yearNum 未被就地補上（應仍是 undefined）').toBe(originalL2YearNum);
  expect(selected[2].layer.yearNum, 'L3 原本物件的 yearNum 未被就地更動（應仍是 undefined）').toBe(originalL3YearNum);
  expect(typeof selected[1].layer.yearNum !== 'number', 'L2 原始物件不應該被就地補上數字').toBeTruthy();
});

/* ---------------------------------------------------------
   createCustomTimelineFromSelection(selected)
   ---------------------------------------------------------
   新架構重點：這個功能完全獨立於全站時間軸模式（不再共用
   store.mode／timelineMode.js），改成開啟獨立的浮動 dock
  （features/customTimelineUI.js），直接操作 core/layerCache.js
   做單一預覽圖層。每個測試結束都主動呼叫 closeCustomTimelineDock()
   收尾，避免污染下一個測試。
--------------------------------------------------------- */

test('呼叫後會在畫面上掛上 id 為 custom-timeline-dock 的節點', () => {
  closeCustomTimelineDock(); // 保險：確保從乾淨狀態開始

  const selected = makeSelection();
  createCustomTimelineFromSelection(selected);

  const dock = document.getElementById('custom-timeline-dock');
  expect(!!dock, '應該找得到 dock 節點').toBeTruthy();
  expect(dock.className.split(/\s+/).includes('custom-timeline-dock'), 'dock 應該帶有 custom-timeline-dock class').toBeTruthy();
  expect(document.body.children.includes(dock), 'dock 應該真的掛在 document.body 底下').toBeTruthy();

  closeCustomTimelineDock();
});

test('dock 的標題與年份顯示排序後第一筆（年代最舊）的圖層資訊', () => {
  const selected = makeSelection();
  createCustomTimelineFromSelection(selected);

  const expected = buildCustomTimelineCandidates(makeSelection())[0]; // L5：yearNum 1900，最舊
  const dock = document.getElementById('custom-timeline-dock');
  const title = dock.querySelector('.custom-timeline-title');
  const meta = dock.querySelector('.custom-timeline-meta');

  expect(title.textContent, '標題應該顯示排序後第一筆的圖層標題').toBe(expected.layer.title);
  expect(meta.textContent.includes(String(expected.layer.yearNum)), 'meta 應該包含該筆的年份').toBeTruthy();
  expect(meta.textContent.includes(expected.src.name), 'meta 應該包含來源名稱').toBeTruthy();

  closeCustomTimelineDock();
});

test('createCustomTimelineFromSelection 完全不會改變 store.mode（功能與全站時間軸模式完全獨立）', () => {
  setMode('compare'); // 刻意設成非預設值，證明呼叫前後真的沒被動過

  const selected = makeSelection();
  createCustomTimelineFromSelection(selected);

  expect(store.mode, 'store.mode 應該維持呼叫前的值，不受自訂時間軸影響').toBe('compare');

  closeCustomTimelineDock();
  setMode('overlay'); // 還原，避免影響同檔案內其他測試
});

test('傳入 2 筆以上時，dock 出現對應筆數的刻度點，且有可拖曳的滑桿', () => {
  const selected = makeSelection(); // 5 筆
  createCustomTimelineFromSelection(selected);

  const dock = document.getElementById('custom-timeline-dock');
  const dots = dock.querySelectorAll('.custom-timeline-dot');
  const slider = dock.querySelector('.custom-timeline-slider');

  expect(dots.length, '刻度點數量應該等於候選筆數').toBe(selected.length);
  expect(!!slider, '2 筆以上應該要有可拖曳的滑桿').toBeTruthy();

  closeCustomTimelineDock();
});

test('傳入剛好 1 筆時，不會出現滑桿，但仍然有 1 個刻度點', () => {
  const src = { name: 'srcOnly' };
  const selected = [{ src, layer: { id: 'ONLY', yearNum: 1930, title: '單一圖層', year: '1930' } }];
  createCustomTimelineFromSelection(selected);

  const dock = document.getElementById('custom-timeline-dock');
  const dots = dock.querySelectorAll('.custom-timeline-dot');
  const slider = dock.querySelector('.custom-timeline-slider');

  expect(dots.length, '仍然應該有 1 個刻度點').toBe(1);
  expect(!slider, '只有 1 筆時不應該出現滑桿').toBeTruthy();

  closeCustomTimelineDock();
});

test('呼叫 closeCustomTimelineDock() 之後，dock 會真的從畫面上移除', () => {
  const selected = makeSelection();
  createCustomTimelineFromSelection(selected);
  expect(!!document.getElementById('custom-timeline-dock'), '關閉前應該找得到 dock').toBeTruthy();

  closeCustomTimelineDock();

  expect(!document.getElementById('custom-timeline-dock'), '關閉後應該找不到 dock 節點').toBeTruthy();
});

test('重複呼叫 closeCustomTimelineDock()，或本來就沒開啟時，安全地什麼都不做、不會丟出例外', () => {
  closeCustomTimelineDock();
  closeCustomTimelineDock(); // 再呼叫一次不應該報錯
  expect(!document.getElementById('custom-timeline-dock'), '仍然應該找不到 dock').toBeTruthy();
});

test('再次呼叫 createCustomTimelineFromSelection() 會取代舊的 dock，畫面上永遠只有一個', () => {
  createCustomTimelineFromSelection(makeSelection());
  const firstDock = document.getElementById('custom-timeline-dock');
  expect(!!firstDock, '第一次呼叫應該有 dock').toBeTruthy();

  const secondSelected = [{ src: { name: 'srcB' }, layer: { id: 'NEW', yearNum: 2000, title: '新圖層', year: '2000' } }];
  createCustomTimelineFromSelection(secondSelected);

  const dock = document.getElementById('custom-timeline-dock');
  const title = dock.querySelector('.custom-timeline-title');
  expect(title.textContent, '應該顯示新一批候選的內容').toBe('新圖層');
  expect(document.body.children.length, 'document.body 底下應該只剩一個 dock（舊的已被取代移除，不是疊加）').toBe(1);

  closeCustomTimelineDock();
});

/* ---------------------------------------------------------
   previewLayerOnMap／clearPreviewLayer：直接操作 core/layerCache.js
   的單一預覽圖層機制，跟 dock UI 完全脫鉤，可以獨立驗證。
--------------------------------------------------------- */

test('previewLayerOnMap() 切換到新 key 時，前一張會被隱藏（opacity 0），新的一張套用指定透明度', () => {
  const src = { name: 'srcPreview' };
  const layerA = { id: 'PREVIEW_A', fmt: 'jpg', yearNum: 1900, title: 'A 圖層' };
  const layerB = { id: 'PREVIEW_B', fmt: 'jpg', yearNum: 1950, title: 'B 圖層' };

  const keyA = previewLayerOnMap(src, layerA, 80);
  const keyB = previewLayerOnMap(src, layerB, 50);

  expect(getCachedLayer(keyA).getOpacity(), '切走之後，前一張的 opacity 應該被設回 0').toBe(0);
  expect(getCachedLayer(keyB).getOpacity(), '新的一張應該套用指定的透明度百分比（50% -> 0.5）').toBe(0.5);

  clearPreviewLayer();
  expect(getCachedLayer(keyB).getOpacity(), 'clearPreviewLayer() 之後，目前這張 opacity 也應該變 0').toBe(0);
});
