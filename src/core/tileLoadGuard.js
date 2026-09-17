/* ---------------------------------------------------------
   core/tileLoadGuard.js — 圖磚渲染的逾時保護 + 邊界保護 + 節流（組合層）
   ---------------------------------------------------------
   背景：全站 32/33 個 sinica WMTS 來源的 tile URL 都是打一支 PHP
   端點 file-exists.php，伺服器對「該座標沒有歷史圖資」的圖磚回應
   可以慢達 2~3 秒（正常有資料的圖磚跟 OSM 一樣快，約 50~150ms）；
   實測更發現高併發下即使是「有資料」的正常圖磚，回應也會被拖慢到
   ~1 秒量級（不是只有「無資料」才慢）。使用者拖曳／縮放地圖到歷史
   圖層涵蓋範圍邊緣、或疊加歷史圖層時連續改變視角，都會讓這些慢
   請求佔滿 OL 全域圖磚佇列的名額（見下方 attachStaleTileAbort()
   說明），排擠同批次其他真正有資料、原本很快的圖磚，甚至連底圖
   自己要載入新圖磚都要排隊等。

   這裡提供的 createGuardedTileLoadFunction() 建立一個可以直接傳給
   ol.source.XYZ／ol.source.WMTS 的 tileLoadFunction，是三個彼此獨立
   職責的組合層，各自拆到獨立檔案維護：
     1. 邊界保護：core/tileBoundaryGuard.js 的 applyTileBoundaryGuard()。
        載入前用 tileXYToBbox() 算出這顆圖磚的涵蓋範圍，跟圖層的
        region.bbox 用 bboxIntersects() 比對，完全不相交就
        tile.setState(EMPTY)，不建立/指定 <img src>，不發送任何網路
        請求。
     2. 逾時保護＋重試一次：core/tileTimeoutRetry.js 的
        loadWithTimeoutRetry()。只有「逾時」（timeoutMs 內完全沒收到
        onload/onerror）才重試一次；明確的 onerror（伺服器已經回應，
        只是失敗）不重試，直接判定 ERROR。邏輯完全比照
        tileChecker.js 的 _probeWithRetry()。
     3. 節流：core/tileRenderPool.js 的 tileRenderRequestPool。真正
        送出 <img src> 前要先跟它要一個 slot（設計理由見該檔案），
        限制「歷史／自訂圖層同時真正在進行中的圖磚請求數」不超過
        TILE_RENDER_MAX_CONCURRENCY，避免這些慢請求把 OL 全域 16 個
        LOADING 名額吃光、連底圖都要排隊。

   跟 tileChecker.js（TileChecker + RequestPool／globalTileRequestPool）
   刻意保持獨立、不共用任何狀態：那一套是「地址搜尋」背景批次探測
   候選圖層專用的節流閥（全站併發上限 8），如果拿來跟使用者正在看的
   地圖圖磚共用，會讓兩種用途互相排擠（詳見 core/tileRenderPool.js
   檔頭關於 TileRenderPool 為何不直接沿用 RequestPool 的說明）。

   本檔案是「組合層」：import 上述三個獨立模組，組出
   createGuardedTileLoadFunction()（一律包在 tileRenderRequestPool.run()
   裡才送出請求，逾時走 tileTimeoutRetry.js 的邏輯，送出前先過
   tileBoundaryGuard.js 的邊界保護），並保留三者都要用到、或需要跨三者
   協調視角資訊的邏輯：
     - TILE_STATE：實際定義搬到 core/tileBoundaryGuard.js（避免這裡跟
       tileTimeoutRetry.js 互相 import 造成循環依賴），這裡原樣
       re-export，對外的 import 路徑／名稱不變。
     - DEFAULT_TILE_CACHE_SIZE：每個 tile source 的快取上限（見下方
       說明），跟逾時／邊界保護本身無關，只是剛好也是「圖磚載入」
       範疇，統一放在這支檔案維護。
     - attachStaleTileAbort()：讓已經送出但視角早就換過的 guarded
       請求可以提早放棄，釋放 OpenLayers 全域圖磚載入佇列的名額；
       連續拖曳／縮放互動期間也會用節流過的頻率主動清理一次，不用
       等放開滑鼠的 moveend 才清（見該函式上方的完整說明）。同一次
       掃描也處理 core/tileTimeoutRetry.js 的逾時終局失敗冷卻重試
       （timeoutFailedGuardedTiles，見該檔案裡的完整說明）。
     - abortInFlightForKey()：供 core/layerCache.js 在圖層被淘汰／
       移除時，主動中止該 key 底下還在進行中的 guarded 請求與冷卻
       重試候選。
     - throttle()：通用 leading+trailing 節流器，拖曳／縮放互動進行中
       節流版清理會用到。
--------------------------------------------------------- */
import { bboxIntersects } from './tileGeo.js';
import { TILE_STATE, applyTileBoundaryGuard } from './tileBoundaryGuard.js';
import {
  DEFAULT_TILE_LOAD_TIMEOUT_MS,
  loadWithTimeoutRetry,
  inFlightGuardedTiles,
  timeoutFailedGuardedTiles,
  getRecentTileFailures,
  clearRecentTileFailures,
  RECENT_TILE_FAILURE_LIMIT,
  TIMEOUT_RETRY_COOLDOWN_MS,
} from './tileTimeoutRetry.js';
import { tileRenderRequestPool, TILE_RENDER_MAX_CONCURRENCY } from './tileRenderPool.js';

