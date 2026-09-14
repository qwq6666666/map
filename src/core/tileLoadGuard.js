/* ---------------------------------------------------------
   core/tileLoadGuard.js — 圖磚渲染的逾時保護 + 邊界保護 + 節流
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
   ol.source.XYZ／ol.source.WMTS 的 tileLoadFunction，具備：
     1. 邊界保護：載入前用 tileXYToBbox() 算出這顆圖磚的涵蓋範圍，
        跟圖層的 region.bbox 用 bboxIntersects() 比對，完全不相交
        就 tile.setState(EMPTY)，不建立/指定 <img src>，不發送任何
        網路請求。
     2. 逾時保護＋重試一次：只有「逾時」（timeoutMs 內完全沒收到
        onload/onerror）才重試一次；明確的 onerror（伺服器已經回應，
        只是失敗）不重試，直接判定 ERROR。邏輯完全比照
        tileChecker.js 的 _probeWithRetry()。
     3. 節流：真正送出 <img src> 前要先跟 tileRenderRequestPool 要一個
        slot（見下方常數區塊的設計理由），限制「歷史／自訂圖層同時
        真正在進行中的圖磚請求數」不超過 TILE_RENDER_MAX_CONCURRENCY，
        避免這些慢請求把 OL 全域 16 個 LOADING 名額吃光、連底圖都要
        排隊。

   跟 tileChecker.js（TileChecker + RequestPool／globalTileRequestPool）
   刻意保持獨立、不共用任何狀態：那一套是「地址搜尋」背景批次探測
   候選圖層專用的節流閥（全站併發上限 8），如果拿來跟使用者正在看的
   地圖圖磚共用，會讓兩種用途互相排擠。這裡是另一個獨立的節流池
   （tileRenderRequestPool，上限 4），刻意沒有直接 import／new
   tileChecker.js 的 RequestPool class：那個 class 的 run() 是
   `async function`，就算 slot 立即可用，`await this._acquire()`
   還是會把 fn() 的實際執行延到下一個 microtask 才跑（JS 的
   async/await 語意本身如此，即使 await 的是已經 resolve 的
   Promise）。但 attachStaleTileAbort() 需要在同一個事件循環內（例如
   moveend 觸發當下）就同步看到 entry.abort 是不是已經可以呼叫、以及
   呼叫後 tile 狀態是否立刻反映，這裡改寫了一個介面相容
   （run()／getStats()）但「slot 立即可用時同步執行 fn()」的等價節流器
   （見下方 TileRenderPool），避免引入這一個 tick 的延遲讓時序測試
   （tile-load-guard.test.mjs 既有的同步 abort 案例）失真。

   本檔案另外還處理兩件跟「圖磚渲染」有關、彼此獨立的事：
     - DEFAULT_TILE_CACHE_SIZE：每個 tile source 的快取上限（見下方
       說明），跟這裡的逾時／邊界保護無關，只是剛好也是「圖磚載入」
       範疇，統一放在這支檔案維護。
     - attachStaleTileAbort()：讓已經送出但視角早就換過的 guarded
       請求可以提早放棄，釋放 OpenLayers 全域圖磚載入佇列的名額；
       連續拖曳／縮放互動期間也會用節流過的頻率主動清理一次，不用
       等放開滑鼠的 moveend 才清（見該函式上方的完整說明）。
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

// ---------------------------------------------------------
// tileRenderRequestPool — 歷史／自訂圖層圖磚渲染專用節流池
// ---------------------------------------------------------
// 跟 tileChecker.js 的 globalTileRequestPool（背景地址搜尋探測用，
// 上限 8）是完全獨立的第三套節流機制、獨立 instance，理由見檔頭註解。
// 上限選 4 而不是更高或更低：
//   - 瀏覽器對同一 host 本身約有 6 條連線上限，4 略低於這個瀏覽器
//     限制，讓我們自己的節流池才是實際瓶頸、行為可預期（不同瀏覽器／
//     版本對同一 host 的連線數限制不完全一致，不能全部交給瀏覽器）。
//   - 雙圖比對／多重疊加模式可能同時有 2 個歷史圖層在渲染，4 留了
//     緩衝，不會讓兩個圖層互搶到卡死彼此。
//   - 底圖（OSM／衛星）完全不套用這個節流池，不受影響；OL 全域 16 個
//     LOADING 名額裡，平時至少留 12 個給底圖使用。
export const TILE_RENDER_MAX_CONCURRENCY = 4;

// 介面精簡比照 tileChecker.js 的 RequestPool（run()／getStats()），差別
// 只在於 slot 立即可用時同步呼叫 fn()、不透過 async function 的
// await 引入額外一個 microtask 延遲（理由見檔頭註解）；排隊等待中的
// 任務跟 RequestPool 一樣，slot 釋放時才會真的執行，本來就是非同步。
class TileRenderPool {
  constructor(maxConcurrency){
    this.maxConcurrency = maxConcurrency;
    this._active = 0;
    this._queue = [];       // 排隊等待 slot 的 () => void 陣列
    this._maxObserved = 0;  // 觀測到的歷史最大同時進行中請求數，供測試／除錯用
  }

  _invoke(fn){
    let result;
    try{
      result = fn();
    } catch(err){
      this._release();
      return Promise.reject(err);
    }
    return Promise.resolve(result).then(
      (value) => { this._release(); return value; },
      (err) => { this._release(); throw err; }
    );
  }

  _release(){
    this._active--;
    if(this._queue.length > 0){
      const next = this._queue.shift();
      next();
    }
  }

  // 真正發送請求的地方一律包在這裡：pool.run(() => new Promise(...))。
  // slot 有空位時同步呼叫 fn()；沒有空位時排隊，輪到時才呼叫。
  run(fn){
    if(this._active < this.maxConcurrency){
      this._active++;
      if(this._active > this._maxObserved) this._maxObserved = this._active;
      return this._invoke(fn);
    }
    return new Promise((resolve, reject) => {
      this._queue.push(() => {
        this._active++;
        if(this._active > this._maxObserved) this._maxObserved = this._active;
        this._invoke(fn).then(resolve, reject);
      });
    });
  }

  getStats(){
    return { active: this._active, queued: this._queue.length, maxObserved: this._maxObserved };
  }
}

export const tileRenderRequestPool = new TileRenderPool(TILE_RENDER_MAX_CONCURRENCY);

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

  // 每一次嘗試（含重試）都各自向 tileRenderRequestPool 要一個 slot，
  // 真正送出 <img src> 前要先排隊；slot 佔用到這次嘗試 settled（成功／
  // 失敗／逾時判定／abort）才釋放，重試會重新排隊，不會繞過節流上限。
  //
  // entry.abort 必須在呼叫 tileRenderRequestPool.run() 之前、同步指定
  // 好：attachStaleTileAbort() 可能在這次嘗試還在排隊等 slot（甚至
  // 還沒真的送出 <img src>）的階段就呼叫它，如果 entry.abort 要等排到
  // slot 才被賦值，這段排隊期間它會是 null，被呼叫會直接丟例外。
  // started 記錄「是否已經真的送出請求」，abort 時只有 started 才需要
  // 清 img.src／拔 onload-onerror；還在排隊的話從來沒發送過，不用清。
  // settled 記錄「這次嘗試是否已經有結果」，pool 排到 slot 時如果發現
  // settled 已經是 true（代表排隊期間就被 abort 了），直接釋放 slot、
  // 不用真的發送請求。
  const attempt = (isRetry) => {
    let settled = false;
    let started = false;
    let timer;
    let releaseSlot = null;

    const cleanup = () => {
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
    };

    // 供 attachStaleTileAbort() 呼叫：視角已經換過、這顆圖磚不再相關時
    // 提早放棄，不會像逾時那樣再重試一次——都已經確定不相關了，重試
    // 也沒有意義。
    //
    // opts.stale === true 代表這次放棄純粹是「視角過期」，不是真正的
    // 逾時／失敗——圖磚實際上可能有資料，不能讓它像真正失敗一樣卡在
    // ERROR 永遠不會重試。已反解 OL 原始碼（Tile.load()／TileQueue.
    // loadMoreTiles()／renderer 的 forEachTileCoord）確認：圖磚只有在
    // getState()===IDLE 時才會被重新排進下一次載入佇列，ERROR 狀態的
    // Tile 物件只要還留在 TileCache（cacheSize:256）裡，之後就算又進入
    // 可視範圍也不會被重新排入、不會再呼叫 tileLoadFunction——會被誤判
    // 成永久空白。這裡刻意先 setState(ERROR) 再 setState(IDLE) 兩步走，
    // 不能直接從 LOADING 跳到 IDLE：OL 的 Tile.setState() 有序列檢查
    // `if(this.state!==ERROR && this.state>t) throw`，只有「目前狀態
    // 已經是 ERROR」時才會放行往回退的狀態轉移——這是 OL 自己內部
    // ImageTile.load() 重新載入既有錯誤圖磚時依賴的同一個特例，不是
    // 我們發明的旁門左道。setState(IDLE) 之後不會立刻觸發任何請求，
    // 只是讓這顆 Tile 物件重新符合「還沒載入過」的判定，下次真的又
    // 進入可視範圍、OL 的 renderer 重新走訪到它時才會自然呼叫
    // tile.load() -> 我們的 guardedTileLoadFunction，跟一顆全新的圖磚
    // 走一模一樣的流程（含邊界保護、逾時重試）。真正逾時/明確失敗的
    // ERROR（見上面 timer 與 img.onerror）不受影響，繼續維持原本
    // 「不會自動重試」的語意。
    entry.abort = (opts) => {
      if(settled) return;
      settled = true;
      if(started){
        cleanup();
        img.src = '';
      }
      tile.setState(TILE_STATE.ERROR);
      if(opts && opts.stale) tile.setState(TILE_STATE.IDLE);
      unregister();
      // 已經排到 slot（started===true）才需要主動釋放；還在排隊時
      // releaseSlot 尚未指定，稍後真的排到這次嘗試時，pool.run() 的
      // callback 會看到 settled 已經是 true，自己呼叫 resolve() 放棄。
      if(releaseSlot) releaseSlot();
    };

    tileRenderRequestPool.run(() => new Promise((resolve) => {
      releaseSlot = resolve;
      if(settled){
        // 排隊等 slot 期間已經被 abort，這次嘗試不用真的發送請求。
        resolve();
        return;
      }
      started = true;
      img.onload = () => {
        if(settled) return;
        settled = true;
        cleanup();
        tile.setState(TILE_STATE.LOADED);
        unregister();
        resolve();
      };
      img.onerror = () => {
        // 伺服器已經明確回應（不論是連線被拒絕還是 404），不是逾時，
        // 不重試——理由跟 tileChecker._probe() 完全一致。
        if(settled) return;
        settled = true;
        cleanup();
        tile.setState(TILE_STATE.ERROR);
        unregister();
        resolve();
      };
      timer = setTimeout(() => {
        if(settled) return;
        settled = true;
        cleanup();
        // 先清空 src 讓瀏覽器真的中止背景下載、釋放連線名額，之後
        // 重新指定同一個網址時瀏覽器才會真的重新發送請求（直接把
        // src 設回一模一樣的字串，部分瀏覽器不會觸發重新載入）。
        img.src = '';
        // 不論是否還要重試，這次嘗試都已經結束，先釋放 pool slot；
        // 需要重試的話 attempt(true) 會重新跟 pool 排隊要一個新 slot。
        resolve();
        if(!isRetry){ attempt(true); return; }
        tile.setState(TILE_STATE.ERROR);
        unregister();
      }, timeoutMs);
      img.src = src;
    }));
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
   會把 tile 重置回 IDLE（細節見 loadWithTimeoutRetry() 裡 entry.abort
   的定義），讓它下次真的又進入可視範圍時可以被 OL 的 renderer 重新
   排入載入佇列、正常重新呼叫 tileLoadFunction，不會被誤判成永久空白
   （不同於 loadWithTimeoutRetry() 自己判定的真正逾時／明確失敗，那些
   仍然維持原本「不會自動重試」的 ERROR 終態）。
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
// 節流版清理（見 attachStaleTileAbort()）共用同一份實作。
function sweepStaleGuardedTiles(map){
  if(inFlightGuardedTiles.size === 0) return;
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
  const rawZoom = view.getZoom();
  const zLow = Math.floor(rawZoom);
  const zHigh = Math.ceil(rawZoom);
  const extent3857 = view.calculateExtent(size);
  const extent4326 = ol.proj.transformExtent(extent3857, view.getProjection(), 'EPSG:4326');
  inFlightGuardedTiles.forEach(entry => {
    // { stale: true }：只是視角過期而放棄，不是真正逾時/失敗，讓
    // entry.abort() 把 tile 重置回 IDLE 而不是永久卡在 ERROR（見
    // entry.abort 定義處的完整說明）。
    const zStale = entry.z < zLow || entry.z > zHigh;
    if(zStale || !bboxIntersects(entry.bbox, extent4326)) entry.abort({ stale: true });
  });
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
