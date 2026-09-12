import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import { loadAppData } from '../../src/data.js';
import { initMapCore } from '../../src/mapCore.js';
import { initSidebar } from '../../src/sidebarUI.js';
import { initSearchUI } from '../../src/ui/search.js';

/* ---------------------------------------------------------
   tests/specs/nearby-place-names-ui.test.mjs
   ---------------------------------------------------------
   針對 src/ui/search.js 新增的「附近歷史地名」清單（一般地址搜尋命中
   後，在 #locationResult 裡順帶列出附近的地名今昔對照候選）寫測試。

   renderNearbyPlaceNames()／buildNearbyPlaceNameItem()／
   selectGeocodeResult()／selectPlaceNameCandidate() 這幾個都是
   ui/search.js 內部沒有 export 的函式（見 CLAUDE.md 任務交接說明），
   這裡刻意不另外要求它們 export——改用跟 place-name-card-ui.test.mjs
   同一套手法：透過 initSearchUI() 掛好的真實 DOM 事件流程（直接呼叫
   `#addressSearchBtn` 的 click handler，也就是 runImmediateSearch()）
   走一次完整的「打字搜尋 -> 命中 -> 渲染」流程，再從 #locationResult
   的實際 DOM 結構驗證渲染結果，跟真正使用者操作路徑一致。

   為了不真的打 Nominatim／10MB 的 data/place-names.json，這裡覆寫
   globalThis.fetch：地名今昔對照資料改成回傳這份檔案自己準備的小型
   fixture（比照 tests/specs/geocode.test.mjs／identify-pin.test.mjs
   既有「每個測試檔案各自覆寫 globalThis.fetch」的做法），一般地理
   編碼（Nominatim search endpoint）也回傳固定的假座標；其餘網址
   （例如 loadAppData() 需要的 data/layers.bundle.json 等本機檔案）
   原樣交給 env-stub.mjs 原本的假 fetch 處理。

   findAvailableLayersAt()（找出「這個地點目前有哪些歷史地圖圖層可
   套疊」）會照常真的跑一輪（候選圖層數量經過確認落在合理範圍內，
   見 CLAUDE.md／SOURCE_MAP_RULES.alwaysInclude 只有 sinica／ls／ccts
   三個全臺涵蓋來源共約 285 筆，env-stub.mjs 的假 Image 一律模擬成功，
   不會真的發送網路請求也不會卡住），不特別 mock 掉；這是刻意選擇：
   showLocationAndFindLayers() 開頭清空 .nearby-place-names 的動作，
   跟 selectGeocodeResult() 結尾渲染 .nearby-place-names 的動作之間，
   實際上就隔著這整段流程，直接測完整路徑比另外挖一個測試專用的假
   showLocationAndFindLayers() 更能反映真實行為。
--------------------------------------------------------- */

// 搜尋基準點：沿用 place-names-matching.test.mjs／place-names-nearby.test.mjs
// 同一個南投縣魚池鄉德化社座標，方便跨測試檔對照。
const GEO_LON = 120.9123;
const GEO_LAT = 23.8567;

// 兩筆落在預設 800 公尺半徑內的地名候選（皆為正東方向位移，方便手算
// 大略距離：這個緯度下 1 度經度約 101.9 公里，0.0005 度約 51 公尺，
// 0.0027 度約 275 公尺，兩者都在 800 公尺內）。
const NEAR_PLACE_A = {
  name: '化番社舊址', aliases: ['卜吉舊社'], county: '南投縣', town: '魚池鄉',
  description: '', sourceType: 'settlement', longitude: GEO_LON + 0.0005, latitude: GEO_LAT
};
const NEAR_PLACE_B = {
  name: '德化社渡船頭', aliases: [], county: '南投縣', town: '魚池鄉',
  description: '', sourceType: 'settlement', longitude: GEO_LON + 0.0027, latitude: GEO_LAT
};
// 遠方地名（約超過 5 公里），確認不會被納入附近清單。
const FAR_PLACE = {
  name: '遠方地名', aliases: [], county: '南投縣', town: '魚池鄉',
  description: '', sourceType: 'settlement', longitude: GEO_LON + 0.5, latitude: GEO_LAT + 0.5
};
// 專門給「地名今昔對照精確比對」路徑用的獨立地點（跟上面附近搜尋用的
// 地點刻意分開，避免兩種測試情境互相干擾）。
const EXACT_MATCH_PLACE = {
  name: '卜吉庄', aliases: ['卜吉'], county: '南投縣', town: '魚池鄉',
  description: '日治時期舊稱', sourceType: 'settlement', longitude: 121.05, latitude: 24.05
};