// 原樣 re-export，維持這支檔案作為對外唯一入口，消費端
// （data.js／core/map.js／core/layerCache.js／ui/sourceStatusUI.js／
// 測試檔）的 import 路徑與名稱完全不變。
export { TILE_STATE };
export { DEFAULT_TILE_LOAD_TIMEOUT_MS, getRecentTileFailures, clearRecentTileFailures, RECENT_TILE_FAILURE_LIMIT, TIMEOUT_RETRY_COOLDOWN_MS };
export { tileRenderRequestPool, TILE_RENDER_MAX_CONCURRENCY };

// 每個 tile source（ol.source.XYZ／WMTS／OSM）的圖磚快取上限。OL 的
// TileCache 建構子收到的 cacheSize 選項如果沒給（=== undefined），會
// 退回內建預設值 2048；但這幾個 tile source 建構時全部沒帶 cacheSize，
// 而 data.js／core/map.js 呼叫端傳的是 `options.cacheSize || 0`，`0`
// 不是 `undefined`，所以實際會被設成 0——OL 的 TileCache.canExpireCache()
// 要求 highWaterMark > 0 才會清舊圖磚，設成 0 等於「永遠不清」：不只
// osmLayer／satLayer 這種整個 session 只建立一次的單例會無限累積
// 已解碼的圖磚點陣圖，被 tileLoadGuard 逾時判定 ERROR 的圖磚（見
// core/tileTimeoutRetry.js 的 loadWithTimeoutRetry()）也會永久卡住，
// 離開視野再回來一樣是洞，不會自動重試。256 顆大約是一般視窗＋平移
// 緩衝會同時用到的圖磚數量的數倍，留夠回訪不用重新打網路的空間，
// 同時讓 LRU 過期機制真的會被觸發，不會又跟 0 一樣形同虛設。
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
 * @param {string} [options.label] 供失敗紀錄顯示用的人類可讀圖層名稱
 *   （例如「台灣百年歷史地圖／日治臺灣堡圖」），不影響載入邏輯本身。
 * @param {string} [options.sourceKey] core/layerCache.js 用的圖層 key
 *   （例如 "custom:xxx"、"hist:sinica:JM25K_1921:jpg"）。只用來讓
 *   abortInFlightForKey() 能在 layerCache 淘汰／移除這個 key 時，找到
 *   哪些還在 inFlightGuardedTiles 裡的請求屬於它，不影響載入邏輯本身。
 * @returns {function(tile, string): void}
 */
export function createGuardedTileLoadFunction({ regionBbox, timeoutMs = DEFAULT_TILE_LOAD_TIMEOUT_MS, label, sourceKey } = {}){
  return function guardedTileLoadFunction(tile, src){
    const { blocked, tileBbox, z, x, y } = applyTileBoundaryGuard(tile, regionBbox);
    if(blocked) return;
    loadWithTimeoutRetry(tile, src, timeoutMs, tileBbox, z, x, y, label, sourceKey);
  };
}

