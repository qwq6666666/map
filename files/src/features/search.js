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
   2.5 圖層層級 bbox 篩選：對每筆候選圖層各自的 WGS84 bbox（layer.
      region.bbox，見 tileGeo.js 的 pointInBbox()）做座標範圍比對，
      確定不在圖層範圍內的候選直接排除，減少下一步要送出的圖磚請求
      數量；沒有 bbox 索引資料的圖層一律保留、不受影響。
   3. 逐筆資料驗證：候選圖層各自對該地點座標實際發送一次圖磚請求，
      只列出真的成功回傳影像的圖層。

   注意：這裡刻意不做「中心點沒資料時，改測周圍 8 顆鄰近圖磚」的補測
   （時間軸功能 timelineMode.js 仍保留這個機制，見 core/tileGeo.js 的
   neighborTiles()）。地址搜尋一次要檢查的候選圖層筆數遠比時間軸多，
   每一筆失敗都多測 8 顆圖磚，在候選數量大時會讓整體搜尋時間大幅增加；
   實測也發現「中心點沒資料」絕大多數就是真的沒資料，鄰近補測換來的
   額外命中率，換不回等待時間的成本，因此地址搜尋維持「中心點檢查 +
   必要時的文字比對 fallback」，不做鄰近補測。

   這支模組不知道 sidebar、時間軸面板長什麼樣子、也不直接操作
   任何 DOM——結果與進度都透過回傳值／回呼函式交給呼叫端
   （ui/search.js）決定要怎麼畫出來。
--------------------------------------------------------- */
import { runtime } from '../runtime.js';
import {
  LAYER_SOURCES, REGION_EXTENTS, layerKey,
  matchSourceIdsForAddress, extractPlaceKeywords, prefilterLayersByPlaceName
} from '../data.js';
import { TileChecker, globalTileRequestPool } from '../tileChecker.js';
import { state as store, setMode, selectOverlayLayer } from '../store.js';
import { lonLatToTileXY, toTWD97, formatWGS84, formatTWD97, pointInBbox } from '../core/tileGeo.js';

export const SEARCH_ZOOM = 15;

// 全站共用同一個 TileChecker 實例，才能真的發揮快取效果：使用者
// 短時間內搜尋相近地點、或重新搜尋同一個地址，只要落在同一顆
// z/x/y 圖磚上，就會直接讀到剛才探測過的結果，不用再發送 HTTP 請求。
// concurrency=10 只決定同時處理幾筆候選圖層（worker/task concurrency）；
// pool 明確指定共用 globalTileRequestPool，讓這裡跟 timelineMode.js
// 的 TileChecker 共用同一份「真正 HTTP 請求」名額，兩邊同時運作時
// 加總的併發請求數也不會超過 TILE_REQUEST_MAX_CONCURRENCY。
const tileChecker = new TileChecker({ concurrency: 10, timeoutMs: 6000, pool: globalTileRequestPool });

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

// 圖層層級的 bbox 篩選：candidates 是 { src, layer } 的陣列，只保留
// pointInBbox(lon, lat, layer.region?.bbox) 為 true 的項目——也就是
// 「沒有 bbox 索引資料」或「座標確實落在 bbox 範圍內」的候選都會保留，
// 只有「有合法 bbox、且座標確定在範圍外」的候選才會被排除。純函式，
// 不 mutate 傳入的 candidates 陣列，方便獨立測試。
export function filterCandidatesByBbox(candidates, lon, lat){
  return candidates.filter(c => pointInBbox(lon, lat, c.layer.region && c.layer.region.bbox));
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
    if(!nearby) bboxExcluded.push({ name: s.name, extent: REGION_EXTENTS[s.id] });
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
  let priority = [];
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

  // 圖層層級 bbox 篩選：priority、fallbackBySource 都套用，只排除「有
  // 合法 bbox、且這個座標確定不在範圍內」的候選，沒有 bbox 索引資料的
  // 圖層一律保留（pointInBbox 內建的 fallback 行為已經處理好這件事）。
  const priorityBeforeBbox = priority.length;
  priority = filterCandidatesByBbox(priority, lon, lat);
  let bboxFilteredCount = priorityBeforeBbox - priority.length;

  fallbackBySource.forEach((layers, srcId) => {
    const beforeCount = layers.length;
    const filtered = filterCandidatesByBbox(layers, lon, lat);
    bboxFilteredCount += beforeCount - filtered.length;
    fallbackBySource.set(srcId, filtered);
  });

  if(priority.length === 0){
    return { status: 'no-source' };
  }

  const noteParts = [];
  if(bboxExcluded.length > 0) noteParts.push(`已用座標排除 ${bboxExcluded.length} 個範圍不重疊的來源`);
  if(textFilteredSourceCount > 0) noteParts.push(`已用地址文字比對優先檢查 ${textFilteredSourceCount} 個來源的候選圖層`);
  if(bboxFilteredCount > 0) noteParts.push(`已用圖層 bbox 排除 ${bboxFilteredCount} 筆範圍不重疊的候選圖層`);
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

  return { status: 'ok', available, totalChecked };
}

// 搜尋結果可篩選的圖層類型清單，供 UI 產生篩選按鈕使用
export const SEARCH_RESULT_TYPES = ['地形圖', '地籍圖', '行政區劃圖'];

