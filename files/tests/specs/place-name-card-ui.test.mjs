import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import { loadAppData } from '../../src/data.js';
import { initMapCore } from '../../src/mapCore.js';
import { initSidebar } from '../../src/sidebarUI.js';
import { initSearchUI, renderPlaceNameCard, renderPlaceNameCandidateList, renderMergedSuggestList, hidePlaceNameCard } from '../../src/ui/search.js';

/* ---------------------------------------------------------
   tests/specs/place-name-card-ui.test.mjs
   ---------------------------------------------------------
   針對 #placeNameCard 的渲染／收合／清除邏輯寫測試，做法比照
   tests/specs/full-integration.test.mjs：loadAppData() + initMapCore()
   + initSidebar() + initSearchUI() 把整個初始化流程跑一次，讓
   ui/search.js 內部的模組層級 DOM 變數（placeNameCardEl 等）被指到
   env-stub.mjs 的假 DOM 節點。

   這裡刻意直接呼叫 renderPlaceNameCard()／renderPlaceNameCandidateList()／
   hidePlaceNameCard()（本次任務新增的 export，見 CLAUDE.md 交接說明），
   不透過完整的 showLocationAndFindLayers() 非同步流程——後者還會牽動
   真正的 findAvailableLayersAt()（地理編碼＋逐筆圖磚驗證），跟這裡要
   驗證的「卡片內容渲染對不對」是兩件事，直接測渲染函式本身更精準也
   更快。
--------------------------------------------------------- */
const place = {
  name: '德化社',
  aliases: ['卜吉', '化番社'],
  county: '南投縣',
  town: '魚池鄉',
  description: '日月潭邊的邵族聚落，日治時期曾稱化番社。',
  sourceType: 'settlement',
  longitude: 120.9123,
  latitude: 23.8567
};

const placeNoAlias = {
  name: '社寮',
  aliases: [],
  county: '南投縣',
  town: '竹山鎮',
  description: '',
  sourceType: 'admin',
  longitude: 120.6789,
  latitude: 23.7654
};

await loadAppData();
initMapCore();
initSidebar();
initSearchUI();

const placeNameCardEl = document.getElementById('placeNameCard');
const placeNameCardBodyEl = document.getElementById('placeNameCardBody');
const placeNameCardToggleBtn = document.getElementById('placeNameCardToggle');
const addressSuggestEl = document.getElementById('addressSuggest');
const addressInput = document.getElementById('addressInput');
const addressInputClearBtn = document.getElementById('addressInputClearBtn');
const clearLocationBtn = document.getElementById('clearLocationBtn');

// 觸發 #addressInput 的 input debounce handler：env-stub.mjs 的 FakeNode
// 沒有實作通用 dispatchEvent()，比照 tests/specs/draw-color.test.mjs 等
// 既有測試直接呼叫 `_listeners['input'][0]()`（handler 不吃事件物件）。
function typeAddress(value){
  addressInput.value = value;
  addressInput._listeners.input[0]();
}

function cardText(){
  // env-stub.mjs 的 FakeNode.textContent 是單純屬性，不會像真的瀏覽器
  // DOM 一樣自動彙總子孫節點文字，這裡走訪整棵子樹自行拼接，方便用
  // 「文字內容是否包含某段字串」的方式驗證渲染結果。
  const parts = [];
  (function walk(node){
    if(node.textContent) parts.push(node.textContent);
    (node.children || []).forEach(walk);
  })(placeNameCardBodyEl);
  return parts.join('\n');
}

test('renderPlaceNameCard()：呼叫後 #placeNameCard.hidden 變成 false，內容包含現名文字', () => {
  renderPlaceNameCard(place);
  assertEqual(placeNameCardEl.hidden, false, '渲染後卡片應該顯示');
  assertTrue(cardText().includes('德化社'), '應該包含現名「德化社」');
});

test('renderPlaceNameCard()：呼叫後預設是收合狀態（collapsed class／aria-expanded=false／▸）', () => {
  renderPlaceNameCard(place);
  assertTrue(placeNameCardEl.classList.contains('collapsed'), '渲染後應該預設收合');
  assertEqual(placeNameCardToggleBtn.getAttribute('aria-expanded'), 'false', 'aria-expanded 應該是 false');
  assertEqual(placeNameCardToggleBtn.textContent, '▸', '收合按鈕文字應該是 ▸');
});

test('renderPlaceNameCard()：aliases 非空時會顯示別名／舊稱標籤與內容', () => {
  renderPlaceNameCard(place);
  const text = cardText();
  assertTrue(text.includes('別名／舊稱'), '應該顯示「別名／舊稱」標籤');
  assertTrue(text.includes('卜吉') && text.includes('化番社'), '應該顯示別名內容');
});

