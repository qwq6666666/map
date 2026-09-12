/* ---------------------------------------------------------
   compare-mode-mobile-browse.test.mjs — 左右比對模式手機版
   （<=768px）A/B 兩側圖層選擇器面板串接「大區域→地區→來源」
   三段式瀏覽（features/compareMode.js 的 buildPickerPanel() 內呼叫
   ui/mobileRegionBrowse.js 的 initMobileCountryBrowse()）
   ---------------------------------------------------------
   compare-mode.test.mjs 沒有涵蓋這條路徑：tests/env-stub.mjs 沒有
   提供 window.matchMedia，buildPickerPanel() 內
   `typeof window.matchMedia === 'function'` 恆為 false，永遠落回
   `{ matches:false }` fallback，三段式瀏覽分支不會被跑到，只測到
   桌面版扁平手風琴那條路徑。

   這裡在 import initMapCore() 之前，於本檔案內局部 stub
   window.matchMedia（只影響這個獨立 process，不動共用的
   tests/env-stub.mjs），讓 buildPickerPanel() 每次呼叫都拿到一個
   全新、獨立、matches:true 的假 MediaQueryList，藉此驗證：
     1. A、B 兩側 picker 面板各自都能正確顯示三段式瀏覽 UI。
     2. A、B 兩側的 mobileBrowse 實例互相獨立（各自的國家篩選、
        大區域／地區選擇不會互相污染）。
     3. 三段式瀏覽選圖能正確觸發 onSelect，更新對應側的
        store.compareA／store.compareB。
--------------------------------------------------------- */
import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue } from '../assert.mjs';

// 局部 stub：每次呼叫都回傳全新、獨立的假 MediaQueryList（matches 固定
// true，模擬手機寬度）。buildPickerPanel() 對 A、B 兩側各自呼叫一次
// window.matchMedia()，兩側因此各自拿到不同物件參照，不會共用同一份
// mq 狀態——這正是下面測試要驗證的獨立性前提。
window.matchMedia = (query) => ({
  matches: true,
  media: query,
  addEventListener(){},
  removeEventListener(){},
  addListener(){},
  removeListener(){},
});

import { loadAppData, DATA } from '../../src/data.js';
import { macroRegionForSource } from '../../src/ui/mobileTwBrowse.js';
import { initMapCore } from '../../src/mapCore.js';
import { initSidebar } from '../../src/sidebarUI.js';
import { initSearchUI } from '../../src/searchUI.js';
import { state as store, setCompareSide } from '../../src/store.js';

await loadAppData();
initMapCore();
initSidebar();
initSearchUI();

const panelA = document.getElementById('pickerPanelA');
const panelB = document.getElementById('pickerPanelB');

// 回傳 [twEntry, cnEntry, otherEntry]：對應 compareMode.js 傳給
// initMobileCountryBrowse() 的 configs 順序（tw、cn、other 依序），三者的
// rootClassName 都是共用的 'mobile-tw-browse'（見 CLAUDE.md，
// mobileOtherBrowse.js 的「其他」分頁二段式瀏覽也沿用同一組 class），所以
// 用 querySelectorAll 取得的陣列順序來區分，不是用 className。
function mobileBrowseEntries(panelEl){
  return panelEl.querySelectorAll('.mobile-tw-browse');
}

test('手機寬度下，A、B 兩側 picker 面板各自都有三段式瀏覽 UI（tw／cn／other 各一個大區域／來源按鈕列＋國家篩選列）', () => {
  [[panelA, 'A'], [panelB, 'B']].forEach(([panelEl, label]) => {
    const entries = mobileBrowseEntries(panelEl);
    assertEqual(entries.length, 3, `${label} 側面板應該有 tw／cn／other 三個三段式（或二段式）瀏覽容器`);
    entries.forEach(entry => {
      const macroRow = entry.children[0];
      assertTrue(!!macroRow && macroRow.classList.contains('mobile-tw-macro-row'), `${label} 側每個瀏覽容器都應該有大區域／來源按鈕列`);
      assertTrue(macroRow.children.length > 0, `${label} 側大區域／來源按鈕列不應該是空的`);
    });
    assertTrue(!!panelEl.querySelector('.country-filter'), `${label} 側面板應該有國家篩選列`);
  });
});

test('A、B 兩側 mobileBrowse 實例互相獨立：兩側的三段式瀏覽容器不是同一個 DOM 節點', () => {
  const [twEntryA, cnEntryA, otherEntryA] = mobileBrowseEntries(panelA);
  const [twEntryB, cnEntryB, otherEntryB] = mobileBrowseEntries(panelB);
  assertTrue(twEntryA !== twEntryB, 'A、B 兩側的 tw 三段式瀏覽容器應該是各自獨立建立的 DOM 節點');
  assertTrue(cnEntryA !== cnEntryB, 'A、B 兩側的 cn 三段式瀏覽容器應該是各自獨立建立的 DOM 節點');
  assertTrue(otherEntryA !== otherEntryB, 'A、B 兩側的 other（其他）瀏覽容器應該是各自獨立建立的 DOM 節點');
});

