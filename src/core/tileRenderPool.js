/* ---------------------------------------------------------
   core/tileRenderPool.js — 歷史／自訂圖層圖磚渲染專用節流池
   ---------------------------------------------------------
   從 core/tileLoadGuard.js 拆出的三個獨立職責之一（另外兩個是
   core/tileBoundaryGuard.js 的邊界保護、core/tileTimeoutRetry.js 的
   逾時重試），只負責「限制歷史／自訂圖層同時真正在進行中的圖磚請求數
   不超過 TILE_RENDER_MAX_CONCURRENCY」，不處理邊界／逾時判斷本身。

   跟 tileChecker.js 的 globalTileRequestPool（背景地址搜尋探測用，
   上限 8）是完全獨立的第三套節流機制、獨立 instance：那一套是「地址
   搜尋」背景批次探測候選圖層專用的節流閥，如果拿來跟使用者正在看的
   地圖圖磚共用，會讓兩種用途互相排擠。這裡的 tileRenderRequestPool
   上限選 4 而不是更高或更低：
     - 瀏覽器對同一 host 本身約有 6 條連線上限，4 略低於這個瀏覽器
       限制，讓我們自己的節流池才是實際瓶頸、行為可預期（不同瀏覽器／
       版本對同一 host 的連線數限制不完全一致，不能全部交給瀏覽器）。
     - 雙圖比對／多重疊加模式可能同時有 2 個歷史圖層在渲染，4 留了
       緩衝，不會讓兩個圖層互搶到卡死彼此。
     - 底圖（OSM／衛星）完全不套用這個節流池，不受影響；OL 全域 16 個
       LOADING 名額裡，平時至少留 12 個給底圖使用。

   刻意沒有直接 import／new tileChecker.js 的 RequestPool class：那個
   class 的 run() 是 `async function`，就算 slot 立即可用，
   `await this._acquire()` 還是會把 fn() 的實際執行延到下一個
   microtask 才跑（JS 的 async/await 語意本身如此，即使 await 的是已經
   resolve 的 Promise）。但 core/tileLoadGuard.js 的
   attachStaleTileAbort() 需要在同一個事件循環內（例如 moveend 觸發
   當下）就同步看到 entry.abort 是不是已經可以呼叫、以及呼叫後 tile
   狀態是否立刻反映，這裡改寫了一個介面相容（run()／getStats()）但
   「slot 立即可用時同步執行 fn()」的等價節流器（見下方
   TileRenderPool），避免引入這一個 tick 的延遲讓時序測試
   （tile-load-guard.test.mjs 既有的同步 abort 案例）失真。
--------------------------------------------------------- */

// 介面精簡比照 tileChecker.js 的 RequestPool（run()／getStats()），差別
// 只在於 slot 立即可用時同步呼叫 fn()、不透過 async function 的
// await 引入額外一個 microtask 延遲（理由見上方檔頭註解）；排隊等待中的
// 任務跟 RequestPool 一樣，slot 釋放時才會真的執行，本來就是非同步。
export class TileRenderPool {
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

export const TILE_RENDER_MAX_CONCURRENCY = 4;

export const tileRenderRequestPool = new TileRenderPool(TILE_RENDER_MAX_CONCURRENCY);