test('renderPlaceNameCard()：現代位置一定顯示（縣市＋鄉鎮）', () => {
  renderPlaceNameCard(place);
  assertTrue(cardText().includes('南投縣魚池鄉'), '應該顯示現代位置');
});

test('renderPlaceNameCard()：資料來源固定格式，且正確帶入 sourceTypeLabel', () => {
  renderPlaceNameCard(place);
  assertTrue(cardText().includes('臺灣地區地名資料（聚落類）'), '資料來源文字格式應該正確（settlement -> 聚落）');
});

test('renderPlaceNameCard()：aliases 為空陣列時，卡片內容不出現「別名／舊稱」標籤', () => {
  renderPlaceNameCard(placeNoAlias);
  const text = cardText();
  assertTrue(!text.includes('別名／舊稱'), 'aliases 為空時不應該出現別名／舊稱標籤');
  assertTrue(text.includes('社寮'), '仍然應該顯示現名');
  assertTrue(text.includes('臺灣地區地名資料（行政區域類）'), 'admin 類型的資料來源文字應該正確');
});

test('renderPlaceNameCard()：description 為空字串時，不顯示「地名說明」標籤', () => {
  renderPlaceNameCard(placeNoAlias);
  assertTrue(!cardText().includes('地名說明'), 'description 為空時不應該有地名說明區塊');
});

test('renderPlaceNameCard()：description 過長時會截斷並顯示「展開全文」按鈕', () => {
  const longDesc = '甲'.repeat(150);
  renderPlaceNameCard({ ...place, description: longDesc });
  const text = cardText();
  assertTrue(text.includes('展開全文'), '超過 100 字應該顯示「展開全文」按鈕');
  assertTrue(!text.includes(longDesc), '截斷狀態不應該顯示完整全文');
});

test('點擊「展開全文」按鈕後顯示完整全文，按鈕文字變成「收合」', () => {
  const longDesc = '乙'.repeat(150);
  renderPlaceNameCard({ ...place, description: longDesc });
  // 走訪找出「展開全文」按鈕本身並點擊。
  let toggleBtn = null;
  (function walk(node){
    if(node.tag === 'button' && node.textContent === '展開全文') toggleBtn = node;
    (node.children || []).forEach(walk);
  })(placeNameCardBodyEl);
  assertTrue(!!toggleBtn, '前置條件：應該找得到「展開全文」按鈕');

  toggleBtn.click();

  assertTrue(cardText().includes(longDesc), '點擊後應該顯示完整全文');
  assertEqual(toggleBtn.textContent, '收合', '按鈕文字應該變成「收合」');
});

test('收合按鈕（#placeNameCardToggle）點擊後，#placeNameCard 移除 collapsed class（展開）', () => {
  renderPlaceNameCard(place); // 渲染後預設是收合狀態
  assertTrue(placeNameCardEl.classList.contains('collapsed'), '前置條件：卡片預設應該是收合狀態');

  placeNameCardToggleBtn.click();

  assertTrue(!placeNameCardEl.classList.contains('collapsed'), '點擊收合按鈕後應該移除 collapsed class（展開）');
  assertEqual(placeNameCardToggleBtn.getAttribute('aria-expanded'), 'true', '展開後 aria-expanded 應該是 true');
  assertEqual(placeNameCardToggleBtn.textContent, '▾', '展開後按鈕文字應該是 ▾');
});

test('再次點擊收合按鈕會加回 collapsed class（切換回收合）', () => {
  assertTrue(!placeNameCardEl.classList.contains('collapsed'), '前置條件：目前應該是展開狀態');

  placeNameCardToggleBtn.click();

  assertTrue(placeNameCardEl.classList.contains('collapsed'), '再次點擊應該加回 collapsed class');
  assertEqual(placeNameCardToggleBtn.getAttribute('aria-expanded'), 'false', '收合後 aria-expanded 應該是 false');
  assertEqual(placeNameCardToggleBtn.textContent, '▸', '收合後按鈕文字應該是 ▸');
});

test('hidePlaceNameCard()：呼叫後 #placeNameCard.hidden 變成 true', () => {
  renderPlaceNameCard(place);
  assertEqual(placeNameCardEl.hidden, false, '前置條件：卡片應該是顯示中');

  hidePlaceNameCard();

  assertEqual(placeNameCardEl.hidden, true, '呼叫後卡片應該隱藏');
});

test('renderPlaceNameCandidateList()：多筆候選會各自渲染成 .place-name-suggest-item', () => {
  const candidates = [place, placeNoAlias];
  renderPlaceNameCandidateList(candidates);
  const items = addressSuggestEl.children.filter(c => c.classList.contains('place-name-suggest-item'));
  assertEqual(items.length, 2, '應該渲染出跟候選筆數相同的項目');
  assertTrue(addressSuggestEl.classList.contains('show'), '候選清單容器應該加上 show class');
});

