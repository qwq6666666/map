/* ---------------------------------------------------------
   tileChecker.js — 圖磚探測（Tile Sniffing）封裝
   ---------------------------------------------------------
   把「發一張圖磚圖片請求，確認該座標是否真的有資料」這件事，從
   searchUI.js 的搜尋流程裡獨立出來，封裝成 TileChecker 類別，
   讓它自己管理：

     1. 全站共用同一個 RequestPool（見下方），限制「同時真正在進行中
        的 WMTS HTTP 請求數」不超過 TILE_REQUEST_MAX_CONCURRENCY，
        不論請求來自哪個 TileChecker instance、哪個搜尋流程、或
        checkBatchAny 的鄰近圖磚 fallback。
     2. 記憶體快取：同一個 tile 網址（也就是同一個圖層在同一個
        z/x/y）只要探測過一次，結果就會被記住。使用者短時間內搜尋
        相近地點、或重新搜尋同一個地址時，只要落在同一個 zoom
        level 的同一顆圖磚上，就不用再對遠端伺服器重新發送請求。
     3. 同一網址的重複請求去重（in-flight de-dup）：如果同一顆
        tile 的探測請求還在進行中，之後對同一網址的呼叫會直接共用
        同一個 Promise，不會另外多發一次 HTTP 請求。
     4. 快取上限（maxCacheEntries）：避免長時間使用同一頁面時，
        快取隨著搜尋次數增加而無限成長；超過上限時汰換掉最舊的
        紀錄（簡單的 FIFO／近似 LRU，因為每次命中都會刷新順序）。
     5. 只在「逾時」時重試一次：伺服器明確回應（不論是 onload 回傳
        一張過小的空白圖、還是 onerror／404 之類的明確失敗）都代表
        已經問到答案了，不需要也不應該重試——重試只會讓每一筆真的
        沒有資料的圖層，都額外多等一輪逾時（最差情況下 timeoutMs
        的兩倍），在候選圖層筆數多的搜尋（例如地址搜尋一次要驗證
        上百筆）裡會讓總時間大幅拉長。只有在 timeoutMs 內完全沒有收
        到 onload/onerror 任何回應時，才視為可能的單純網路波動或伺服器
        暫時性緩慢，重試一次；重試後一樣逾時或失敗，才真的判定沒
        資料。
        　　注意：純前端 <img> 載入沒有辦法讀到 HTTP 狀態碼，所以無法
        真的區分「伺服器回 404」跟「連線被拒絕」這兩種 onerror 情況；
        但兩者都代表伺服器（或網路層）已經明確回應、不是逾時，所以
        都不重試，跟「逾時」這種沒收到任何回應的情況分開處理。

   未來如果圖層數量成長到數千筆，這裡是唯一需要調整併發數、逾時、
   快取策略的地方，不會影響 searchUI.js 的搜尋流程邏輯。
--------------------------------------------------------- */

// 全站唯一的「真正 HTTP 請求」併發上限。所有會造成 WMTS 網路請求的
// 路徑（單筆 check、批次 check、checkBatchAny 的鄰近圖磚 fallback、
// timeout 後的 retry）最終都要經過同一個 RequestPool，才能確保實際
// 同時進行中的請求數不超過這個值——不會因為外層同時處理多個 layer、
// 或單一候選項目展開成多顆鄰近圖磚，而疊加出遠超這個上限的請求量。
export const TILE_REQUEST_MAX_CONCURRENCY = 8;

// 輕量的全域 request pool（semaphore）。跟「同時處理幾個候選項目」
// 的 worker/task concurrency 是兩件不同的事：worker concurrency 只決定
// 同時有幾個 checkOne() 呼叫在跑，但呼叫真正送出 HTTP 請求時，一律要
// 先跟這個 pool 要一個 slot，slot 用完才能真的 fetch，藉此把「實際同時
// 進行中的 HTTP 請求數」鎖在 maxConcurrency 以內。
export class RequestPool {
  constructor(maxConcurrency = TILE_REQUEST_MAX_CONCURRENCY){
    this.maxConcurrency = maxConcurrency;
    this._active = 0;
    this._queue = [];        // 排隊等待 slot 的 resolve 函式陣列
    this._maxObserved = 0;   // 觀測到的歷史最大同時進行中請求數，供測試／除錯用
  }

