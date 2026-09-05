import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import { loadAppData, LAYER_SOURCES, layerKey } from '../../src/data.js';
import { searchLayers, activateLayerSearchResult } from '../../src/features/layerSearch.js';
import {
  state as store, setMode, selectOverlayLayer, clearOverlayLayer,
  toggleFavoriteLayer, isFavoriteLayer
} from '../../src/store.js';

await loadAppData();

const FAVORITE_KEY = 'hundredYearMap:favoriteLayers';
const RECENT_KEY = 'hundredYearMap:recentLayers';

// 這兩份清單是這次新增的功能，跟既有的 hundredYearMap:customSources 用
// 不同的 localStorage key，彼此不會互相污染；這裡只需要清自己這兩把 key，
// 並把 store 裡對應的記憶體狀態一併重設，避免前一個 test case 殘留。
function reset(){
  localStorage.removeItem(FAVORITE_KEY);
  localStorage.removeItem(RECENT_KEY);
  store.favoriteLayers = [];
  store.recentLayers = [];
  clearOverlayLayer();
  setMode('overlay');
}

// ---------------------------------------------------------
// features/layerSearch.js — searchLayers()
// ---------------------------------------------------------

test('searchLayers("")：空字串回傳空陣列', () => {
  assertEqual(searchLayers('').length, 0, '空字串應該回傳空陣列');
});

test('searchLayers("   ")：只有空白字元也回傳空陣列', () => {
  assertEqual(searchLayers('   ').length, 0, '純空白應該回傳空陣列');
});

test('searchLayers("不會有任何圖層標題年份來源符合這串亂碼xyz")：完全沒命中回傳空陣列', () => {
  const result = searchLayers('不會有任何圖層標題年份來源符合這串亂碼xyz');
  assertEqual(result.length, 0, '完全沒命中時應該回傳空陣列');
});

test('searchLayers("地形圖")：標題開頭符合（rank1）排在只有包含符合（rank2）前面', () => {
  // sinica.json：JM25K_1944 標題「地形圖(航照修正版) 1:25,000」開頭就是「地形圖」；
  // JM25K_1921 標題「日治二萬五千分之一地形圖」只是「包含」，不是開頭。
  const result = searchLayers('地形圖');
  const startsWithIdx = result.findIndex(e => e.layer.id === 'JM25K_1944' && e.src.id === 'sinica');
  const containsIdx = result.findIndex(e => e.layer.id === 'JM25K_1921' && e.src.id === 'sinica');
  assertTrue(startsWithIdx !== -1, '應該要找到標題開頭符合「地形圖」的圖層（sinica JM25K_1944）');
  assertTrue(containsIdx !== -1, '應該要找到標題只包含「地形圖」的圖層（sinica JM25K_1921）');
  assertTrue(startsWithIdx < containsIdx, '標題開頭符合的排序應該在只包含符合的前面');
});

test('searchLayers("堡圖")：能找到標題包含「堡圖」的圖層', () => {
  const result = searchLayers('堡圖');
  assertTrue(result.length > 0, '應該至少找到一筆');
  const hit = result.find(e => e.src.id === 'sinica' && e.layer.id === 'JM20K_1921');
  assertTrue(!!hit, '應該找得到 sinica「日治臺灣堡圖(大正版) 1:20,000」');
  assertTrue(result.every(e => (e.layer.title || '').includes('堡圖')), '每一筆結果標題都應該包含「堡圖」（目前規則沒有其他欄位會用到這個關鍵字）');
});

test('searchLayers("1945")：年份符合的圖層會被找到，且標題含年份數字的排在只靠年份比對命中的前面', () => {
  // tainan.json Tainan_1945：標題「美軍航照影像(1945)」包含「1945」（不是開頭）-> rank2。
  // hsinchu.json Hsinchu_aerialphoto_1945：標題「新竹市舊航照」完全沒有「1945」字樣，
  // 只有 year/dateLabel 是 1945 -> rank3。
  const result = searchLayers('1945');
  const titleHitIdx = result.findIndex(e => e.src.id === 'tainan' && e.layer.id === 'Tainan_1945');
  const yearOnlyHitIdx = result.findIndex(e => e.src.id === 'hsinchu' && e.layer.id === 'Hsinchu_aerialphoto_1945');
  assertTrue(titleHitIdx !== -1, '應該找到標題含「1945」的圖層（tainan Tainan_1945）');
  assertTrue(yearOnlyHitIdx !== -1, '應該找到只有年份符合「1945」的圖層（hsinchu Hsinchu_aerialphoto_1945）');
  assertTrue(titleHitIdx < yearOnlyHitIdx, '標題含年份數字的排序應該在只靠年份比對命中的前面');
});

