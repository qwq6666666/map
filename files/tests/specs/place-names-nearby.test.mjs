import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import { findNearbyPlaceNames } from '../../src/features/placeNames.js';

/* ---------------------------------------------------------
   tests/specs/place-names-nearby.test.mjs
   ---------------------------------------------------------
   針對 src/features/placeNames.js 新增的「附近歷史地名」空間鄰近搜尋
   （findNearbyPlaceNames／haversineDistanceMeters）寫測試，比照
   place-names-matching.test.mjs 的風格：直接餵寫死的小型 places 陣列，
   不需要真的 fetch data/place-names.json。

   haversineDistanceMeters() 本身沒有 export（見 CLAUDE.md 任務交接
   說明），這裡一律透過 findNearbyPlaceNames() 回傳的 distanceMeters
   間接驗證距離計算是否正確；findNearbyPlaceNamesAsync()（ensurePlaceNamesLoaded
   + findNearbyPlaceNames 的組合）本身不重覆測試，理由跟
   place-names-matching.test.mjs 略過 findPlaceNameCandidates() 整合
   測試一致（純粹是 fetch 快取包裝，邏輯已經被純函式版本完整涵蓋）。
--------------------------------------------------------- */

// 只用來「建構」測試用固定點座標（例如剛好卡在半徑邊界上的座標），
// 不用來斷言「計算是否正確」——正確性驗證改用「南北向位移距離必定等於
// 大圓弧長 R×Δlat（弧度）」這個跟 haversine 實作寫法無關的獨立數學事實
// （見下方「距離計算正確性」測試），避免測試程式碼重抄一份公式、變成
// 拿實作抄自己來驗證自己。
const EARTH_RADIUS_METERS_FOR_FIXTURE = 6371000;
function fixtureDistanceMeters(lon1, lat1, lon2, lat2){
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS_FOR_FIXTURE * c;
}

// 搜尋基準點：南投縣魚池鄉德化社（沿用 place-names-matching.test.mjs
// 既有測試資料同一個點，方便對照）。
const BASE_LON = 120.9123;
const BASE_LAT = 23.8567;

function makePlace(name, lon, lat, extra){
  return { name, aliases: [], county: '南投縣', town: '魚池鄉', description: '', sourceType: 'settlement', longitude: lon, latitude: lat, ...extra };
}

test('距離計算正確性：正南北向位移的距離應約等於 R×Δlat（弧度）這個跟 haversine 實作無關的獨立數學事實', () => {
  // 正南北向（經度相同）位移時，haversine 大圓弧長公式會精確退化成
  // 「地球半徑 × 緯度差（弧度）」，這是球面幾何的定義本身，不是在
  // 重複實作的公式，可以拿來獨立驗證實作有沒有算對。
  const dLatDeg = 0.01; // 約 1112 公尺
  const places = [ makePlace('正北方測試點', BASE_LON, BASE_LAT + dLatDeg) ];
  const results = findNearbyPlaceNames(places, BASE_LON, BASE_LAT, { radiusMeters: 2000 });
  assertEqual(results.length, 1, '前置條件：應該找到這筆測試點');

  const expected = EARTH_RADIUS_METERS_FOR_FIXTURE * (dLatDeg * Math.PI / 180);
  const diff = Math.abs(results[0].distanceMeters - expected);
  assertTrue(diff <= 5, `距離應該接近 ${expected.toFixed(1)} 公尺（誤差 <= 5 公尺），實際 ${results[0].distanceMeters}`);
});

test('半徑篩選：超出 radiusMeters 的候選不會出現在結果裡', () => {
  const places = [
    makePlace('近處', BASE_LON + 0.001, BASE_LAT), // 約 100 公尺內
    makePlace('遠處', BASE_LON + 0.5, BASE_LAT + 0.5), // 遠遠超過任何合理半徑
  ];
  const results = findNearbyPlaceNames(places, BASE_LON, BASE_LAT, { radiusMeters: 800 });
  assertEqual(results.length, 1, '應該只有「近處」在半徑範圍內');
  assertEqual(results[0].place.name, '近處');
});

test('半徑篩選：邊界情況（距離剛好等於 radiusMeters）目前的實際行為是「包含」（<=）', () => {
  // 用跟實作同一份公式算出「剛好」落在邊界上的座標（見檔頭說明：只用來
  // 建構固定點，不用來斷言正確性），鎖住目前 <= 比較運算子的實際行為，
  // 避免之後不小心改成 < 卻沒有任何測試發現。
  const boundaryLat = BASE_LAT + 0.005;
  const exactDistance = fixtureDistanceMeters(BASE_LON, BASE_LAT, BASE_LON, boundaryLat);
  const places = [ makePlace('邊界點', BASE_LON, boundaryLat) ];

  const results = findNearbyPlaceNames(places, BASE_LON, BASE_LAT, { radiusMeters: exactDistance });
  assertEqual(results.length, 1, '距離剛好等於 radiusMeters 時，目前的實作行為應該是「包含」在結果裡');
});

