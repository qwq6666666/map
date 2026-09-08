import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import { loadAppData, LAYER_SOURCES } from '../../src/data.js';
import { MACRO_REGION_ORDER, macroRegionForSource, regionLabelForSource } from '../../src/ui/mobileTwBrowse.js';

await loadAppData();

function findSource(id){
  const src = LAYER_SOURCES.find(s => s.id === id);
  assertTrue(!!src, `應該要能在 LAYER_SOURCES 找到來源 ${id}`);
  return src;
}

/* ---------------------------------------------------------
   1：MACRO_REGION_ORDER 順序
--------------------------------------------------------- */
test('MACRO_REGION_ORDER：內容與順序應為全國／北部／中部／南部／東部／離島', () => {
  assertEqual(
    JSON.stringify(MACRO_REGION_ORDER),
    JSON.stringify(['全國', '北部', '中部', '南部', '東部', '離島']),
    'MACRO_REGION_ORDER 應該完全符合預期的 6 個字串與順序'
  );
});

/* ---------------------------------------------------------
   2：macroRegionForSource 對照表測試
--------------------------------------------------------- */
test('macroRegionForSource：sinica -> 全國', () => {
  assertEqual(macroRegionForSource(findSource('sinica')), '全國', 'sinica 應該對應到全國');
});
test('macroRegionForSource：nlsc -> 全國', () => {
  assertEqual(macroRegionForSource(findSource('nlsc')), '全國', 'nlsc 應該對應到全國');
});
test('macroRegionForSource：taipei -> 北部', () => {
  assertEqual(macroRegionForSource(findSource('taipei')), '北部', 'taipei 應該對應到北部');
});
test('macroRegionForSource：thm -> 北部', () => {
  assertEqual(macroRegionForSource(findSource('thm')), '北部', 'thm 應該對應到北部');
});
test('macroRegionForSource：yilan -> 北部', () => {
  assertEqual(macroRegionForSource(findSource('yilan')), '北部', 'yilan 應該對應到北部');
});
test('macroRegionForSource：taichung -> 中部', () => {
  assertEqual(macroRegionForSource(findSource('taichung')), '中部', 'taichung 應該對應到中部');
});
test('macroRegionForSource：lukang -> 中部', () => {
  assertEqual(macroRegionForSource(findSource('lukang')), '中部', 'lukang 應該對應到中部');
});
test('macroRegionForSource：kaohsiung -> 南部', () => {
  assertEqual(macroRegionForSource(findSource('kaohsiung')), '南部', 'kaohsiung 應該對應到南部');
});
test('macroRegionForSource：hakkaliudui -> 南部', () => {
  assertEqual(macroRegionForSource(findSource('hakkaliudui')), '南部', 'hakkaliudui 應該對應到南部');
});
test('macroRegionForSource：hualien -> 東部', () => {
  assertEqual(macroRegionForSource(findSource('hualien')), '東部', 'hualien 應該對應到東部');
});
test('macroRegionForSource：kinmen -> 離島', () => {
  assertEqual(macroRegionForSource(findSource('kinmen')), '離島', 'kinmen 應該對應到離島');
});

/* ---------------------------------------------------------
   3：regionLabelForSource 規則測試（函式沒變，沿用原斷言）
--------------------------------------------------------- */
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
   4：全站台灣來源大區域分組回歸測試
--------------------------------------------------------- */
test('全站台灣來源大區域分組：24 個 tw 來源依 macroRegionForSource 分組後，各組來源數與總數應符合預期（新增/移除台灣來源時要同步更新這幾個數字）', () => {
  const twSources = LAYER_SOURCES.filter(s => s.country === 'tw');

  const counts = {};
  MACRO_REGION_ORDER.forEach(macro => { counts[macro] = 0; });
  let otherCount = 0;
  const otherIds = [];

  twSources.forEach(src => {
    const macro = macroRegionForSource(src);
    if(macro === '其他'){
      otherCount++;
      otherIds.push(src.id);
    } else {
      counts[macro] = (counts[macro] || 0) + 1;
    }
  });

  assertEqual(twSources.length, 24, `目前台灣來源（country==='tw'）總數應為 24 個，實際 ${twSources.length} 個`);

  assertEqual(counts['全國'], 2, `全國組來源數應為 2，實際 ${counts['全國']}`);
  assertEqual(counts['北部'], 9, `北部組來源數應為 9，實際 ${counts['北部']}`);
  assertEqual(counts['中部'], 4, `中部組來源數應為 4，實際 ${counts['中部']}`);
  assertEqual(counts['南部'], 5, `南部組來源數應為 5，實際 ${counts['南部']}`);
  assertEqual(counts['東部'], 2, `東部組來源數應為 2，實際 ${counts['東部']}`);
  assertEqual(counts['離島'], 2, `離島組來源數應為 2，實際 ${counts['離島']}`);

  const total = MACRO_REGION_ORDER.reduce((sum, macro) => sum + counts[macro], 0);
  assertEqual(total, 24, `六組加總應等於 tw 來源總數 24，實際 ${total}（新增/移除台灣來源時要同步更新這幾個數字）`);

  assertEqual(otherCount, 0, `不應該有任何 tw 來源被分類成「其他」，實際有 ${otherCount} 個未涵蓋：${otherIds.join(', ')}（代表 MACRO_REGION_MAP 未涵蓋目前全部 24 個 tw 來源，需同步更新）`);
});

await run();
