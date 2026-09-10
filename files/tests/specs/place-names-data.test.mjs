import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import buildPlaceNames from '../../tools/build-place-names.js';

/* ---------------------------------------------------------
   tests/specs/place-names-data.test.mjs
   ---------------------------------------------------------
   針對 tools/build-place-names.js 的三個純函式（parseCsv／
   splitAliases／rowToPlace）寫測試，全部用寫死在測試檔裡的小段
   輸入，不依賴任何工作區外的真實 CSV 檔案。tools/ 底下是獨立的
   CommonJS 模組（見 tools/package.json），這裡用預設匯入拿到整個
   module.exports 物件再解構。
--------------------------------------------------------- */
const { parseCsv, splitAliases, rowToPlace } = buildPlaceNames;

test('module.exports 應該正確匯出三個函式', () => {
  assertEqual(typeof parseCsv, 'function', 'parseCsv 應該是函式');
  assertEqual(typeof splitAliases, 'function', 'splitAliases 應該是函式');
  assertEqual(typeof rowToPlace, 'function', 'rowToPlace 應該是函式');
});

/* ---------------- parseCsv ---------------- */

test('parseCsv：一般逗號分隔列', () => {
  const rows = parseCsv('a,b,c\n1,2,3');
  assertEqual(rows.length, 2, '應該有 2 列');
  assertEqual(rows[0].join('|'), 'a|b|c', '第一列欄位應正確拆分');
  assertEqual(rows[1].join('|'), '1|2|3', '第二列欄位應正確拆分');
});

test('parseCsv：欄位帶雙引號且內含逗號', () => {
  const rows = parseCsv('a,"b,c",d');
  assertEqual(rows.length, 1, '應該只有 1 列');
  assertEqual(rows[0].length, 3, '應該只有 3 個欄位（引號內的逗號不應該被當成分隔符）');
  assertEqual(rows[0][1], 'b,c', '第二欄應該是含逗號的完整字串');
});

test('parseCsv：欄位帶 "" 轉義雙引號', () => {
  const rows = parseCsv('"he said ""hi"""');
  assertEqual(rows.length, 1, '應該只有 1 列');
  assertEqual(rows[0][0], 'he said "hi"', '"" 應該被轉義成一個字面雙引號');
});

test('parseCsv：CRLF / LF 混合換行皆視為換列', () => {
  const rows = parseCsv('a,b\r\nc,d\ne,f');
  assertEqual(rows.length, 3, '應該有 3 列（CRLF 與 LF 都要正確斷列）');
  assertEqual(rows[1].join('|'), 'c|d', '第二列（CRLF 後）應該正確拆分');
  assertEqual(rows[2].join('|'), 'e|f', '第三列（LF 後）應該正確拆分');
});

test('parseCsv：空白列會被過濾掉', () => {
  const rows = parseCsv('a,b\n\nc,d\n');
  assertEqual(rows.length, 2, '中間的空白列不應該出現在結果中');
  assertEqual(rows[0].join('|'), 'a|b');
  assertEqual(rows[1].join('|'), 'c|d');
});

/* ---------------- splitAliases ---------------- */

test('splitAliases：頓號分隔的混合別名', () => {
  const result = splitAliases('卜吉、化番社', '德化社');
  assertEqual(result.join(','), '卜吉,化番社', '應該依頓號拆分成兩個別名');
});

test('splitAliases：頓號/逗號/分號/間隔號混合分隔', () => {
  const result = splitAliases('甲,乙；丙・丁、戊', '主名');
  assertEqual(result.join(','), '甲,乙,丙,丁,戊', '應該用各種分隔符正確拆分');
});

test('splitAliases：跟 name 相同的片段要被排除', () => {
  const result = splitAliases('德化社、卜吉', '德化社');
  assertEqual(result.join(','), '卜吉', '跟主名相同的片段應被排除');
});

test('splitAliases：重複片段要去重', () => {
  const result = splitAliases('卜吉、卜吉、化番社', '德化社');
  assertEqual(result.join(','), '卜吉,化番社', '重複片段應該只留一份');
});

