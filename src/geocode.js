/* ---------------------------------------------------------
   geocode.js — 與 OpenStreetMap Nominatim 溝通的地理編碼功能
   ---------------------------------------------------------
   純粹的 API 呼叫，不碰 DOM、不碰地圖，方便獨立測試／未來替換
   成其他地理編碼服務。
--------------------------------------------------------- */

const GEOCODE_TIMEOUT_MS = 8000;

// 幫 fetch 加上逾時保護：Nominatim 若無回應，避免呼叫端永遠掛著，
// 逾時後主動 abort 並拋出清楚的中文錯誤訊息。
async function fetchWithTimeout(url, options){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('地理編碼服務逾時，請稍後再試');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// 刻意不帶 countrycodes 限制：站內除了台灣歷史圖層，還有日本／韓國／
// 中國／東南亞等海外來源（見 data/source-map.json），寫死 `tw` 會讓
// 使用者瀏覽這些海外圖層時，透過地址搜尋定位當地地名直接被 Nominatim
// 過濾掉、查不到任何結果。呼叫端（src/ui/search.js）目前沒有「使用者
// 正在瀏覽哪個國家的圖層」這個上下文可以傳進來判斷該用哪個國別限制，
// 與其猜測，不如讓搜尋涵蓋全球——Nominatim 本身的比對已經有相關性
// 排序（地名/地址字串比對＋權重），拿掉國別限制不會因此搜出大量
// 不相關的結果，只是不再排除海外地名而已。
export async function geocodeAddress(query){
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&accept-language=zh-TW&q=' + encodeURIComponent(query);
  const res = await fetchWithTimeout(url, { headers: { 'Accept': 'application/json' } });
  if(!res.ok) throw new Error('geocode request failed');
  return res.json();
}

export async function reverseGeocode(lon, lat){
  const url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&accept-language=zh-TW&lat=' + lat + '&lon=' + lon;
  const res = await fetchWithTimeout(url, { headers: { 'Accept': 'application/json' } });
  if(!res.ok) throw new Error('reverse geocode request failed');
  return res.json();
}
