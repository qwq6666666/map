import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import { loadAppData, DATA } from '../../src/data.js';
import { MACRO_REGION_ORDER, macroRegionForSource, regionLabelForSource } from '../../src/ui/mobileCnBrowse.js';

await loadAppData();

function findSource(id){
  const src = DATA.LAYER_SOURCES.find(s => s.id === id);
  assertTrue(!!src, `應該要能在 DATA.LAYER_SOURCES 找到來源 ${id}`);
  return src;
}

/* ---------------------------------------------------------
   1：MACRO_REGION_ORDER 順序
--------------------------------------------------------- */
test('MACRO_REGION_ORDER：內容與順序應為全國／華北／華東／華中／華南／西南', () => {
  assertEqual(
    JSON.stringify(MACRO_REGION_ORDER),
    JSON.stringify(['全國', '華北', '華東', '華中', '華南', '西南']),
    'MACRO_REGION_ORDER 應該完全符合預期的 6 個字串與順序'
  );
});

/* ---------------------------------------------------------
   2：macroRegionForSource 對照表測試
--------------------------------------------------------- */
test('macroRegionForSource：ccts -> 全國', () => {
  assertEqual(macroRegionForSource(findSource('ccts')), '全國', 'ccts 應該對應到全國');
});
test('macroRegionForSource：beijing -> 華北', () => {
  assertEqual(macroRegionForSource(findSource('beijing')), '華北', 'beijing 應該對應到華北');
});
test('macroRegionForSource：tianjin -> 華北', () => {
  assertEqual(macroRegionForSource(findSource('tianjin')), '華北', 'tianjin 應該對應到華北');
});
test('macroRegionForSource：shanghai -> 華東', () => {
  assertEqual(macroRegionForSource(findSource('shanghai')), '華東', 'shanghai 應該對應到華東');
});
test('macroRegionForSource：nanjing -> 華東', () => {
  assertEqual(macroRegionForSource(findSource('nanjing')), '華東', 'nanjing 應該對應到華東');
});
test('macroRegionForSource：wuhan -> 華中', () => {
  assertEqual(macroRegionForSource(findSource('wuhan')), '華中', 'wuhan 應該對應到華中');
});
test('macroRegionForSource：guangzhou -> 華南', () => {
  assertEqual(macroRegionForSource(findSource('guangzhou')), '華南', 'guangzhou 應該對應到華南');
});
test('macroRegionForSource：hongkong -> 華南', () => {
  assertEqual(macroRegionForSource(findSource('hongkong')), '華南', 'hongkong 應該對應到華南');
});
test('macroRegionForSource：kunming -> 西南', () => {
  assertEqual(macroRegionForSource(findSource('kunming')), '西南', 'kunming 應該對應到西南');
});

/* ---------------------------------------------------------
   3：regionLabelForSource 規則測試
--------------------------------------------------------- */
test('regionLabelForSource：ccts -> 全國性圖資（特殊對照表）', () => {
  assertEqual(regionLabelForSource(findSource('ccts')), '全國性圖資', 'ccts 應該對應到全國性圖資');
});
test('regionLabelForSource：shanghai -> 上海（特殊對照表，驗證去尾規則沒有誤切成「上海城市」）', () => {
  assertEqual(regionLabelForSource(findSource('shanghai')), '上海', 'shanghai 應該對應到上海，而不是被去尾規則誤切成上海城市');
});
test('regionLabelForSource：beijing -> 北京（去尾規則）', () => {
  assertEqual(regionLabelForSource(findSource('beijing')), '北京', 'beijing 應該對應到北京');
});
test('regionLabelForSource：wuhan -> 武漢（去尾規則）', () => {
  assertEqual(regionLabelForSource(findSource('wuhan')), '武漢', 'wuhan 應該對應到武漢');
});

/* ---------------------------------------------------------
   4：全站中國來源大區域分組回歸測試
--------------------------------------------------------- */
test('全站中國來源大區域分組：11 個 cn 來源依 macroRegionForSource 分組後，各組來源數與總數應符合預期（新增/移除中國來源時要同步更新這幾個數字）', () => {
  const cnSources = DATA.LAYER_SOURCES.filter(s => s.country === 'cn');

  const counts = {};
  MACRO_REGION_ORDER.forEach(macro => { counts[macro] = 0; });
  let otherCount = 0;
  const otherIds = [];

  cnSources.forEach(src => {
    const macro = macroRegionForSource(src);
    if(macro === '其他'){
      otherCount++;
      otherIds.push(src.id);
    } else {
      counts[macro] = (counts[macro] || 0) + 1;
    }
  });

  assertEqual(cnSources.length, 11, `目前中國來源（country==='cn'）總數應為 11 個，實際 ${cnSources.length} 個`);

  assertEqual(counts['全國'], 1, `全國組來源數應為 1，實際 ${counts['全國']}`);
  assertEqual(counts['華北'], 2, `華北組來源數應為 2，實際 ${counts['華北']}`);
  assertEqual(counts['華東'], 4, `華東組來源數應為 4，實際 ${counts['華東']}`);
  assertEqual(counts['華中'], 1, `華中組來源數應為 1，實際 ${counts['華中']}`);
  assertEqual(counts['華南'], 2, `華南組來源數應為 2，實際 ${counts['華南']}`);
  assertEqual(counts['西南'], 1, `西南組來源數應為 1，實際 ${counts['西南']}`);

  const total = MACRO_REGION_ORDER.reduce((sum, macro) => sum + counts[macro], 0);
  assertEqual(total, 11, `六組加總應等於 cn 來源總數 11，實際 ${total}（新增/移除中國來源時要同步更新這幾個數字）`);

  assertEqual(otherCount, 0, `不應該有任何 cn 來源被分類成「其他」，實際有 ${otherCount} 個未涵蓋：${otherIds.join(', ')}（代表 MACRO_REGION_MAP 未涵蓋目前全部 11 個 cn 來源，需同步更新）`);
});

await run();