  _acquire(){
    if(this._active < this.maxConcurrency){
      this._active++;
      if(this._active > this._maxObserved) this._maxObserved = this._active;
      return Promise.resolve();
    }
    return new Promise(resolve => {
      this._queue.push(() => {
        this._active++;
        if(this._active > this._maxObserved) this._maxObserved = this._active;
        resolve();
      });
    });
  }

  _release(){
    this._active--;
    if(this._queue.length > 0){
      const next = this._queue.shift();
      next();
    }
  }

  // 真正發送請求的地方一律包在這裡：await pool.run(() => fetch(url))。
  // 不論 fn() 成功、失敗、或逾時（呼叫端自己在 fn 內用 setTimeout 處理），
  // 一定會在 finally 釋放 slot，避免 slot 洩漏導致 pool 卡死。
  async run(fn){
    await this._acquire();
    try{
      return await fn();
    } finally {
      this._release();
    }
  }

  // 供測試／開發環境觀察目前狀態：active（進行中）、queued（排隊中）、
  // maxObserved（歷史最大同時進行中請求數，可用來驗證「有沒有超過上限」）。
  getStats(){
    return { active: this._active, queued: this._queue.length, maxObserved: this._maxObserved };
  }
}

// 全站共用的預設 pool：search.js、timelineMode.js 個別 `new TileChecker()`
// 時如果沒有另外傳入 pool，就會共用這一個 instance，確保「搜尋流程」跟
// 「時間軸模式」不會各自擁有一份獨立的請求名額、疊加出超過上限的總請求數。
export const globalTileRequestPool = new RequestPool(TILE_REQUEST_MAX_CONCURRENCY);

export class TileChecker {
  // concurrency 是「同時處理幾個候選項目（worker/task concurrency）」，
  // 決定 checkBatch/checkBatchAny 同時有幾個 cursor worker 在跑；沒有
  // 明確傳入 pool 時，也拿來當這個 instance 專屬 RequestPool 的上限，
  // 維持「這個 instance 自己的 concurrency 就是真正 HTTP 併發上限」的
  // 直覺行為。如果呼叫端想跟其他 TileChecker instance／其他搜尋流程
  // 共用同一份全域請求名額（例如 search.js 跟 timelineMode.js 不希望
  // 兩邊各自的請求疊加起來超過總上限），要另外明確傳入
  // `pool: globalTileRequestPool`（或其他共用的 RequestPool instance），
  // 這時候實際 HTTP 併發數由那個共用 pool 的上限決定，不是這裡的
  // concurrency。
  constructor({ concurrency = 10, timeoutMs = 6000, maxCacheEntries = 5000, pool } = {}){
    this.concurrency = concurrency;
    this.timeoutMs = timeoutMs;
    this.maxCacheEntries = maxCacheEntries;
    this.pool = pool || new RequestPool(concurrency);
    this.cache = new Map();   // url -> boolean（探測結果）
    this.pending = new Map(); // url -> Promise<boolean>（尚在進行中的請求，避免重複發送）
  }