test('limit 截斷：候選數量超過 limit 時，只回傳最近的前 limit 筆', () => {
  const places = [
    makePlace('第1近', BASE_LON + 0.0005, BASE_LAT),
    makePlace('第2近', BASE_LON + 0.001, BASE_LAT),
    makePlace('第3近', BASE_LON + 0.0015, BASE_LAT),
    makePlace('第4近', BASE_LON + 0.002, BASE_LAT),
    makePlace('第5近', BASE_LON + 0.0025, BASE_LAT),
    makePlace('第6近', BASE_LON + 0.003, BASE_LAT),
  ];
  const results = findNearbyPlaceNames(places, BASE_LON, BASE_LAT, { radiusMeters: 2000, limit: 3 });
  assertEqual(results.length, 3, '應該只回傳 3 筆（limit=3）');
  const names = results.map(r => r.place.name);
  assertEqual(names.join(','), '第1近,第2近,第3近', '應該是距離最近的前 3 筆，依序排列');
});

test('排序：結果應該依 distanceMeters 由近到遠排序', () => {
  const places = [
    makePlace('中', BASE_LON + 0.002, BASE_LAT),
    makePlace('近', BASE_LON + 0.0005, BASE_LAT),
    makePlace('遠', BASE_LON + 0.003, BASE_LAT),
  ];
  const results = findNearbyPlaceNames(places, BASE_LON, BASE_LAT, { radiusMeters: 2000 });
  assertEqual(results.length, 3, '前置條件：3 筆都應該在半徑內');
  assertEqual(results.map(r => r.place.name).join(','), '近,中,遠', '應該依距離由近到遠排序');
  assertTrue(results[0].distanceMeters <= results[1].distanceMeters, '第 1 筆距離應該 <= 第 2 筆');
  assertTrue(results[1].distanceMeters <= results[2].distanceMeters, '第 2 筆距離應該 <= 第 3 筆');
});

test('沒有座標（longitude/latitude 不是 number）的候選會被跳過，不計入候選', () => {
  const places = [
    makePlace('有座標', BASE_LON + 0.0005, BASE_LAT),
    { name: '無座標地', aliases: [], county: '南投縣', town: '魚池鄉', description: '', sourceType: 'settlement' },
    { name: '座標是字串', aliases: [], county: '南投縣', town: '魚池鄉', description: '', sourceType: 'settlement', longitude: '120.9', latitude: '23.86' },
  ];
  const results = findNearbyPlaceNames(places, BASE_LON, BASE_LAT, { radiusMeters: 2000 });
  assertEqual(results.length, 1, '只有「有座標」那一筆應該被計入');
  assertEqual(results[0].place.name, '有座標');
});

test('邊界情況：places 為空陣列時回傳空陣列', () => {
  assertEqual(findNearbyPlaceNames([], BASE_LON, BASE_LAT).length, 0);
});

test('邊界情況：lon/lat 不合法（非數字）不拋例外，回傳空陣列', () => {
  const places = [ makePlace('測試點', BASE_LON, BASE_LAT) ];
  let results;
  let threw = false;
  try {
    results = findNearbyPlaceNames(places, 'not-a-number', BASE_LAT);
  } catch(e) {
    threw = true;
  }
  assertTrue(!threw, '不應該拋出例外');
  assertEqual(results.length, 0, 'lon 不合法時應該回傳空陣列');

  threw = false;
  try {
    results = findNearbyPlaceNames(places, BASE_LON, undefined);
  } catch(e) {
    threw = true;
  }
  assertTrue(!threw, '不應該拋出例外');
  assertEqual(results.length, 0, 'lat 不合法時應該回傳空陣列');
});

test('查無範圍內候選時回傳空陣列（有候選但全部超出半徑）', () => {
  const places = [ makePlace('遠方', BASE_LON + 1, BASE_LAT + 1) ];
  const results = findNearbyPlaceNames(places, BASE_LON, BASE_LAT, { radiusMeters: 800 });
  assertEqual(results.length, 0);
});

test('distanceMeters 是整數（Math.round 過，不是浮點數）', () => {
  const places = [ makePlace('測試點', BASE_LON + 0.0013, BASE_LAT + 0.0007) ];
  const results = findNearbyPlaceNames(places, BASE_LON, BASE_LAT, { radiusMeters: 2000 });
  assertEqual(results.length, 1, '前置條件：應該有 1 筆結果');
  assertTrue(Number.isInteger(results[0].distanceMeters), 'distanceMeters 應該是整數');
});

test('不會 mutate 原始 place 物件（distanceMeters 只存在回傳的 wrapper 上）', () => {
  const place = makePlace('測試點', BASE_LON + 0.0005, BASE_LAT);
  const results = findNearbyPlaceNames([place], BASE_LON, BASE_LAT, { radiusMeters: 2000 });
  assertEqual(results.length, 1);
  assertEqual(results[0].place, place, '結果裡的 place 應該是同一個物件參照');
  assertTrue(!Object.hasOwn(place, 'distanceMeters'), '不應該在原始 place 物件上新增 distanceMeters 欄位');
});

test('預設 radiusMeters=800、limit=5（不傳 opts 時使用預設值）', () => {
  const places = [
    makePlace('近-1', BASE_LON + 0.0002, BASE_LAT),
    makePlace('近-2', BASE_LON + 0.0004, BASE_LAT),
    makePlace('遠-超過800m', BASE_LON + 0.01, BASE_LAT), // 約 1112 公尺，超過預設 800
  ];
  const results = findNearbyPlaceNames(places, BASE_LON, BASE_LAT);
  assertEqual(results.length, 2, '預設半徑 800 公尺應該只找到 2 筆近處候選');
  const names = results.map(r => r.place.name).sort();
  assertEqual(names.join(','), '近-1,近-2', '應該剛好是兩筆近處候選');
});

await run();
