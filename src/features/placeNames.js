/* ---------------------------------------------------------
   features/placeNames.js — 地名今昔對照比對邏輯（不碰 DOM）
   ---------------------------------------------------------
   給一個查詢字串（使用者輸入的地名），比對 data/place-names.json
   （臺灣地區地名資料，約 3-4 萬筆聚落／行政區域紀錄，含日治時期
   舊名／別名），找出「現名或別名精確相符」的候選地點，供 UI 層
   （src/ui/search.js）畫出候選清單，並可把使用者選定的候選點跳轉
   到地圖上、餵給 identifyPin.js 顯示「歷史地名」小卡。

   延遲載入：這份 JSON 檔案筆數多、體積可能達數 MB，仿照 data/presets/
   的既有慣例（見 DEVELOPMENT.md），不在 app 啟動流程載入，只在真的
   呼叫 findPlaceNameCandidates() 時才 fetch，且只 fetch 一次，之後
   全部吃記憶體快取（見下方 loadedPlacesPromise／loadedPlaces）。
   離線或檔案不存在時 fetch 失敗要吞掉例外、console.warn 記錄，讓
   這個功能優雅降級成「找不到地名資料」，不能讓整個網站掛掉。

   這支模組不知道 sidebar、地圖 Overlay 長什麼樣子，也不直接操作
   任何 DOM——純資料比對與一個給 identifyPin.js 用的極小「目前作用
   中比對結果」狀態（setActivePlaceNameMatch／getActivePlaceNameMatchAt），
   跟 identifyPin.js 之間一律靠 main.js 組裝時的參數注入串接，兩邊
   互不 import。
--------------------------------------------------------- */

const PLACE_NAMES_URL = './data/place-names.json';

// 模組層級快取：loadedPlaces 是已經 resolve 完成的 place 陣列（fetch
// 失敗時是空陣列），loadingPromise 是進行中的 fetch Promise，避免短時間
// 內重複觸發多次請求（例如使用者連續輸入時每個字都觸發一次查詢）。
let loadedPlaces = null;
let loadingPromise = null;

// 現名／別名 -> place[] 索引，跟 loadedPlaces 同步建立、同步快取。
let nameIndex = null;
let aliasIndex = null;

function buildIndexes(places){
  const byName = new Map();
  const byAlias = new Map();
  for(const place of places){
    if(place.name){
      const list = byName.get(place.name) || [];
      list.push(place);
      byName.set(place.name, list);
    }
    for(const alias of place.aliases || []){
      if(!alias) continue;
      const list = byAlias.get(alias) || [];
      list.push(place);
      byAlias.set(alias, list);
    }
  }
  return { byName, byAlias };
}

async function fetchPlaceNamesData(){
  const res = await fetch(PLACE_NAMES_URL);
  if(!res.ok) throw new Error(`place-names.json fetch failed: ${res.status}`);
  const data = await res.json();
  if(!data || !Array.isArray(data.places)) throw new Error('place-names.json 格式不正確：缺少 places 陣列');
  return data.places;
}

// 確保地名資料已載入完成，回傳 place 陣列（Promise）。只在第一次呼叫時
// 真的送出 fetch，之後的呼叫都吃 loadedPlaces／loadingPromise 快取。
function ensurePlaceNamesLoaded(){
  if(loadedPlaces) return Promise.resolve(loadedPlaces);
  if(loadingPromise) return loadingPromise;

  loadingPromise = fetchPlaceNamesData()
    .then(places => {
      loadedPlaces = places;
      const indexes = buildIndexes(places);
      nameIndex = indexes.byName;
      aliasIndex = indexes.byAlias;
      return loadedPlaces;
    })
    .catch(err => {
      console.warn('[placeNames] 地名今昔對照資料載入失敗，功能將優雅降級為查無結果', err);
      loadedPlaces = [];
      nameIndex = new Map();
      aliasIndex = new Map();
      return loadedPlaces;
    })
    .finally(() => {
      loadingPromise = null;
    });

  return loadingPromise;
}

// 純函式版本：給定已經備好的 place 陣列與查詢字串，回傳比對結果，
// 不依賴模組內部的載入快取，方便單元測試直接餵資料、不用真的 fetch()。
// 比對規則：現名精確相符 OR 別名精確相符，用物件參照去重複，只保留
// 有 longitude／latitude（可定位到地圖上）的候選。
export function matchPlaceNames(places, query){
  const q = typeof query === 'string' ? query.trim() : '';
  if(!q || !Array.isArray(places) || places.length === 0) return [];

  const { byName, byAlias } = buildIndexes(places);
  const matched = new Set();
  const results = [];

  const collect = (list) => {
    if(!list) return;
    for(const place of list){
      if(matched.has(place)) continue;
      matched.add(place);
      if(typeof place.longitude === 'number' && typeof place.latitude === 'number'){
        results.push(place);
      }
    }
  };

  collect(byName.get(q));
  collect(byAlias.get(q));

  return results;
}

