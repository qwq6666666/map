/* ---------------------------------------------------------
   features/layerSearch.js — 圖資 metadata 搜尋（不碰 DOM）
   ---------------------------------------------------------
   這是「圖資搜尋」功能的核心邏輯，跟 features/search.js 的「地址
   地理編碼搜尋」是兩條完全獨立的路徑：
     - search.js：使用者輸入地址 -> 呼叫 Nominatim 地理編碼 -> 用經
       緯度對候選圖層逐筆送出圖磚請求驗證是否有資料。
     - layerSearch.js（這支）：使用者輸入關鍵字（圖層名稱／年份／
       來源／分類）-> 純文字比對已載入的 LAYER_SOURCES metadata ->
       不送出任何 WMTS／圖磚請求，也不呼叫任何地理編碼 API。

   兩者不共用輸入值、不互相觸發，只共用 data.js 的 layerKey()／
   資料結構，以及 store.js 的 selectOverlayLayer（透過 search.js 的
   activateFromSearch()）／toggleMultiOverlayLayer 這兩個既有的
   「套用圖層」動作。
--------------------------------------------------------- */
import { LAYER_SOURCES, layerKey } from '../data.js';
import { state as store, toggleMultiOverlayLayer } from '../store.js';
import { activateFromSearch } from './search.js';

// 走訪一次 LAYER_SOURCES，攤平成 { src, layer, category, group } 的陣列。
// group 沒有次分類時為 null。資料量約 1500 筆，純字串比對即可，不需要
// 快取；每次呼叫 searchLayers() 都重新走訪一次即可。
function buildIndex(){
  const index = [];
  LAYER_SOURCES.forEach(src => {
    src.categories.forEach(cat => {
      if(cat.groups){
        cat.groups.forEach(g => {
          g.layers.forEach(layer => {
            index.push({ src, layer, category: cat.category, group: g.name });
          });
        });
      } else {
        cat.layers.forEach(layer => {
          index.push({ src, layer, category: cat.category, group: null });
        });
      }
    });
  });
  return index;
}

// 依優先序規則判斷一筆索引項目是否命中 query，命中則回傳 rank（數字
// 越小越優先），沒有命中任何規則回傳 -1。
//   0. 標題完全等於 query
//   1. 標題開頭符合 query
//   2. 標題包含 query
//   3. 年份符合（yearNum 字串化 或 顯示用 year 字串）
//   4. 來源名稱符合
//   5. 分類／次分類名稱符合
//   6. 其他 metadata（type／keywords）符合
function matchRank(entry, query){
  const title = (entry.layer.title || '').toLowerCase();
  if(title === query) return 0;
  if(title.startsWith(query)) return 1;
  if(title.includes(query)) return 2;

  const yearNumStr = entry.layer.yearNum != null ? String(entry.layer.yearNum) : '';
  const yearLabel = (entry.layer.year || '').toLowerCase();
  if((yearNumStr && yearNumStr.includes(query)) || (yearLabel && yearLabel.includes(query))) return 3;

  const srcName = (entry.src.name || '').toLowerCase();
  if(srcName.includes(query)) return 4;

  const category = (entry.category || '').toLowerCase();
  const group = (entry.group || '').toLowerCase();
  if(category.includes(query) || group.includes(query)) return 5;

  const type = (entry.layer.type || '').toLowerCase();
  const keywords = entry.layer.keywords || [];
  if(type.includes(query) || keywords.some(k => (k || '').toLowerCase().includes(query))) return 6;

  return -1;
}

// 純文字比對圖層 metadata，找出符合 query 的圖層，依優先序排序後回傳
// { src, layer } 的陣列（跟 features/search.js 的 available 候選形狀
// 一致，方便共用 layerKey()／titleForKey()）。不發送任何網路請求。
export function searchLayers(query){
  const q = (query || '').trim().toLowerCase();
  if(!q) return [];

  const index = buildIndex();
  const ranked = [];
  index.forEach(entry => {
    const rank = matchRank(entry, q);
    if(rank !== -1) ranked.push({ rank, src: entry.src, layer: entry.layer });
  });
  ranked.sort((a, b) => a.rank - b.rank);
  return ranked.map(({ src, layer }) => ({ src, layer }));
}

// 套用一筆圖資搜尋結果：複合疊圖模式底下加入疊圖組合，其餘模式沿用
// 地址搜尋既有的 activateFromSearch()（會視需要先切回透明疊圖模式）。
// 不操作任何 DOM、不改變地圖中心／zoom。
export function activateLayerSearchResult(entry){
  if(store.mode === 'multi'){
    toggleMultiOverlayLayer(layerKey(entry.src, entry.layer));
    return;
  }
  activateFromSearch(entry.src, entry.layer);
}
