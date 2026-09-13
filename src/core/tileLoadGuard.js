/* ---------------------------------------------------------
   core/tileLoadGuard.js — 圖磚渲染的逾時保護 + 邊界保護
   ---------------------------------------------------------
   背景：全站 32/33 個 sinica WMTS 來源的 tile URL 都是打一支 PHP
   端點 file-exists.php，伺服器對「該座標沒有歷史圖資」的圖磚回應
   可以慢達 2~3 秒（正常有資料的圖磚跟 OSM 一樣快，約 50~150ms）。
   使用者平移／縮放地圖到歷史圖層涵蓋範圍邊緣時，畫面會卡在這些慢
   請求上；瀏覽器對同一 host 的併發連線數有限，卡住的慢請求還會
   排擠同批次其他真正有資料、原本很快的圖磚。

   這裡提供的 createGuardedTileLoadFunction() 建立一個可以直接傳給
   ol.source.XYZ／ol.source.WMTS 的 tileLoadFunction，具備：
     1. 邊界保護：載入前用 tileXYToBbox() 算出這顆圖磚的涵蓋範圍，
        跟圖層的 region.bbox 用 bboxIntersects() 比對，完全不相交
        就 tile.setState(EMPTY)，不建立/指定 <img src>，不發送任何
        網路請求。
     2. 逾時保護＋重試一次：只有「逾時」（timeoutMs 內完全沒收到
        onload/onerror）才重試一次；明確的 onerror（伺服器已經回應，
        只是失敗）不重試，直接判定 ERROR。邏輯完全比照
        tileChecker.js 的 _probeWithRetry()。

   跟 tileChecker.js（TileChecker + RequestPool）刻意保持獨立、不共用
   任何狀態：那一套是「地址搜尋」背景批次探測候選圖層專用的節流閥
   （全站併發上限 8），如果拿來跟使用者正在看的地圖圖磚共用，會讓
   兩種用途互相排擠。這裡的圖磚渲染請求，併發數交給瀏覽器對同一
   host 的原生連線限制即可，不另外疊加應用層 pool。

   本檔案另外還處理兩件跟「圖磚快取」有關、彼此獨立的事：
     - DEFAULT_TILE_CACHE_SIZE：每個 tile source 的快取上限（見下方
       說明），跟這裡的逾時／邊界保護無關，只是剛好也是「圖磚載入」
       範疇，統一放在這支檔案維護。
     - attachStaleTileAbort()：讓已經送出但視角早就換過的 guarded
       請求可以提早放棄，釋放 OpenLayers 全域圖磚載入佇列的名額
       （見該函式上方的完整說明）。
--------------------------------------------------------- */
import { tileXYToBbox, bboxIntersects } from './tileGeo.js';

// OpenLayers 的 TileState 列舉沒有被匯出到全域 UMD 的 `ol` 命名空間
// （只有 ol.source／ol.layer／ol.tilegrid 等少數子命名空間可以從全域
// 拿到，ol.TileState 是 undefined——實地載入 index.html 釘住的
// ol@v9.2.4 版本驗證過），這裡自己定義同樣的數值。數值抄自該版本
// ol.js 內部的 TileState 列舉（IDLE/LOADING/LOADED/ERROR/EMPTY），
// tile.setState() 只認數值本身，不要求傳入 OL 內部那個列舉物件的
// 參照，所以功能上完全等價。
export const TILE_STATE = { IDLE: 0, LOADING: 1, LOADED: 2, ERROR: 3, EMPTY: 4 };

// 刻意比 tileChecker.js 的 timeoutMs 預設值（6000ms）短很多：那邊是
// 背景批次探測，寧可慢一點也要準；這裡是使用者正在看的地圖，目的是
// 盡快釋放瀏覽器對同一 host 的連線名額，讓排在後面、真正有資料的
// 圖磚不被卡住的慢請求排擠，所以要在「明顯不正常」就儘早放棄——
// 2000ms 略短於實測到的 file-exists.php 最慢個案（2.3~2.4 秒），
// 同時是正常圖磚 p90（約 150ms）的十幾倍，留有網路波動餘裕。
export const DEFAULT_TILE_LOAD_TIMEOUT_MS = 2000;

