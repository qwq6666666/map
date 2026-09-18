/* ---------------------------------------------------------
   core/tileTimeoutRetry.js — 圖磚渲染的逾時保護 + 重試一次
   ---------------------------------------------------------
   從 core/tileLoadGuard.js 拆出的三個獨立職責之一（另外兩個是
   core/tileBoundaryGuard.js 的邊界保護、core/tileRenderPool.js 的
   節流池），只負責「送出 <img src> 之後，逾時／成功／失敗該怎麼判定」：
     - 逾時保護＋重試一次：只有「逾時」（timeoutMs 內完全沒收到
       onload/onerror）才重試一次；明確的 onerror（伺服器已經回應，
       只是失敗）不重試，直接判定 ERROR。邏輯完全比照 tileChecker.js
       的 _probeWithRetry()。
     - 真正送出 <img src> 前要先跟 tileRenderRequestPool（見
       core/tileRenderPool.js）要一個 slot，限制併發數。
     - 逾時終局失敗的冷卻重試（timeoutFailedGuardedTiles）：修正使用者
       回報「圖磚有時要放大縮小才會出現，原地不動卻一直空白」——OL 的
       圖磚佇列只把 state===IDLE 的圖磚排入下次載入，ERROR 狀態的圖磚
       就算重新進入可視範圍也不會自動重新呼叫 tileLoadFunction。逾時
       失敗大概率是暫時性伺服器壅塞，不是真的沒資料，所以需要有辦法
       把它撥回 IDLE；差別是這裡要先等一段冷卻時間
       （TIMEOUT_RETRY_COOLDOWN_MS）才重試，且每顆圖磚只有這一次額外
       機會，避免對真的持續故障的主機做無限重試。明確 onerror 的失敗
       不適用，繼續維持永久 ERROR。撥回 IDLE 有兩條並存的路徑：一是
       tileLoadGuard.js 的 sweepStaleGuardedTiles()（掛在 moveend／
       view change，比對目前可視範圍，先到的先撥）；二是這裡
       registerTimeoutRetryCandidate() 內建的 setTimeout（冷卻時間一到
       就直接撥，不依賴任何視角事件）——後者是為了涵蓋「使用者點一下
       地圖後完全不再移動/縮放」的情境，見該函式上方的完整說明。
     - 最近圖磚載入失敗紀錄（recentTileFailures）：供「來源狀態」面板
       （ui/sourceStatusUI.js）顯示。

   inFlightGuardedTiles／timeoutFailedGuardedTiles 這兩個 registry 雖然
   概念上屬於跨三者的協調狀態（core/tileLoadGuard.js 的
   attachStaleTileAbort()／abortInFlightForKey() 需要掃描／清除它們），
   但 entry 是在這裡的 loadWithTimeoutRetry() 內建立（entry.abort 是
   跟 attempt() 內部 settled/started/cleanup 等區域變數綁死的閉包），
   拆成獨立檔案又要另外設計一組註冊/查詢介面沒有必要，所以直接把這兩個
   Set 定義在這裡、原樣 export 給 tileLoadGuard.js（組合層）import 後
   直接操作，不新增任何行為，純粹是拆檔案邊界的取捨。
--------------------------------------------------------- */
import { TILE_STATE } from './tileBoundaryGuard.js';
import { tileRenderRequestPool } from './tileRenderPool.js';

// 刻意比 tileChecker.js 的 timeoutMs 預設值（6000ms）短很多：那邊是
// 背景批次探測，寧可慢一點也要準；這裡是使用者正在看的地圖，目的是
// 盡快釋放瀏覽器對同一 host 的連線名額，讓排在後面、真正有資料的
// 圖磚不被卡住的慢請求排擠，所以要在「明顯不正常」就儘早放棄——
// 2000ms 略短於實測到的 file-exists.php 最慢個案（2.3~2.4 秒），
// 同時是正常圖磚 p90（約 150ms）的十幾倍，留有網路波動餘裕。
export const DEFAULT_TILE_LOAD_TIMEOUT_MS = 2000;