test('searchLayers("嘉義百年歷史地圖")：依來源名稱搜尋，能命中該來源底下的圖層', () => {
  const chiayi = LAYER_SOURCES.find(s => s.id === 'chiayi');
  assertEqual(chiayi.name, '嘉義百年歷史地圖', '確認 fixture 假設：chiayi 來源名稱');
  const result = searchLayers('嘉義百年歷史地圖');
  assertTrue(result.length > 0, '應該至少找到一筆');
  assertTrue(result.every(e => e.src.id === 'chiayi'), '目前沒有任何圖層標題會包含完整來源名稱字串，命中的應該都只來自 chiayi 來源');
});

// ---------------------------------------------------------
// features/layerSearch.js — activateLayerSearchResult()
// ---------------------------------------------------------

test('activateLayerSearchResult：multi 模式下，會呼叫 toggleMultiOverlayLayer 加入疊圖組合', () => {
  reset();
  setMode('multi');
  const sinica = LAYER_SOURCES.find(s => s.id === 'sinica');
  const layer = sinica.categories[0].layers[0];
  const key = layerKey(sinica, layer);

  activateLayerSearchResult({ src: sinica, layer });
  assertEqual(store.multiOverlayLayers.length, 1, '應該加入一筆到 multiOverlayLayers');
  assertEqual(store.multiOverlayLayers[0].key, key, '加入的 key 應該正確');

  // 再呼叫一次應該是 toggle 移除（跟 toggleMultiOverlayLayer 行為一致）
  activateLayerSearchResult({ src: sinica, layer });
  assertEqual(store.multiOverlayLayers.length, 0, '再次呼叫應該從疊圖組合移除');

  setMode('overlay');
});

test('activateLayerSearchResult：非 multi 模式下，會走 activateFromSearch（切回 overlay 模式並設定 activeOverlayKey）', () => {
  reset();
  setMode('compare');
  const sinica = LAYER_SOURCES.find(s => s.id === 'sinica');
  const layer = sinica.categories[0].layers[0];
  const key = layerKey(sinica, layer);

  activateLayerSearchResult({ src: sinica, layer });
  assertEqual(store.mode, 'overlay', 'compare 模式呼叫後應該切回 overlay 模式');
  assertEqual(store.activeOverlayKey, key, 'activeOverlayKey 應該設成對應的 key');

  setMode('overlay');
});

// ---------------------------------------------------------
// store.js — 收藏圖層 toggleFavoriteLayer／isFavoriteLayer
// ---------------------------------------------------------

test('toggleFavoriteLayer／isFavoriteLayer：加入收藏', () => {
  reset();
  const key = 'hist:sinica:JM20K_1921:jpg';
  assertTrue(!isFavoriteLayer(key), '一開始不應該是收藏狀態');
  toggleFavoriteLayer(key);
  assertTrue(isFavoriteLayer(key), '呼叫後應該變成收藏狀態');
  assertTrue(store.favoriteLayers.includes(key), 'favoriteLayers 陣列應該包含這個 key');
});

test('toggleFavoriteLayer：再次呼叫會移除收藏', () => {
  reset();
  const key = 'hist:sinica:JM20K_1921:jpg';
  toggleFavoriteLayer(key);
  toggleFavoriteLayer(key);
  assertTrue(!isFavoriteLayer(key), '再次呼叫後應該取消收藏');
  assertEqual(store.favoriteLayers.length, 0, 'favoriteLayers 應該是空陣列');
});

test('toggleFavoriteLayer：會自動寫入 localStorage（hundredYearMap:favoriteLayers）', () => {
  reset();
  const key = 'hist:sinica:JM20K_1921:jpg';
  toggleFavoriteLayer(key);
  const raw = localStorage.getItem(FAVORITE_KEY);
  assertTrue(!!raw, '應該已經寫入 localStorage');
  const parsed = JSON.parse(raw);
  assertTrue(Array.isArray(parsed) && parsed.includes(key), 'localStorage 內容應該跟 store 一致');
});