// 每個 tile source（ol.source.XYZ／WMTS／OSM）的圖磚快取上限。OL 的
// TileCache 建構子收到的 cacheSize 選項如果沒給（=== undefined），會
// 退回內建預設值 2048；但這幾個 tile source 建構時全部沒帶 cacheSize，
// 而 data.js／core/map.js 呼叫端傳的是 `options.cacheSize || 0`，`0`
// 不是 `undefined`，所以實際會被設成 0——OL 的 TileCache.canExpireCache()
// 要求 highWaterMark > 0 才會清舊圖磚，設成 0 等於「永遠不清」：不只
// osmLayer／satLayer 這種整個 session 只建立一次的單例會無限累積
// 已解碼的圖磚點陣圖，被 tileLoadGuard 逾時判定 ERROR 的圖磚（見上方
// loadWithTimeoutRetry()）也會永久卡住，離開視野再回來一樣是洞，不會
// 自動重試。256 顆大約是一般視窗＋平移緩衝會同時用到的圖磚數量的
// 數倍，留夠回訪不用重新打網路的空間，同時讓 LRU 過期機制真的會被
// 觸發，不會又跟 0 一樣形同虛設。
export const DEFAULT_TILE_CACHE_SIZE = 256;

/**
 * 建立一個符合 OpenLayers tileLoadFunction 簽名（(tile, src) => void）
 * 的圖磚載入函式，具備邊界保護與逾時＋重試一次的保護。
 *
 * @param {object} [options]
 * @param {[number,number,number,number]|null} [options.regionBbox] 圖層的
 *   WGS84 bbox；缺失或格式不合法時，bboxIntersects() 內建的防呆會自動
 *   回傳 true（不可排除），等於跳過邊界保護、只保留逾時保護——呼叫端
 *   不需要自己先判斷「有沒有 bbox」。
 * @param {number} [options.timeoutMs] 逾時毫秒數，預設 DEFAULT_TILE_LOAD_TIMEOUT_MS。
 * @returns {function(tile, string): void}
 */
export function createGuardedTileLoadFunction({ regionBbox, timeoutMs = DEFAULT_TILE_LOAD_TIMEOUT_MS } = {}){
  return function guardedTileLoadFunction(tile, src){
    // tile.getTileCoord()（OL API）回傳 [z, x, y]，跟 tileXYToBbox()
    // 的 (x, y, z) 參數順序不同，這裡要重新排列，不能直接展開傳入。
    const [z, x, y] = tile.getTileCoord();
    const tileBbox = tileXYToBbox(x, y, z);
    if(!bboxIntersects(tileBbox, regionBbox)){
      tile.setState(TILE_STATE.EMPTY);
      return;
    }
    loadWithTimeoutRetry(tile, src, timeoutMs, tileBbox, z);
  };
}

// 目前所有「已經送出 <img src>、還沒 resolve」的 guarded 請求，供
// attachStaleTileAbort() 掃描；每個 entry 是 { bbox, z, abort }。只有
// 真正發送了網路請求的圖磚才會在這裡登記——被邊界保護擋下、直接
// EMPTY 的圖磚從來不會進來，本來就沒有佔用載入名額，不需要放棄。
const inFlightGuardedTiles = new Set();

function loadWithTimeoutRetry(tile, src, timeoutMs, tileBbox, z){
  const img = tile.getImage();

  // attempt() 執行到底（不論成功、失敗、逾時判定 ERROR）都會呼叫這個
  // 把自己從 registry 移除；attempt(true) 重試時沿用同一筆 registry
  // entry（只是換掉 entry.abort 指向新的一次嘗試），不會重複註冊。
  const entry = { bbox: tileBbox, z, abort: null };
  inFlightGuardedTiles.add(entry);
  const unregister = () => inFlightGuardedTiles.delete(entry);

  const attempt = (isRetry) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
    };
    img.onload = () => {
      if(settled) return;
      settled = true;
      cleanup();
      tile.setState(TILE_STATE.LOADED);
      unregister();
    };
    img.onerror = () => {
      // 伺服器已經明確回應（不論是連線被拒絕還是 404），不是逾時，
      // 不重試——理由跟 tileChecker._probe() 完全一致。
      if(settled) return;
      settled = true;
      cleanup();
      tile.setState(TILE_STATE.ERROR);
      unregister();
    };
    timer = setTimeout(() => {
      if(settled) return;
      settled = true;
      cleanup();
      // 先清空 src 讓瀏覽器真的中止背景下載、釋放連線名額，之後
      // 重新指定同一個網址時瀏覽器才會真的重新發送請求（直接把
      // src 設回一模一樣的字串，部分瀏覽器不會觸發重新載入）。
      img.src = '';
      if(!isRetry){ attempt(true); return; }
      tile.setState(TILE_STATE.ERROR);
      unregister();
    }, timeoutMs);
    // 供 attachStaleTileAbort() 呼叫：視角已經換過、這顆圖磚不再相關時
    // 提早放棄，邏輯跟上面的逾時分支共用（同樣清 src、判 ERROR、釋放
    // 名額），差別只在於不會像逾時那樣再重試一次——都已經確定不相關
    // 了，重試也沒有意義。
    entry.abort = () => {
      if(settled) return;
      settled = true;
      cleanup();
      img.src = '';
      tile.setState(TILE_STATE.ERROR);
      unregister();
    };
    img.src = src;
  };

  attempt(false);
}

