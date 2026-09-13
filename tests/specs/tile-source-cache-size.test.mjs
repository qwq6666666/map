/* ---------------------------------------------------------
   tests/specs/tile-source-cache-size.test.mjs
   ---------------------------------------------------------
   靜態檢查：src/core/map.js／src/data.js 裡每一個真的會發送網路請求
   的 ol.source.*（OSM／XYZ／WMTS）建構呼叫，都必須明確帶
   cacheSize: DEFAULT_TILE_CACHE_SIZE（見 core/tileLoadGuard.js 的
   DEFAULT_TILE_CACHE_SIZE 說明：不帶這個選項 OL 會把它當成 0，不是
   退回內建預設 2048，LRU 過期機制形同虛設）。

   這不是執行期行為測試（假 ol 環境下 FakeTileSource 只是把 opts 存
   起來，測不出「OL 內部真的會不會清快取」），改用「讀原始碼字串＋
   正則」的靜態掃描方式，直接比對每個 `new ol.source.X({ ... })`
   物件字面值裡有沒有 cacheSize，或是刻意排除的兩種「找不到
   entry/src/layer 時的 url: '' 佔位 source」（url 是空字串，不會真的
   發送請求，不需要快取上限，也不應該誤報成漏帶 cacheSize）。

   跟 tests/specs/service-worker.test.mjs 一樣是「讀檔案內容＋規則
   比對」的靜態檢查風格（那份用 node:vm 執行整份腳本，這份更單純，
   直接 regex 掃字串即可，不需要真的執行 data.js／core/map.js 的
   模組層級程式碼）。

   括號比對說明：不能單純用非貪婪正則抓到「第一個 })」當結尾——
   makeWmtsSourceFromEntry() 那個 ol.source.WMTS 物件字面值裡，
   `tileLoadFunction: createGuardedTileLoadFunction({})` 這個屬性值
   本身就內含一組 `{}`，非貪婪正則會在這裡提早誤判成物件字面值的
   結尾，把後面才出現的 cacheSize 漏掉（已在撰寫這份測試時實際踩到，
   看到的假失敗案例就是這個原因）。改用 findMatchingBrace() 手動計數
   括號深度，從 `new ol.source.X({` 的那個 `{` 開始數到真正配對的
   `}` 為止，正確處理巢狀大括號。
--------------------------------------------------------- */
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_JS_PATH = path.join(__dirname, '../../src/data.js');
const MAP_JS_PATH = path.join(__dirname, '../../src/core/map.js');
const dataJs = readFileSync(DATA_JS_PATH, 'utf-8');
const mapJs = readFileSync(MAP_JS_PATH, 'utf-8');

