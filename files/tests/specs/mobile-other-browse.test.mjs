/* ---------------------------------------------------------
   mobile-other-browse.test.mjs — src/ui/mobileOtherBrowse.js
   ---------------------------------------------------------
   分兩部分：
   1. buildMobileOtherBrowseUI() 純 UI 邏輯單元測試，用最小的假
      sources／buildSourceGroup（比照 mobile-region-browse.test.mjs
      的寫法），不依賴真實 DATA.LAYER_SOURCES。
   2. 串接真實 app 的回歸測試：驗證「其他」分頁三處呼叫端
      （sidebarUI.js 的 MOBILE_BROWSE_CONFIGS、features/multiOverlay.js、
      features/compareMode.js）都確實把 { country:'other', build:
      buildMobileOtherBrowseUI } 這筆設定接進去，避免以後改一處漏改
      另一處（compareMode.js 那份已在
      compare-mode-mobile-browse.test.mjs 涵蓋，這裡補 sidebarUI.js／
      multiOverlay.js 兩處）。
--------------------------------------------------------- */
import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import { buildMobileOtherBrowseUI } from '../../src/ui/mobileOtherBrowse.js';

/* ===========================================================
   Part 1：buildMobileOtherBrowseUI() 純 UI 邏輯單元測試
=========================================================== */

// 最小假來源：只需要 buildMobileOtherBrowseUI 內部用得到的欄位
// （id／name／categories，categories 給 layerCountForSource() 算數字用）。
const sourceA = { id: 'src-a', name: 'A館', categories: [{ layers: [{}, {}] }] }; // count = 2
const sourceB = { id: 'src-b', name: 'B館', categories: [{ layers: [{}] }] }; // count = 1

function fakeBuildSourceGroup(src){
  const wrap = document.createElement('div');
  wrap.className = 'source-group';
  wrap.dataset.sourceId = src.id;
  wrap.textContent = src.name;
  return wrap;
}

function chipFor(root, name){
  const sourceRow = root.children[0];
  return Array.from(sourceRow.children).find(btn => btn.textContent.startsWith(name));
}

test('buildMobileOtherBrowseUI：對每個來源各自渲染一個 chip，文字含名稱與 layerCountForSource 數字', () => {
  const root = buildMobileOtherBrowseUI([sourceA, sourceB], fakeBuildSourceGroup);
  const sourceRow = root.children[0];
  assertEqual(sourceRow.children.length, 2, '應該有 2 個來源 chip');
  assertEqual(sourceRow.children[0].textContent, 'A館 2', 'A 來源 chip 文字應為名稱＋圖層數');
  assertEqual(sourceRow.children[1].textContent, 'B館 1', 'B 來源 chip 文字應為名稱＋圖層數');
});

test('buildMobileOtherBrowseUI：初始狀態未選取任何來源，顯示提示文字，sourcesWrap 是空的', () => {
  const root = buildMobileOtherBrowseUI([sourceA, sourceB], fakeBuildSourceGroup);
  const hint = root.children[1];
  const sourcesWrap = root.children[2];
  // 元件在初始建立時不會主動呼叫 renderSources()（只有點擊 chip 才會），
  // hint.hidden 沿用 HTMLElement 的預設值（未顯式設定即為 false／falsy），
  // 這裡用 assertTrue(!hidden) 而非 assertEqual(..., false)，避免跟 DOM
  // stub 對「未顯式賦值屬性」的預設值（undefined）打架。
  assertTrue(!hint.hidden, '未選取來源時應該顯示提示文字');
  assertEqual(hint.textContent, '請先選擇來源', '提示文字內容應該正確');
  assertEqual(sourcesWrap.children.length, 0, '未選取來源時 sourcesWrap 應該是空的');
});

test('buildMobileOtherBrowseUI：點擊 A 來源 chip，顯示 A 的 buildSourceGroup 內容、隱藏提示文字、chip 標記 active', () => {
  const root = buildMobileOtherBrowseUI([sourceA, sourceB], fakeBuildSourceGroup);
  const hint = root.children[1];
  const sourcesWrap = root.children[2];
  const chipA = chipFor(root, 'A館');
  chipA.click();

  assertEqual(hint.hidden, true, '選取來源後提示文字應該隱藏');
  assertEqual(sourcesWrap.children.length, 1, 'sourcesWrap 應該只有 1 個 buildSourceGroup 結果');
  assertEqual(sourcesWrap.children[0].dataset.sourceId, 'src-a', '顯示的應該是 A 來源的內容');
  assertTrue(chipA.classList.contains('active'), 'A chip 應該被標記 active');
});

