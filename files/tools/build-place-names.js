/* ---------------------------------------------------------
   tools/build-place-names.js
   ---------------------------------------------------------
   讀取中華民國內政部「臺灣地區地名資料」CSV（聚落類 + 行政區域類），
   解析出精簡的「地名今昔對照」資料，輸出到 data/place-names.json，
   供 src/features/placeNames.js 用瀏覽器 fetch() 延遲載入。

   兩份原始 CSV 不在專案 repo 內（檔案較大、非工作區檔案），欄位固定為：
       Type,PlaceName,ChinesePhonetic,CommonPhonetic,AnotherName,
       County,CountyCode,Town,TownCode,Village,PlaceMean,
       Longitude,Latitude
   （含 UTF-8 BOM，欄位可能用雙引號包住並含逗號/換行，需正確處理
   RFC4180 風格引號跳脫）

   用法：
       node tools/build-place-names.js
       node tools/build-place-names.js <聚落CSV路徑> <行政區域CSV路徑>

   核心邏輯（parseCsv / splitAliases / rowToPlace）刻意寫成不做任何
   檔案 I/O 的純函式並 module.exports 匯出，方便測試檔用寫死的小段
   CSV 文字直接 require() 驗證，不依賴真正的外部 CSV 檔案。
--------------------------------------------------------- */
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SETTLEMENT_CSV =
  'C:\\Users\\USER\\Desktop\\台灣百年歷史地圖設計\\53677臺灣地區地名資料_聚落類_20250528.csv';
const DEFAULT_ADMIN_CSV =
  'C:\\Users\\USER\\Desktop\\台灣百年歷史地圖設計\\40281臺灣地區地名資料_行政區域類_20250528.csv';

const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'place-names.json');

// 別名拆分用的分隔符：頓號、逗號（全形/半形）、分號（全形/半形）、頓點/間隔號
const ALIAS_SPLIT_RE = /[、,，;；·・]/;

/**
 * 把 CSV 全文字串解析成列陣列（每列是欄位字串陣列），正確處理：
 *   - 欄位以雙引號包住時，內部可以含逗號、換行
 *   - 雙引號內的 "" 表示跳脫成一個字面雙引號
 *   - CRLF / LF 換行皆視為換列（在非引號狀態下）
 * 不處理 BOM（呼叫端先自行去除），不做任何檔案 I/O。
 * @param {string} text
 * @returns {string[][]}
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const len = text.length;

  for (let i = 0; i < len; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      // 交由接下來的 \n（若有）處理換列，單獨的 \r 也視為換列
      if (text[i + 1] !== '\n') {
        row.push(field);
        field = '';
        rows.push(row);
        row = [];
      }
    } else if (ch === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }

  // 最後一列若有殘留內容（檔尾沒有換行）要補進去
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // 過濾掉完全空白的列（例如檔尾多餘的空行：單一欄位且為空字串）
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/**
 * 把 AnotherName 原始字串拆成別名陣列：依常見分隔符拆分、去頭尾空白、
 * 過濾空字串、用 Set 去重複，並排除掉跟主名稱完全相同的片段。
 * 純函式，不依賴任何外部狀態。
 * @param {string} raw AnotherName 原始欄位值
 * @param {string} name 該列的主名稱（PlaceName，已去頭尾空白）
 * @returns {string[]}
 */
function splitAliases(raw, name) {
  if (!raw) return [];
  const parts = String(raw)
    .split(ALIAS_SPLIT_RE)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== name);
  return Array.from(new Set(parts));
}

/**
 * 把一列資料（表頭陣列 + 該列欄位值陣列）轉成輸出用的單筆 place 物件。
 * @param {string[]} header CSV 表頭欄名陣列（parseCsv 回傳的第一列）
 * @param {string[]} rowFields 該資料列的欄位值陣列
 * @param {'settlement'|'admin'} sourceType 資料來源類別
 * @returns {object|null} 轉換後的 place 物件；若該列沒有 PlaceName 則回傳 null（表示跳過）
 */
function rowToPlace(header, rowFields, sourceType) {
  const record = {};
  for (let i = 0; i < header.length; i++) {
    record[header[i]] = rowFields[i] !== undefined ? rowFields[i] : '';
  }

  const name = (record.PlaceName || '').trim();
  if (!name) return null;

  const county = (record.County || '').trim();
  const town = (record.Town || '').trim();
  const description = (record.PlaceMean || '').trim();
  const aliases = splitAliases(record.AnotherName || '', name);

  const place = {
    name,
    aliases,
    county,
    town,
    description,
    sourceType,
  };

  const lon = Number(record.Longitude);
  const lat = Number(record.Latitude);
  const hasLon = record.Longitude !== undefined && String(record.Longitude).trim() !== '' && !Number.isNaN(lon);
  const hasLat = record.Latitude !== undefined && String(record.Latitude).trim() !== '' && !Number.isNaN(lat);
  if (hasLon && hasLat) {
    place.longitude = lon;
    place.latitude = lat;
  }

  return place;
}

module.exports = { parseCsv, splitAliases, rowToPlace };

if (require.main === module) {
  const settlementPath = process.argv[2] || DEFAULT_SETTLEMENT_CSV;
  const adminPath = process.argv[3] || DEFAULT_ADMIN_CSV;

  /**
   * 讀取單一 CSV 檔案，解析出 place 物件陣列，並印出該檔案的解析統計。
   * @param {string} filePath
   * @param {'settlement'|'admin'} sourceType
   * @returns {object[]}
   */
  function loadCsvFile(filePath, sourceType) {
    const raw = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
    const rows = parseCsv(raw);
    if (rows.length === 0) {
      console.log(`  [${sourceType}] ${filePath}：空檔案，跳過`);
      return [];
    }
    const header = rows[0];
    const dataRows = rows.slice(1);

    let skipped = 0;
    const places = [];
    for (const row of dataRows) {
      const place = rowToPlace(header, row, sourceType);
      if (!place) {
        skipped++;
        continue;
      }
      places.push(place);
    }

    console.log(
      `  [${sourceType}] ${filePath}\n    解析資料列：${dataRows.length}，跳過（無 PlaceName）：${skipped}，有效：${places.length}`
    );
    return places;
  }

  console.log('讀取地名資料 CSV...');
  const settlementPlaces = loadCsvFile(settlementPath, 'settlement');
  const adminPlaces = loadCsvFile(adminPath, 'admin');

  const allPlaces = settlementPlaces.concat(adminPlaces);
  const withCoords = allPlaces.filter((p) => 'longitude' in p && 'latitude' in p).length;
  const withoutCoords = allPlaces.length - withCoords;

  const output = {
    version: 1,
    generatedAt: new Date().toISOString(),
    count: allPlaces.length,
    places: allPlaces,
  };

  const json = JSON.stringify(output);
  fs.writeFileSync(OUTPUT_PATH, json, 'utf-8');
  const sizeBytes = Buffer.byteLength(json, 'utf-8');
  const sizeMB = (sizeBytes / 1024 / 1024).toFixed(2);

  console.log('\n輸出完成：');
  console.log(`  總筆數：${allPlaces.length}（聚落 ${settlementPlaces.length} ＋ 行政區域 ${adminPlaces.length}）`);
  console.log(`  有座標：${withCoords}，無座標：${withoutCoords}`);
  console.log(`  輸出檔案：${OUTPUT_PATH}`);
  console.log(`  檔案大小：${sizeBytes} bytes（約 ${sizeMB} MB）`);
}
