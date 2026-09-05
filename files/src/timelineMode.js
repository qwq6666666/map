/* ---------------------------------------------------------
   timelineMode.js — 時間軸模式：依「目前地圖畫面」瀏覽台灣百年歷史地圖
   ---------------------------------------------------------
   跟 searchUI.js 的「搜尋結果」時間軸不同，這裡不需要先搜尋地址，
   而是直接拿地圖目前的中心點座標，只在 sinica（台灣百年歷史地圖）
   這一個來源裡逐筆探測有沒有資料，畫成時間軸。之所以只限定 sinica，
   是因為它是全站唯一「同一種地形圖、橫跨 1895~2017 上百年、年份分布
   平均」的來源，適合做時間軸；其他來源不是內容類型混雜（水利圖／
   都市計畫圖／航照混在一起比較沒有意義），就是像 thm 那樣全部集中在
   同一年，時間軸對它們沒有幫助。

   使用共用的 TileChecker（節流＋快取）。這裡刻意不做「移動地圖就自動
   重新整理」，因為每次重新整理都要對 sinica 全部圖層發送圖磚探測，
   自由拖曳／縮放地圖時很容易觸發一長串不必要的請求。改成：移動地圖
   後只更新一個輕量的「地圖已移動」提示（純畫面狀態、不碰網路），
   真正重新探測交給使用者自己按「重新整理」按鈕決定，類似 Google 地圖
   「搜尋此區域」的做法。

   中心點那一顆圖磚沒資料時，不會直接判定「這個位置沒有這份地圖」，
   而是改測它周圍 8 顆鄰近圖磚（見 core/tileGeo.js 的 neighborTiles）；
   只要附近有資料就算這個位置有涵蓋。這是因為老地圖的實際掃描範圍常常
   不是整齊的矩形，圖幅邊界、拼接處的空白 margin 很容易剛好卡在地圖
   中心點那一顆圖磚裡，隔壁圖磚其實是有資料的——只探測單一一個點很
   容易在這種邊界情形誤判成「找不到」。
--------------------------------------------------------- */
import { state as store, selectOverlayLayer } from './store.js';
import { LAYER_SOURCES, layerKey } from './data.js';
import { TileChecker, globalTileRequestPool } from './tileChecker.js';
import { buildTimeline } from './timelineUI.js';
import { lonLatToTileXY, neighborTiles } from './core/tileGeo.js';

const ZOOM = 15;

// 「1:25,000 系列」：同一種精細地形圖，橫跨 1897~2003，106 年。
const PLAN_A_LAYER_IDS = new Set([
  'JM200K_1897', 'JM200K_1897_new',
  'JM20K_1904', 'JM20K_1921',
  'JM25K_1921', 'JM25K_1944',
  'AM25K_1944A', 'AM25K_1944B',
  'TM25K_1950', 'TM25K_1955', 'TM25K_1966',
  'TM25K_1989', 'TM25K_1993', 'TM25K_2001', 'TM25K_2003'
]);

// 「1:50,000 系列」：橫跨 1916~2003，87 年，跟 1:25,000 系列互補
//（涵蓋 1916、1920、1924、1954、1956、1990、1996 等 1:25,000 沒有資料的年份）。
const PLAN_B_LAYER_IDS = new Set([
  'JM50K_1916', 'JM50K_1920', 'JM50K_1924',
  'AM50K_1944',
  'TM50K_1954', 'TM50K_1956', 'TM50K_1990', 'TM50K_1996', 'TM50K_2003'
]);

// 三種瀏覽模式：只看 1:25,000、只看 1:50,000、或兩者合併（一樣照時間順序
// 排列，只是候選清單從其中一份變成兩份的聯集）。合併預設不開啟，因為
// 兩種精細程度的地圖混在同一條時間軸上比較，畫面差異有一部分其實是
// 「換了比例尺」造成的、不是「時間演變」造成的，容易誤導；但保留當
// 使用者自己想看年份覆蓋更密的選項。
const SCALE_MODES = {
  '25k': { ids: PLAN_A_LAYER_IDS, label: '1:25,000 系列歷史地形圖' },
  '50k': { ids: PLAN_B_LAYER_IDS, label: '1:50,000 系列歷史地形圖' },
  'mix': { ids: new Set([...PLAN_A_LAYER_IDS, ...PLAN_B_LAYER_IDS]), label: '1:25,000／1:50,000 混合系列歷史地形圖' }
};
let currentScaleMode = '25k';

// pool 明確指定共用 globalTileRequestPool，理由同 features/search.js：
// 跟搜尋流程共用同一份全域 HTTP 請求名額，避免兩邊各自的請求量疊加。
const tileChecker = new TileChecker({ concurrency: 10, timeoutMs: 6000, pool: globalTileRequestPool });

let mapRef = null;
let containerEl = null;
let refreshBtn = null;
let scaleSwitchEl = null;
let refreshToken = 0;
let lastProbedTileKey = null; // 上一次真的送出探測時，地圖中心點所在的圖磚（z/x/y）
let preloadOverlayKeysFn = null; // mapCore.js 的 preloadOverlayKeys()，由 initTimelineMode() 傳入

function currentTileKey(){
  const center3857 = mapRef.getView().getCenter();
  const [lon, lat] = ol.proj.toLonLat(center3857);
  const tile = lonLatToTileXY(lon, lat, ZOOM);
  return `${tile.z}/${tile.x}/${tile.y}`;
}

