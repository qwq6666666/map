import { createRequire } from 'node:module';
import { test, run, assertEqual } from '../assert.mjs';

// tools/build-nlsc-layers.js 是 CommonJS 腳本（用 require()），這裡用
// createRequire() 匯入，只會拿到 module.exports 的純函式，不會觸發
// require.main === module 才會跑的 main()（抓 GetCapabilities、寫檔）。
const require = createRequire(import.meta.url);
const {
  yearInfoForPhoto,
  yearInfoForTopo,
  yearInfoForLuimap,
  yearInfoForTerrainAnalysis,
  yearInfoForAdmin,
} = require('../../tools/build-nlsc-layers.js');

// SonarQube javascript:S8786 修正：把 \d+ 改成 \d{1,4}／\d{1,2} 之後，
// 這裡驗證所有真實資料格式的行為跟改之前一致。

test('yearInfoForPhoto：PHOTO 開頭直接抓 4 碼西元年', () => {
  const info = yearInfoForPhoto('PHOTO2020', '2020年航照影像');
  assertEqual(info.year, 2020, 'PHOTO id 應優先於 title 判斷');
  assertEqual(info.dateLabel, '2020');
});

test('yearInfoForPhoto：從 title 的「NNN年」換算民國年為西元年', () => {
  const info = yearInfoForPhoto('OTHER_ID', '108年航照影像');
  assertEqual(info.year, 2019, '民國108年應換算為西元2019年');
  assertEqual(info.dateLabel, '2019');
});

test('yearInfoForPhoto：title 沒有年份資訊時回傳「現代」', () => {
  const info = yearInfoForPhoto('OTHER_ID', '無年份標題');
  assertEqual(info.year, null);
  assertEqual(info.dateLabel, '現代');
});

test('yearInfoForTopo：id 內含民國年數字時正確換算', () => {
  const info = yearInfoForTopo('TOPO25K_95');
  assertEqual(info.year, 2006, '民國95年應換算為西元2006年');
});

test('yearInfoForTopo：id 不含年份數字時回傳「現代」', () => {
  const info = yearInfoForTopo('B100000');
  assertEqual(info.year, null);
  assertEqual(info.dateLabel, '現代');
});

test('yearInfoForLuimap：id 為 LUIMAP01~09 時視為土地利用類別、非年份', () => {
  const info = yearInfoForLuimap('LUIMAP05', '土地利用類別圖');
  assertEqual(info.year, null);
  assertEqual(info.dateLabel, '現代');
});

test('yearInfoForLuimap：title 帶「NNN-NNN年」區間時取起始年份為 year', () => {
  const info = yearInfoForLuimap('LUIMAP60', '60-70年土地利用調查成果圖');
  assertEqual(info.year, 1971, '民國60年應換算為西元1971年');
  assertEqual(info.dateLabel, '1971-1981');
});

test('yearInfoForLuimap：title 沒有年份區間時直接用 id 數字換算', () => {
  const info = yearInfoForLuimap('LUIMAP60', '土地利用調查成果圖');
  assertEqual(info.year, 1971);
  assertEqual(info.dateLabel, '1971');
});

test('yearInfoForTerrainAnalysis：title 帶「(西元-西元)」區間直接使用，不換算民國年', () => {
  const info = yearInfoForTerrainAnalysis('地形分析圖(2010-2020)');
  assertEqual(info.year, 2010);
  assertEqual(info.dateLabel, '2010-2020');
});

test('yearInfoForAdmin：title 帶「NNN年NN月」時換算西元年（例：村里界(108年10月)）', () => {
  const info = yearInfoForAdmin('村里界(108年10月)');
  assertEqual(info.year, 2019, '民國108年應換算為西元2019年');
  assertEqual(info.dateLabel, '2019');
});

test('yearInfoForAdmin：title 沒有「年」「月」格式時回傳「現代」', () => {
  const info = yearInfoForAdmin('行政區界線圖');
  assertEqual(info.year, null);
  assertEqual(info.dateLabel, '現代');
});

await run();