test('splitAliases：純空字串輸入回傳空陣列', () => {
  assertEqual(splitAliases('', '德化社').length, 0, '空字串輸入應該回傳空陣列');
});

test('splitAliases：undefined/null 輸入回傳空陣列', () => {
  assertEqual(splitAliases(undefined, '德化社').length, 0, 'undefined 輸入應該回傳空陣列');
  assertEqual(splitAliases(null, '德化社').length, 0, 'null 輸入應該回傳空陣列');
});

/* ---------------- rowToPlace ---------------- */

const HEADER = ['Type','PlaceName','ChinesePhonetic','CommonPhonetic','AnotherName',
  'County','CountyCode','Town','TownCode','Village','PlaceMean','Longitude','Latitude'];

test('rowToPlace：正常一列（含經緯度、含別名）轉出正確物件', () => {
  const row = ['聚落','德化社','','','卜吉、化番社','南投縣','','魚池鄉','','','日月潭邊的聚落','120.9123','23.8567'];
  const place = rowToPlace(HEADER, row, 'settlement');
  assertTrue(!!place, '應該回傳有效物件');
  assertEqual(place.name, '德化社');
  assertEqual(place.aliases.join(','), '卜吉,化番社');
  assertEqual(place.county, '南投縣');
  assertEqual(place.town, '魚池鄉');
  assertEqual(place.description, '日月潭邊的聚落');
  assertEqual(place.sourceType, 'settlement');
  assertEqual(place.longitude, 120.9123);
  assertEqual(place.latitude, 23.8567);
});

test('rowToPlace：PlaceName 空白時回傳 null', () => {
  const row = ['聚落','','','','','南投縣','','魚池鄉','','','','120.9','23.8'];
  const place = rowToPlace(HEADER, row, 'settlement');
  assertEqual(place, null, 'PlaceName 空白應該回傳 null');
});

test('rowToPlace：PlaceName 只有空白字元時也視為空、回傳 null', () => {
  const row = ['聚落','   ','','','','南投縣','','魚池鄉','','','','120.9','23.8'];
  const place = rowToPlace(HEADER, row, 'settlement');
  assertEqual(place, null, '只有空白字元的 PlaceName 應該視為空');
});

test('rowToPlace：經度缺值時，輸出物件不應該有 longitude/latitude 這兩個 key', () => {
  const row = ['聚落','社寮','','','','南投縣','','竹山鎮','','','','','23.8'];
  const place = rowToPlace(HEADER, row, 'settlement');
  assertTrue(!('longitude' in place), '經度缺值時不應該有 longitude key');
  assertTrue(!('latitude' in place), '經度缺值時也不應該有 latitude key（要嘛兩個都有，要嘛都沒有）');
});

test('rowToPlace：緯度缺值時，輸出物件不應該有 longitude/latitude 這兩個 key', () => {
  const row = ['聚落','社寮','','','','南投縣','','竹山鎮','','','','120.7',''];
  const place = rowToPlace(HEADER, row, 'settlement');
  assertTrue(!('longitude' in place), '緯度缺值時不應該有 longitude key');
  assertTrue(!('latitude' in place), '緯度缺值時也不應該有 latitude key');
});

test('rowToPlace：AnotherName 為空時 aliases 應為空陣列', () => {
  const row = ['聚落','社寮','','','','南投縣','','竹山鎮','','','','120.7','23.8'];
  const place = rowToPlace(HEADER, row, 'settlement');
  assertEqual(place.aliases.length, 0, '沒有別名應該是空陣列');
});

test('rowToPlace：sourceType 正確帶入 admin', () => {
  const row = ['行政區域','南投市','','','','南投縣','','南投市','','','','120.68','23.91'];
  const place = rowToPlace(HEADER, row, 'admin');
  assertEqual(place.sourceType, 'admin', 'sourceType 應該正確帶入 admin');
});

await run();
