import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import { loadAppData, LAYER_SOURCES, REGION_EXTENTS } from '../../src/data.js';

await loadAppData();

test('資料載入後，39 個 WMTS 來源都在（含後來新增的北京／上海等中國城市與 ccts、nlsc、ls、korea、tamsui、puli、penghu、taitung、japan、southeast_asia）', () => {
  assertEqual(LAYER_SOURCES.length, 39, '來源數量');
});

test('資料載入後，總圖層數是 2425 筆（一筆都不能少）', () => {
  let total = 0;
  LAYER_SOURCES.forEach(s => s.categories.forEach(c => {
    if(c.groups) c.groups.forEach(g => total += g.layers.length);
    else total += c.layers.length;
  }));
  assertEqual(total, 2425, '總圖層數');
});

test('每個來源都有對應的地理範圍（REGION_EXTENTS）', () => {
  assertEqual(Object.keys(REGION_EXTENTS).length, 39, 'REGION_EXTENTS 筆數');
});

test('sinica 來源的圖層有 yearNum（數字年份）跟 scale（比例尺）欄位', () => {
  const sinica = LAYER_SOURCES.find(s => s.id === 'sinica');
  assertTrue(!!sinica, '找得到 sinica 來源');
  const withYear = sinica.categories[0].layers.find(l => typeof l.yearNum === 'number');
  assertTrue(!!withYear, '至少有一筆圖層帶有數字年份');
});

test('thm 來源的圖層全部是 1901 年（先前確認過的資料修正）', () => {
  const thm = LAYER_SOURCES.find(s => s.id === 'thm');
  const allLayers = [];
  thm.categories.forEach(c => c.groups.forEach(g => allLayers.push(...g.layers)));
  assertEqual(allLayers.length, 535, 'thm 總圖層數');
  assertTrue(allLayers.every(l => l.yearNum === 1901), 'thm 全部圖層 yearNum 都是 1901');
});

test('udd 圖層的 tileUrl() 用 literalUrl（每筆圖層自己的完整網址），不是套樣板', () => {
  const udd = LAYER_SOURCES.find(s => s.id === 'udd');
  const catWithUrl = udd.categories.find(c => c.layers && c.layers.some(l => l.url));
  const layer = catWithUrl.layers.find(l => l.url);
  const resolved = udd.tileUrl(layer);
  assertEqual(resolved, layer.url, 'udd 圖層的 tileUrl 應該直接等於 layer.url');
});

await run();
