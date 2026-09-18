import { test, expect } from 'vitest';
import '../env-stub.mjs';
import { loadAppData, DATA, layerKey } from '../../src/data.js';
import { searchLayers, activateLayerSearchResult } from '../../src/features/layerSearch.js';
import {
  state as store, setMode, selectOverlayLayer, clearOverlayLayer,
  toggleFavoriteLayer, isFavoriteLayer, pruneFavoriteLayers,
  toggleMultiOverlayLayer, removeMultiOverlayLayer, setMultiOverlayOpacity,
  clearMultiOverlayLayers
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
  expect(searchLayers('').length, '空字串應該回傳空陣列').toBe(0);
});

test('searchLayers("   ")：只有空白字元也回傳空陣列', () => {
  expect(searchLayers('   ').length, '純空白應該回傳空陣列').toBe(0);
});

test('searchLayers("不會有任何圖層標題年份來源符合這串亂碼xyz")：完全沒命中回傳空陣列', () => {
  const result = searchLayers('不會有任何圖層標題年份來源符合這串亂碼xyz');
  expect(result.length, '完全沒命中時應該回傳空陣列').toBe(0);
});

test('searchLayers("地形圖")：標題開頭符合（rank1）排在只有包含符合（rank2）前面', () => {
  // sinica.json：JM25K_1944 標題「地形圖(航照修正版) 1:25,000」開頭就是「地形圖」；
  // JM25K_1921 標題「日治二萬五千分之一地形圖」只是「包含」，不是開頭。
  const result = searchLayers('地形圖');
  const startsWithIdx = result.findIndex(e => e.layer.id === 'JM25K_1944' && e.src.id === 'sinica');
  const containsIdx = result.findIndex(e => e.layer.id === 'JM25K_1921' && e.src.id === 'sinica');
  expect(startsWithIdx !== -1, '應該要找到標題開頭符合「地形圖」的圖層（sinica JM25K_1944）').toBeTruthy();
  expect(containsIdx !== -1, '應該要找到標題只包含「地形圖」的圖層（sinica JM25K_1921）').toBeTruthy();
  expect(startsWithIdx < containsIdx, '標題開頭符合的排序應該在只包含符合的前面').toBeTruthy();
});

test('searchLayers("堡圖")：能找到標題包含「堡圖」的圖層', () => {
  const result = searchLayers('堡圖');
  expect(result.length > 0, '應該至少找到一筆').toBeTruthy();
  const hit = result.find(e => e.src.id === 'sinica' && e.layer.id === 'JM20K_1921');
  expect(!!hit, '應該找得到 sinica「日治臺灣堡圖(大正版) 1:20,000」').toBeTruthy();
  expect(result.every(e => (e.layer.title || '').includes('堡圖')), '每一筆結果標題都應該包含「堡圖」（目前規則沒有其他欄位會用到這個關鍵字）').toBeTruthy();
});

test('searchLayers("1945")：年份符合的圖層會被找到，且標題含年份數字的排在只靠年份比對命中的前面', () => {
  // tainan.json Tainan_1945：標題「美軍航照影像(1945)」包含「1945」（不是開頭）-> rank2。
  // hsinchu.json Hsinchu_aerialphoto_1945：標題「新竹市舊航照」完全沒有「1945」字樣，
  // 只有 year/dateLabel 是 1945 -> rank3。
  const result = searchLayers('1945');
  const titleHitIdx = result.findIndex(e => e.src.id === 'tainan' && e.layer.id === 'Tainan_1945');
  const yearOnlyHitIdx = result.findIndex(e => e.src.id === 'hsinchu' && e.layer.id === 'Hsinchu_aerialphoto_1945');
  expect(titleHitIdx !== -1, '應該找到標題含「1945」的圖層（tainan Tainan_1945）').toBeTruthy();
  expect(yearOnlyHitIdx !== -1, '應該找到只有年份符合「1945」的圖層（hsinchu Hsinchu_aerialphoto_1945）').toBeTruthy();
  expect(titleHitIdx < yearOnlyHitIdx, '標題含年份數字的排序應該在只靠年份比對命中的前面').toBeTruthy();
});

