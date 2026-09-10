import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import { matchPlaceNames, getActivePlaceNameMatchAt, setActivePlaceNameMatch, clearActivePlaceNameMatch, sourceTypeLabel } from '../../src/features/placeNames.js';

/* ---------------------------------------------------------
   tests/specs/place-names-matching.test.mjs
   ---------------------------------------------------------
   針對 src/features/placeNames.js 寫測試。matchPlaceNames／
   getActivePlaceNameMatchAt／setActivePlaceNameMatch／
   clearActivePlaceNameMatch／sourceTypeLabel 這幾個都不需要真的
   fetch()，直接用寫死的小型 places 陣列測試。

   findPlaceNameCandidates() 本身只是「ensurePlaceNamesLoaded()
   （fetch 並快取）+ matchPlaceNames 同款的比對邏輯」的組合，實際比對
   規則已經由 matchPlaceNames 這個純函式路徑完整涵蓋；env-stub.mjs 的
   假 fetch 只支援讀本機檔案系統的相對路徑（見 fetch 實作），這裡不用
   真的打一次 10MB 的 data/place-names.json 走一輪 fetch 流程，避免
   測試變慢又測不出比 matchPlaceNames 更多的邏輯，故意跳過
   findPlaceNameCandidates 本身的整合測試。
--------------------------------------------------------- */

// 模擬「德化社」有兩個別名（卜吉、化番社），「社寮」沒有別名，
// 「竹腳寮」是完全獨立、跟前兩者無關的地名，另外準備一筆同名
// 「德化社」（不同地點，用來驗證多筆候選都會被回傳）與一筆缺座標
// 的「無座標地」。
function makePlaces(){
  return [
    { name: '德化社', aliases: ['卜吉', '化番社'], county: '南投縣', town: '魚池鄉', description: '日月潭邊聚落', sourceType: 'settlement', longitude: 120.9123, latitude: 23.8567 },
    { name: '社寮', aliases: [], county: '南投縣', town: '竹山鎮', description: '', sourceType: 'settlement', longitude: 120.6789, latitude: 23.7654 },
    { name: '竹腳寮', aliases: ['腳寮'], county: '苗栗縣', town: '公館鄉', description: '', sourceType: 'settlement', longitude: 120.8, latitude: 24.5 },
    { name: '德化社', aliases: [], county: '南投縣', town: '魚池鄉', description: '行政區域類的德化社', sourceType: 'admin', longitude: 120.9200, latitude: 23.8600 },
    { name: '無座標地', aliases: ['無座標別名'], county: '南投縣', town: '魚池鄉', description: '', sourceType: 'settlement' },
  ];
}

test('matchPlaceNames：現名精確相符能找到', () => {
  const results = matchPlaceNames(makePlaces(), '社寮');
  assertEqual(results.length, 1, '應該找到 1 筆');
  assertEqual(results[0].name, '社寮');
});

test('matchPlaceNames：別名精確相符能找到，且回傳現名那筆完整物件', () => {
  const results = matchPlaceNames(makePlaces(), '卜吉');
  assertEqual(results.length, 1, '應該找到 1 筆');
  assertEqual(results[0].name, '德化社', '應該回傳現名為「德化社」的完整物件');
  assertEqual(results[0].description, '日月潭邊聚落', '應該是完整的 place 物件，不是憑空生出的別名物件');
});

test('matchPlaceNames：同名有多筆資料時，回傳全部候選（不是只回傳第一筆）', () => {
  const results = matchPlaceNames(makePlaces(), '德化社');
  assertEqual(results.length, 2, '應該回傳 2 筆同名的「德化社」候選');
  const sourceTypes = results.map(r => r.sourceType).sort().join(',');
  assertEqual(sourceTypes, 'admin,settlement', '應該分別是聚落類跟行政區域類各一筆');
});

test('matchPlaceNames：沒有座標的候選會被過濾掉', () => {
  const results = matchPlaceNames(makePlaces(), '無座標地');
  assertEqual(results.length, 0, '沒有座標的候選不應該出現在結果裡');
});