test('切換 A 側國家篩選列到「中國」，只影響 A 側面板的三段式瀏覽顯示，不影響 B 側', () => {
  const filterBarA = panelA.querySelector('.country-filter');
  const cnBtnA = Array.from(filterBarA.children).find(b => b.textContent === '中國');
  assertTrue(!!cnBtnA, 'A 側篩選列應該有「中國」按鈕');
  cnBtnA.click();

  const [twEntryA, cnEntryA] = mobileBrowseEntries(panelA);
  assertEqual(twEntryA.hidden, true, 'A 側切到中國後，tw 三段式瀏覽應該隱藏');
  assertEqual(cnEntryA.hidden, false, 'A 側切到中國後，cn 三段式瀏覽應該顯示');

  const [twEntryB, cnEntryB] = mobileBrowseEntries(panelB);
  assertEqual(twEntryB.hidden, false, 'B 側不受 A 側篩選列切換影響，應該仍顯示 tw 三段式瀏覽');
  assertEqual(cnEntryB.hidden, true, 'B 側不受 A 側篩選列切換影響，cn 三段式瀏覽應該仍隱藏');

  // 還原：切回台灣分頁，避免影響後續測試對 A 側的假設
  const twBtnA = Array.from(filterBarA.children).find(b => b.textContent === '台灣');
  twBtnA.click();
});

test('切換 A 側國家篩選列到「其他」，只影響 A 側面板的 other 二段式瀏覽顯示，不影響 B 側', () => {
  const filterBarA = panelA.querySelector('.country-filter');
  const otherBtnA = Array.from(filterBarA.children).find(b => b.textContent === '其他');
  assertTrue(!!otherBtnA, 'A 側篩選列應該有「其他」按鈕');
  otherBtnA.click();

  const [twEntryA, cnEntryA, otherEntryA] = mobileBrowseEntries(panelA);
  assertEqual(twEntryA.hidden, true, 'A 側切到其他後，tw 瀏覽應該隱藏');
  assertEqual(cnEntryA.hidden, true, 'A 側切到其他後，cn 瀏覽應該隱藏');
  assertEqual(otherEntryA.hidden, false, 'A 側切到其他後，other 瀏覽應該顯示');

  const [twEntryB, , otherEntryB] = mobileBrowseEntries(panelB);
  assertEqual(twEntryB.hidden, false, 'B 側不受 A 側篩選列切換影響，應該仍顯示 tw 瀏覽');
  assertEqual(otherEntryB.hidden, true, 'B 側不受 A 側篩選列切換影響，other 瀏覽應該仍隱藏');

  // other 分頁是「來源 chip → buildSourceGroup」二段式，結構跟 tw/cn 不同
  // （沒有地區列），這裡只驗證第一層來源 chip 列存在且數量等於 country==='other' 的來源數。
  const otherSourceRow = otherEntryA.children[0];
  const expectedOtherCount = DATA.LAYER_SOURCES.filter(s => s.country === 'other').length;
  assertEqual(otherSourceRow.children.length, expectedOtherCount, 'A 側 other 來源 chip 數量應等於 country==="other" 的來源總數');

  // 還原：切回台灣分頁，避免影響後續測試對 A 側的假設
  const twBtnA = Array.from(filterBarA.children).find(b => b.textContent === '台灣');
  twBtnA.click();
});

test('三段式瀏覽選擇大區域後正確篩出來源，且只影響被操作的那一側', () => {
  const twEntryA = mobileBrowseEntries(panelA)[0];
  const twEntryB = mobileBrowseEntries(panelB)[0];
  const macroRowA = twEntryA.children[0];
  const northBtn = Array.from(macroRowA.children).find(b => b.textContent === '北部');
  assertTrue(!!northBtn, 'A 側應該有「北部」大區域按鈕');
  northBtn.click();

  const expectedCount = DATA.LAYER_SOURCES.filter(s => s.country === 'tw' && macroRegionForSource(s) === '北部').length;
  assertTrue(expectedCount > 0, '前置條件：北部應該至少有一個 tw 來源');

  const sourcesWrapA = twEntryA.children[3];
  assertEqual(sourcesWrapA.children.length, expectedCount, 'A 側選擇北部後，應該篩出所有北部來源的 source-group');

  const sourcesWrapB = twEntryB.children[3];
  assertEqual(sourcesWrapB.children.length, 0, 'B 側未操作，三段式瀏覽的來源清單應該仍是空的（另一側不受影響）');
});

test('三段式瀏覽點選圖層：onSelect 正確觸發，只更新被操作那一側的 store.compareA/compareB', () => {
  setCompareSide('A', 'base:osm');
  setCompareSide('B', 'base:sat');

  // 沿用上一個測試已選好「北部」的 A 側面板狀態，直接找一個圖層項目點選。
  const twEntryA = mobileBrowseEntries(panelA)[0];
  const layerItem = twEntryA.querySelector('.layer-item[data-layer-id]');
  assertTrue(!!layerItem, 'A 側北部來源篩選結果裡應該至少能找到一個圖層項目');
  const expectedLayerId = layerItem.dataset.layerId;
  layerItem.click();

  assertTrue(store.compareA !== 'base:osm', 'A 側 store.compareA 應該被三段式瀏覽選圖更新，不再是原本的 base:osm');
  assertTrue(store.compareA.startsWith('hist:'), 'A 側 store.compareA 應該是選到的歷史圖層 key');
  assertTrue(store.compareA.includes(expectedLayerId), 'A 側 store.compareA 應該包含剛剛點選的圖層 id');
  assertEqual(store.compareB, 'base:sat', 'B 側 store.compareB 不應該被 A 側的三段式瀏覽選圖影響');
  assertTrue(!panelA.classList.contains('open'), '選好圖層後 A 側面板應該收合');
});

await run();