// ---------------------------------------------------------
// 最近圖磚載入失敗紀錄——供「來源狀態」面板（ui/sourceStatusUI.js）
// 顯示，跟 features/sourceStatus.js 的主機探測是互補、不是重複的兩件
// 事：那邊只測「主機有沒有回應」（onload／onerror 都算活著），測不出
// 「使用者實際瀏覽時，這個圖層／這個座標到底讀不讀得出來」；這裡記錄
// 的才是使用者真正遇到的失敗。
//
// 刻意只記錄「明確失敗」的兩種終態（逾時重試後仍失敗、伺服器明確
// onerror），不記錄邊界保護判定的 EMPTY——平移到圖層涵蓋範圍外是每次
// 使用者操作都會正常發生的預期行為（一次平移可能觸發幾十次 EMPTY），
// 記進來只會洗掉真正的失敗訊號，不是故障。
// ---------------------------------------------------------
export const RECENT_TILE_FAILURE_LIMIT = 10;
const recentTileFailures = [];

function recordTileFailure(label, reason, z, x, y){
  recentTileFailures.unshift({ time: Date.now(), label: label || '（未知圖層）', reason, z, x, y });
  if(recentTileFailures.length > RECENT_TILE_FAILURE_LIMIT) recentTileFailures.length = RECENT_TILE_FAILURE_LIMIT;
}

// 回傳複本（最新的排最前面），避免呼叫端不小心改到內部陣列。
export function getRecentTileFailures(){
  return recentTileFailures.slice();
}

export function clearRecentTileFailures(){
  recentTileFailures.length = 0;
}

// ---------------------------------------------------------
// timeoutFailedGuardedTiles — 逾時終局失敗圖磚的冷卻重試候選名單
// ---------------------------------------------------------
// 背景（使用者回報「歷史圖層圖磚有時要放大縮小才會出現，原地不動卻
// 一直空白」）：OpenLayers 的圖磚佇列只會把 state===IDLE 的圖磚排入
// 下次載入，state===ERROR 的圖磚即使重新進入可視範圍也不會被重新
// 呼叫 tileLoadFunction（同一份反解結論見 tileLoadGuard.js
// attachStaleTileAbort() 上方的說明）。loadWithTimeoutRetry() 逾時
// 重試一次後仍逾時，會判定終局 ERROR——但檔頭已經記載 sinica 來源在
// 高併發下，連「有資料」的正常圖磚回應都可能被拖慢到 ~1 秒、逼近
// 2000ms 逾時線，代表這種逾時很大機率是暫時性伺服器壅塞，不是真的
// 沒資料，永久卡死在 ERROR 會被誤判成「這個座標沒有歷史圖資」。
//
// 這裡刻意只處理「逾時終局失敗」（reason==='timeout'），不處理
// img.onerror 判定的明確失敗（reason==='error'）：後者絕大多數是
// file-exists.php 對「真的沒有歷史圖資」座標回傳的 404，伺服器已經
// 明確回應過，重試沒有意義，對大量真正無資料的圖磚做無謂重試只會
// 浪費請求名額、排擠其他正常圖磚。
//
// 跟 tileLoadGuard.js 的 attachStaleTileAbort()「視角過期」重置共用
// 同一個 sweep（見該檔案 sweepStaleGuardedTiles()），但語意不同：那邊
// 是「使用者根本還沒等到結果就已經換了視角」，這裡是「已經等到明確的
// 逾時終局失敗」，需要額外一段冷卻時間（TIMEOUT_RETRY_COOLDOWN_MS）
// 讓造成逾時的伺服器壅塞真的有機會消退，不能像 stale abort 那樣立刻
// 重置；也因為這顆圖磚現在本來就已經是 ERROR，撥回 IDLE 不需要 stale
// abort 那套「先 setState(ERROR) 再 setState(IDLE)」的兩步走技巧——
// OL 的序列檢查 `state!==ERROR && state>t` 在 state 已經是 ERROR 時
// 本來就會放行。
//
// sweepStaleGuardedTiles() 只在使用者移動/縮放地圖時才會被觸發，如果
// 使用者點一下地圖（例如 identifyPin.js 的落點探針）就不再互動，
// 冷卻時間到了也沒有任何事件會去檢查這個 Set——所以
// registerTimeoutRetryCandidate() 另外內建了一個不依賴視角事件的
// setTimeout 自動撥回路徑（見該函式定義處），兩條路徑並存、先到的先
// 把 entry 從這個 Set 移除，互不衝突。
export const TIMEOUT_RETRY_REGISTRY_LIMIT = 200;
export const timeoutFailedGuardedTiles = new Set();