const SOURCE_CTOR_START_RE = /new ol\.source\.(OSM|XYZ|WMTS)\(\{/g;
const EMPTY_URL_PLACEHOLDER_RE = /url:\s*(['"])\1/; // url: '' 或 url: ""

// 從 code[openBraceIndex]（必須是 '{'）開始數括號深度，回傳配對的
// 結尾 '}' 的 index；找不到配對（理論上不會發生，除非原始碼語法本身
// 就有誤）就回傳 -1，呼叫端要自行處理。
function findMatchingBrace(code, openBraceIndex){
  let depth = 0;
  for(let i = openBraceIndex; i < code.length; i++){
    if(code[i] === '{') depth++;
    else if(code[i] === '}'){
      depth--;
      if(depth === 0) return i;
    }
  }
  return -1;
}

function findSourceConstructions(code){
  const results = [];
  for(const m of code.matchAll(SOURCE_CTOR_START_RE)){
    const openBraceIndex = m.index + m[0].length - 1; // m[0] 最後一個字元就是 '{'
    const closeBraceIndex = findMatchingBrace(code, openBraceIndex);
    assertTrue(closeBraceIndex !== -1, `在 ${m[0]} 附近找不到配對的 '}'，原始碼可能有語法問題`);
    results.push({ type: m[1], snippet: code.slice(m.index, closeBraceIndex + 1) });
  }
  return results;
}

function classify(snippet){
  const hasCacheSize = /cacheSize\s*:/.test(snippet);
  const isEmptyUrlPlaceholder = EMPTY_URL_PLACEHOLDER_RE.test(snippet);
  return { hasCacheSize, isEmptyUrlPlaceholder };
}

test('src/core/map.js：osmLayer／satLayer 的 ol.source.* 都帶 cacheSize', () => {
  const found = findSourceConstructions(mapJs);
  assertEqual(found.length, 2, `預期 core/map.js 剛好有 2 個 ol.source.* 建構呼叫（osm、sat），實際找到 ${found.length}`);
  found.forEach(({ type, snippet }) => {
    const { hasCacheSize } = classify(snippet);
    assertTrue(hasCacheSize, `core/map.js 的 ol.source.${type} 建構呼叫缺少 cacheSize：\n${snippet}`);
  });
});

test('src/data.js：每個真的會發送請求的 ol.source.* 都帶 cacheSize；找不到 entry/src/layer 的 url: \'\' 佔位 source 刻意例外', () => {
  const found = findSourceConstructions(dataJs);
  // base:osm、base:sat、custom wmts 成功、custom xyz、hist 真實圖層，共 5 個
  // 「真的會發送請求」的 source；另外 5 個是找不到 entry/src/layer 時的
  // url: '' 佔位 source（2 處在 makeWmtsSourceFromEntry：缺必要資料／建立
  // 失敗；3 處在 makeSourceForKey：custom entry 不存在、src 不存在、
  // layer 不存在），刻意不帶 cacheSize。異動 data.js 新增/刪除 ol.source.*
  // 呼叫時，這個總數斷言會抓到漏改。
  assertEqual(found.length, 10, `預期 data.js 剛好有 10 個 ol.source.* 建構呼叫，實際找到 ${found.length}`);

  let realCount = 0;
  let placeholderCount = 0;
  found.forEach(({ type, snippet }) => {
    const { hasCacheSize, isEmptyUrlPlaceholder } = classify(snippet);
    if(hasCacheSize){ realCount++; return; }
    assertTrue(
      isEmptyUrlPlaceholder,
      `data.js 的 ol.source.${type} 建構呼叫既沒有 cacheSize、也不是已知的 url: '' 佔位 source，可能漏帶 cacheSize：\n${snippet}`
    );
    placeholderCount++;
  });

  assertEqual(realCount, 5, `預期 5 個真的會發送請求的 ol.source.* 都帶 cacheSize，實際 ${realCount}`);
  assertEqual(placeholderCount, 5, `預期 5 個 url: '' 佔位 source 刻意不帶 cacheSize，實際 ${placeholderCount}`);
});

test('src/data.js／src/core/map.js：所有帶 cacheSize 的 ol.source.* 都指向 DEFAULT_TILE_CACHE_SIZE（不是寫死的數字），且該常數確實有從 tileLoadGuard.js 匯入', () => {
  assertTrue(dataJs.includes("import { createGuardedTileLoadFunction, DEFAULT_TILE_CACHE_SIZE"), 'data.js 應該從 core/tileLoadGuard.js 匯入 DEFAULT_TILE_CACHE_SIZE，除非 import 寫法已變更（此時請同步更新這條斷言）');
  assertTrue(mapJs.includes('DEFAULT_TILE_CACHE_SIZE') && mapJs.includes("from './tileLoadGuard.js'"), 'core/map.js 應該從 core/tileLoadGuard.js 匯入 DEFAULT_TILE_CACHE_SIZE');

  const found = [...findSourceConstructions(dataJs), ...findSourceConstructions(mapJs)];
  found.forEach(({ type, snippet }) => {
    const m = snippet.match(/cacheSize\s*:\s*([^\n,}]+)/);
    if(!m) return; // 佔位 source，另一個測試案例已經驗證過不需要 cacheSize
    assertEqual(m[1].trim(), 'DEFAULT_TILE_CACHE_SIZE', `ol.source.${type} 的 cacheSize 應該引用 DEFAULT_TILE_CACHE_SIZE 常數，不應該寫死數字：\n${snippet}`);
  });
});

await run();