test('searchLayers("嘉義百年歷史地圖")：依來源名稱搜尋，能命中該來源底下的圖層', () => {
  const chiayi = DATA.LAYER_SOURCES.find(s => s.id === 'chiayi');
  expect(chiayi.name, '確認 fixture 假設：chiayi 來源名稱').toBe('嘉義百年歷史地圖');
  const result = searchLayers('嘉義百年歷史地圖');
  expect(result.length > 0, '應該至少找到一筆').toBeTruthy();
  expect(result.every(e => e.src.id === 'chiayi'), '目前沒有任何圖層標題會包含完整來源名稱字串，命中的應該都只來自 chiayi 來源').toBeTruthy();
});

// ---------------------------------------------------------
// features/layerSearch.js — activateLayerSearchResult()
// ---------------------------------------------------------

test('activateLayerSearchResult：multi 模式下，會呼叫 toggleMultiOverlayLayer 加入疊圖組合', () => {
  reset();
  setMode('multi');
  const sinica = DATA.LAYER_SOURCES.find(s => s.id === 'sinica');
  const layer = sinica.categories[0].layers[0];
  const key = layerKey(sinica, layer);

  activateLayerSearchResult({ src: sinica, layer });
  expect(store.multiOverlayLayers.length, '應該加入一筆到 multiOverlayLayers').toBe(1);
  expect(store.multiOverlayLayers[0].key, '加入的 key 應該正確').toBe(key);

  // 再呼叫一次應該是 toggle 移除（跟 toggleMultiOverlayLayer 行為一致）
  activateLayerSearchResult({ src: sinica, layer });
  expect(store.multiOverlayLayers.length, '再次呼叫應該從疊圖組合移除').toBe(0);

  setMode('overlay');
});

test('activateLayerSearchResult：非 multi 模式下，會走 activateFromSearch（切回 overlay 模式並設定 activeOverlayKey）', () => {
  reset();
  setMode('compare');
  const sinica = DATA.LAYER_SOURCES.find(s => s.id === 'sinica');
  const layer = sinica.categories[0].layers[0];
  const key = layerKey(sinica, layer);

  activateLayerSearchResult({ src: sinica, layer });
  expect(store.mode, 'compare 模式呼叫後應該切回 overlay 模式').toBe('overlay');
  expect(store.activeOverlayKey, 'activeOverlayKey 應該設成對應的 key').toBe(key);

  setMode('overlay');
});

test('activateLayerSearchResult：時間軸模式下不會被強制切回 overlay，只更新 activeOverlayKey', () => {
  reset();
  setMode('timeline');
  const sinica = DATA.LAYER_SOURCES.find(s => s.id === 'sinica');
  const layer = sinica.categories[0].layers[0];
  const key = layerKey(sinica, layer);

  activateLayerSearchResult({ src: sinica, layer });
  expect(store.mode, '時間軸模式呼叫後應該維持在 timeline 模式，不強制切回 overlay').toBe('timeline');
  expect(store.activeOverlayKey, 'activeOverlayKey 應該設成對應的 key').toBe(key);

  setMode('overlay');
});

// ---------------------------------------------------------
// store.js — 收藏圖層 toggleFavoriteLayer／isFavoriteLayer
// ---------------------------------------------------------

test('toggleFavoriteLayer／isFavoriteLayer：加入收藏', () => {
  reset();
  const key = 'hist:sinica:JM20K_1921:jpg';
  expect(!isFavoriteLayer(key), '一開始不應該是收藏狀態').toBeTruthy();
  toggleFavoriteLayer(key);
  expect(isFavoriteLayer(key), '呼叫後應該變成收藏狀態').toBeTruthy();
  expect(store.favoriteLayers.includes(key), 'favoriteLayers 陣列應該包含這個 key').toBeTruthy();
});

test('toggleFavoriteLayer：再次呼叫會移除收藏', () => {
  reset();
  const key = 'hist:sinica:JM20K_1921:jpg';
  toggleFavoriteLayer(key);
  toggleFavoriteLayer(key);
  expect(!isFavoriteLayer(key), '再次呼叫後應該取消收藏').toBeTruthy();
  expect(store.favoriteLayers.length, 'favoriteLayers 應該是空陣列').toBe(0);
});