// 記錄「這顆 Tile 物件已經用過它唯一一次額外重試機會」。只在第一次
// 因逾時終局失敗被加進 timeoutFailedGuardedTiles 時標記，之後不論這次
// 冷卻重試最終有沒有真的被撥回 IDLE（也可能因為一直不在可視範圍內、
// 或被 TIMEOUT_RETRY_REGISTRY_LIMIT 擠掉而從未被撥回），同一顆 Tile
// 物件都不會再被加進候選名單第二次——保持「每顆圖磚只有一次額外重試
// 機會」的簡單語意，避免對持續故障的主機做無限重試。用 WeakSet 是
// 因為 Tile 物件本身的生命週期完全交給 OL 的 TileCache
// （cacheSize:DEFAULT_TILE_CACHE_SIZE）管理，物件被 LRU 汰換、GC 回收
// 時這裡的標記不需要、也無法手動清除，WeakSet 剛好不會阻止 GC、也
// 不用另外維護上限。
const cooldownRetriedTiles = new WeakSet();

// 逾時終局失敗後，要冷卻多久才有機會被撥回 IDLE 重新嘗試。下限：明顯
// 長於一次完整逾時＋重試的最差耗時（2000ms 逾時 + 重試一次再
// 2000ms ≈ 4000ms），要留時間讓造成逾時的暫時性伺服器壅塞真的消退，
// 不然冷卻一結束又立刻撞回同一個壅塞窗口、白白多打一次還是失敗。
// 上限：不要久到使用者「離開又回來看」都感受不到差異——8000ms 是
// 最差耗時的兩倍，多數使用者一次平移/縮放操作間隔不會超過這個量級，
// 大部分情況下都能等於「回來看又好了」。
export const TIMEOUT_RETRY_COOLDOWN_MS = 8000;

// 供 loadWithTimeoutRetry() 在判定逾時終局失敗時呼叫，登記這顆圖磚
// 進冷卻重試候選名單；已經用過額外重試機會的 Tile 物件（無論當初是
// 否真的被撥回過 IDLE）直接略過，不重複登記。名單滿了（見
// TIMEOUT_RETRY_REGISTRY_LIMIT）就捨棄最舊的一筆，避免使用者長時間
// 平移到很遠的地方、大量逾時失敗的圖磚（可能再也不會被看到）永遠留在
// 名單裡佔記憶體；捨棄的代價只是那筆圖磚少一次冷卻重試機會，等同
// 退回「不會自動重試」的原始行為，不會更糟。
// 使用者點一下地圖（例如 identifyPin.js 的落點探針）觸發逾時失敗後，
// 如果之後完全不再移動/縮放地圖，sweepStaleGuardedTiles() 永遠不會被
// 觸發——冷卻時間到了也沒有任何事件會把它撥回 IDLE，圖磚永久卡在畫面
// 上空白，只能等使用者「剛好」再動一下地圖才被動撿回來。所以這裡額外
// 排一個 setTimeout，冷卻時間一到就不依賴任何視角事件、直接把 entry
// 撥回 IDLE：跟 sweepStaleGuardedTiles() 的差異只在於「不比對 bbox 是否
// 在目前可視範圍」——這正是這條路徑存在的意義（要撥回的就是『不管使用者
// 有沒有再看這裡』都該恢復的圖磚），而不是漏改；bbox 篩選是
// sweepStaleGuardedTiles() 用來判斷「值不值得現在消耗這次機會」的優化，
// 對這裡「反正冷卻已經到期、乾脆自己觸發」的兜底路徑沒有意義。
//
// callback 觸發時務必先確認 entry 是否還在 timeoutFailedGuardedTiles
// 裡：sweepStaleGuardedTiles() 可能已經搶先（使用者剛好在冷卻到期前後
// 動了地圖）處理掉同一個 entry，或者 entry 被 TIMEOUT_RETRY_REGISTRY_LIMIT
// 擠掉——兩種情況下 entry 都已經不在 Set 裡，此時什麼都不做，避免對
// 已經不相關（甚至已經被 GC／LRU 換掉 Tile 物件）的 entry 重複撥回或
// 誤動作。不需要額外 clearTimeout：這個計時器只觸發一次、自然結束，
// 不會累積成洩漏，被搶先處理的 entry 只是讓這次觸發變成一次沒有作用的
// no-op。
function registerTimeoutRetryCandidate(tile, tileBbox, z, sourceKey){
  if(cooldownRetriedTiles.has(tile)) return;
  cooldownRetriedTiles.add(tile);
  const entry = { tile, bbox: tileBbox, z, sourceKey, failedAt: Date.now() };
  timeoutFailedGuardedTiles.add(entry);
  if(timeoutFailedGuardedTiles.size > TIMEOUT_RETRY_REGISTRY_LIMIT){
    const oldest = timeoutFailedGuardedTiles.values().next().value;
    timeoutFailedGuardedTiles.delete(oldest);
  }
  const cooldownTimer = setTimeout(() => {
    if(!timeoutFailedGuardedTiles.has(entry)) return;
    entry.tile.setState(TILE_STATE.IDLE);
    timeoutFailedGuardedTiles.delete(entry);
  }, TIMEOUT_RETRY_COOLDOWN_MS);
  // Node 的 setTimeout 回傳值預設會讓 process 在計時器觸發前不會自然
  // 結束（在瀏覽器完全不是問題，頁面不會因為有 pending timer 而「不
  // 結束」）；但這支模組同時也在 Node 測試環境下執行，unref() 讓這顆
  // 計時器不會阻止測試檔案的 process 提早結束——只是不強制保活，時間到
  // 該觸發還是照常觸發，不影響行為，只影響 process 存活判斷。瀏覽器的
  // setTimeout 回傳純數字、沒有 unref 方法，防呆略過。
  if(cooldownTimer && typeof cooldownTimer.unref === 'function') cooldownTimer.unref();
}