/* ---------------------------------------------------------
   attachStaleTileAbort() — 視角過期請求主動放棄
   ---------------------------------------------------------
   背景：OpenLayers 每個 Map 共用同一份全域圖磚載入佇列，不分底圖／
   歷史圖層，同一時間全站最多只有 16 顆圖磚可以處於「LOADING」狀態
   （ol.js 內部 renderer 固定呼叫 tileQueue_.loadMoreTiles(16, 16)，
   已實地反解 ol@9.2.4 dist 確認）；一顆圖磚要真正 resolve（LOADED／
   ERROR／EMPTY）才會釋放這個名額。OL 自己的佇列機制（reprioritize()）
   只會丟棄「還沒送出請求、仍在排隊」的項目——圖磚一旦送出
   <img src>，就只能等它自然 resolve，或等 loadWithTimeoutRetry() 的
   逾時（最差近 4 秒：2000ms 逾時 + 重試一次再 2000ms）。

   快速縮放／拉動／混合操作時，短時間內會連續切換好幾個視角，每個
   視角都會送出一批圖磚請求；使用者早就看不到上一個視角了，那批
   請求卻還占著上面說的 16 個名額，連 OSM 底圖自己要載入新圖磚都要
   排隊等（同一個 Map、同一份佇列，不分底圖／疊圖）——這裡讓
   tileLoadGuard 在「視角剛安定下來」的那一刻，主動掃過所有還在等待
   中的 guarded 請求，凡是縮放層級對不上目前視角、或圖磚涵蓋範圍已經
   不跟目前可視範圍相交，就直接放棄（見上面 entry.abort），不用乾等
   逾時，讓名額更快釋放給真正當下需要的圖磚。

   掛在 map.on('moveend', ...)，不是 'movestart'：movestart 觸發的
   當下，view 的 center／resolution 都還是「這次操作開始前」的舊值
   （新視角還沒算出來），這時候掃描只會拿舊視角比對舊請求，兩者本來
   就相符，永遠掃不出過期項目。要等 moveend（這次操作／動畫已經安定
   到新視角）才拿得到正確的比對基準，時機上也剛好搭配 OL 本來就會在
   這個時間點開始為新視角送出下一批圖磚請求。也不掛在 view 的
   change:center／change:resolution——那兩個事件在拖曳/縮放動畫進行
   中會連續觸發，掛上去等於每個影格都在掃描，得不償失。

   只需要在 core/map.js 建立完 map 之後呼叫一次；map 是整頁生命週期
   唯一的一個實例，不需要另外清理這個監聽器。

   注意：這裡只會中止「歷史圖層／自訂圖層」透過
   createGuardedTileLoadFunction() 建立的請求——OSM／衛星底圖沒有套用
   這支 tileLoadFunction，本身不在這個機制的管轄範圍內，但一樣會因為
   名額被更快釋放而受益。
--------------------------------------------------------- */
export function attachStaleTileAbort(map){
  map.on('moveend', () => {
    if(inFlightGuardedTiles.size === 0) return;
    const view = map.getView();
    const size = map.getSize();
    const resolution = view.getResolution();
    const center = view.getCenter();
    if(!size || resolution == null || !center) return;
    const currentZ = Math.round(view.getZoom());
    const extent3857 = view.calculateExtent(size);
    const extent4326 = ol.proj.transformExtent(extent3857, view.getProjection(), 'EPSG:4326');
    inFlightGuardedTiles.forEach(entry => {
      if(entry.z !== currentZ || !bboxIntersects(entry.bbox, extent4326)) entry.abort();
    });
  });
}
