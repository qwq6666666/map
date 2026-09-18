import { test, expect } from 'vitest';
import '../env-stub.mjs';
import { loadAppData, DATA } from '../../src/data.js';
import { MACRO_REGION_ORDER, macroRegionForSource, regionLabelForSource, FIXED_AREA_ORDER } from '../../src/ui/mobileCnBrowse.js';
import { guessRegionFromLastLocation } from '../../src/ui/mobileRegionBrowse.js';

await loadAppData();

function findSource(id){
  const src = DATA.LAYER_SOURCES.find(s => s.id === id);
  expect(!!src, `應該要能在 DATA.LAYER_SOURCES 找到來源 ${id}`).toBeTruthy();
  return src;
}

/* ---------------------------------------------------------
   1：MACRO_REGION_ORDER 順序
--------------------------------------------------------- */
test('MACRO_REGION_ORDER：內容與順序應為全國／華北／華東／華中／華南／西南', () => {
  expect(
    JSON.stringify(MACRO_REGION_ORDER),
    'MACRO_REGION_ORDER 應該完全符合預期的 6 個字串與順序'
  ).toBe(JSON.stringify(['全國', '華北', '華東', '華中', '華南', '西南']));
});

/* ---------------------------------------------------------
   2：macroRegionForSource 對照表測試
--------------------------------------------------------- */
test('macroRegionForSource：ccts -> 全國', () => {
  expect(macroRegionForSource(findSource('ccts')), 'ccts 應該對應到全國').toBe('全國');
});
test('macroRegionForSource：beijing -> 華北', () => {
  expect(macroRegionForSource(findSource('beijing')), 'beijing 應該對應到華北').toBe('華北');
});
test('macroRegionForSource：tianjin -> 華北', () => {
  expect(macroRegionForSource(findSource('tianjin')), 'tianjin 應該對應到華北').toBe('華北');
});
test('macroRegionForSource：shanghai -> 華東', () => {
  expect(macroRegionForSource(findSource('shanghai')), 'shanghai 應該對應到華東').toBe('華東');
});
test('macroRegionForSource：nanjing -> 華東', () => {
  expect(macroRegionForSource(findSource('nanjing')), 'nanjing 應該對應到華東').toBe('華東');
});
test('macroRegionForSource：wuhan -> 華中', () => {
  expect(macroRegionForSource(findSource('wuhan')), 'wuhan 應該對應到華中').toBe('華中');
});
test('macroRegionForSource：guangzhou -> 華南', () => {
  expect(macroRegionForSource(findSource('guangzhou')), 'guangzhou 應該對應到華南').toBe('華南');
});
test('macroRegionForSource：hongkong -> 華南', () => {
  expect(macroRegionForSource(findSource('hongkong')), 'hongkong 應該對應到華南').toBe('華南');
});
test('macroRegionForSource：kunming -> 西南', () => {
  expect(macroRegionForSource(findSource('kunming')), 'kunming 應該對應到西南').toBe('西南');
});

/* ---------------------------------------------------------
   3：regionLabelForSource 規則測試
--------------------------------------------------------- */
test('regionLabelForSource：ccts -> 全國性圖資（特殊對照表）', () => {
  expect(regionLabelForSource(findSource('ccts')), 'ccts 應該對應到全國性圖資').toBe('全國性圖資');
});
test('regionLabelForSource：shanghai -> 上海（特殊對照表，驗證去尾規則沒有誤切成「上海城市」）', () => {
  expect(regionLabelForSource(findSource('shanghai')), 'shanghai 應該對應到上海，而不是被去尾規則誤切成上海城市').toBe('上海');
});
test('regionLabelForSource：beijing -> 北京（去尾規則）', () => {
  expect(regionLabelForSource(findSource('beijing')), 'beijing 應該對應到北京').toBe('北京');
});
test('regionLabelForSource：wuhan -> 武漢（去尾規則）', () => {
  expect(regionLabelForSource(findSource('wuhan')), 'wuhan 應該對應到武漢').toBe('武漢');
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

  expect(cnSources.length, `目前中國來源（country==='cn'）總數應為 11 個，實際 ${cnSources.length} 個`).toBe(11);

  expect(counts['全國'], `全國組來源數應為 1，實際 ${counts['全國']}`).toBe(1);
  expect(counts['華北'], `華北組來源數應為 2，實際 ${counts['華北']}`).toBe(2);
  expect(counts['華東'], `華東組來源數應為 4，實際 ${counts['華東']}`).toBe(4);
  expect(counts['華中'], `華中組來源數應為 1，實際 ${counts['華中']}`).toBe(1);
  expect(counts['華南'], `華南組來源數應為 2，實際 ${counts['華南']}`).toBe(2);
  expect(counts['西南'], `西南組來源數應為 1，實際 ${counts['西南']}`).toBe(1);

  const total = MACRO_REGION_ORDER.reduce((sum, macro) => sum + counts[macro], 0);
  expect(total, `六組加總應等於 cn 來源總數 11，實際 ${total}（新增/移除中國來源時要同步更新這幾個數字）`).toBe(11);

  expect(otherCount, `不應該有任何 cn 來源被分類成「其他」，實際有 ${otherCount} 個未涵蓋：${otherIds.join(', ')}（代表 MACRO_REGION_MAP 未涵蓋目前全部 11 個 cn 來源，需同步更新）`).toBe(0);
});

/* ---------------------------------------------------------
   5：FIXED_AREA_ORDER 與實際資料同步的回歸測試
--------------------------------------------------------- */
test('FIXED_AREA_ORDER：華北/華東/華南列出的地區標籤都要能在實際 cn 來源資料中找到（防止 name 改名後排序表沒同步更新）', () => {
  const cnSources = DATA.LAYER_SOURCES.filter(s => s.country === 'cn');
  const actualLabels = new Set(cnSources.map(regionLabelForSource));
  Object.entries(FIXED_AREA_ORDER).forEach(([macro, labels]) => {
    labels.forEach(label => {
      expect(actualLabels.has(label), `FIXED_AREA_ORDER['${macro}'] 裡的 '${label}' 應該要能在實際 cn 來源的 regionLabelForSource() 結果中找到，否則代表某個來源改名後這裡沒同步更新`).toBeTruthy();
    });
  });
});

/* ---------------------------------------------------------
   6：guessRegionFromLastLocation 跨國別誤判回歸測試（CN 情境）
--------------------------------------------------------- */
test('guessRegionFromLastLocation：地址搜尋結果是台灣（countryCode=tw），中國分頁候選標籤含「南京」時仍應回傳 null（不能把「南京東路」誤判成中國「南京」）', () => {
  const resultEl = document.getElementById('locationResult');
  const nameEl = document.getElementById('locationName');
  resultEl.style.display = 'block';
  resultEl.dataset.countryCode = 'tw';
  nameEl.textContent = '臺北市中山區南京東路一段';
  const guessed = guessRegionFromLastLocation(['南京', '上海', '北京'], 'cn');
  expect(guessed, 'countryCode 是 tw 時，中國分頁傳入 cn 應該比對不上、回傳 null').toBe(null);
});