test('matchPlaceNames：別名比對也會過濾沒有座標的候選', () => {
  const results = matchPlaceNames(makePlaces(), '無座標別名');
  assertEqual(results.length, 0, '沒有座標的候選（透過別名比對到）也不應該出現在結果裡');
});

test('matchPlaceNames：完全比對不到時回傳空陣列', () => {
  const results = matchPlaceNames(makePlaces(), '完全不存在的地名');
  assertEqual(results.length, 0, '應該回傳空陣列');
});

test('matchPlaceNames：query 為空字串時回傳空陣列', () => {
  assertEqual(matchPlaceNames(makePlaces(), '').length, 0);
  assertEqual(matchPlaceNames(makePlaces(), '   ').length, 0, '純空白也應該視為空');
});

test('matchPlaceNames：places 為空陣列時回傳空陣列', () => {
  assertEqual(matchPlaceNames([], '德化社').length, 0);
});

test('matchPlaceNames：同一筆資料同時符合現名與別名也只回傳一次（物件參照去重複）', () => {
  // 竹腳寮本身有別名「腳寮」，用現名查詢應只回傳一次，不會因為
  // matchPlaceNames 內部先查 byName 再查 byAlias 就重複兩次。
  const results = matchPlaceNames(makePlaces(), '竹腳寮');
  assertEqual(results.length, 1, '同一筆資料不應該因為現名/別名各命中一次就被算兩筆');
});

/* ---------------- getActivePlaceNameMatchAt / setActivePlaceNameMatch ---------------- */

test('setActivePlaceNameMatch 之後，用完全相同座標查詢會拿到該 place', () => {
  const place = makePlaces()[0]; // 德化社 (120.9123, 23.8567)
  setActivePlaceNameMatch(place);
  const found = getActivePlaceNameMatchAt(120.9123, 23.8567);
  assertTrue(!!found, '應該找到目前作用中的比對結果');
  assertEqual(found.name, '德化社');
});

test('用差距超過 1e-4 度的座標查詢應該回傳 null', () => {
  const place = makePlaces()[0];
  setActivePlaceNameMatch(place);
  const found = getActivePlaceNameMatchAt(120.9123 + 0.001, 23.8567);
  assertEqual(found, null, '超過誤差容許值應該回傳 null');
});

test('用差距在 1e-4 度以內的座標查詢仍然能命中', () => {
  const place = makePlaces()[0];
  setActivePlaceNameMatch(place);
  const found = getActivePlaceNameMatchAt(120.9123 + 0.00005, 23.8567 - 0.00005);
  assertTrue(!!found, '誤差容許值以內應該仍然命中');
});

test('clearActivePlaceNameMatch 之後查詢任何座標都回傳 null', () => {
  const place = makePlaces()[0];
  setActivePlaceNameMatch(place);
  clearActivePlaceNameMatch();
  const found = getActivePlaceNameMatchAt(120.9123, 23.8567);
  assertEqual(found, null, '清除後應該一律回傳 null');
});

test('setActivePlaceNameMatch(null) 等同清除', () => {
  const place = makePlaces()[0];
  setActivePlaceNameMatch(place);
  setActivePlaceNameMatch(null);
  assertEqual(getActivePlaceNameMatchAt(120.9123, 23.8567), null);
});

/* ---------------- sourceTypeLabel ---------------- */

test('sourceTypeLabel：settlement 對應「聚落」', () => {
  assertEqual(sourceTypeLabel('settlement'), '聚落');
});

test('sourceTypeLabel：admin 對應「行政區域」', () => {
  assertEqual(sourceTypeLabel('admin'), '行政區域');
});

test('sourceTypeLabel：未知值回傳空字串', () => {
  assertEqual(sourceTypeLabel('unknown-type'), '');
  assertEqual(sourceTypeLabel(undefined), '');
});

await run();
