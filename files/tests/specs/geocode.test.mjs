/* ---------------------------------------------------------
   tests/specs/geocode.test.mjs
   ---------------------------------------------------------
   src/geocode.js 是純粹的 fetch 呼叫，不碰 DOM／地圖，這裡直接用
   可控的假 fetch（每個測試各自覆寫 globalThis.fetch）驗證三種分支：
   成功回應、res.ok=false、網路錯誤，以及 fetchWithTimeout() 的
   AbortController 逾時保護會被轉換成中文提示訊息。
--------------------------------------------------------- */
import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import { geocodeAddress, reverseGeocode } from '../../src/geocode.js';

test('geocodeAddress 成功時回傳 fetch 的 json 內容，且網址帶正確編碼的查詢字串', async () => {
  let capturedUrl = null;
  let capturedHeaders = null;
  const fakeResults = [{ display_name: '台北車站' }];
  globalThis.fetch = async (url, options) => {
    capturedUrl = url;
    capturedHeaders = options && options.headers;
    return { ok: true, json: async () => fakeResults };
  };
  const result = await geocodeAddress('台北 車站');
  assertEqual(JSON.stringify(result), JSON.stringify(fakeResults), '應該回傳 fetch 回應的 json 內容');
  assertTrue(capturedUrl.includes('nominatim.openstreetmap.org/search'), 'URL 應該指向 search endpoint');
  assertTrue(capturedUrl.includes(encodeURIComponent('台北 車站')), 'URL 應該正確編碼查詢字串');
  assertEqual(capturedHeaders.Accept, 'application/json', '應該帶 Accept: application/json 標頭');
});

test('geocodeAddress：res.ok 為 false 時拋出錯誤', async () => {
  globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
  let caught = null;
  try { await geocodeAddress('不存在的地址'); } catch(err){ caught = err; }
  assertTrue(caught !== null, '應該要拋出錯誤');
  assertEqual(caught.message, 'geocode request failed', '錯誤訊息應符合實作');
});

test('geocodeAddress：fetch 拋出一般網路錯誤時原樣往外拋（非逾時訊息）', async () => {
  globalThis.fetch = async () => { throw new Error('network down'); };
  let caught = null;
  try { await geocodeAddress('台北'); } catch(err){ caught = err; }
  assertTrue(caught !== null, '應該要拋出錯誤');
  assertEqual(caught.message, 'network down', '一般網路錯誤不應被改寫成逾時訊息');
});

test('reverseGeocode 成功時回傳 fetch 的 json 內容，且網址帶正確的經緯度', async () => {
  let capturedUrl = null;
  const fakeResult = { display_name: '台北市中正區' };
  globalThis.fetch = async (url) => {
    capturedUrl = url;
    return { ok: true, json: async () => fakeResult };
  };
  const result = await reverseGeocode(121.51, 25.04);
  assertEqual(JSON.stringify(result), JSON.stringify(fakeResult), '應該回傳 fetch 回應的 json 內容');
  assertTrue(capturedUrl.includes('nominatim.openstreetmap.org/reverse'), 'URL 應該指向 reverse endpoint');
  assertTrue(capturedUrl.includes('lat=25.04'), 'URL 應該帶正確的緯度');
  assertTrue(capturedUrl.includes('lon=121.51'), 'URL 應該帶正確的經度');
});

test('reverseGeocode：res.ok 為 false 時拋出錯誤', async () => {
  globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
  let caught = null;
  try { await reverseGeocode(121, 25); } catch(err){ caught = err; }
  assertTrue(caught !== null, '應該要拋出錯誤');
  assertEqual(caught.message, 'reverse geocode request failed', '錯誤訊息應符合實作');
});

test('逾時保護：AbortController 觸發 abort 時，會被轉換成中文逾時提示（不洩漏原始 AbortError）', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  // geocode.js 的 GEOCODE_TIMEOUT_MS 固定 8000ms，測試不應該真的等 8 秒；
  // 這裡把 setTimeout 的延遲一律壓成 0，讓內部的 abort 計時器立刻觸發，
  // 驗證的是「abort 之後錯誤訊息有沒有被正確轉譯」這件事本身，不是
  // 計時器準不準。
  globalThis.setTimeout = (fn) => originalSetTimeout(fn, 0);
  globalThis.fetch = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
  try {
    let caught = null;
    try { await reverseGeocode(121.5, 25.05); } catch(err){ caught = err; }
    assertTrue(caught !== null, '逾時應該要拋出錯誤');
    assertEqual(caught.message, '地理編碼服務逾時，請稍後再試', '逾時錯誤訊息應為中文提示');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

await run();
