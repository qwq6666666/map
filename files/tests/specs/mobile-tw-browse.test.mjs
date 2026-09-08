import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import { loadAppData, LAYER_SOURCES } from '../../src/data.js';
import { YEAR_BUCKET_ORDER, yearBucketOf, regionLabelForSource } from '../../src/ui/mobileTwBrowse.js';

await loadAppData();

/* ---------------------------------------------------------
   1：yearBucketOf 邊界值測試
--------------------------------------------------------- */
test('yearBucketOf：1894 -> 清領時期（<1895 上緣）', () => {
  assertEqual(yearBucketOf(1894), '清領時期', '1894 應屬清領時期');
});
test('yearBucketOf：1895 -> 日治初期（邊界起點）', () => {
  assertEqual(yearBucketOf(1895), '日治初期', '1895 應屬日治初期');
});
test('yearBucketOf：1911 -> 日治初期（邊界終點）', () => {
  assertEqual(yearBucketOf(1911), '日治初期', '1911 應屬日治初期');
});
test('yearBucketOf：1912 -> 日治中期（邊界起點）', () => {
  assertEqual(yearBucketOf(1912), '日治中期', '1912 應屬日治中期');
});
test('yearBucketOf：1926 -> 日治中期（邊界終點）', () => {
  assertEqual(yearBucketOf(1926), '日治中期', '1926 應屬日治中期');
});
test('yearBucketOf：1927 -> 日治後期（邊界起點）', () => {
  assertEqual(yearBucketOf(1927), '日治後期', '1927 應屬日治後期');
});
test('yearBucketOf：1945 -> 日治後期（邊界終點）', () => {
  assertEqual(yearBucketOf(1945), '日治後期', '1945 應屬日治後期');
});
test('yearBucketOf：1946 -> 戰後（邊界起點）', () => {
  assertEqual(yearBucketOf(1946), '戰後', '1946 應屬戰後');
});
test('yearBucketOf：1980 -> 戰後（邊界終點）', () => {
  assertEqual(yearBucketOf(1980), '戰後', '1980 應屬戰後');
});
test('yearBucketOf：1981 -> 近代（邊界起點）', () => {
  assertEqual(yearBucketOf(1981), '近代', '1981 應屬近代');
});
test('yearBucketOf：null -> 年代不明', () => {
  assertEqual(yearBucketOf(null), '年代不明', 'null 應屬年代不明');
});
test('yearBucketOf：undefined -> 年代不明', () => {
  assertEqual(yearBucketOf(undefined), '年代不明', 'undefined 應屬年代不明');
});

/* ---------------------------------------------------------
   2：YEAR_BUCKET_ORDER 順序
--------------------------------------------------------- */
test('YEAR_BUCKET_ORDER：內容與順序應為清領時期／日治初期／日治中期／日治後期／戰後／近代／年代不明', () => {
  assertEqual(
    JSON.stringify(YEAR_BUCKET_ORDER),
    JSON.stringify(['清領時期', '日治初期', '日治中期', '日治後期', '戰後', '近代', '年代不明']),
    'YEAR_BUCKET_ORDER 應該完全符合預期的 7 個字串與順序'
  );
});

/* ---------------------------------------------------------
   3：regionLabelForSource 規則測試
--------------------------------------------------------- */
function findSource(id){
  const src = LAYER_SOURCES.find(s => s.id === id);
  assertTrue(!!src, `應該要能在 LAYER_SOURCES 找到來源 ${id}`);
  return src;
}

test('regionLabelForSource：sinica -> 全國性圖資（特殊對照表）', () => {
  assertEqual(regionLabelForSource(findSource('sinica')), '全國性圖資', 'sinica 應該對應到全國性圖資');
});
test('regionLabelForSource：nlsc -> 全國性圖資（特殊對照表）', () => {
  assertEqual(regionLabelForSource(findSource('nlsc')), '全國性圖資', 'nlsc 應該對應到全國性圖資');
});
test('regionLabelForSource：thm -> 桃竹苗（特殊對照表）', () => {
  assertEqual(regionLabelForSource(findSource('thm')), '桃竹苗', 'thm 應該對應到桃竹苗');
});
test('regionLabelForSource：udd -> 臺北（特殊對照表，刻意跟 taipei 合併）', () => {
  assertEqual(regionLabelForSource(findSource('udd')), '臺北', 'udd 應該對應到臺北');
});
test('regionLabelForSource：taipei -> 臺北（去尾規則）', () => {
  assertEqual(regionLabelForSource(findSource('taipei')), '臺北', 'taipei 應該對應到臺北');
});
test('regionLabelForSource：udd 與 taipei 應合併成同一個地區標籤', () => {
  const uddLabel = regionLabelForSource(findSource('udd'));
  const taipeiLabel = regionLabelForSource(findSource('taipei'));
  assertEqual(uddLabel, taipeiLabel, 'udd 與 taipei 應該回傳完全相同的地區標籤字串');
});
test('regionLabelForSource：newtaipei -> 新北市（去尾規則）', () => {
  assertEqual(regionLabelForSource(findSource('newtaipei')), '新北市', 'newtaipei 應該對應到新北市');
});
test('regionLabelForSource：keelung -> 基隆（去尾規則）', () => {
  assertEqual(regionLabelForSource(findSource('keelung')), '基隆', 'keelung 應該對應到基隆');
});

/* ---------------------------------------------------------
   4：全站台灣來源年代分桶回歸測試
--------------------------------------------------------- */
test('全站台灣來源年代分桶：24 個 tw 來源全部圖層攤平分桶後，七桶總和應為 1900 筆（新增/移除台灣來源圖層時要同步更新這個數字）', () => {
  const twSources = LAYER_SOURCES.filter(s => s.country === 'tw');

  const counts = {};
  YEAR_BUCKET_ORDER.forEach(bucket => { counts[bucket] = 0; });

  twSources.forEach(src => {
    (src.categories || []).forEach(cat => {
      const layersArr = cat.groups ? cat.groups.flatMap(g => g.layers) : cat.layers;
      (layersArr || []).forEach(layer => {
        const bucket = yearBucketOf(layer.yearNum);
        counts[bucket] = (counts[bucket] || 0) + 1;
      });
    });
  });

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  assertEqual(total, 1900, `台灣來源（country==='tw'）全部圖層依 yearBucketOf 分桶後總和應為 1900 筆，實際 ${total} 筆（若有新增/移除台灣來源圖層，請同步更新此測試；若非預期異動，代表 src.country 判斷或攤平邏輯可能有誤）`);
});

await run();
