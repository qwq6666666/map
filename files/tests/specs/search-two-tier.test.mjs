import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import { loadAppData, LAYER_SOURCES, prefilterLayersByPlaceName } from '../../src/data.js';

await loadAppData();

test('文字篩選：關鍵字完全沒命中任何標題時回傳 null（呼叫端應該退回全部檢查）', () => {
  const candidates = [
    { src: {}, layer: { id: 'a', title: '完全不相關的標題' } },
  ];
  const result = prefilterLayersByPlaceName(candidates, ['某個不會出現的關鍵字']);
  assertEqual(result, null, '應該回傳 null');
});

test('文字篩選：關鍵字命中「部分」標題時，只回傳命中的那幾筆（不是全部）', () => {
  const candidates = [
    { src: {}, layer: { id: 'a', title: '新竹廳竹北二堡塔仔脚庄' } },
    { src: {}, layer: { id: 'b', title: '苗栗廳苗栗一堡新開庄' } },
  ];
  const result = prefilterLayersByPlaceName(candidates, ['竹北二堡']);
  assertEqual(result.length, 1, '應該只有 1 筆命中');
  assertEqual(result[0].layer.id, 'a', '命中的應該是 a');
});

test('只有「有次分類（groups）結構」的來源才適合套用文字篩選（例如 thm）', () => {
  // 這是後來修正過的重要規則：sinica/taoyuan 這種扁平、內容類型混雜、
  // 且同一座標可能同時有多筆資料有效的來源，一律全部檢查，不做文字篩選，
  // 避免「篩窄了又剛好命中一筆，其餘真正有資料的圖層被誤判排除」。
  const sinica = LAYER_SOURCES.find(s => s.id === 'sinica');
  const thm = LAYER_SOURCES.find(s => s.id === 'thm');
  const sinicaHasGroups = sinica.categories.some(c => c.groups);
  const thmHasGroups = thm.categories.some(c => c.groups);
  assertTrue(!sinicaHasGroups, 'sinica 不該有 groups 結構');
  assertTrue(thmHasGroups, 'thm 應該有 groups 結構');
});

test('目前只有 thm、nlsc 這兩個來源有 groups 結構（如果之後又有新來源用了 groups，這則測試會提醒要重新檢視篩選規則）', () => {
  const sourcesWithGroups = LAYER_SOURCES.filter(s => s.categories.some(c => c.groups));
  const idsWithGroups = sourcesWithGroups.map(s => s.id).sort();
  assertEqual(idsWithGroups.join(','), ['nlsc', 'thm'].sort().join(','), '目前應該剛好是 thm、nlsc 這兩個來源用 groups 結構');
});

await run();
