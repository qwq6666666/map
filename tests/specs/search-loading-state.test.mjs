import '../env-stub.mjs';
import { test, expect } from 'vitest';
import { loadAppData } from '../../src/data.js';
import { initMapCore } from '../../src/mapCore.js';
import { initSidebar } from '../../src/sidebarUI.js';
import { initSearchUI } from '../../src/ui/search.js';

/* ---------------------------------------------------------
   tests/specs/search-loading-state.test.mjs
   ---------------------------------------------------------
   回歸測試：commit 98eb00d 修正過的「地址搜尋放大鏡卡死轉圈」bug。

   runImmediateSearch()（src/ui/search.js）命中「單筆」候選時會巢狀
   呼叫 showLocationAndFindLayers() -> findAndRenderAvailableLayers()，
   後者自己又 bumpSearchToken()。修復前的寫法在 finally 區塊用
   isSearchStale(myToken) 判斷要不要移除 .loading class，會被這次巢狀
   呼叫誤判成「已過期」而卡住轉圈；修復後的寫法是 finally 無條件移除
   .loading（不看 token 過不過期）。這裡直接走真實的
   #addressSearchBtn click handler 完整路徑（含它會觸發的巢狀
   bumpSearchToken() 呼叫），鎖住這個行為，避免之後重構時重新踩雷。

   fetch mock 比照 nearby-place-names-ui.test.mjs 的做法：地名今昔對照
   資料回傳空陣列（避免走到地名精確比對那條分支，單純測一般地址單筆
   命中的路徑），一般地理編碼（Nominatim search endpoint）回傳「剛好
   1 筆」結果，觸發 selectGeocodeResult() 這條會巢狀 bump token 的路徑。
--------------------------------------------------------- */

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const urlStr = String(url);
  if(urlStr.includes('data/place-names.json')){
    return { ok: true, json: async () => ({ places: [] }) };
  }
  if(urlStr.includes('nominatim.openstreetmap.org/search')){
    return {
      ok: true,
      json: async () => ([{ display_name: '測試縣測試鄉單筆命中地址100號', lon: '121.5', lat: '25.0', address: {} }])
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

test('地址搜尋命中單筆結果後，放大鏡按鈕的 loading 狀態應該被正確移除（不會卡死轉圈）', async () => {
  addressInput.value = '某個會命中單筆結果的測試地址';
  await addressSearchBtn._listeners.click[0]();
  expect(!addressSearchBtn.classList.contains('loading'), 'loading class 應該被移除，不應該卡住轉圈').toBeTruthy();
});

test('連續觸發兩次搜尋（模擬快速按兩次），結束後 loading 狀態一樣要被正確移除', async () => {
  addressInput.value = '另一個會命中單筆結果的測試地址';
  await Promise.all([
    addressSearchBtn._listeners.click[0](),
    addressSearchBtn._listeners.click[0]() // 函式開頭的 loading class 重入防護會擋掉第二次真正執行
  ]);
  expect(!addressSearchBtn.classList.contains('loading'), '兩次呼叫結束後 loading class 都應該被移除').toBeTruthy();
});

/* ---------------------------------------------------------
   回歸測試：手機版「按 Enter／前往就好像卡住」的使用者回報。
   ---------------------------------------------------------
   逐筆確認附近歷史圖層是否有資料通常要花上數秒（見 findAndRenderAvailableLayers()
   的 onProgress 進度文字），這段等待期間唯一的畫面回饋（座標資訊、
   「正在確認…」進度文字）都畫在輸入框下方。手機版點建議清單項目時，
   焦點轉移到清單節點，瀏覽器通常會順帶收起虛擬鍵盤；但單純按 Enter
   提交，輸入框本身沒有失焦，鍵盤常常不會自動收起，這段回饋畫面會被
   鍵盤蓋住，使用者只看得到放大鏡圖示一直轉，以為卡住了（實際上背景
   還在正常跑，只是看不到）。runImmediateSearch() 現在一開始就主動
   blur() 輸入框，讓鍵盤立刻收起。
--------------------------------------------------------- */
test('runImmediateSearch()：一開始就主動 blur() 輸入框（讓手機版虛擬鍵盤立刻收起，不會擋住下方的進度回饋）', async () => {
  addressInput.value = '會觸發 blur 檢查的測試地址';
  let blurCalled = false;
  const originalBlur = addressInput.blur;
  addressInput.blur = () => { blurCalled = true; };
  try{
    await addressSearchBtn._listeners.click[0]();
    expect(blurCalled, '搜尋開始時應該呼叫 blur() 讓虛擬鍵盤收起').toBe(true);
  } finally {
    addressInput.blur = originalBlur;
  }
});
