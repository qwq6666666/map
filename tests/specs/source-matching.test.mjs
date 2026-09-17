import '../env-stub.mjs';
import { test, run, assertTrue } from '../assert.mjs';
import { readFileSync } from 'fs';
import path from 'path';
import { loadAppData, matchSourceIdsForAddress, extractPlaceKeywords } from '../../src/data.js';

await loadAppData();

function includesAll(arr, items){ return items.every(i => arr.includes(i)); }
function excludesAll(arr, items){ return items.every(i => !arr.includes(i)); }

test('臺北市地址（county 欄位）比對出正確來源', () => {
  const result = matchSourceIdsForAddress({ county: '臺北市' });
  assertTrue(includesAll(result, ['sinica', 'taipei', 'udd']), '應包含 sinica/taipei/udd');
});

test('八德區出現在非預期的 city 欄位，仍然要正確比對出桃園相關來源（防止之前修過的欄位不穩定問題再次發生）', () => {
  const result = matchSourceIdsForAddress({ road: '桃鶯路', city: '八德區', state: '桃園市' });
  assertTrue(includesAll(result, ['sinica', 'taoyuan', 'thm']), '應包含 sinica/taoyuan/thm');
});

test('基隆（county+district 合併規則）仍然正確運作', () => {
  const result = matchSourceIdsForAddress({ town: '基隆', county: '基隆市' });
  assertTrue(includesAll(result, ['sinica', 'keelung']), '應包含 sinica/keelung');
});

test('新北市新店區觸發深坑巢狀例外規則，補上 thm', () => {
  const result = matchSourceIdsForAddress({ county: '新北市', town: '新店區' });
  assertTrue(includesAll(result, ['sinica', 'newtaipei', 'thm']), '應包含 sinica/newtaipei/thm');
});

test('新北市板橋區（一般行政區）不該誤觸發深坑例外規則', () => {
  const result = matchSourceIdsForAddress({ county: '新北市', town: '板橋區' });
  assertTrue(includesAll(result, ['sinica', 'newtaipei']), '應包含 sinica/newtaipei');
  assertTrue(excludesAll(result, ['thm']), '不該包含 thm');
});

test('彰化縣鹿港鎮觸發鹿港巢狀例外規則', () => {
  const result = matchSourceIdsForAddress({ county: '彰化縣', town: '鹿港鎮' });
  assertTrue(includesAll(result, ['sinica', 'changhua', 'lukang']), '應包含 sinica/changhua/lukang');
});

test('完全沒有可用欄位時，至少會有全臺涵蓋的 sinica', () => {
  const result = matchSourceIdsForAddress({});
  assertTrue(result.includes('sinica'), '應包含 sinica');
});

test('完全沒有可用欄位時（反向地理編碼失敗，或呼叫端搶在地理編碼結果回來前送出查詢），不能只剩 alwaysInclude 來源——地區性來源（例如 taipei）也要一併列入候選，交給後面的座標 bbox 與圖磚探測把關，避免「有時定位後周圍圖資顯示不出來」', () => {
  const result = matchSourceIdsForAddress({});
  assertTrue(includesAll(result, ['taipei', 'newtaipei', 'keelung']), '空地址時仍應包含地區性來源');
});

test('地址欄位全部是空字串（例如 Nominatim 回傳但欄位皆為空值）等同於完全沒有欄位，同樣不排除地區性來源', () => {
  const result = matchSourceIdsForAddress({ county: '', town: '', city: '' });
  assertTrue(includesAll(result, ['taipei', 'newtaipei']), '欄位皆為空字串時仍應包含地區性來源');
});

test('extractPlaceKeywords 不會把縣市層級（county/state）的值當成關鍵字（避免誤篩窄其他來源）', () => {
  const keywords = extractPlaceKeywords({ town: '安平區', county: '臺南市', state: '臺南市' });
  assertTrue(!keywords.includes('臺南市') && !keywords.includes('臺南'), '不該包含縣市層級關鍵字');
  assertTrue(keywords.includes('安平區'), '應該包含鄉鎮市區層級關鍵字');
});

test('ccts（alwaysIncludeUnless）在台灣地址時不觸發', () => {
  const result = matchSourceIdsForAddress({ county: '臺北市' });
  assertTrue(excludesAll(result, ['ccts']), '台北市地址不該包含 ccts');
});

