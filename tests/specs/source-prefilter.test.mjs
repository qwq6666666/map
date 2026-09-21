import '../env-stub.mjs';
import { test, expect } from 'vitest';
import { loadAppData } from '../../src/data.js';
import { findAvailableLayersAt } from '../../src/features/search.js';

/* ---------------------------------------------------------
   tests/specs/source-prefilter.test.mjs
   ---------------------------------------------------------
   地址搜尋的「來源層級預篩」：座標靠近來源範圍（REGION_EXTENTS），或靠近
   該來源任一圖層的 bbox，都要保留這個來源。

   背景：來源範圍只是概略行政區，有些圖層的涵蓋範圍完全在來源範圍之外
   （thm 的深坑廳 7 張、hakkaliudui 的佳冬鄉 2 張，共 9 張），原本預篩只看
   來源範圍，這 9 張在任何座標都永遠搜不到。

   env-stub.mjs 的假 Image 一律模擬圖磚存在，所以「有沒有出現在結果」
   完全取決於預篩與圖層 bbox 篩選，不受網路影響。
--------------------------------------------------------- */

await loadAppData();

function idsOf(result){
  return new Set(result.available.map(a => `${a.src.id}:${a.layer.id}`));
}

test('佳冬鄉行政區域圖（涵蓋範圍完全在客家六堆來源範圍之外）在佳冬座標搜得到', async () => {
  // Admin_1001321_1993 bbox 約 [120.507,22.376,120.580,22.472]，來源範圍南界 22.55（−0.05 緩衝＝22.50）
  const result = await findAvailableLayersAt(120.5437, 22.424, { county: '屏東縣', town: '佳冬鄉' });
  expect(result.status).toBe('ok');
  expect(idsOf(result).has('hakkaliudui:Admin_1001321_1993'), '佳冬鄉行政區域圖應該出現').toBe(true);
  expect(idsOf(result).has('hakkaliudui:Admin_1001321_2004'), '2004 版同樣應該出現').toBe(true);
});

test('深坑廳文山堡（涵蓋範圍完全在桃竹苗舊地籍圖來源範圍之外）在深坑座標搜得到', async () => {
  // shenkeng_fc07118 bbox 約 [121.539,24.924,121.620,24.970]，來源範圍東界 121.4（+0.05＝121.45）
  const result = await findAvailableLayersAt(121.579, 24.947, { county: '新北市', town: '深坑區' });
  expect(result.status).toBe('ok');
  expect(idsOf(result).has('thm:shenkeng_fc07118'), '深坑廳青潭庄地籍圖應該出現').toBe(true);
});

test('放寬來源預篩不會放寬圖層篩選：座標離佳冬很遠時，佳冬鄉的圖層仍不會出現', async () => {
  // 客家六堆有全台範圍的圖層，這個來源會通過預篩，但佳冬鄉自己的圖層 bbox 不涵蓋基隆
  const result = await findAvailableLayersAt(121.74, 25.13, { county: '屏東縣', town: '佳冬鄉' });
  expect(idsOf(result).has('hakkaliudui:Admin_1001321_1993'), '基隆座標不該搜到佳冬鄉行政區域圖').toBe(false);
});
