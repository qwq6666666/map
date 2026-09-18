import { test, expect } from 'vitest';
import '../env-stub.mjs';
import { loadAppData, DATA } from '../../src/data.js';
import { MACRO_REGION_ORDER, macroRegionForSource, regionLabelForSource, FIXED_AREA_ORDER } from '../../src/ui/mobileTwBrowse.js';
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
test('MACRO_REGION_ORDER：內容與順序應為全國／北部／中部／南部／東部／離島', () => {
  expect(
    JSON.stringify(MACRO_REGION_ORDER),
    'MACRO_REGION_ORDER 應該完全符合預期的 6 個字串與順序'
  ).toBe(JSON.stringify(['全國', '北部', '中部', '南部', '東部', '離島']));
});

/* ---------------------------------------------------------
   2：macroRegionForSource 對照表測試
--------------------------------------------------------- */
test('macroRegionForSource：sinica -> 全國', () => {
  expect(macroRegionForSource(findSource('sinica')), 'sinica 應該對應到全國').toBe('全國');
});
test('macroRegionForSource：nlsc -> 全國', () => {
  expect(macroRegionForSource(findSource('nlsc')), 'nlsc 應該對應到全國').toBe('全國');
});
test('macroRegionForSource：taipei -> 北部', () => {
  expect(macroRegionForSource(findSource('taipei')), 'taipei 應該對應到北部').toBe('北部');
});
test('macroRegionForSource：thm -> 北部', () => {
  expect(macroRegionForSource(findSource('thm')), 'thm 應該對應到北部').toBe('北部');
});
test('macroRegionForSource：yilan -> 東部', () => {
  expect(macroRegionForSource(findSource('yilan')), 'yilan 應該對應到東部').toBe('東部');
});
test('macroRegionForSource：taichung -> 中部', () => {
  expect(macroRegionForSource(findSource('taichung')), 'taichung 應該對應到中部').toBe('中部');
});
test('macroRegionForSource：lukang -> 中部', () => {
  expect(macroRegionForSource(findSource('lukang')), 'lukang 應該對應到中部').toBe('中部');
});
test('macroRegionForSource：kaohsiung -> 南部', () => {
  expect(macroRegionForSource(findSource('kaohsiung')), 'kaohsiung 應該對應到南部').toBe('南部');
});
test('macroRegionForSource：hakkaliudui -> 南部', () => {
  expect(macroRegionForSource(findSource('hakkaliudui')), 'hakkaliudui 應該對應到南部').toBe('南部');
});
test('macroRegionForSource：hualien -> 東部', () => {
  expect(macroRegionForSource(findSource('hualien')), 'hualien 應該對應到東部').toBe('東部');
});
test('macroRegionForSource：kinmen -> 離島', () => {
  expect(macroRegionForSource(findSource('kinmen')), 'kinmen 應該對應到離島').toBe('離島');
});

/* ---------------------------------------------------------
   3：regionLabelForSource 規則測試（函式沒變，沿用原斷言）
--------------------------------------------------------- */
test('regionLabelForSource：sinica -> 全國性圖資（特殊對照表）', () => {
  expect(regionLabelForSource(findSource('sinica')), 'sinica 應該對應到全國性圖資').toBe('全國性圖資');
});
test('regionLabelForSource：nlsc -> 全國性圖資（特殊對照表）', () => {
  expect(regionLabelForSource(findSource('nlsc')), 'nlsc 應該對應到全國性圖資').toBe('全國性圖資');
});
test('regionLabelForSource：thm -> 桃竹苗（特殊對照表）', () => {
  expect(regionLabelForSource(findSource('thm')), 'thm 應該對應到桃竹苗').toBe('桃竹苗');
});
test('regionLabelForSource：udd -> 臺北（特殊對照表，刻意跟 taipei 合併）', () => {
  expect(regionLabelForSource(findSource('udd')), 'udd 應該對應到臺北').toBe('臺北');
});
test('regionLabelForSource：taipei -> 臺北（去尾規則）', () => {
  expect(regionLabelForSource(findSource('taipei')), 'taipei 應該對應到臺北').toBe('臺北');
});
test('regionLabelForSource：udd 與 taipei 應合併成同一個地區標籤', () => {
  const uddLabel = regionLabelForSource(findSource('udd'));
  const taipeiLabel = regionLabelForSource(findSource('taipei'));
  expect(uddLabel, 'udd 與 taipei 應該回傳完全相同的地區標籤字串').toBe(taipeiLabel);
});
test('regionLabelForSource：newtaipei -> 新北（去尾規則）', () => {
  expect(regionLabelForSource(findSource('newtaipei')), 'newtaipei 應該對應到新北').toBe('新北');
});
test('regionLabelForSource：keelung -> 基隆（去尾規則）', () => {
  expect(regionLabelForSource(findSource('keelung')), 'keelung 應該對應到基隆').toBe('基隆');
});