test('ccts（alwaysIncludeUnless）在非台灣地址（例如北京）時會觸發', () => {
  const result = matchSourceIdsForAddress({ county: '北京市' });
  assertTrue(includesAll(result, ['sinica', 'beijing', 'ccts']), '應包含 sinica/beijing/ccts');
});

test('ccts（alwaysIncludeUnless）完全沒有可用欄位時，因為無法判斷是不是台灣地址，預設仍然觸發', () => {
  const result = matchSourceIdsForAddress({});
  assertTrue(result.includes('ccts'), '空地址應包含 ccts');
});

/* ---------------------------------------------------------
   全站來源 id 都要登記在 data/source-map.json 回歸測試
   ---------------------------------------------------------
   背景：CLAUDE.md 記載 ls、korea 都曾發生「新增來源時忘記同步
   data/source-map.json」的疏失——圖層資料本身存在，但因為沒有
   任何 alwaysInclude／alwaysIncludeUnless／rules／districtRule
   規則會選到這個來源 id，導致地址搜尋永遠不會把它列入候選。
   這裡走訪 data/layers/index.json 的全部來源 id，逐一斷言除了
   白名單以外，每個 id 都至少出現在 source-map.json 的某個規則
   結構裡（不驗證規則本身是否合理，只驗證「有沒有被登記」）。
--------------------------------------------------------- */
const INDEX_PATH = path.join(process.cwd(), 'data/layers/index.json');
const SOURCE_MAP_PATH = path.join(process.cwd(), 'data/source-map.json');

const layersIndex = JSON.parse(readFileSync(INDEX_PATH, 'utf-8'));
const sourceMap = JSON.parse(readFileSync(SOURCE_MAP_PATH, 'utf-8'));

// nlsc（國土測繪圖資）是現代參考圖層，不透過「地址→歷史地名來源」這套
// 比對機制篩選，前端另有獨立的圖層樹狀目錄可直接開關，故不需登記在
// source-map.json 裡——這是目前唯一已知、刻意排除在外的來源。
const SOURCE_MAP_REGISTRATION_EXEMPT = ['nlsc'];

function collectRegisteredSourceIds(map){
  const ids = new Set();
  (map.alwaysInclude || []).forEach(id => ids.add(id));
  (map.alwaysIncludeUnless || []).forEach(entry => {
    (entry.sources || []).forEach(id => ids.add(id));
  });
  (map.rules || []).forEach(rule => {
    (rule.sources || []).forEach(id => ids.add(id));
    if(rule.districtRule){
      (rule.districtRule.sources || []).forEach(id => ids.add(id));
    }
  });
  return ids;
}

const registeredIds = collectRegisteredSourceIds(sourceMap);
const allSourceIds = (layersIndex.sources || []).map(s => s.id);

test('data/layers/index.json 的每個來源 id（白名單除外）都至少登記在 source-map.json 的某個規則裡', () => {
  const missing = allSourceIds.filter(id => !SOURCE_MAP_REGISTRATION_EXEMPT.includes(id) && !registeredIds.has(id));
  assertTrue(
    missing.length === 0,
    `以下來源 id 沒有出現在 data/source-map.json 的 alwaysInclude／alwaysIncludeUnless／rules／districtRule 任何一處，地址搜尋永遠不會選到它們，請補上對應規則（或若確實不需要地址比對，加進本測試的 SOURCE_MAP_REGISTRATION_EXEMPT 白名單並註明原因）：${JSON.stringify(missing)}`
  );
});

test('SOURCE_MAP_REGISTRATION_EXEMPT 白名單本身仍必須是 data/layers/index.json 裡存在的來源 id（避免白名單留著早已改名/移除的舊 id）', () => {
  const staleExemptions = SOURCE_MAP_REGISTRATION_EXEMPT.filter(id => !allSourceIds.includes(id));
  assertTrue(
    staleExemptions.length === 0,
    `以下白名單 id 已經不存在於 data/layers/index.json，應從 SOURCE_MAP_REGISTRATION_EXEMPT 移除：${JSON.stringify(staleExemptions)}`
  );
});

await run();