  _remember(url, ok){
    // Map 的 key 插入順序等於迭代順序，命中時先刪除再重新 set，
    // 等於把這筆紀錄挪到「最新」，簡單近似 LRU。
    if(this.cache.has(url)) this.cache.delete(url);
    this.cache.set(url, ok);
    if(this.cache.size > this.maxCacheEntries){
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
  }

  // 回傳 { ok, timedOut }：ok 是探測結果；timedOut 代表這次是因為
  // timeoutMs 內完全沒收到 onload/onerror 才判定失敗，不是伺服器給了
  // 明確答案。呼叫端只在 timedOut 時才考慮重試。
  // 真正的 Image 請求包在 this.pool.run(...) 裡送出，確保這一筆請求
  // 會先排隊等 pool 的 slot，slot 到手才真的建立 Image 物件發送請求。
  async _probe(url){
    return this.pool.run(() => new Promise((resolve)=>{
      let done = false;
      const img = new Image();
      const finish = (ok, timedOut = false)=>{
        if(done) return;
        done = true;
        clearTimeout(timer);
        // 明確中止這個 Image 的載入（尤其逾時情況）：先拔掉
        // onload/onerror 避免中止動作觸發的事件又跑進來呼叫一次
        // finish，再把 src 清空讓瀏覽器真的停止背景下載。一定要在
        // resolve()、也就是 pool.run() 釋放 slot 之前完成，
        // 這樣 retry 或下一個排隊請求拿到 slot 時，舊請求已經真的
        // 停止，不會讓實際併發 HTTP 連線數超過 pool 上限。
        img.onload = null;
        img.onerror = null;
        img.src = '';
        resolve({ ok, timedOut });
      };
      // 載入失敗或回傳極小的空白圖，視為無資料——這是伺服器的明確回應。
      img.onload = ()=> finish(img.naturalWidth > 2 && img.naturalHeight > 2);
      img.onerror = ()=> finish(false);
      const timer = setTimeout(()=> finish(false, true), this.timeoutMs);
      img.src = url;
    }));
  }

  // 只有「逾時」（沒收到伺服器任何回應）才重試一次；伺服器明確回應
  // 沒資料（onload 小圖／onerror）不重試，避免每一筆真的沒資料的圖層
  // 都白白多等一輪 timeoutMs。重試的這次 _probe() 一樣會經過 pool，
  // 不會繞過併發上限。
  _probeWithRetry(url){
    return this._probe(url).then(result => {
      if(result.ok) return true;
      if(!result.timedOut) return false;
      return this._probe(url).then(retryResult => retryResult.ok);
    });
  }

  // 探測單一網址是否有資料。優先讀快取，其次共用進行中的請求，
  // 都沒有才真的發送圖磚請求。cache hit／in-flight dedup 都在進入
  // pool 之前就短路回傳，不會佔用 HTTP 併發名額。
  checkOne(url){
    if(!url) return Promise.resolve(false);
    if(this.cache.has(url)) return Promise.resolve(this.cache.get(url));
    if(this.pending.has(url)) return this.pending.get(url);
    const promise = this._probeWithRetry(url).then(ok=>{
      this._remember(url, ok);
      this.pending.delete(url);
      return ok;
    });
    this.pending.set(url, promise);
    return promise;
  }

  // 批次探測一組候選項目。urlOf(item) 從候選項目取出要探測的網址
  // （可能因為資料不完整而丟例外，視為無資料）；onProgress(checked, total)
  // 每完成一筆就會被呼叫一次，供呼叫端更新進度文字。
  // 回傳「確認有資料」的候選項目子陣列，順序不保證與輸入相同
  // （worker 平行處理，跟原本的行為一致）。
  async checkBatch(items, urlOf, onProgress){
    const total = items.length;
    const available = [];
    let cursor = 0;
    let checked = 0;

    const worker = async () => {
      while(cursor < items.length){
        const idx = cursor++;
        const item = items[idx];
        let url = null;
        try{ url = urlOf(item); }catch(e){ url = null; }
        const ok = await this.checkOne(url);
        checked++;
        if(onProgress) onProgress(checked, total);
        if(ok) available.push(item);
      }
    };

    const runnerCount = Math.min(this.concurrency, items.length || 1);
    const runners = Array.from({ length: runnerCount }, worker);
    await Promise.all(runners);
    return available;
  }

  // 跟 checkBatch 類似，差別是 urlsOf(item) 回傳「一組網址」而不是單一
  // 網址，只要這組裡任何一個網址探測成功，就把這個候選項目算作「有
  // 資料」。用途：中心點那一顆圖磚探測失敗時，改測它周圍幾顆鄰近圖磚
  // （見 core/tileGeo.js 的 neighborTiles()），只要附近有資料就不該
  // 被當成「找不到」。內部一樣透過 checkOne 走快取／去重，即使不同
  // 候選項目的鄰近圖磚剛好重疊，也不會重複發送請求。
  // 這裡的 Promise.all(urls.map(...)) 只是同時「建立」多個 checkOne
  // 任務，每個任務真正送出的 HTTP 請求仍然各自要跟 pool 要 slot，
  // 所以不會因為一次展開 8 顆鄰近圖磚就讓實際併發數超過 pool 上限。
  async checkBatchAny(items, urlsOf, onProgress){
    const total = items.length;
    const available = [];
    let cursor = 0;
    let checked = 0;

    const worker = async () => {
      while(cursor < items.length){
        const idx = cursor++;
        const item = items[idx];
        let urls = [];
        try{ urls = urlsOf(item) || []; }catch(e){ urls = []; }
        const results = await Promise.all(urls.map(u => this.checkOne(u)));
        checked++;
        if(onProgress) onProgress(checked, total);
        if(results.some(Boolean)) available.push(item);
      }
    };

    const runnerCount = Math.min(this.concurrency, items.length || 1);
    const runners = Array.from({ length: runnerCount }, worker);
    await Promise.all(runners);
    return available;
  }

  clearCache(){
    this.cache.clear();
    this.pending.clear();
  }
}