/**
 * 查詢字串比對地名今昔對照候選地點（確保資料已載入、走模組內部快取索引）。
 * @param {string} query 使用者輸入的地名查詢字串
 * @returns {Promise<Array>} 候選 place 物件陣列（可能為空陣列）
 */
export async function findPlaceNameCandidates(query){
  const q = typeof query === 'string' ? query.trim() : '';
  if(!q) return [];

  await ensurePlaceNamesLoaded();
  if(!nameIndex || !aliasIndex) return [];

  const matched = new Set();
  const results = [];
  const collect = (list) => {
    if(!list) return;
    for(const place of list){
      if(matched.has(place)) continue;
      matched.add(place);
      if(typeof place.longitude === 'number' && typeof place.latitude === 'number'){
        results.push(place);
      }
    }
  };

  collect(nameIndex.get(q));
  collect(aliasIndex.get(q));

  return results;
}

// 地球半徑（公尺），僅用於「附近提示」等級的距離估算，不追求橢球體精度。
const EARTH_RADIUS_METERS = 6371000;

// haversine 公式：兩組經緯度（十進位度）之間的球面距離（公尺）。
function haversineDistanceMeters(lon1, lat1, lon2, lat2){
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

// 純函式版本：給定已經備好的 place 陣列與查詢座標，回傳半徑範圍內、依距離
// 由近到遠排序的地名候選，不依賴模組內部的載入快取，方便單元測試直接餵
// 資料、不用真的 fetch()。比照 matchPlaceNames() 只保留有 longitude／
// latitude（可定位到地圖上）的候選；結果不 mutate 原本的 place 物件，
// 用 { place, distanceMeters } wrapper 包起來。
export function findNearbyPlaceNames(places, lon, lat, { radiusMeters = 800, limit = 5 } = {}){
  if(!Array.isArray(places) || places.length === 0) return [];
  if(typeof lon !== 'number' || typeof lat !== 'number') return [];

  const results = [];
  for(const place of places){
    if(typeof place.longitude !== 'number' || typeof place.latitude !== 'number') continue;
    const distanceMeters = haversineDistanceMeters(lon, lat, place.longitude, place.latitude);
    if(distanceMeters <= radiusMeters){
      results.push({ place, distanceMeters: Math.round(distanceMeters) });
    }
  }

  results.sort((a, b) => a.distanceMeters - b.distanceMeters);
  return results.slice(0, limit);
}

/**
 * 空間鄰近搜尋：給定經緯度座標，找出附近的歷史地名點位（確保資料已載入、
 * 走模組內部快取），供使用者搜尋一般現代地址後順便提示附近的歷史地名，
 * 不需要使用者剛好打對舊地名字串。
 * @param {number} lon 經度
 * @param {number} lat 緯度
 * @param {{radiusMeters?: number, limit?: number}} [opts]
 * @returns {Promise<Array<{place: object, distanceMeters: number}>>} 依距離由近到遠排序的候選（可能為空陣列）
 */
export async function findNearbyPlaceNamesAsync(lon, lat, opts){
  await ensurePlaceNamesLoaded();
  if(!loadedPlaces) return [];
  return findNearbyPlaceNames(loadedPlaces, lon, lat, opts);
}

// 「目前作用中的比對結果」：記錄使用者剛剛從候選清單選定、顯示在地圖上
// 的 place，供 identifyPin.js 在同一個點落點時顯示「歷史地名」小卡，
// 不需要 identifyPin.js 自己重新做一次地名比對。
let activeMatch = null;

export function setActivePlaceNameMatch(place){
  activeMatch = place || null;
}

export function clearActivePlaceNameMatch(){
  setActivePlaceNameMatch(null);
}

// 誤差容許值：約 1e-4 度（約 11 公尺），刻意保守，寧可少觸發也不要把
// 同鄉鎮內不相干的聚落誤判成同一個地點。
const MATCH_TOLERANCE_DEG = 1e-4;

export function getActivePlaceNameMatchAt(lon, lat){
  if(!activeMatch) return null;
  if(typeof activeMatch.longitude !== 'number' || typeof activeMatch.latitude !== 'number') return null;
  if(typeof lon !== 'number' || typeof lat !== 'number') return null;
  const dLon = Math.abs(activeMatch.longitude - lon);
  const dLat = Math.abs(activeMatch.latitude - lat);
  return (dLon <= MATCH_TOLERANCE_DEG && dLat <= MATCH_TOLERANCE_DEG) ? activeMatch : null;
}

// sourceType -> 顯示用分類名稱。未知/缺值給空字串 fallback，UI 端自行
// 決定要不要顯示這個分類（例如組「資料來源：臺灣地區地名資料（○○類）」）。
const SOURCE_TYPE_LABELS = {
  settlement: '聚落',
  admin: '行政區域'
};

export function sourceTypeLabel(sourceType){
  return SOURCE_TYPE_LABELS[sourceType] || '';
}
