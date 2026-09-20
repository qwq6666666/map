import '../env-stub.mjs';
import { test, expect } from 'vitest';
import { matchPlaceNames, getActivePlaceNameMatchAt, setActivePlaceNameMatch, clearActivePlaceNameMatch, sourceTypeLabel, summarizeDescription, SUMMARY_MAX_CHARS } from '../../src/features/placeNames.js';

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
  expect(results.length, '應該找到 1 筆').toBe(1);
  expect(results[0].name).toBe('社寮');
});

test('matchPlaceNames：別名精確相符能找到，且回傳現名那筆完整物件', () => {
  const results = matchPlaceNames(makePlaces(), '卜吉');
  expect(results.length, '應該找到 1 筆').toBe(1);
  expect(results[0].name, '應該回傳現名為「德化社」的完整物件').toBe('德化社');
  expect(results[0].description, '應該是完整的 place 物件，不是憑空生出的別名物件').toBe('日月潭邊聚落');
});

test('matchPlaceNames：同名有多筆資料時，回傳全部候選（不是只回傳第一筆）', () => {
  const results = matchPlaceNames(makePlaces(), '德化社');
  expect(results.length, '應該回傳 2 筆同名的「德化社」候選').toBe(2);
  const sourceTypes = results.map(r => r.sourceType).sort().join(',');
  expect(sourceTypes, '應該分別是聚落類跟行政區域類各一筆').toBe('admin,settlement');
});

test('matchPlaceNames：沒有座標的候選會被過濾掉', () => {
  const results = matchPlaceNames(makePlaces(), '無座標地');
  expect(results.length, '沒有座標的候選不應該出現在結果裡').toBe(0);
});

test('matchPlaceNames：別名比對也會過濾沒有座標的候選', () => {
  const results = matchPlaceNames(makePlaces(), '無座標別名');
  expect(results.length, '沒有座標的候選（透過別名比對到）也不應該出現在結果裡').toBe(0);
});

test('matchPlaceNames：完全比對不到時回傳空陣列', () => {
  const results = matchPlaceNames(makePlaces(), '完全不存在的地名');
  expect(results.length, '應該回傳空陣列').toBe(0);
});

test('matchPlaceNames：query 為空字串時回傳空陣列', () => {
  expect(matchPlaceNames(makePlaces(), '').length).toBe(0);
  expect(matchPlaceNames(makePlaces(), '   ').length, '純空白也應該視為空').toBe(0);
});

test('matchPlaceNames：places 為空陣列時回傳空陣列', () => {
  expect(matchPlaceNames([], '德化社').length).toBe(0);
});

test('matchPlaceNames：同一筆資料同時符合現名與別名也只回傳一次（物件參照去重複）', () => {
  // 竹腳寮本身有別名「腳寮」，用現名查詢應只回傳一次，不會因為
  // matchPlaceNames 內部先查 byName 再查 byAlias 就重複兩次。
  const results = matchPlaceNames(makePlaces(), '竹腳寮');
  expect(results.length, '同一筆資料不應該因為現名/別名各命中一次就被算兩筆').toBe(1);
});

/* ---------------- getActivePlaceNameMatchAt / setActivePlaceNameMatch ---------------- */

test('setActivePlaceNameMatch 之後，用完全相同座標查詢會拿到該 place', () => {
  const place = makePlaces()[0]; // 德化社 (120.9123, 23.8567)
  setActivePlaceNameMatch(place);
  const found = getActivePlaceNameMatchAt(120.9123, 23.8567);
  expect(!!found, '應該找到目前作用中的比對結果').toBeTruthy();
  expect(found.name).toBe('德化社');
});

test('用差距超過 1e-4 度的座標查詢應該回傳 null', () => {
  const place = makePlaces()[0];
  setActivePlaceNameMatch(place);
  const found = getActivePlaceNameMatchAt(120.9123 + 0.001, 23.8567);
  expect(found, '超過誤差容許值應該回傳 null').toBe(null);
});

test('用差距在 1e-4 度以內的座標查詢仍然能命中', () => {
  const place = makePlaces()[0];
  setActivePlaceNameMatch(place);
  const found = getActivePlaceNameMatchAt(120.9123 + 0.00005, 23.8567 - 0.00005);
  expect(!!found, '誤差容許值以內應該仍然命中').toBeTruthy();
});

