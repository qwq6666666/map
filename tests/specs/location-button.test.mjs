import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import { initLocateButton } from '../../src/features/location.js';
import { runtime } from '../../src/runtime.js';

// 假 geolocation：不立即回呼，讓測試可以自己決定「第一次定位」什麼時候
// 完成，藉此模擬「使用者在上一次定位還沒回應前又連續點擊」的競態情境。
let getCurrentPositionCalls = 0;
let pendingSuccessCallbacks = [];
globalThis.navigator.geolocation = {
  getCurrentPosition(success, error){
    getCurrentPositionCalls++;
    pendingSuccessCallbacks.push(success);
  }
};

initLocateButton();
const locateBtn = document.getElementById('locateBtn');

test('連續快速點擊定位按鈕：上一次定位還在等待回應時，不應該重複發出新的 getCurrentPosition 請求', () => {
  getCurrentPositionCalls = 0;
  pendingSuccessCallbacks = [];

  locateBtn.click();
  locateBtn.click();
  locateBtn.click();

  assertEqual(getCurrentPositionCalls, 1, '連續點擊三次，實際只應該呼叫一次 getCurrentPosition');
  assertTrue(locateBtn.classList.contains('loading'), '等待回應期間應該維持 loading 狀態');
});

test('上一次定位成功完成、loading 解除後，再次點擊可以正常發出新的定位請求', () => {
  getCurrentPositionCalls = 0;
  pendingSuccessCallbacks = [];
  locateBtn.classList.remove('loading'); // 重設上一個測試案例殘留的 loading 狀態（上一案例的請求刻意沒有被 resolve）

  locateBtn.click();
  assertEqual(getCurrentPositionCalls, 1, '第一次點擊應該發出請求');

  pendingSuccessCallbacks[0]({ coords: { latitude: 25.03, longitude: 121.56 } });
  assertTrue(!locateBtn.classList.contains('loading'), '定位成功回呼後應該移除 loading 狀態');

  locateBtn.click();
  assertEqual(getCurrentPositionCalls, 2, 'loading 解除後再次點擊應該可以發出新的請求');
});

test('上一次定位失敗、loading 解除後，再次點擊可以正常發出新的定位請求', () => {
  getCurrentPositionCalls = 0;
  pendingSuccessCallbacks = [];
  locateBtn.classList.remove('loading'); // 重設狀態，確保這個案例不受前一案例殘留影響
  let pendingErrorCallback = null;
  globalThis.navigator.geolocation.getCurrentPosition = (success, error) => {
    getCurrentPositionCalls++;
    pendingErrorCallback = error;
  };

  locateBtn.click();
  assertEqual(getCurrentPositionCalls, 1, '第一次點擊應該發出請求');
  pendingErrorCallback({ code: 1, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
  assertTrue(!locateBtn.classList.contains('loading'), '定位失敗回呼後應該移除 loading 狀態');

  locateBtn.click();
  assertEqual(getCurrentPositionCalls, 2, 'loading 解除後再次點擊應該可以發出新的請求');
});

await run();

// 定位失敗的測試案例會觸發 showLocateToast()，留下一顆真實的
// setTimeout(4500ms)（見 features/location.js）。不清掉的話 Node
// process 要等它自然到期才會結束，讓這支測試檔平白多花 4.5 秒
// wall time 卻沒有驗證任何額外邏輯。
if(runtime.locateToastTimer) clearTimeout(runtime.locateToastTimer);
