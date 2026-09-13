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
    loadWithTimeoutRetry(tile, src, timeoutMs);
  };
}

function loadWithTimeoutRetry(tile, src, timeoutMs){
  const img = tile.getImage();

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
    };
    img.onerror = () => {
      // 伺服器已經明確回應（不論是連線被拒絕還是 404），不是逾時，
      // 不重試——理由跟 tileChecker._probe() 完全一致。
      if(settled) return;
      settled = true;
      cleanup();
      tile.setState(TILE_STATE.ERROR);
    };
    timer = setTimeout(() => {
      if(settled) return;
      settled = true;
      cleanup();
      // 先清空 src 讓瀏覽器真的中止背景下載、釋放連線名額，之後
      // 重新指定同一個網址時瀏覽器才會真的重新發送請求（直接把
      // src 設回一模一樣的字串，部分瀏覽器不會觸發重新載入）。
      img.src = '';
      if(!isRetry) attempt(true);
      else tile.setState(TILE_STATE.ERROR);
    }, timeoutMs);
    img.src = src;
  };

  attempt(false);
}