function refreshNow(){
  if(!mapRef || !containerEl) return;
  const myToken = ++refreshToken; // 讓還在跑的舊一輪探測作廢，避免畫面被過期結果蓋掉

  const center3857 = mapRef.getView().getCenter();
  const [lon, lat] = ol.proj.toLonLat(center3857);
  const tile = lonLatToTileXY(lon, lat, ZOOM);
  lastProbedTileKey = `${tile.z}/${tile.x}/${tile.y}`;
  if(refreshBtn) refreshBtn.classList.remove('stale'); // 重新整理過了，取消「地圖已移動」提示

  const sinica = LAYER_SOURCES.find(s => s.id === 'sinica');
  if(!sinica){
    containerEl.innerHTML = '<p class="avail-empty">找不到「台灣百年歷史地圖」這個來源。</p>';
    return;
  }

  const activeMode = SCALE_MODES[currentScaleMode];
  const candidates = [];
  sinica.categories.forEach(cat => {
    const layersArr = cat.groups ? cat.groups.flatMap(g => g.layers) : cat.layers;
    layersArr.forEach(layer => {
      if(activeMode.ids.has(layer.id)) candidates.push({ src: sinica, layer });
    });
  });

  containerEl.innerHTML = `<p class="avail-empty">正在確認目前地圖畫面中心點，${activeMode.label}是否有資料…</p>`;

  tileChecker.checkBatch(
    candidates,
    (c) => c.src.tileUrl(c.layer).replace('{z}', tile.z).replace('{x}', tile.x).replace('{y}', tile.y),
    (checked, total) => {
      if(myToken !== refreshToken) return;
      const p = containerEl.querySelector('.avail-empty');
      if(p) p.textContent = `正在確認 ${checked} / ${total} 筆${activeMode.label}是否有資料…`;
    }
  ).then(async available => {
    if(myToken !== refreshToken) return; // 使用者在探測過程中又切換了系列或按了重新整理，捨棄這次結果

    // 中心點那一顆圖磚沒資料的圖層，改測它周圍 8 顆鄰近圖磚（見
    // core/tileGeo.js 的說明：老地圖圖幅邊界、掃描空白 margin 常常剛好
    // 卡在地圖中心點所在的那一顆，隔壁圖磚其實是有資料的）。只對「中心點
    // 沒資料」的圖層才多做這一步，不會讓正常情況下的請求量變多。
    const availableKeys = new Set(available.map(c => layerKey(c.src, c.layer)));
    const failedDirect = candidates.filter(c => !availableKeys.has(layerKey(c.src, c.layer)));
    if(failedDirect.length > 0){
      const p = containerEl.querySelector('.avail-empty');
      if(p) p.textContent = `中心點沒有資料的 ${failedDirect.length} 筆，正在檢查鄰近位置是否有資料…`;

      const neighborHits = await tileChecker.checkBatchAny(
        failedDirect,
        (c) => neighborTiles(tile).map(t =>
          c.src.tileUrl(c.layer).replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y)
        )
      );
      if(myToken !== refreshToken) return;
      available = available.concat(neighborHits);
    }

    if(available.length === 0){
      containerEl.innerHTML = `<p class="avail-empty">目前地圖畫面中心點附近，${activeMode.label}沒有找到資料，請移動地圖到其他地方試試看。</p>`;
      return;
    }

    buildTimeline(available, containerEl, (src, layer) => {
      selectOverlayLayer(layerKey(src, layer));
    });

    // 探測完成、確定這個位置真的有哪些圖層之後，把它們全部背景預先載入
    //（見 mapCore.js 的 preloadOverlayKeys）。清單筆數不多、實際通過
    // 探測的通常更少，數量可控，直接全部預載不會太誇張，之後拖搖桿或
    // 按播放時幾乎不用再等圖磚。
    if(preloadOverlayKeysFn) preloadOverlayKeysFn(available.map(c => layerKey(c.src, c.layer)));
  });
}

/**
 * 初始化：只需要在 main.js 啟動流程裡呼叫一次。
 * 移動地圖不會自動觸發探測，只會在按鈕上標示「地圖已移動」提示；
 * 真正重新整理由使用者按「重新整理」按鈕觸發。切換 1:25,000／1:50,000／
 * 混合系列則會立即重新探測（這是使用者主動要求換內容，不是單純移動
 * 地圖，跟「移動地圖不自動重新整理」的節流原則不衝突）。
 *
 * @param {ol.Map} map
 * @param {(keys: string[]) => void} [preloadOverlayKeysFnParam]
 *   mapCore.js 的 preloadOverlayKeys()，用參數傳入而不是 import，
 *   避免 mapCore.js 已經 import 這支模組、這支模組又反過來 import
 *   mapCore.js 造成循環依賴。
 */
export function initTimelineMode(map, preloadOverlayKeysFnParam){
  mapRef = map;
  containerEl = document.getElementById('mapTimelineBarInner');
  refreshBtn = document.getElementById('mapTimelineRefreshBtn');
  scaleSwitchEl = document.getElementById('mapTimelineScaleSwitch');
  preloadOverlayKeysFn = preloadOverlayKeysFnParam;

  refreshBtn.addEventListener('click', refreshNow);

  scaleSwitchEl.addEventListener('click', (e)=>{
    const btn = e.target.closest('button[data-scale]');
    if(!btn || btn.classList.contains('active')) return;
    scaleSwitchEl.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
    currentScaleMode = btn.dataset.scale;
    refreshNow();
  });

  map.on('moveend', () => {
    if(store.mode !== 'timeline') return;
    // 純畫面狀態、不涉及任何網路請求：只是讓按鈕標示「地圖已移動」，
    // 提醒使用者目前看到的時間軸可能不是這個位置的了，實際要不要
    // 重新整理，由使用者自己決定、自己按按鈕。
    if(currentTileKey() !== lastProbedTileKey) refreshBtn.classList.add('stale');
  });
}

/** 進入時間軸模式時呼叫，立即依目前地圖畫面探測一次（不用等按按鈕）。 */
export function activateTimelineMode(){
  refreshNow();
}
