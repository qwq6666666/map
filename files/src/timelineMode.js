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
--------------------------------------------------------- */
import { state as store, selectOverlayLayer } from './store.js';
import { LAYER_SOURCES, layerKey } from './data.js';
import { TileChecker } from './tileChecker.js';
import { buildTimeline } from './timelineUI.js';

const ZOOM = 15;

// 「方案 A」：只保留同一種精細地形圖系列（1:20,000 堡圖 → 1:25,000 系列，
// 含 1897 假製二十萬分一圖這兩筆作為早期起點），橫跨 1897~2003，106 年。
// 跟使用者一起從全部 86 筆裡篩出來的清單：sinica 其餘圖層內容類型混雜
//（行政區劃圖、各縣市分開的灌溉圖、三角測量點位圖等），混進同一條
// 時間軸比較不容易分辨、也拖慢探測速度，所以只留這 16 筆當預設內容。
const PLAN_A_LAYER_IDS = new Set([
  'JM200K_1897', 'JM200K_1897_new',
  'JM20K_1904', 'JM20K_1921',
  'JM25K_1921', 'JM25K_1942', 'JM25K_1944',
  'AM25K_1944A', 'AM25K_1944B',
  'TM25K_1950', 'TM25K_1955', 'TM25K_1966',
  'TM25K_1989', 'TM25K_1993', 'TM25K_2001', 'TM25K_2003'
]);

const tileChecker = new TileChecker({ concurrency: 10, timeoutMs: 6000 });

// 跟 searchUI.js 裡同一支函式邏輯相同（將經緯度換算成 Slippy Map 圖磚座標），
// 因為只有這裡跟 searchUI.js 兩處用到、彼此不互相依賴，這裡單獨保留一份，
// 避免為了共用 8 行程式碼而在兩個功能模組之間增加不必要的匯入關係。
function lonLatToTileXY(lon, lat, z){
  const n = Math.pow(2, z);
  const x = Math.floor((lon + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return {
    x: Math.max(0, Math.min(n - 1, x)),
    y: Math.max(0, Math.min(n - 1, y)),
    z
  };
}

let mapRef = null;
let containerEl = null;
let refreshBtn = null;
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

  const candidates = [];
  sinica.categories.forEach(cat => {
    const layersArr = cat.groups ? cat.groups.flatMap(g => g.layers) : cat.layers;
    layersArr.forEach(layer => {
      if(PLAN_A_LAYER_IDS.has(layer.id)) candidates.push({ src: sinica, layer });
    });
  });

  containerEl.innerHTML = '<p class="avail-empty">正在確認目前地圖畫面中心點，1:25,000 系列歷史地形圖是否有資料…</p>';

  tileChecker.checkBatch(
    candidates,
    (c) => c.src.tileUrl(c.layer).replace('{z}', tile.z).replace('{x}', tile.x).replace('{y}', tile.y),
    (checked, total) => {
      if(myToken !== refreshToken) return;
      const p = containerEl.querySelector('.avail-empty');
      if(p) p.textContent = `正在確認 ${checked} / ${total} 筆台灣百年歷史地圖是否有資料…`;
    }
  ).then(available => {
    if(myToken !== refreshToken) return; // 使用者在探測過程中又按了一次重新整理，捨棄這次結果

    if(available.length === 0){
      containerEl.innerHTML = '<p class="avail-empty">目前地圖畫面中心點附近，1:25,000 系列歷史地形圖沒有找到資料，請移動地圖到其他地方試試看。</p>';
      return;
    }

    buildTimeline(available, containerEl, (src, layer) => {
      selectOverlayLayer(layerKey(src, layer));
    });

    // 探測完成、確定這個位置真的有哪些圖層之後，把它們全部背景預先載入
    //（見 mapCore.js 的 preloadOverlayKeys）。方案 A 只有 16 筆、實際
    // 通過探測的通常更少，數量可控，直接全部預載不會太誇張，之後拖
    // 搖桿或按播放時幾乎不用再等圖磚。
    if(preloadOverlayKeysFn) preloadOverlayKeysFn(available.map(c => layerKey(c.src, c.layer)));
  });
}

/**
 * 初始化：只需要在 main.js 啟動流程裡呼叫一次。
 * 移動地圖不會自動觸發探測，只會在按鈕上標示「地圖已移動」提示；
 * 真正重新整理由使用者按「重新整理」按鈕觸發。
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
  preloadOverlayKeysFn = preloadOverlayKeysFnParam;

  refreshBtn.addEventListener('click', refreshNow);

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
