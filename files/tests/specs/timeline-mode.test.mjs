import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import { loadAppData, DATA } from '../../src/data.js';
import { TIMELINE_SOURCES } from '../../src/timelineMode.js';

/* ---------------------------------------------------------
   共用工具：跟 data-loading.test.mjs 同樣的作法，走一次真的
   loadAppData()（內部會 fetch('./data/layers.bundle.json') 等三份
   檔案，由 env-stub.mjs 的假 fetch 從本機檔案系統讀取），拿
   DATA.LAYER_SOURCES 轉換後的真實形狀（cat.category，不是原始
   bundle 裡的 cat.name）。timelineMode.js 的 refreshNow() 實際呼叫
   match(layer, cat.category) 時拿到的就是這個形狀，直接讀原始
   bundle.json 的 cat.name 會繞過 src/data.js 的欄位改名，測不出
   呼叫端用錯欄位名稱的 bug（已踩過一次）。
--------------------------------------------------------- */
await loadAppData();

function findSource(id){
  const src = DATA.LAYER_SOURCES.find(s => s.id === id);
  assertTrue(!!src, `應該要能在 DATA.LAYER_SOURCES 裡找到來源 ${id}`);
  return src;
}

// 攤平出 [{ layer, catName }]，比照 timelineMode.js refreshNow() 逐層遍歷的方式
// （categories -> (groups ->) layers），讓 match(layer, catName) 拿到跟正式程式
// 相同形狀的參數（catName 對應 cat.category，即 DATA.LAYER_SOURCES 轉換後的欄位）。
function flattenLayersWithCategory(src){
  const out = [];
  (src.categories || []).forEach(cat => {
    const layersArr = cat.groups ? cat.groups.flatMap(g => g.layers) : cat.layers;
    (layersArr || []).forEach(layer => out.push({ layer, catName: cat.category }));
  });
  return out;
}

function countByCategoryName(entries, catName){
  return entries.filter(e => e.catName === catName).length;
}

function filterByMode(entries, mode){
  return entries.filter(e => mode.match(e.layer, e.catName));
}

const udd = findSource('udd');
const uddEntries = flattenLayersWithCategory(udd);

const sinica = findSource('sinica');
const sinicaEntries = flattenLayersWithCategory(sinica);

/* ---------------------------------------------------------
   1：TIMELINE_SOURCES 結構基本檢查
--------------------------------------------------------- */
test('TIMELINE_SOURCES：應該同時有 sinica、udd 兩個來源設定', () => {
  assertTrue(!!TIMELINE_SOURCES.sinica, '應該有 sinica 設定');
  assertTrue(!!TIMELINE_SOURCES.udd, '應該有 udd 設定');
  assertEqual(TIMELINE_SOURCES.sinica.sourceId, 'sinica', 'sinica.sourceId 應為 sinica');
  assertEqual(TIMELINE_SOURCES.udd.sourceId, 'udd', 'udd.sourceId 應為 udd');
});

/* ---------------------------------------------------------
   2~3：udd topo／aerial 兩個 mode 的 match() 應該篩出跟分類底下
   實際圖層數一致的候選（不寫死數字，兩邊都從真實資料算出來比對）
--------------------------------------------------------- */
test('udd topo mode：match() 篩出的候選數應等於「數值地形圖（歷年版）」分類底下的圖層數', () => {
  const topoMode = TIMELINE_SOURCES.udd.modes.topo;
  const expectedCount = countByCategoryName(uddEntries, '數值地形圖（歷年版）');
  const matched = filterByMode(uddEntries, topoMode);

  assertTrue(expectedCount > 0, '「數值地形圖（歷年版）」分類底下應該至少有 1 筆圖層，資料結構可能已改動');
  assertEqual(matched.length, expectedCount, `topo mode 篩出的候選數應等於分類底下的圖層數，實際 ${matched.length} vs ${expectedCount}`);
});

test('udd aerial mode：match() 篩出的候選數應等於「航空測量影像（歷年版）」分類底下的圖層數', () => {
  const aerialMode = TIMELINE_SOURCES.udd.modes.aerial;
  const expectedCount = countByCategoryName(uddEntries, '航空測量影像（歷年版）');
  const matched = filterByMode(uddEntries, aerialMode);

  assertTrue(expectedCount > 0, '「航空測量影像（歷年版）」分類底下應該至少有 1 筆圖層，資料結構可能已改動');
  assertEqual(matched.length, expectedCount, `aerial mode 篩出的候選數應等於分類底下的圖層數，實際 ${matched.length} vs ${expectedCount}`);
});

