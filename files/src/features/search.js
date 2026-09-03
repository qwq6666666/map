/* ---------------------------------------------------------
   features/search.js — 搜尋流程（不碰 DOM）
   ---------------------------------------------------------
   從 searchUI.js 拆出來的「搜尋邏輯」部分：給一個經緯度＋地址
   元件，算出「這個地點目前有哪些歷史地圖圖層可套疊」。

   運作方式（細節說明沿用自原本 searchUI.js 檔頭註解）：
   1. 圖層來源篩選：依地理編碼回傳的縣市／鄉鎮名稱，先從全部 1500+
      筆歷史圖層中，篩出「地理範圍上可能相關」的圖資來源，全臺涵蓋
      的來源則一律列入候選。額外用經緯度跟每個來源的概略 bounding
      box（REGION_EXTENTS）比對，完全落在範圍外的來源可以直接跳過。
   2. 文字比對候選圖層（僅作用在有堡／庄次分類結構的來源，目前只有
      thm）：用地址元件的地名核心字跟圖層標題做子字串比對，命中的
      優先檢查，沒命中的留著當備援，確保新舊地名對不上時不會漏掉。
   3. 逐筆資料驗證：候選圖層各自對該地點座標實際發送一次圖磚請求，
      只列出真的成功回傳影像的圖層。
   4. 鄰近補測：上一步「中心點那一顆圖磚沒資料」的候選，不會直接判定
      沒有涵蓋，而是改測它周圍 8 顆鄰近圖磚（見 core/tileGeo.js），
      任一顆有資料就算這個位置有涵蓋。老地圖的實際掃描範圍常常不是
      整齊的矩形，圖幅邊界、拼接處的空白 margin 很容易剛好卡在使用者
      定位到的那個點上，只探測單一個點很容易在這種邊界情形誤判成
      「找不到」。

   這支模組不知道 sidebar、時間軸面板長什麼樣子、也不直接操作
   任何 DOM——結果與進度都透過回傳值／回呼函式交給呼叫端
   （ui/search.js）決定要怎麼畫出來。
--------------------------------------------------------- */
import { runtime } from '../runtime.js';
import {
  LAYER_SOURCES, REGION_EXTENTS, layerKey,
  matchSourceIdsForAddress, extractPlaceKeywords, prefilterLayersByPlaceName
} from '../data.js';
import { TileChecker } from '../tileChecker.js';
import { state as store, setMode, selectOverlayLayer } from '../store.js';
import { lonLatToTileXY, neighborTiles } from '../core/tileGeo.js';

export const SEARCH_ZOOM = 15;

// 全站共用同一個 TileChecker 實例，才能真的發揮快取效果：使用者
// 短時間內搜尋相近地點、或重新搜尋同一個地址，只要落在同一顆
// z/x/y 圖磚上，就會直接讀到剛才探測過的結果，不用再發送 HTTP 請求。
const tileChecker = new TileChecker({ concurrency: 10, timeoutMs: 6000 });

// 用搜尋到的經緯度，跟每個來源的概略 bounding box（REGION_EXTENTS）比對，
// 完全落在範圍外的來源可以直接跳過。這是純數學運算、沒有任何網路請求，
// 跟 matchSourceIdsForAddress()（用 Nominatim 回傳的縣市／鄉鎮文字比對）
// 互補：文字比對可能因為新舊地名對不上而漏篩，座標 bbox 則是幾何上的保險，
// 兩者同時通過才視為候選來源。
//
// EXTENT_BUFFER_DEG 是刻意保留的容許誤差：REGION_EXTENTS 只是概略行政區
// 範圍，跟實際歷史圖資邊界可能有些微落差，加一點緩衝可以避免把邊界附近、
// 其實還是有資料的來源誤判排除掉。沒有 bbox 資料的來源則保守地不排除，
// 維持「寧可多檢查、不要漏掉」的行為。
const EXTENT_BUFFER_DEG = 0.05; // 約 5 公里的容許誤差
function isPointNearExtent(lon, lat, ext){
  if(!ext) return true;
  const [minLon, minLat, maxLon, maxLat] = ext;
  return lon >= minLon - EXTENT_BUFFER_DEG && lon <= maxLon + EXTENT_BUFFER_DEG &&
         lat >= minLat - EXTENT_BUFFER_DEG && lat <= maxLat + EXTENT_BUFFER_DEG;
}