/* ---------------------------------------------------------
   4：全站台灣來源大區域分組回歸測試
--------------------------------------------------------- */
test('全站台灣來源大區域分組：24 個 tw 來源依 macroRegionForSource 分組後，各組來源數與總數應符合預期（新增/移除台灣來源時要同步更新這幾個數字）', () => {
  const twSources = DATA.LAYER_SOURCES.filter(s => s.country === 'tw');

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

  expect(twSources.length, `目前台灣來源（country==='tw'）總數應為 24 個，實際 ${twSources.length} 個`).toBe(24);

  expect(counts['全國'], `全國組來源數應為 2，實際 ${counts['全國']}`).toBe(2);
  expect(counts['北部'], `北部組來源數應為 8，實際 ${counts['北部']}`).toBe(8);
  expect(counts['中部'], `中部組來源數應為 4，實際 ${counts['中部']}`).toBe(4);
  expect(counts['南部'], `南部組來源數應為 5，實際 ${counts['南部']}`).toBe(5);
  expect(counts['東部'], `東部組來源數應為 3，實際 ${counts['東部']}`).toBe(3);
  expect(counts['離島'], `離島組來源數應為 2，實際 ${counts['離島']}`).toBe(2);

  const total = MACRO_REGION_ORDER.reduce((sum, macro) => sum + counts[macro], 0);
  expect(total, `六組加總應等於 tw 來源總數 24，實際 ${total}（新增/移除台灣來源時要同步更新這幾個數字）`).toBe(24);

  expect(otherCount, `不應該有任何 tw 來源被分類成「其他」，實際有 ${otherCount} 個未涵蓋：${otherIds.join(', ')}（代表 MACRO_REGION_MAP 未涵蓋目前全部 24 個 tw 來源，需同步更新）`).toBe(0);
});

/* ---------------------------------------------------------
   5：FIXED_AREA_ORDER 與實際資料同步的回歸測試
--------------------------------------------------------- */
test('FIXED_AREA_ORDER：北部/中部/南部列出的地區標籤都要能在實際 tw 來源資料中找到（防止 name 改名後排序表沒同步更新）', () => {
  const twSources = DATA.LAYER_SOURCES.filter(s => s.country === 'tw');
  const actualLabels = new Set(twSources.map(regionLabelForSource));
  Object.entries(FIXED_AREA_ORDER).forEach(([macro, labels]) => {
    labels.forEach(label => {
      expect(actualLabels.has(label), `FIXED_AREA_ORDER['${macro}'] 裡的 '${label}' 應該要能在實際 tw 來源的 regionLabelForSource() 結果中找到，否則代表某個來源改名後這裡沒同步更新`).toBeTruthy();
    });
  });
});

/* ---------------------------------------------------------
   6：guessRegionFromLastLocation 國別碼比對回歸測試
--------------------------------------------------------- */
function setLocationResult({ display, countryCode, text }){
  const resultEl = document.getElementById('locationResult');
  const nameEl = document.getElementById('locationName');
  resultEl.style.display = display;
  resultEl.dataset.countryCode = countryCode;
  nameEl.textContent = text;
  return { resultEl, nameEl };
}

test('guessRegionFromLastLocation：countryCode 相符時，應該從候選標籤中猜出對上的地區', () => {
  setLocationResult({ display: 'block', countryCode: 'tw', text: '臺北市中山區南京東路一段' });
  const guessed = guessRegionFromLastLocation(['臺北', '新北', '基隆'], 'tw');
  expect(guessed, 'countryCode 相符時應該猜出候選標籤裡出現在文字中的那一個').toBe('臺北');
});

test('guessRegionFromLastLocation：跨國別誤判回歸測試——地址搜尋結果 countryCode 是 tw，中國分頁用 cn 去比對應該回傳 null（不能把「南京東路」誤判成中國「南京」）', () => {
  setLocationResult({ display: 'block', countryCode: 'tw', text: '臺北市中山區南京東路一段' });
  const guessed = guessRegionFromLastLocation(['南京', '上海', '北京'], 'cn');
  expect(guessed, '台灣地址搜尋結果的 countryCode 是 tw，中國分頁傳入 cn 應該比對不上、回傳 null，不能誤判成南京').toBe(null);
});

test('guessRegionFromLastLocation：沒有顯示中的搜尋結果（style.display 為 none）時，不論 countryCode 為何都應回傳 null', () => {
  setLocationResult({ display: 'none', countryCode: 'tw', text: '臺北市中山區南京東路一段' });
  expect(guessRegionFromLastLocation(['臺北', '新北'], 'tw'), 'display 為 none 時應回傳 null').toBe(null);
  expect(guessRegionFromLastLocation(['臺北', '新北'], 'cn'), 'display 為 none 時不論 countryCode 為何都應回傳 null').toBe(null);
});