test('toggleFavoriteLayer：會自動寫入 localStorage（hundredYearMap:favoriteLayers）', () => {
  reset();
  const key = 'hist:sinica:JM20K_1921:jpg';
  toggleFavoriteLayer(key);
  const raw = localStorage.getItem(FAVORITE_KEY);
  expect(!!raw, '應該已經寫入 localStorage').toBeTruthy();
  const parsed = JSON.parse(raw);
  expect(Array.isArray(parsed) && parsed.includes(key), 'localStorage 內容應該跟 store 一致').toBeTruthy();
});

// ---------------------------------------------------------
// store.js — selectOverlayLayer 對 recentLayers 的 MRU 副作用
// ---------------------------------------------------------

test('selectOverlayLayer：選取歷史圖層會記錄進 recentLayers 最前面', () => {
  reset();
  const key = 'hist:sinica:JM20K_1921:jpg';
  selectOverlayLayer(key);
  expect(store.recentLayers[0], 'recentLayers 第一筆應該是剛選的 key').toBe(key);
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
  expect(store.recentLayers[0], 'A 應該回到最前面').toBe(keyA);
  expect(store.recentLayers.filter(k => k === keyA).length, 'A 不應該重複出現').toBe(1);
  expect(store.recentLayers.length, 'recentLayers 總筆數應該還是 2 筆（A、B 各一筆）').toBe(2);
});

test('selectOverlayLayer：超過 8 筆時，最舊的會被砍掉', () => {
  reset();
  // 找 9 個真實存在、fmt/id 皆不同的歷史圖層 key，逐一選取（每次先取消再選新的，
  // 避免因為兩次選同一個 key 誤觸發 toggle 關閉）。
  const flatLayers = [];
  DATA.LAYER_SOURCES.forEach(src => {
    src.categories.forEach(cat => {
      const layers = cat.groups ? cat.groups.flatMap(g => g.layers) : cat.layers;
      layers.forEach(layer => flatLayers.push(layerKey(src, layer)));
    });
  });
  const keys = flatLayers.slice(0, 9);
  expect(keys.length, '測試前提：資料裡至少要有 9 筆圖層可用').toBe(9);

  keys.forEach(k => {
    selectOverlayLayer(null);
    selectOverlayLayer(k);
  });

  expect(store.recentLayers.length, 'recentLayers 上限應該是 8 筆').toBe(8);
  expect(store.recentLayers[0], '最新選取的應該在最前面').toBe(keys[8]);
  expect(!store.recentLayers.includes(keys[0]), '最早選取、超出上限的那一筆應該被砍掉').toBeTruthy();
});

test('selectOverlayLayer：選取底圖 key（base:osm）不會記錄進 recentLayers', () => {
  reset();
  selectOverlayLayer('base:osm');
  expect(store.recentLayers.length, 'recentLayers 應該還是空的').toBe(0);
});

test('selectOverlayLayer：取消選取（同一個 key 再點一次變成 null）不會記錄進 recentLayers', () => {
  reset();
  const key = 'hist:sinica:JM20K_1921:jpg';
  selectOverlayLayer(key); // 選取 -> 記錄一筆
  expect(store.recentLayers.length, '選取後應該有一筆紀錄').toBe(1);
  selectOverlayLayer(key); // 再點一次 -> toggle 關閉，變成 null
  expect(store.activeOverlayKey, 'activeOverlayKey 應該變回 null').toBe(null);
  expect(store.recentLayers.length, '取消選取不應該再新增或改變 recentLayers 的紀錄').toBe(1);
});

test('selectOverlayLayer：會自動寫入 localStorage（hundredYearMap:recentLayers）', () => {
  reset();
  const key = 'hist:sinica:JM20K_1921:jpg';
  selectOverlayLayer(key);
  const raw = localStorage.getItem(RECENT_KEY);
  expect(!!raw, '應該已經寫入 localStorage').toBeTruthy();
  const parsed = JSON.parse(raw);
  expect(Array.isArray(parsed) && parsed[0] === key, 'localStorage 內容應該跟 store 一致').toBeTruthy();
});

// ---------------------------------------------------------
// store.js — pruneFavoriteLayers
// ---------------------------------------------------------