// ---------------------------------------------------------
// store.js — selectOverlayLayer 對 recentLayers 的 MRU 副作用
// ---------------------------------------------------------

test('selectOverlayLayer：選取歷史圖層會記錄進 recentLayers 最前面', () => {
  reset();
  const key = 'hist:sinica:JM20K_1921:jpg';
  selectOverlayLayer(key);
  assertEqual(store.recentLayers[0], key, 'recentLayers 第一筆應該是剛選的 key');
});

test('selectOverlayLayer：重複選取同一個 key（先取消再選回來）不會在 recentLayers 裡重複出現，而是移到最前面', () => {
  reset();
  const keyA = 'hist:sinica:JM20K_1921:jpg';
  const keyB = 'hist:sinica:JM25K_1921:jpg';
  selectOverlayLayer(keyA); // 選 A -> recentLayers = [A]
  selectOverlayLayer(null); // 取消，確保下面不是 toggle 關閉
  selectOverlayLayer(keyB); // 選 B -> recentLayers = [B, A]
  selectOverlayLayer(null);
  selectOverlayLayer(keyA); // 再選回 A -> 應該移到最前面，而不是變成 [A, B, A]
  assertEqual(store.recentLayers[0], keyA, 'A 應該回到最前面');
  assertEqual(store.recentLayers.filter(k => k === keyA).length, 1, 'A 不應該重複出現');
  assertEqual(store.recentLayers.length, 2, 'recentLayers 總筆數應該還是 2 筆（A、B 各一筆）');
});

test('selectOverlayLayer：超過 8 筆時，最舊的會被砍掉', () => {
  reset();
  // 找 9 個真實存在、fmt/id 皆不同的歷史圖層 key，逐一選取（每次先取消再選新的，
  // 避免因為兩次選同一個 key 誤觸發 toggle 關閉）。
  const flatLayers = [];
  LAYER_SOURCES.forEach(src => {
    src.categories.forEach(cat => {
      const layers = cat.groups ? cat.groups.flatMap(g => g.layers) : cat.layers;
      layers.forEach(layer => flatLayers.push(layerKey(src, layer)));
    });
  });
  const keys = flatLayers.slice(0, 9);
  assertEqual(keys.length, 9, '測試前提：資料裡至少要有 9 筆圖層可用');

  keys.forEach(k => {
    selectOverlayLayer(null);
    selectOverlayLayer(k);
  });

  assertEqual(store.recentLayers.length, 8, 'recentLayers 上限應該是 8 筆');
  assertEqual(store.recentLayers[0], keys[8], '最新選取的應該在最前面');
  assertTrue(!store.recentLayers.includes(keys[0]), '最早選取、超出上限的那一筆應該被砍掉');
});

test('selectOverlayLayer：選取底圖 key（base:osm）不會記錄進 recentLayers', () => {
  reset();
  selectOverlayLayer('base:osm');
  assertEqual(store.recentLayers.length, 0, 'recentLayers 應該還是空的');
});

test('selectOverlayLayer：取消選取（同一個 key 再點一次變成 null）不會記錄進 recentLayers', () => {
  reset();
  const key = 'hist:sinica:JM20K_1921:jpg';
  selectOverlayLayer(key); // 選取 -> 記錄一筆
  assertEqual(store.recentLayers.length, 1, '選取後應該有一筆紀錄');
  selectOverlayLayer(key); // 再點一次 -> toggle 關閉，變成 null
  assertEqual(store.activeOverlayKey, null, 'activeOverlayKey 應該變回 null');
  assertEqual(store.recentLayers.length, 1, '取消選取不應該再新增或改變 recentLayers 的紀錄');
});

test('selectOverlayLayer：會自動寫入 localStorage（hundredYearMap:recentLayers）', () => {
  reset();
  const key = 'hist:sinica:JM20K_1921:jpg';
  selectOverlayLayer(key);
  const raw = localStorage.getItem(RECENT_KEY);
  assertTrue(!!raw, '應該已經寫入 localStorage');
  const parsed = JSON.parse(raw);
  assertTrue(Array.isArray(parsed) && parsed[0] === key, 'localStorage 內容應該跟 store 一致');
});

await run();