// 目前所有「已經送出 <img src>、還沒 resolve」的 guarded 請求，供
// tileLoadGuard.js 的 attachStaleTileAbort() 掃描；每個 entry 是
// { bbox, z, sourceKey, abort }。只有真正發送了網路請求的圖磚才會在
// 這裡登記——被邊界保護擋下、直接 EMPTY 的圖磚從來不會進來，本來就
// 沒有佔用載入名額，不需要放棄。
export const inFlightGuardedTiles = new Set();

/**
 * 送出 <img src> 並處理逾時（重試一次）／成功／明確失敗，具備節流
 * （透過 tileRenderRequestPool）與冷卻重試登記。由
 * core/tileLoadGuard.js 的 createGuardedTileLoadFunction() 在邊界保護
 * 判定「相交、可以載入」之後呼叫。
 *
 * @param {object} tile OL 的 Tile 物件。
 * @param {string} src 圖磚網址。
 * @param {number} timeoutMs 逾時毫秒數。
 * @param {[number,number,number,number]} tileBbox 這顆圖磚的 WGS84 bbox
 *   （由 tileBoundaryGuard.js 的 applyTileBoundaryGuard() 算好傳入，
 *   避免重複呼叫 tile.getTileCoord()／tileXYToBbox()）。
 * @param {number} z 縮放層級。
 * @param {number} x 圖磚 X 座標（僅用於失敗紀錄）。
 * @param {number} y 圖磚 Y 座標（僅用於失敗紀錄）。
 * @param {string} [label] 供失敗紀錄顯示用的人類可讀圖層名稱。
 * @param {string} [sourceKey] core/layerCache.js 用的圖層 key，供
 *   abortInFlightForKey() 依 key 中止使用。
 */
export function loadWithTimeoutRetry(tile, src, timeoutMs, tileBbox, z, x, y, label, sourceKey){
  const img = tile.getImage();

  // attempt() 執行到底（不論成功、失敗、逾時判定 ERROR）都會呼叫這個
  // 把自己從 registry 移除；attempt(true) 重試時沿用同一筆 registry
  // entry（只是換掉 entry.abort 指向新的一次嘗試），不會重複註冊。
  const entry = { bbox: tileBbox, z, sourceKey, abort: null };
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
        recordTileFailure(label, 'error', z, x, y);
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
        recordTileFailure(label, 'timeout', z, x, y);
        // 逾時重試一次後仍逾時＝終局失敗，登記進冷卻重試候選名單，
        // 讓 tileLoadGuard.js 的 sweepStaleGuardedTiles() 之後有機會
        // 撥回 IDLE 重新嘗試（見 timeoutFailedGuardedTiles 上方的完整
        // 說明）。明確 onerror 判定的失敗（上面 img.onerror）刻意不
        // 呼叫這個函式。
        registerTimeoutRetryCandidate(tile, tileBbox, z, sourceKey);
      }, timeoutMs);
      img.src = src;
    }));
  };

  attempt(false);
}
