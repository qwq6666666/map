/* ---------------------------------------------------------
   geocode.js — 與 OpenStreetMap Nominatim 溝通的地理編碼功能
   ---------------------------------------------------------
   純粹的 API 呼叫，不碰 DOM、不碰地圖，方便獨立測試／未來替換
   成其他地理編碼服務。
--------------------------------------------------------- */

export async function geocodeAddress(query){
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&countrycodes=tw&accept-language=zh-TW&q=' + encodeURIComponent(query);
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if(!res.ok) throw new Error('geocode request failed');
  return res.json();
}

export async function reverseGeocode(lon, lat){
  const url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&accept-language=zh-TW&lat=' + lat + '&lon=' + lon;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if(!res.ok) throw new Error('reverse geocode request failed');
  return res.json();
}