// 依類型篩選 available 陣列（{ src, layer } 的陣列），純前端過濾、不重新搜尋。
// filterType 為 null / undefined / 'all' 時代表「全部」，不過濾、原樣回傳。
export function filterAvailableByType(available, filterType){
  if(!filterType || filterType === 'all') return available;
  return available.filter(c => c.layer.type === filterType);
}

// 依年代排序 available 陣列，用 layer.yearNum（數字）排序，不使用顯示用的
// layer.year 字串。yearNum 為 null（年代不明）的項目一律排在最後面。
// direction: 'desc'（新到舊，預設）或 'asc'（舊到新）。回傳新陣列，不 mutate 傳入的陣列。
export function sortAvailableByYear(available, direction = 'desc'){
  const withYear = [];
  const withoutYear = [];
  available.forEach(c => {
    (c.layer.yearNum == null ? withoutYear : withYear).push(c);
  });
  withYear.sort((a, b) => direction === 'asc'
    ? a.layer.yearNum - b.layer.yearNum
    : b.layer.yearNum - a.layer.yearNum);
  return withYear.concat(withoutYear);
}

// 「類型」頁籤用的分組結果標籤，null／不在 SEARCH_RESULT_TYPES 裡的一律歸入這組
export const SEARCH_RESULT_TYPE_OTHER = '其他';

// 依類型把 available 陣列分組，固定回傳 4 組（SEARCH_RESULT_TYPES 三種 +
// 最後一組 SEARCH_RESULT_TYPE_OTHER），每組是 { type, items }，items 可能是
// 空陣列，是否要跳過空群組交給呼叫端 UI 決定。不 mutate 傳入的 available。
export function groupAvailableByType(available){
  const groups = SEARCH_RESULT_TYPES.map(type => ({ type, items: [] }));
  const otherGroup = { type: SEARCH_RESULT_TYPE_OTHER, items: [] };
  const groupByType = new Map(groups.map(g => [g.type, g]));
  available.forEach(c => {
    const g = groupByType.get(c.layer.type);
    (g || otherGroup).items.push(c);
  });
  groups.push(otherGroup);
  return groups;
}

// 依「年代是否已知」拆分 available 陣列，用 layer.yearNum 是否為 null 判斷，
// 邏輯跟 sortAvailableByYear 篩 null 的方式一致。known 之後可直接丟進
// sortAvailableByYear(known, direction) 排序。不 mutate 傳入的 available。
export function splitAvailableByYearKnown(available){
  const known = [];
  const unknown = [];
  available.forEach(c => {
    (c.layer.yearNum == null ? unknown : known).push(c);
  });
  return { known, unknown };
}

// 從搜尋結果點選圖層：若目前在左右比對模式，先切回透明疊圖模式，
// 再沿用跟主清單共用的 selectOverlayLayer（會一併同步兩個面板的高亮狀態）
export function activateFromSearch(src, layer){
  if(store.mode !== 'overlay') setMode('overlay');
  selectOverlayLayer(layerKey(src, layer));
}

// 座標資訊區塊（WGS84／TWD97 各一行＋一鍵複製）：純 DOM 工廠函式，不假設
// 呼叫端的版面長什麼樣子，回傳的元素可以直接 append 進搜尋結果卡片、也可以
// 塞進地圖 Pin 的 Popup，維持這支模組「不直接操作特定 DOM」的原則。
// 注意：目前 ui/search.js 尚未呼叫這支函式把區塊實際掛進畫面，需要在
// showLocationAndFindLayers()／selectGeocodeResult() 顯示結果卡片時，
// 呼叫 buildCoordInfoElement(lat, lon) 並把回傳元素 append 進 locationResultEl。
function copyCoordText(text, btn){
  const flash = () => {
    btn.classList.add('copied');
    setTimeout(()=> btn.classList.remove('copied'), 1500);
  };
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(flash).catch(()=>{});
    return;
  }
  // 非安全上下文（例如 http）navigator.clipboard 可能不存在，退回舊式做法；
  // 複製失敗就靜默略過，不影響搜尋結果本身的顯示。
  try{
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    flash();
  }catch(e){ /* 略過 */ }
}

function buildCoordRow(label, text){
  const row = document.createElement('div');
  row.className = 'coord-info-row';
  row.innerHTML = `<span class="coord-info-label">${label}</span><span class="coord-info-value">${text}</span>`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'coord-copy-btn';
  btn.textContent = '複製';
  btn.addEventListener('click', ()=> copyCoordText(text, btn));
  row.appendChild(btn);
  return row;
}

export function buildCoordInfoElement(lat, lon){
  const wrap = document.createElement('div');
  wrap.className = 'coord-info';
  wrap.appendChild(buildCoordRow('WGS84', formatWGS84(lat, lon)));
  const { x, y } = toTWD97(lat, lon);
  wrap.appendChild(buildCoordRow('TWD97', formatTWD97(x, y)));
  return wrap;
}

// 搜尋 token 相關的 runtime 讀寫集中在這裡，讓 ui/search.js 不用
// 自己 import runtime.js 也能判斷「這次搜尋是不是已經過期」。
export function bumpSearchToken(){
  return ++runtime.searchToken;
}
export function isSearchStale(token){
  return token !== runtime.searchToken;
}
