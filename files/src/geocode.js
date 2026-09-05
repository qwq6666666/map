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

export async function geocodeAddress(query){
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&countrycodes=tw&accept-language=zh-TW&q=' + encodeURIComponent(query);
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