test('renderMergedSuggestList()：地名候選在上、地址建議在下，且各自套用對應 class', () => {
  const geocodeResults = [{ display_name: '南投縣魚池鄉德化社', lon: '120.9123', lat: '23.8567' }];
  renderMergedSuggestList([place], geocodeResults);
  assertTrue(addressSuggestEl.classList.contains('show'), '建議清單容器應該加上 show class');
  const children = addressSuggestEl.children;
  assertEqual(children.length, 2, '應該渲染出地名候選＋地址建議共 2 筆');
  assertTrue(children[0].classList.contains('place-name-suggest-item'), '第一筆應該是地名候選項目');
  assertTrue(children[1].classList.contains('address-suggest-item') && !children[1].classList.contains('place-name-suggest-item'), '第二筆應該是一般地址建議項目');
});

test('renderMergedSuggestList()：地名候選與地址建議皆為空陣列時，顯示空狀態訊息', () => {
  renderMergedSuggestList([], []);
  assertTrue(addressSuggestEl.classList.contains('show'), '空狀態也應該加上 show class（顯示提示文字）');
  const empty = addressSuggestEl.children.find(c => c.classList.contains('address-suggest-empty'));
  assertTrue(!!empty, '應該渲染出空狀態提示元素');
});

/* ---------------------------------------------------------
   #addressInput debounce 觸發門檻（ADDRESS_SUGGEST_MIN_QUERY_LENGTH=2）
   ---------------------------------------------------------
   直接測「會不會排入 debounce timer」，不等真的 550ms 觸發、也不讓
   debounce callback 真的執行（避免打到 findPlaceNameCandidates()／
   geocodeAddress() 這兩個涉及 fetch 的非同步流程，跟這裡要驗證的門檻
   邏輯無關）：暫時替換 globalThis.setTimeout 成純粹計數用的假版本，
   測完立刻還原，不影響其他測試。
--------------------------------------------------------- */
function withFakeDebounceTimer(fn){
  const original = globalThis.setTimeout;
  const calls = [];
  globalThis.setTimeout = (cb, ms) => { calls.push(ms); return 0; };
  try{
    fn(calls);
  } finally {
    globalThis.setTimeout = original;
  }
}

test('#addressInput debounce：輸入未達門檻（1 字）不會建立 debounce timer', () => {
  withFakeDebounceTimer((calls) => {
    typeAddress('中');
    assertEqual(calls.length, 0, '長度 1（< ADDRESS_SUGGEST_MIN_QUERY_LENGTH=2）不應該排入 debounce timer');
  });
});

test('#addressInput debounce：輸入達到門檻（2 字）會建立一個 550ms 的 debounce timer', () => {
  withFakeDebounceTimer((calls) => {
    typeAddress('中正');
    assertEqual(calls.length, 1, '長度 2 應該排入 1 個 debounce timer');
    assertEqual(calls[0], 550, 'debounce 延遲應該是 550ms');
  });
});

/* ---------------------------------------------------------
   #addressInputClearBtn（手機版輸入框快速清除鈕）
--------------------------------------------------------- */

test('#addressInputClearBtn：輸入框有文字時顯示，清空文字後隱藏', () => {
  withFakeDebounceTimer(() => {
    typeAddress('中正');
    assertEqual(addressInputClearBtn.hidden, false, '有輸入內容時清除鈕應該顯示');

    typeAddress('');
    assertEqual(addressInputClearBtn.hidden, true, '清空輸入內容後清除鈕應該隱藏');
  });
});

test('點擊 #addressInputClearBtn：清空輸入框文字並隱藏自己', () => {
  withFakeDebounceTimer(() => {
    typeAddress('台北車站');
    assertEqual(addressInputClearBtn.hidden, false, '前置條件：清除鈕應該顯示');

    addressInputClearBtn.click();

    assertEqual(addressInput.value, '', '點擊後輸入框應該清空');
    assertEqual(addressInputClearBtn.hidden, true, '點擊後清除鈕應該隱藏');
  });
});

test('點擊 #clearLocationBtn：同步隱藏 #addressInputClearBtn（清除搜尋結果時輸入框清除鈕也要跟著收起）', () => {
  addressInput.value = '台北車站';
  addressInputClearBtn.hidden = false; // 模擬使用者先前已輸入過文字、清除鈕正顯示中

  clearLocationBtn.click();

  assertEqual(addressInput.value, '', '點擊後輸入框應該清空');
  assertEqual(addressInputClearBtn.hidden, true, '點擊後應該同步隱藏清除鈕');
});

await run();