const FIXTURE_PLACES = [NEAR_PLACE_A, NEAR_PLACE_B, FAR_PLACE, EXACT_MATCH_PLACE];

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const urlStr = String(url);
  if(urlStr.includes('data/place-names.json')){
    return { ok: true, json: async () => ({ places: FIXTURE_PLACES }) };
  }
  if(urlStr.includes('nominatim.openstreetmap.org/search')){
    return {
      ok: true,
      json: async () => ([{ display_name: '南投縣魚池鄉測試地址100號', lon: String(GEO_LON), lat: String(GEO_LAT), address: {} }])
    };
  }
  return originalFetch(url, options);
};

await loadAppData();
initMapCore();
initSidebar();
initSearchUI();

const addressInput = document.getElementById('addressInput');
const addressSearchBtn = document.getElementById('addressSearchBtn');
const locationResultEl = document.getElementById('locationResult');
const placeNameCardEl = document.getElementById('placeNameCard');
const placeNameCardBodyEl = document.getElementById('placeNameCardBody');

// 直接呼叫 #addressSearchBtn 的 click handler（也就是 runImmediateSearch），
// 並 await 它回傳的 Promise：比照 place-name-card-ui.test.mjs 的
// typeAddress() 直接呼叫 `_listeners['input'][0]()` 的做法，差別是這裡
// 的 handler 是 async function，FakeNode.click() 本身不會等待非同步
// 完成，改成直接呼叫 listener 陣列裡的函式並 await 它。
async function searchByText(query){
  addressInput.value = query;
  await addressSearchBtn._listeners.click[0]();
}

function cardText(){
  const parts = [];
  (function walk(node){
    if(node.textContent) parts.push(node.textContent);
    (node.children || []).forEach(walk);
  })(placeNameCardBodyEl);
  return parts.join('\n');
}

test('一般地址搜尋命中（非地名精確比對）後，#locationResult 內會出現 .nearby-place-names 區塊，筆數正確', async () => {
  await searchByText('測試地址不是任何地名');

  const wrap = locationResultEl.querySelector('.nearby-place-names');
  assertTrue(!!wrap, '應該出現附近歷史地名區塊');
  const items = wrap.querySelectorAll('.nearby-place-name-item');
  assertEqual(items.length, 2, '預設半徑 800 公尺內應該剛好有 2 筆候選（遠方地名不應該被列入）');
});

test('.nearby-place-names 是 #locationResult 底下的直接子節點（插入呼叫用的是 locationResultEl.insertBefore）', async () => {
  // 注意：env-stub.mjs 用扁平的 id -> FakeNode 對照表模擬 DOM（見該檔頭
  // 註解），不是真的解析 index.html 的巢狀結構，所以這裡沒辦法像真的
  // 瀏覽器一樣驗證「插在 #layerAvailPanel 之前」這種依賴 index.html
  // 既有標記順序的視覺位置（layerAvailPanelEl 在假環境裡不是
  // locationResultEl 真正的子節點）；只驗證程式碼呼叫的
  // `locationResultEl.insertBefore(wrap, layerAvailPanelEl)` 確實讓
  // wrap 變成 locationResultEl 的子節點，位置關係交由實機／人工驗證。
  const wrap = locationResultEl.querySelector('.nearby-place-names');
  assertTrue(!!wrap, '前置條件：應該存在 .nearby-place-names');
  assertEqual(wrap.parentElement, locationResultEl, '.nearby-place-names 應該是 #locationResult 的子節點');
});

test('每筆項目內容包含地名與縣市鄉鎮，且依距離由近到遠排序（化番社舊址在前、德化社渡船頭在後）', async () => {
  const wrap = locationResultEl.querySelector('.nearby-place-names');
  const items = wrap.querySelectorAll('.nearby-place-name-item');
  assertEqual(items.length, 2, '前置條件：應該有 2 筆項目');

  const nameOf = (item) => item.querySelector('.nearby-place-name-name').textContent;
  const metaOf = (item) => item.querySelector('.nearby-place-name-meta').textContent;

  assertEqual(nameOf(items[0]), '化番社舊址', '第 1 筆應該是距離較近的「化番社舊址」');
  assertEqual(nameOf(items[1]), '德化社渡船頭', '第 2 筆應該是距離較遠的「德化社渡船頭」');

  assertTrue(metaOf(items[0]).includes('南投縣魚池鄉'), '每筆項目應該包含縣市鄉鎮資訊');
  assertTrue(/距離約\s*\d+\s*公尺/.test(metaOf(items[0])), '每筆項目應該包含「距離約 X 公尺」文字');
});