test('clearActivePlaceNameMatch 之後查詢任何座標都回傳 null', () => {
  const place = makePlaces()[0];
  setActivePlaceNameMatch(place);
  clearActivePlaceNameMatch();
  const found = getActivePlaceNameMatchAt(120.9123, 23.8567);
  expect(found, '清除後應該一律回傳 null').toBe(null);
});

test('setActivePlaceNameMatch(null) 等同清除', () => {
  const place = makePlaces()[0];
  setActivePlaceNameMatch(place);
  setActivePlaceNameMatch(null);
  expect(getActivePlaceNameMatchAt(120.9123, 23.8567)).toBe(null);
});

/* ---------------- sourceTypeLabel ---------------- */

test('sourceTypeLabel：settlement 對應「聚落」', () => {
  expect(sourceTypeLabel('settlement')).toBe('聚落');
});

test('sourceTypeLabel：admin 對應「行政區域」', () => {
  expect(sourceTypeLabel('admin')).toBe('行政區域');
});

test('sourceTypeLabel：未知值回傳空字串', () => {
  expect(sourceTypeLabel('unknown-type')).toBe('');
  expect(sourceTypeLabel(undefined)).toBe('');
});

/* ---------- summarizeDescription：地名卡的一句話摘要 ---------- */

test('summarizeDescription：60 字以內原文直接回傳、不標記截斷', () => {
  const text = '因聚落位置適在水里溪曲流凸岸上，故名';
  expect(summarizeDescription(text)).toEqual({ summary: text, truncated: false });
  const exactly60 = '字'.repeat(SUMMARY_MAX_CHARS);
  expect(summarizeDescription(exactly60).truncated).toBe(false);
});

test('summarizeDescription：空值與只有空白回傳空摘要', () => {
  expect(summarizeDescription('')).toEqual({ summary: '', truncated: false });
  expect(summarizeDescription(null)).toEqual({ summary: '', truncated: false });
  expect(summarizeDescription('   ')).toEqual({ summary: '', truncated: false });
});

test('summarizeDescription：超過 60 字時取第一句（含句尾標點），不加省略號', () => {
  const first = '新街地名有二義，其一指聚落名稱，是由彰化市進入名間鄉的第一個聚落。';
  const r = summarizeDescription(first + '漢人入墾初期，此地原為閩籍陳姓族人產業，後又售予其他閩籍移民，故名福興庄。');
  expect(r.summary).toBe(first);
  expect(r.truncated).toBe(true);
});

test('summarizeDescription：分號、驚嘆號、問號也視為句尾', () => {
  const s = '甲'.repeat(20);
  expect(summarizeDescription(`${s}；${'乙'.repeat(60)}`).summary).toBe(`${s}；`);
  expect(summarizeDescription(`${s}！${'乙'.repeat(60)}`).summary).toBe(`${s}！`);
  expect(summarizeDescription(`${s}？${'乙'.repeat(60)}`).summary).toBe(`${s}？`);
});

test('summarizeDescription：第一句超過 60 字時，在上限內最後一個逗號處斷開並加「…」', () => {
  const clause = '甲'.repeat(24);
  const r = summarizeDescription(`${clause}，${clause}，${clause}，${clause}。`);
  // 上限 60 字內最後的逗號在第 50 字（索引 49）：前兩段各 24 字＋逗號，共 50 字
  expect(r.summary).toBe(`${clause}，${clause}…`);
  expect(r.truncated).toBe(true);
});

test('summarizeDescription：逗號太靠前（不到上限一半）就不在那斷開，避免摘要過短', () => {
  const r = summarizeDescription(`短，${'乙'.repeat(100)}`);
  expect(Array.from(r.summary).length).toBe(SUMMARY_MAX_CHARS + 1); // 60 字＋「…」
  expect(r.summary.endsWith('…')).toBe(true);
});

test('summarizeDescription：完全沒有標點的長文字硬切在 60 字並加「…」', () => {
  const r = summarizeDescription('丙'.repeat(200));
  expect(r.summary).toBe(`${'丙'.repeat(SUMMARY_MAX_CHARS)}…`);
  expect(r.truncated).toBe(true);
});
