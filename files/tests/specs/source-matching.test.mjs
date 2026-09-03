import '../env-stub.mjs';
import { test, run, assertTrue } from '../assert.mjs';
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

await run();