/* ---------------------------------------------------------
   核心搜尋流程：找出候選來源 → 兩階段 priority/fallback 篩選 →
   逐筆圖磚驗證。

   options.onProgress(text)：過程中可能被呼叫多次，text 是可以
   直接顯示給使用者看的進度文字；呼叫端只需要把它塞進畫面。
   options.isStale()：由呼叫端提供，用來判斷「使用者是不是已經
   開始下一次搜尋、或清除了目前的搜尋結果」——回傳 true 時這支
   函式會盡快停止，回傳的 { status: 'stale' } 不具參考價值。

   回傳其中一種：
     { status: 'no-source' }                     沒有可比對的來源
     { status: 'stale' }                          搜尋已經過期
     { status: 'ok', available, totalChecked }    正常結果（available 可能是空陣列）
--------------------------------------------------------- */
export async function findAvailableLayersAt(lon, lat, addr, { onProgress, isStale } = {}){
  const sourceIds = matchSourceIdsForAddress(addr);
  const bboxExcluded = []; // 記錄被座標 bbox 排除掉的來源名稱，僅供進度顯示參考
  const candidateSources = LAYER_SOURCES.filter(s=>{
    if(!sourceIds.includes(s.id)) return false;
    const nearby = isPointNearExtent(lon, lat, REGION_EXTENTS[s.id]);
    if(!nearby) bboxExcluded.push(s.name);
    return nearby;
  });
  const placeKeywords = extractPlaceKeywords(addr);

  // 兩階段候選名單：
  //   priority   — 優先檢查的圖層。沒有可用關鍵字、或關鍵字命中了該來源
  //                「全部」圖層的來源，直接把全部圖層放進 priority；
  //                關鍵字只命中「部分」圖層的來源，只把命中的放進 priority。
  //   fallbackBySource — 每個「靠文字比對縮小過範圍」的來源，各自剩下沒被
  //                命中的圖層。只要 priority 裡這個來源一筆有資料的都沒有，
  //                就把 fallback 名單也一起檢查，確保不會因為文字篩選誤判
  //                而漏掉圖層。
  const priority = [];
  const fallbackBySource = new Map(); // srcId -> 候選圖層陣列
  let textFilteredSourceCount = 0; // 有多少個來源是靠文字比對縮小範圍的（僅供進度顯示參考）

  candidateSources.forEach(src=>{
    const srcCandidates = [];
    src.categories.forEach(cat=>{
      const layersArr = cat.groups ? cat.groups.flatMap(g=>g.layers) : cat.layers;
      layersArr.forEach(layer => srcCandidates.push({ src, layer }));
    });

    // 只對「有堡／庄這種次分類結構」的來源做文字篩選（目前只有 thm／
    // 桃竹苗舊地籍圖）。sinica、taoyuan 這種沒有次分類、每張圖都涵蓋
    // 整個縣市或全台的來源，同一個座標很可能同時有十幾筆不同年代的
    // 地圖都有資料，文字篩選容易誤篩窄，所以一律全部檢查。
    const hasSubcategoryStructure = src.categories.some(cat => cat.groups);

    if(!hasSubcategoryStructure){
      priority.push(...srcCandidates);
      return;
    }

    const textFiltered = prefilterLayersByPlaceName(srcCandidates, placeKeywords);
    if(textFiltered && textFiltered.length < srcCandidates.length){
      // 真的有縮小範圍：命中的圖層優先檢查，沒命中的留著當備援
      textFilteredSourceCount++;
      priority.push(...textFiltered);
      const matchedIds = new Set(textFiltered.map(c => c.layer.id));
      fallbackBySource.set(src.id, srcCandidates.filter(c => !matchedIds.has(c.layer.id)));
    } else {
      // 沒有可用關鍵字、或關鍵字命中了全部圖層 -> 沒有縮小空間，全部一起檢查
      priority.push(...srcCandidates);
    }
  });

  if(priority.length === 0){
    return { status: 'no-source' };
  }

  const noteParts = [];
  if(bboxExcluded.length > 0) noteParts.push(`已用座標排除 ${bboxExcluded.length} 個範圍不重疊的來源`);
  if(textFilteredSourceCount > 0) noteParts.push(`已用地址文字比對優先檢查 ${textFilteredSourceCount} 個來源的候選圖層`);
  const filterNote = noteParts.length > 0 ? `（${noteParts.join('；')}）` : '';

  onProgress?.(`正在確認 0 / ${priority.length} 筆圖層是否有資料…${filterNote}`);

  const tile = lonLatToTileXY(lon, lat, SEARCH_ZOOM);
  const urlOf = (c) => c.src.tileUrl(c.layer).replace('{z}', tile.z).replace('{x}', tile.x).replace('{y}', tile.y);

  let available = await tileChecker.checkBatch(
    priority,
    urlOf,
    (checkedCount, total) => {
      if(!isStale?.()) onProgress?.(`正在確認 ${checkedCount} / ${total} 筆圖層是否有資料…${filterNote}`);
    }
  );

  if(isStale?.()) return { status: 'stale' };

  // 第二階段：文字比對「有」縮小範圍、但優先檢查的候選裡完全沒有找到資料的
  // 來源，很可能是新舊地名對不上導致誤篩，把該來源剩下沒檢查過的圖層也
  // 一併檢查，確保不會因為文字比對而漏掉真正有資料的圖層。
  const sourcesWithHit = new Set(available.map(c => c.src.id));
  const remainder = [];
  fallbackBySource.forEach((layers, srcId) => {
    if(!sourcesWithHit.has(srcId)) remainder.push(...layers);
  });

  let totalChecked = priority.length;
  if(remainder.length > 0){
    totalChecked += remainder.length;
    const moreAvailable = await tileChecker.checkBatch(
      remainder,
      urlOf,
      (checkedCount, total) => {
        if(!isStale?.()) onProgress?.(`地址文字比對沒有命中的候選中，正在擴大檢查 ${checkedCount} / ${total} 筆（避免新舊地名對不上而漏掉圖層）…`);
      }
    );
    if(isStale?.()) return { status: 'stale' };
    available = available.concat(moreAvailable);
  }

  // 第三階段：中心點那一顆圖磚沒資料的候選，改測它周圍 8 顆鄰近圖磚
  // （見 core/tileGeo.js 的說明：老地圖圖幅邊界、掃描空白 margin 常常
  // 剛好卡在使用者定位到的那一點，隔壁圖磚其實是有資料的）。只對「中心點
  // 沒資料」的候選才多做這一步，不會讓大多數正常情況下的請求量變多。
  const directChecked = remainder.length > 0 ? priority.concat(remainder) : priority;
  const availableKeys = new Set(available.map(c => layerKey(c.src, c.layer)));
  const failedDirect = directChecked.filter(c => !availableKeys.has(layerKey(c.src, c.layer)));

  if(failedDirect.length > 0){
    totalChecked += failedDirect.length;
    const neighborUrlsOf = (c) => neighborTiles(tile).map(t =>
      c.src.tileUrl(c.layer).replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y)
    );
    const neighborHits = await tileChecker.checkBatchAny(
      failedDirect,
      neighborUrlsOf,
      (checkedCount, total) => {
        if(!isStale?.()) onProgress?.(`中心點沒有資料的候選中，正在檢查鄰近位置 ${checkedCount} / ${total} 筆…${filterNote}`);
      }
    );
    if(isStale?.()) return { status: 'stale' };
    available = available.concat(neighborHits);
  }

  return { status: 'ok', available, totalChecked };
}

// 從搜尋結果點選圖層：若目前在左右比對模式，先切回透明疊圖模式，
// 再沿用跟主清單共用的 selectOverlayLayer（會一併同步兩個面板的高亮狀態）
export function activateFromSearch(src, layer){
  if(store.mode !== 'overlay') setMode('overlay');
  selectOverlayLayer(layerKey(src, layer));
}

// 搜尋 token 相關的 runtime 讀寫集中在這裡，讓 ui/search.js 不用
// 自己 import runtime.js 也能判斷「這次搜尋是不是已經過期」。
export function bumpSearchToken(){
  return ++runtime.searchToken;
}
export function isSearchStale(token){
  return token !== runtime.searchToken;
}
