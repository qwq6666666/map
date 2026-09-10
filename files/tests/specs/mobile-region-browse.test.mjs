/* ---------------------------------------------------------
   mobile-region-browse.test.mjs — src/ui/mobileRegionBrowse.js
   ---------------------------------------------------------
   只測 initMobileCountryBrowse()：這是從 sidebarUI.js 原本內聯的
   syncMobileBrowseView() 抽出來的通用版本，目前被
   features/multiOverlay.js／features/compareMode.js 共用（sidebarUI.js
   本身繼續用它自己那份內聯邏輯，不受影響）。用最小的假 build／
   buildSourceGroup／sources 驗證通用機制本身：
     - 依 configs 各別呼叫 build()，把回傳的容器 append 進 containerEl。
     - sync() 依 mq.matches ＋ getCurrentCountry() 正確切換每個容器的
       hidden，並同步對應國別的 sourceWraps 加/減
       mobile-tw-accordion-hidden class。
   不驗證 buildMobileTwBrowseUI／buildMobileCnBrowseUI 內部細節
   （macroRegionForSource／regionLabelForSource 等），那些已經在
   mobile-tw-browse.test.mjs／mobile-cn-browse.test.mjs 涵蓋。
--------------------------------------------------------- */
import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import { initMobileCountryBrowse } from '../../src/ui/mobileRegionBrowse.js';

// 最小假來源：只需要 country 欄位（initMobileCountryBrowse 用來篩選丟給
// 各 build() 的子集），其餘欄位不影響這裡要測的邏輯。
const sources = [
  { id: 'tw-a', country: 'tw' },
  { id: 'tw-b', country: 'tw' },
  { id: 'cn-a', country: 'cn' }
];

// 假 build()：模擬 buildMobileTwBrowseUI／buildMobileCnBrowseUI，記錄
// 收到哪些 sources，並用 buildSourceGroup() 幫每筆來源建一個節點掛入。
function fakeBuild(filteredSources, buildSourceGroup){
  const el = document.createElement('div');
  el.className = 'fake-browse';
  filteredSources.forEach(src => el.appendChild(buildSourceGroup(src)));
  return el;
}

function fakeBuildSourceGroup(src){
  const wrap = document.createElement('div');
  wrap.className = 'source-group';
  wrap.dataset.sourceId = src.id;
  return wrap;
}

function setup(){
  const containerEl = document.createElement('div');
  const sourceWraps = sources.map(src => ({ src, wrap: document.createElement('div') }));
  let current = 'tw';
  const mq = { matches: false };
  const { sync } = initMobileCountryBrowse({
    containerEl,
    sources,
    buildSourceGroup: fakeBuildSourceGroup,
    sourceWraps,
    configs: [
      { country: 'tw', build: fakeBuild },
      { country: 'cn', build: fakeBuild }
    ],
    mq,
    getCurrentCountry: () => current
  });
  return { containerEl, sourceWraps, mq, sync, setCurrent: (c) => { current = c; } };
}

test('initMobileCountryBrowse：依 configs 各別呼叫 build()，並把結果 append 進 containerEl', () => {
  const { containerEl } = setup();
  assertEqual(containerEl.children.length, 2, 'tw／cn 兩個 config 各建立一個容器');
  const [twEl, cnEl] = containerEl.children;
  assertEqual(twEl.children.length, 2, 'tw 容器裡應該只收到 2 筆 tw 來源');
  assertEqual(cnEl.children.length, 1, 'cn 容器裡應該只收到 1 筆 cn 來源');
});

test('sync()：手機寬度＋目前分頁 tw 時，tw 容器顯示、cn 容器隱藏，且只有 tw 的 sourceWraps 被加上 accordion-hidden', () => {
  const { containerEl, sourceWraps, mq, sync } = setup();
  mq.matches = true;
  sync();
  const [twEl, cnEl] = containerEl.children;
  assertEqual(twEl.hidden, false, 'tw 分頁三段式瀏覽應該顯示');
  assertEqual(cnEl.hidden, true, '非目前分頁的 cn 容器應該隱藏');
  sourceWraps.forEach(({ src, wrap }) => {
    const expected = src.country === 'tw';
    assertEqual(wrap.classList.contains('mobile-tw-accordion-hidden'), expected,
      `${src.id} 的扁平手風琴節點 accordion-hidden 狀態應該對應其國別`);
  });
});

test('sync()：非手機寬度時，不論目前分頁為何，兩個容器都隱藏、sourceWraps 都不加 accordion-hidden', () => {
  const { containerEl, sourceWraps, mq, sync } = setup();
  mq.matches = false;
  sync();
  const [twEl, cnEl] = containerEl.children;
  assertEqual(twEl.hidden, true, '桌面寬度不顯示三段式瀏覽（tw）');
  assertEqual(cnEl.hidden, true, '桌面寬度不顯示三段式瀏覽（cn）');
  sourceWraps.forEach(({ src, wrap }) => {
    assertTrue(!wrap.classList.contains('mobile-tw-accordion-hidden'),
      `桌面寬度不應該隱藏扁平手風琴節點（${src.id}）`);
  });
});

test('sync()：切換目前分頁後重新呼叫，顯示狀態與 accordion-hidden 會跟著切換', () => {
  const { containerEl, sourceWraps, mq, sync, setCurrent } = setup();
  mq.matches = true;
  sync(); // 目前分頁 tw（setup() 預設值）

  setCurrent('cn');
  sync();

  const [twEl, cnEl] = containerEl.children;
  assertEqual(twEl.hidden, true, '切到 cn 分頁後，tw 容器應該改為隱藏');
  assertEqual(cnEl.hidden, false, '切到 cn 分頁後，cn 容器應該改為顯示');
  sourceWraps.forEach(({ src, wrap }) => {
    const expected = src.country === 'cn';
    assertEqual(wrap.classList.contains('mobile-tw-accordion-hidden'), expected,
      `切到 cn 分頁後，${src.id} 的 accordion-hidden 狀態應該對應其國別`);
  });
});

await run();