test('點擊 .nearby-place-name-item 會展開該筆完整的地名今昔對照卡（呼叫 renderPlaceNameCard＋focusPlaceNameCard）', async () => {
  const wrap = locationResultEl.querySelector('.nearby-place-names');
  const items = wrap.querySelectorAll('.nearby-place-name-item');
  const secondItem = items[1]; // 「德化社渡船頭」，跟目前作用中的搜尋結果不同筆，確保是點擊觸發、不是搜尋結果殘留

  assertTrue(placeNameCardEl.hidden, '前置條件：地名今昔對照卡目前應該是隱藏的（這次搜尋走的是一般地址路徑，不會自動顯示卡片）');

  secondItem.click();

  assertEqual(placeNameCardEl.hidden, false, '點擊後應該顯示地名今昔對照卡');
  assertTrue(!placeNameCardEl.classList.contains('collapsed'), 'focusPlaceNameCard() 應該讓卡片展開（移除 collapsed）');
  assertTrue(cardText().includes('德化社渡船頭'), '卡片內容應該是被點擊那一筆「德化社渡船頭」');
});

test('查無附近地名候選時（半徑內沒有任何候選），#locationResult 不會出現 .nearby-place-names 區塊', async () => {
  // 搜到一個座標附近完全沒有 fixture 候選的地點（跟所有 fixture 地名
  // 都相距很遠），驗證「空結果安靜跳過、不顯示任何東西」這條規則。
  const originalFetchForThisTest = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const urlStr = String(url);
    if(urlStr.includes('nominatim.openstreetmap.org/search')){
      return {
        ok: true,
        json: async () => ([{ display_name: '一個附近完全沒有地名候選的地方', lon: '121.7', lat: '25.2', address: {} }])
      };
    }
    return originalFetchForThisTest(url, options);
  };
  try {
    await searchByText('查無附近地名的地方');
    const wrap = locationResultEl.querySelector('.nearby-place-names');
    assertTrue(!wrap, '半徑內沒有任何候選時，不應該出現 .nearby-place-names 區塊');
  } finally {
    globalThis.fetch = originalFetchForThisTest;
  }
});

test('重新搜尋（再次呼叫一般地址搜尋流程）：上一輪的 .nearby-place-names 會被清掉，不會疊加兩份', async () => {
  await searchByText('第一次搜尋的測試地址');
  assertTrue(!!locationResultEl.querySelector('.nearby-place-names'), '前置條件：第一次搜尋後應該有附近地名清單');

  await searchByText('第二次搜尋的測試地址');

  const wraps = locationResultEl.querySelectorAll('.nearby-place-names');
  assertEqual(wraps.length, 1, '重新搜尋後應該只有 1 份 .nearby-place-names，不會疊加上一輪殘留的舊版本');
});

test('地名今昔對照精確比對命中（selectPlaceNameCandidate 路徑）：不會觸發附近地名清單，維持只有一張完整對照卡', async () => {
  // 先確保上一輪一般地址搜尋殘留的 .nearby-place-names 存在，驗證這條
  // 精確比對路徑會把它清掉（走 showLocationAndFindLayers() 開頭那段
  // 共用的清空邏輯）、但不會像 selectGeocodeResult() 一樣重新產生一份。
  assertTrue(!!locationResultEl.querySelector('.nearby-place-names'), '前置條件：應該還殘留著上一輪的附近地名清單');

  await searchByText('卜吉庄'); // 精確比對到 EXACT_MATCH_PLACE 的現名

  assertTrue(!locationResultEl.querySelector('.nearby-place-names'), '精確比對到古地名時，不應該出現（或殘留）附近地名清單');
  assertEqual(placeNameCardEl.hidden, false, '精確比對命中應該直接顯示完整的地名今昔對照卡');
  assertTrue(cardText().includes('卜吉庄'), '卡片內容應該是精確比對到的「卜吉庄」');
});

await run();