// 供 core/layerCache.js 在 removeCachedLayer()／evictIfNeeded()／
// clearCache() 真的把某個 key 的圖層從地圖上移除前呼叫：那幾支函式
// 只會 map.removeLayer() 並把 entry 從 cache 刪掉，不會主動中止這個
// key 底下還在 tileRenderRequestPool 排隊或已經送出 <img src> 的
// guarded 請求——這些請求會繼續佔用 slot 直到自然 resolve 或最差等滿
// ~4 秒逾時，而 attachStaleTileAbort() 只比對「視角」，圖層被淘汰當下
// 使用者通常還停留在附近（正是因為還在看才會觸發 LRU），不會被判定
// stale。用跟 attachStaleTileAbort() 一樣的 { stale: true } 語意呼叫
// entry.abort()：圖層物件本身接下來就要被丟棄，重置成 IDLE 或維持
// ERROR 對已經沒人參照的 Tile 物件沒有差別，重用既有邏輯不用另外開一條
// 分支。
// 一併清掉 timeoutFailedGuardedTiles（core/tileTimeoutRetry.js 的逾時
// 終局失敗冷卻重試候選名單，見該檔案內的完整說明）裡屬於這個 key 的
// entry：圖層已經被移除，這些 entry 手上的 Tile 物件不會再被 OL 的
// renderer 用到，繼續留著只是佔用全域 Set 的名額，且之後
// sweepStaleGuardedTiles() 對它們呼叫 tile.setState(IDLE) 也毫無意義
// （沒有任何圖層/地圖參照它們）。
export function abortInFlightForKey(key){
  if(!key) return;
  inFlightGuardedTiles.forEach(entry => {
    if(entry.sourceKey === key) entry.abort({ stale: true });
  });
  timeoutFailedGuardedTiles.forEach(entry => {
    if(entry.sourceKey === key) timeoutFailedGuardedTiles.delete(entry);
  });
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
   <img src>，就只能等它自然 resolve，或等 core/tileTimeoutRetry.js
   的 loadWithTimeoutRetry() 逾時（最差近 4 秒：2000ms 逾時 + 重試
   一次再 2000ms）。

   快速縮放／拉動／混合操作時，短時間內會連續切換好幾個視角，每個
   視角都會送出一批圖磚請求；使用者早就看不到上一個視角了，那批
   請求卻還占著上面說的 16 個名額，連 OSM 底圖自己要載入新圖磚都要
   排隊等（同一個 Map、同一份佇列，不分底圖／疊圖）——這裡讓
   tileLoadGuard 在「視角剛安定下來」的那一刻，主動掃過所有還在等待
   中的 guarded 請求，凡是縮放層級對不上目前視角、或圖磚涵蓋範圍已經
   不跟目前可視範圍相交，就直接放棄（見 tileTimeoutRetry.js 的
   entry.abort），不用乾等逾時，讓名額更快釋放給真正當下需要的圖磚。

   掛在 map.on('moveend', ...)，不是 'movestart'：movestart 觸發的
   當下，view 的 center／resolution 都還是「這次操作開始前」的舊值
   （新視角還沒算出來），這時候掃描只會拿舊視角比對舊請求，兩者本來
   就相符，永遠掃不出過期項目。要等 moveend（這次操作／動畫已經安定
   到新視角）才拿得到正確的比對基準，時機上也剛好搭配 OL 本來就會在
   這個時間點開始為新視角送出下一批圖磚請求。

   節流版拖曳中清理：上面這段 moveend 只會在使用者放開滑鼠／動畫
   結束、視角安定下來後才觸發一次；連續拖曳／縮放的過程中（還沒放開）
   完全不會清理，過期請求會一路佔著名額到操作結束。所以另外也掛在
   view 的 change:center／change:resolution，讓互動進行中也能定期
   清理一次——但這兩個事件在拖曳/縮放動畫進行中會每個影格連續觸發，
   直接掛上去、每次都全量掃描 inFlightGuardedTiles 得不償失，所以
   一定要包一層節流（見下方 throttle()），預設
   STALE_TILE_SWEEP_THROTTLE_MS（400ms）才真的掃描一次，其餘觸發只是
   記錄「稍後要跑一次」，不會每影格都掃。moveend 本身維持不節流、
   立即執行，確保操作結束當下就清乾淨，不需要再等節流窗口。

   只需要在 core/map.js 建立完 map 之後呼叫一次；map 是整頁生命週期
   唯一的一個實例，不需要另外清理這些監聽器。

   注意：這裡只會中止「歷史圖層／自訂圖層」透過
   createGuardedTileLoadFunction() 建立的請求——OSM／衛星底圖沒有套用
   這支 tileLoadFunction，本身不在這個機制的管轄範圍內，但一樣會因為
   名額被更快釋放而受益。

   放棄後的狀態不是永久 ERROR：這裡放棄的圖磚只是「視角過期」，不是
   真正逾時／失敗，實際上可能有資料，所以 entry.abort({ stale: true })
   會把 tile 重置回 IDLE（細節見 tileTimeoutRetry.js 裡 entry.abort
   的定義），讓它下次真的又進入可視範圍時可以被 OL 的 renderer 重新
   排入載入佇列、正常重新呼叫 tileLoadFunction，不會被誤判成永久空白
   （不同於 loadWithTimeoutRetry() 自己判定的明確 onerror 失敗，那些
   仍然維持原本「不會自動重試」的 ERROR 終態）。

   sweepStaleGuardedTiles() 同一次掃描也順便處理逾時終局失敗的冷卻
   重試（timeoutFailedGuardedTiles，見 core/tileTimeoutRetry.js 該常數
   上方的完整說明）：跟這裡的「視角過期」立即重置不同，逾時終局失敗
   需要先冷卻 TIMEOUT_RETRY_COOLDOWN_MS 才會被撥回 IDLE，且每顆圖磚
   只有一次額外機會；明確 onerror 判定的失敗完全不受這個機制影響，
   永遠維持 ERROR。attachStaleTileAbort() 掛的 moveend／節流版
   change:center／change:resolution 監聽器，同時是這兩套機制共用的
   觸發時機。
--------------------------------------------------------- */

// 節流版拖曳中清理的間隔：CLAUDE.md／上方註解要求連續觸發的視角事件
// 一定要節流，300~500ms 是「互動期間仍能感受到即時清理」跟「不會
// 每影格都掃描 inFlightGuardedTiles」之間的折衷值，取中間偏保守的
// 400ms。
export const STALE_TILE_SWEEP_THROTTLE_MS = 400;

// 通用的 leading+trailing 節流器：第一次呼叫立即執行；waitMs 窗口內的
// 後續呼叫只記住「稍後要跑一次」，窗口結束時最多再補跑一次（確保
// 拖曳停在窗口中段時，最後一次視角變化最終還是會被處理到，不會被
// 完全吃掉）。不依賴任何瀏覽器 API，方便在 Node 測試環境直接使用。
export function throttle(fn, waitMs){
  let lastRun = 0;
  let timer = null;
  let pendingArgs = null;
  return function throttled(...args){
    const now = Date.now();
    const elapsed = now - lastRun;
    if(elapsed >= waitMs){
      lastRun = now;
      fn(...args);
      return;
    }
    pendingArgs = args;
    if(!timer){
      timer = setTimeout(() => {
        timer = null;
        lastRun = Date.now();
        const a = pendingArgs;
        pendingArgs = null;
        fn(...a);
      }, waitMs - elapsed);
    }
  };
}

// 實際的掃描＋放棄邏輯，抽成獨立函式讓 moveend（不節流）跟拖曳中的
// 節流版清理（見 attachStaleTileAbort()）共用同一份實作。同一次掃描
// 也順便處理 timeoutFailedGuardedTiles（逾時終局失敗的冷卻重試候選
// 名單，見 core/tileTimeoutRetry.js 該常數上方的完整說明）：兩者都
// 需要「目前視角」這個比對基準，共用同一次視角快照可以少算一次
// extent 轉換。
function sweepStaleGuardedTiles(map){
  if(inFlightGuardedTiles.size === 0 && timeoutFailedGuardedTiles.size === 0) return;
  const view = map.getView();
  const size = map.getSize();
  const resolution = view.getResolution();
  const center = view.getCenter();
  if(!size || resolution == null || !center) return;
  // view.getZoom() 在平滑縮放動畫（滾輪動畫、觸控 pinch）過程中是連續
  // 浮點值，不是使用者最終停下來的那個整數層級；原本直接
  // Math.round() 取整數比對，縮放過渡瞬間（例如 14.5 附近）會把「這次
  // moveend／節流掃描當下，OL 實際上仍在請求」的另一個整數 z 誤判為
  // stale 而 abort，即使那顆圖磚幾乎確定馬上又會被用到。改成允許
  // [floor, ceil] 的容忍範圍：只有 entry.z 落在這個範圍之外，才視為
  // z 不相關；範圍內的兩個端點都視為「跟目前這一刻的連續縮放進度仍然
  // 相關」，不會因為 z 不完全等於四捨五入值就被 abort（bbox 比對不受
  // 影響，仍然是唯一/另一個判定 stale 的依據）。多留這一顆 z 的餘裕，
  // 換來的代價只是「動畫過程中極少數已經過期的請求晚一點點才被放棄」
  // （最差還是會被 loadWithTimeoutRetry() 的逾時機制收尾），遠比「誤殺
  // 仍相關的請求造成閃爍/重新載入」風險小。
  const extent3857 = view.calculateExtent(size);
  const extent4326 = ol.proj.transformExtent(extent3857, view.getProjection(), 'EPSG:4326');

  if(inFlightGuardedTiles.size > 0){
    const rawZoom = view.getZoom();
    const zLow = Math.floor(rawZoom);
    const zHigh = Math.ceil(rawZoom);
    inFlightGuardedTiles.forEach(entry => {
      // { stale: true }：只是視角過期而放棄，不是真正逾時/失敗，讓
      // entry.abort() 把 tile 重置回 IDLE 而不是永久卡在 ERROR（見
      // entry.abort 定義處的完整說明）。
      const zStale = entry.z < zLow || entry.z > zHigh;
      if(zStale || !bboxIntersects(entry.bbox, extent4326)) entry.abort({ stale: true });
    });
  }

  if(timeoutFailedGuardedTiles.size > 0){
    const now = Date.now();
    // 這裡刻意不比對 z（跟上面 inFlightGuardedTiles 的 zLow/zHigh 容忍
    // 範圍不同）：撥回 IDLE 本身不會立即觸發任何請求，只是讓 OL 的
    // renderer 之後真的需要這顆圖磚時（在它實際對應的 z）可以重新排入
    // 載入佇列，跟目前使用者正在看的 z 無關，不需要也不應該用目前 z
    // 篩掉它。bbox 相交只是「這顆圖磚接下來很可能會被用到，值得現在
    // 就花一次額外重試機會」的篩選門檻，不相交就留在名單裡等下次
    // sweep（使用者平移回來、或名單滿了被擠掉），不會因為這次沒中選
    // 就永久放棄。
    timeoutFailedGuardedTiles.forEach(entry => {
      if(now - entry.failedAt < TIMEOUT_RETRY_COOLDOWN_MS) return; // 冷卻還沒過，留著等下次 sweep
      if(!bboxIntersects(entry.bbox, extent4326)) return; // 目前不在可視範圍，先不消耗這次機會
      entry.tile.setState(TILE_STATE.IDLE);
      timeoutFailedGuardedTiles.delete(entry);
    });
  }
}

export function attachStaleTileAbort(map){
  map.on('moveend', () => sweepStaleGuardedTiles(map));

  // 拖曳／縮放互動進行中的節流版清理：掛在 view 的 change:center／
  // change:resolution，透過 throttle() 限制實際掃描頻率，不會每影格
  // 都跑。view.on 在極少數測試用的假 map 物件上可能沒有實作，防呆
  // 略過，不影響 moveend 這條主要路徑。
  const view = map.getView();
  if(view && typeof view.on === 'function'){
    const throttledSweep = throttle(() => sweepStaleGuardedTiles(map), STALE_TILE_SWEEP_THROTTLE_MS);
    view.on('change:center', throttledSweep);
    view.on('change:resolution', throttledSweep);
  }
}