/* ---------------------------------------------------------
   4：topo／aerial 兩組候選彼此不重疊
--------------------------------------------------------- */
test('udd topo／aerial 兩組候選彼此不重疊：沒有圖層同時符合兩個 match()', () => {
  const topoMode = TIMELINE_SOURCES.udd.modes.topo;
  const aerialMode = TIMELINE_SOURCES.udd.modes.aerial;

  const topoIds = new Set(filterByMode(uddEntries, topoMode).map(e => e.layer.id));
  const aerialIds = new Set(filterByMode(uddEntries, aerialMode).map(e => e.layer.id));

  const overlap = [...topoIds].filter(id => aerialIds.has(id));
  assertEqual(overlap.length, 0, `topo／aerial 候選不應該有重疊，實際重疊：${JSON.stringify(overlap)}`);
});

/* ---------------------------------------------------------
   5~7：sinica 既有三個 mode（25k/50k/mix）沒有因這次重構被改壞
--------------------------------------------------------- */
test('sinica 25k mode：至少篩出 1 筆候選（PLAN_A_LAYER_IDS 沒有整批消失）', () => {
  const mode25k = TIMELINE_SOURCES.sinica.modes['25k'];
  const matched = filterByMode(sinicaEntries, mode25k);
  assertTrue(matched.length > 0, `25k mode 應該至少篩出 1 筆候選，實際 ${matched.length}`);
});

test('sinica 50k mode：至少篩出 1 筆候選（PLAN_B_LAYER_IDS 沒有整批消失）', () => {
  const mode50k = TIMELINE_SOURCES.sinica.modes['50k'];
  const matched = filterByMode(sinicaEntries, mode50k);
  assertTrue(matched.length > 0, `50k mode 應該至少篩出 1 筆候選，實際 ${matched.length}`);
});

test('sinica mix mode：25k／50k 兩組 id 彼此互斥，mix 篩出的候選數應等於兩者相加', () => {
  const mode25k = TIMELINE_SOURCES.sinica.modes['25k'];
  const mode50k = TIMELINE_SOURCES.sinica.modes['50k'];
  const modeMix = TIMELINE_SOURCES.sinica.modes.mix;

  const ids25k = new Set(filterByMode(sinicaEntries, mode25k).map(e => e.layer.id));
  const ids50k = new Set(filterByMode(sinicaEntries, mode50k).map(e => e.layer.id));
  const overlap = [...ids25k].filter(id => ids50k.has(id));

  assertEqual(overlap.length, 0, `25k／50k 兩組 id 應該互斥不重疊，實際重疊：${JSON.stringify(overlap)}（若已改為有交集，請把這個斷言改成 >= 而非等於）`);

  const matchedMix = filterByMode(sinicaEntries, modeMix);
  assertEqual(matchedMix.length, ids25k.size + ids50k.size, `mix mode 篩出的候選數應等於 25k(${ids25k.size}) + 50k(${ids50k.size})，實際 ${matchedMix.length}`);
});

/* ---------------------------------------------------------
   8：每個 mode 的 label／btnLabel 都是非空字串
--------------------------------------------------------- */
test('每個來源、每個 mode 的 label／btnLabel 都是非空字串', () => {
  Object.entries(TIMELINE_SOURCES).forEach(([sourceKey, sourceConfig]) => {
    assertTrue(typeof sourceConfig.label === 'string' && sourceConfig.label.length > 0, `${sourceKey}.label 應該是非空字串`);
    Object.entries(sourceConfig.modes).forEach(([modeKey, mode]) => {
      assertTrue(typeof mode.label === 'string' && mode.label.length > 0, `${sourceKey}.modes.${modeKey}.label 應該是非空字串`);
      assertTrue(typeof mode.btnLabel === 'string' && mode.btnLabel.length > 0, `${sourceKey}.modes.${modeKey}.btnLabel 應該是非空字串`);
      assertTrue(typeof mode.match === 'function', `${sourceKey}.modes.${modeKey}.match 應該是函式`);
    });
  });
});

await run();
