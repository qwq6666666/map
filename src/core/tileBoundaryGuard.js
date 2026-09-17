/* ---------------------------------------------------------
   core/tileBoundaryGuard.js — 圖磚渲染的邊界保護
   ---------------------------------------------------------
   從 core/tileLoadGuard.js 拆出的三個獨立職責之一（另外兩個是
   core/tileTimeoutRetry.js 的逾時重試、core/tileRenderPool.js 的節流
   池），只負責「這顆圖磚的涵蓋範圍跟圖層的 region.bbox 比對後，到底
   該不該送出請求」，不處理逾時／節流。組合層 core/tileLoadGuard.js
   的 createGuardedTileLoadFunction() 會在送出請求前先呼叫這裡的
   applyTileBoundaryGuard()：完全不相交就直接 tile.setState(EMPTY)，
   不建立/指定 <img src>，不發送任何網路請求；相交的話回傳
   { blocked:false, tileBbox, z, x, y }，讓呼叫端接著走逾時重試流程
   （tileBbox／z／x／y 一併算好回傳，逾時重試那邊不用重複呼叫
   tile.getTileCoord() 跟 tileXYToBbox()）。

   TILE_STATE 定義也放在這裡：雖然本質上是三個職責共用的協調常數（見
   tileLoadGuard.js 檔頭關於「跨三者協調邏輯」的說明），但 EMPTY 這個
   狀態值只有邊界保護會用到、其餘 IDLE/LOADING/LOADED/ERROR 四個逾時
   重試那邊也要用，為了避免 tileLoadGuard.js（組合層）跟
   tileTimeoutRetry.js 互相 import 對方造成循環依賴，選在這裡定義、
   由另外兩個檔案各自 import 需要的成員，tileLoadGuard.js 再原樣
   re-export，對外的 import 路徑／名稱完全不變。
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

/**
 * 載入前的邊界保護：算出這顆圖磚的涵蓋範圍，跟圖層的 regionBbox 比對，
 * 完全不相交就直接 tile.setState(EMPTY)，不建立/指定 <img src>，不
 * 發送任何網路請求。
 *
 * @param {object} tile OL 的 Tile 物件（要有 getTileCoord()／setState()）。
 * @param {[number,number,number,number]|null|undefined} regionBbox 圖層的
 *   WGS84 bbox；缺失或格式不合法時，bboxIntersects() 內建的防呆會自動
 *   回傳 true（不可排除），等於跳過邊界保護、只保留逾時保護——呼叫端
 *   不需要自己先判斷「有沒有 bbox」。
 * @returns {{ blocked: boolean, tileBbox: [number,number,number,number], z:number, x:number, y:number }}
 *   blocked===true 時已經呼叫過 tile.setState(EMPTY)，呼叫端應該直接
 *   return，不要再往下走逾時重試流程；blocked===false 時把算好的
 *   tileBbox／z／x／y 一併回傳，讓呼叫端不用重複算一次。
 */
export function applyTileBoundaryGuard(tile, regionBbox){
  // tile.getTileCoord()（OL API）回傳 [z, x, y]，跟 tileXYToBbox()
  // 的 (x, y, z) 參數順序不同，這裡要重新排列，不能直接展開傳入。
  const [z, x, y] = tile.getTileCoord();
  const tileBbox = tileXYToBbox(x, y, z);
  if(!bboxIntersects(tileBbox, regionBbox)){
    tile.setState(TILE_STATE.EMPTY);
    return { blocked: true, tileBbox, z, x, y };
  }
  return { blocked: false, tileBbox, z, x, y };
}
