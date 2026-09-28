import '../env-stub.mjs';
import { test, expect, vi } from 'vitest';
import { loadAppData, DATA, prefilterLayersByPlaceName } from '../../src/data.js';

await loadAppData();

// findAvailableLayersAt() 只認 data.js 的 matchSourceIdsForAddress() 決定
// 「哪些來源要進候選名單」——真實規則是資料驅動的（data/source-map.json），
// 這裡只想控制「候選來源固定是哪一個」，跟規則本身無關，所以 mock 掉這
// 一支，其餘（extractPlaceKeywords／prefilterLayersByPlaceName／layerKey）
// 都用真的實作，行為才跟正式程式碼一致。
vi.mock('../../src/data.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, matchSourceIdsForAddress: () => ['fallbackBboxTestSrc'] };
});

test('文字篩選：關鍵字完全沒命中任何標題時回傳 null（呼叫端應該退回全部檢查）', () => {
  const candidates = [
    { src: {}, layer: { id: 'a', title: '完全不相關的標題' } },
  ];
  const result = prefilterLayersByPlaceName(candidates, ['某個不會出現的關鍵字']);
  expect(result, '應該回傳 null').toBe(null);
});

test('文字篩選：關鍵字命中「部分」標題時，只回傳命中的那幾筆（不是全部）', () => {
  const candidates = [
    { src: {}, layer: { id: 'a', title: '新竹廳竹北二堡塔仔腳庄' } },
    { src: {}, layer: { id: 'b', title: '苗栗廳苗栗一堡新開庄' } },
  ];
  const result = prefilterLayersByPlaceName(candidates, ['竹北二堡']);
  expect(result.length, '應該只有 1 筆命中').toBe(1);
  expect(result[0].layer.id, '命中的應該是 a').toBe('a');
});

test('只有「有次分類（groups）結構」的來源才適合套用文字篩選（例如 thm）', () => {
  // 這是後來修正過的重要規則：sinica/taoyuan 這種扁平、內容類型混雜、
  // 且同一座標可能同時有多筆資料有效的來源，一律全部檢查，不做文字篩選，
  // 避免「篩窄了又剛好命中一筆，其餘真正有資料的圖層被誤判排除」。
  const sinica = DATA.LAYER_SOURCES.find(s => s.id === 'sinica');
  const thm = DATA.LAYER_SOURCES.find(s => s.id === 'thm');
  const sinicaHasGroups = sinica.categories.some(c => c.groups);
  const thmHasGroups = thm.categories.some(c => c.groups);
  expect(!sinicaHasGroups, 'sinica 不該有 groups 結構').toBeTruthy();
  expect(thmHasGroups, 'thm 應該有 groups 結構').toBeTruthy();
});

test('目前只有 thm、nlsc 這兩個來源有 groups 結構（如果之後又有新來源用了 groups，這則測試會提醒要重新檢視篩選規則）', () => {
  const sourcesWithGroups = DATA.LAYER_SOURCES.filter(s => s.categories.some(c => c.groups));
  const idsWithGroups = sourcesWithGroups.map(s => s.id).sort();
  expect(idsWithGroups.join(','), '目前應該剛好是 thm、nlsc 這兩個來源用 groups 結構').toBe(['nlsc', 'thm'].sort().join(','));
});

// findAvailableLayersAt() 整合測試：兩階段 priority/fallback 篩選 + bbox
// 篩選交互作用時的真實回歸案例（找到的錯誤：early-return 只看 priority
// 是否為空，沒看 fallbackBySource，導致文字比對命中的圖層剛好被 bbox
// 篩空時，明明還有「沒命中文字但 bbox 有重疊」的候選，卻直接判定整個
// 來源沒有資料）。
test('findAvailableLayersAt()：文字比對命中的圖層被 bbox 篩空時，仍要退回檢查同來源沒命中的圖層', async () => {
  const { findAvailableLayersAt } = await import('../../src/features/search.js');

  const originalSources = DATA.LAYER_SOURCES;
  const testSource = {
    id: 'fallbackBboxTestSrc',
    name: '測試來源',
    tileUrl: (layer) => `https://example.test/${layer.id}/{z}/{x}/{y}.png`,
    categories: [{
      category: '測試分類',
      groups: [{
        group: '測試次分類',
        layers: [
          // 文字比對會命中（標題含關鍵字），但 bbox 遠在天邊、確定跟查詢座標的圖磚不相交。
          { id: 'matchedButFarAway', title: '包含吉祥物專用關鍵字的圖層', fmt: 'png', region: { bbox: [0, 0, 1, 1] } },
          // 文字比對不會命中，但 bbox 覆蓋整個查詢座標所在區域。
          { id: 'notMatchedButHere', title: '完全不相關的標題', fmt: 'png', region: { bbox: [119, 21, 123, 26] } },
        ],
      }],
    }],
  };
  DATA.LAYER_SOURCES = [testSource];

  try{
    const result = await findAvailableLayersAt(121, 24.5, { town: '吉祥物專用關鍵字' }, {});
    expect(result.status, '不該判定成完全沒有來源——fallback 裡沒命中文字、但 bbox 有重疊的圖層應該被檢查到').toBe('ok');
    expect(
      result.available.some(c => c.layer.id === 'notMatchedButHere'),
      '沒被文字命中、但 bbox 確實重疊的圖層應該出現在結果裡'
    ).toBe(true);
  } finally {
    DATA.LAYER_SOURCES = originalSources;
  }
});