test('buildMobileOtherBrowseUI：單選 toggle——再點一次已選中的 chip 會取消選取，回到提示文字', () => {
  const root = buildMobileOtherBrowseUI([sourceA, sourceB], fakeBuildSourceGroup);
  const hint = root.children[1];
  const sourcesWrap = root.children[2];
  const chipA = chipFor(root, 'A館');

  chipA.click(); // 選取 A
  chipA.click(); // 再點一次 = 取消

  assertEqual(hint.hidden, false, '取消選取後應該回到顯示提示文字');
  assertEqual(sourcesWrap.children.length, 0, '取消選取後 sourcesWrap 應該清空');
  assertTrue(!chipA.classList.contains('active'), 'A chip 不應該再是 active');
});

test('buildMobileOtherBrowseUI：切換選取——先點 A 再點 B，只顯示 B 的內容（不是疊加），A 不再 active', () => {
  const root = buildMobileOtherBrowseUI([sourceA, sourceB], fakeBuildSourceGroup);
  const sourcesWrap = root.children[2];
  const chipA = chipFor(root, 'A館');
  const chipB = chipFor(root, 'B館');

  chipA.click();
  chipB.click();

  assertEqual(sourcesWrap.children.length, 1, '切換選取後 sourcesWrap 應該只有 1 筆（B 的內容），不是疊加成 2 筆');
  assertEqual(sourcesWrap.children[0].dataset.sourceId, 'src-b', '應該顯示 B 來源的內容');
  assertTrue(!chipA.classList.contains('active'), 'A chip 應該不再是 active');
  assertTrue(chipB.classList.contains('active'), 'B chip 應該變成 active');
});

test('buildMobileOtherBrowseUI：otherSources 為空陣列時不噴錯，chip 列是空的、顯示提示文字', () => {
  const root = buildMobileOtherBrowseUI([], fakeBuildSourceGroup);
  const sourceRow = root.children[0];
  const hint = root.children[1];
  assertEqual(sourceRow.children.length, 0, '空陣列時 chip 列應該沒有任何 chip');
  assertTrue(!hint.hidden, '空陣列時仍應該顯示提示文字');
});

test('buildMobileOtherBrowseUI：otherSources 只有 1 筆時可以正常渲染與選取', () => {
  const root = buildMobileOtherBrowseUI([sourceA], fakeBuildSourceGroup);
  const sourceRow = root.children[0];
  const sourcesWrap = root.children[2];
  assertEqual(sourceRow.children.length, 1, '只有 1 筆來源時 chip 列應該只有 1 個 chip');
  sourceRow.children[0].click();
  assertEqual(sourcesWrap.children.length, 1, '點擊唯一的 chip 後應該正常顯示其內容');
  assertEqual(sourcesWrap.children[0].dataset.sourceId, 'src-a');
});

/* ===========================================================
   Part 2：sidebarUI.js／multiOverlay.js 兩處呼叫端串接回歸測試
   （比照 compare-mode-mobile-browse.test.mjs 的作法，局部 stub
   window.matchMedia 讓手機版三段式／二段式瀏覽分支被跑到；
   sidebarUI.js／multiOverlay.js 的 mq 是 import 當下就建立的
   module-level 常數，所以必須在 import 這兩支模組之前先 stub 好）。
--------------------------------------------------------- */
window.matchMedia = (query) => ({
  matches: true,
  media: query,
  addEventListener(){},
  removeEventListener(){},
  addListener(){},
  removeListener(){},
});

const { loadAppData, DATA } = await import('../../src/data.js');
const { initMapCore } = await import('../../src/mapCore.js'); // 內部會呼叫 initMultiOverlayUI()
const { initSidebar } = await import('../../src/sidebarUI.js');
const { initSearchUI } = await import('../../src/searchUI.js');

await loadAppData();
initMapCore();
initSidebar();
initSearchUI();

test('全站「其他」（country===\'other\'）來源目前應為 4 個：japan／korea／ls／southeast_asia（新增/移除時要同步更新這裡）', () => {
  const otherSources = DATA.LAYER_SOURCES.filter(s => s.country === 'other');
  const ids = otherSources.map(s => s.id).sort();
  assertEqual(ids.join(','), 'japan,korea,ls,southeast_asia', '目前「其他」分類的來源 id 應該剛好是這 4 個');
});

test('sidebarUI.js #categories：手機寬度下應該有 3 個 .mobile-tw-browse 容器（tw／cn／other），MOBILE_BROWSE_CONFIGS 沒有漏接 other', () => {
  const categoriesEl = document.getElementById('categories');
  const entries = categoriesEl.querySelectorAll('.mobile-tw-browse');
  assertEqual(entries.length, 3, '#categories 底下應該有 tw／cn／other 三個瀏覽容器');
});

test('features/multiOverlay.js #multiCategories：手機寬度下應該有 3 個 .mobile-tw-browse 容器（tw／cn／other），initMobileCountryBrowse() 的 configs 沒有漏接 other', () => {
  const multiCategoriesEl = document.getElementById('multiCategories');
  const entries = multiCategoriesEl.querySelectorAll('.mobile-tw-browse');
  assertEqual(entries.length, 3, '#multiCategories 底下應該有 tw／cn／other 三個瀏覽容器');
});

await run();