test('pruneFavoriteLayers：批次移除多筆收藏，只留下沒被移除的那筆', () => {
  reset();
  const keyA = 'hist:sinica:JM20K_1921:jpg';
  const keyB = 'hist:sinica:JM25K_1921:jpg';
  const keyC = 'hist:sinica:JM25K_1944:jpg';
  toggleFavoriteLayer(keyA);
  toggleFavoriteLayer(keyB);
  toggleFavoriteLayer(keyC);
  expect(store.favoriteLayers.length, '前置狀態：應該有 3 筆收藏').toBe(3);

  pruneFavoriteLayers([keyA, keyB]);
  expect(store.favoriteLayers.length, '移除 2 筆後應該只剩 1 筆').toBe(1);
  expect(store.favoriteLayers[0], '剩下的應該是沒被移除的那筆').toBe(keyC);
});

test('pruneFavoriteLayers：傳入完全不存在的 key 不會改變陣列內容也不會拋錯', () => {
  reset();
  const keyA = 'hist:sinica:JM20K_1921:jpg';
  toggleFavoriteLayer(keyA);
  const before = store.favoriteLayers;
  pruneFavoriteLayers(['hist:not:exist:jpg']);
  expect(store.favoriteLayers, '陣列引用應該不變（沒有真的移除任何東西，提早 return）').toBe(before);
  expect(store.favoriteLayers.length, '內容也應該不變').toBe(1);
});

// ---------------------------------------------------------
// store.js — toggleMultiOverlayLayer／removeMultiOverlayLayer 記住透明度
// ---------------------------------------------------------

test('toggleMultiOverlayLayer：移除再重新勾選同一個 key 會沿用上次調整過的透明度，而不是重置為 100', () => {
  reset();
  clearMultiOverlayLayers();
  const sinica = DATA.LAYER_SOURCES.find(s => s.id === 'sinica');
  const layer = sinica.categories[0].layers[0];
  const key = layerKey(sinica, layer);

  toggleMultiOverlayLayer(key); // 加入，預設 opacity 100
  setMultiOverlayOpacity(key, 42);
  toggleMultiOverlayLayer(key); // 移除
  expect(store.multiOverlayLayers.length, '移除後清單應該是空的').toBe(0);

  toggleMultiOverlayLayer(key); // 重新加入
  expect(store.multiOverlayLayers.length, '重新加入後應該有一筆').toBe(1);
  expect(store.multiOverlayLayers[0].opacity, '應該沿用移除前調整過的透明度，而不是重置為 100').toBe(42);

  clearMultiOverlayLayers();
});

test('removeMultiOverlayLayer：移除後重新用 toggleMultiOverlayLayer 加入同一個 key，同樣沿用上次的透明度', () => {
  reset();
  clearMultiOverlayLayers();
  const sinica = DATA.LAYER_SOURCES.find(s => s.id === 'sinica');
  const layer = sinica.categories[0].layers[0];
  const key = layerKey(sinica, layer);

  toggleMultiOverlayLayer(key);
  setMultiOverlayOpacity(key, 77);
  removeMultiOverlayLayer(key);
  expect(store.multiOverlayLayers.length, '移除後清單應該是空的').toBe(0);

  toggleMultiOverlayLayer(key);
  expect(store.multiOverlayLayers[0].opacity, '透過 removeMultiOverlayLayer 移除的也應該被記住').toBe(77);

  clearMultiOverlayLayers();
});

// ---------------------------------------------------------
// features/layerSearch.js — buildIndex() 快取行為
// ---------------------------------------------------------

test('searchLayers：buildIndex() 有快取，新增到 DATA.LAYER_SOURCES 的圖層在快取建立後查不到', () => {
  // 先觸發一次 searchLayers() 建立快取
  searchLayers('地形圖');

  const fakeSrc = {
    id: '__fake_cache_test_src__',
    name: '快取測試假來源',
    categories: [{
      category: '假分類',
      layers: [{ id: '__fake_layer__', title: '快取測試專用超罕見關鍵字XYZ999', type: 'hist' }]
    }]
  };
  DATA.LAYER_SOURCES.push(fakeSrc);
  try{
    const result = searchLayers('快取測試專用超罕見關鍵字xyz999');
    expect(result.length, '快取建立後才加入的圖層不應該被搜尋到，證明有快取生效').toBe(0);
  } finally {
    DATA.LAYER_SOURCES.pop();
  }
});
