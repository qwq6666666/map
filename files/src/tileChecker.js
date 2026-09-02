/* ---------------------------------------------------------
   tileChecker.js — 圖磚探測（Tile Sniffing）封裝
   ---------------------------------------------------------
   把「發一張圖磚圖片請求，確認該座標是否真的有資料」這件事，從
   searchUI.js 的搜尋流程裡獨立出來，封裝成 TileChecker 類別，
   讓它自己管理：

     1. 固定併發數的 worker pool（沿用原本 CONCURRENCY=10 的做法）。
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

   未來如果圖層數量成長到數千筆，這裡是唯一需要調整併發數、逾時、
   快取策略的地方，不會影響 searchUI.js 的搜尋流程邏輯。
--------------------------------------------------------- */
export class TileChecker {
  constructor({ concurrency = 10, timeoutMs = 6000, maxCacheEntries = 5000 } = {}){
    this.concurrency = concurrency;
    this.timeoutMs = timeoutMs;
    this.maxCacheEntries = maxCacheEntries;
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

  _probe(url){
    return new Promise((resolve)=>{
      let done = false;
      const img = new Image();
      const finish = (ok)=>{ if(done) return; done = true; resolve(ok); };
      // 載入失敗或回傳極小的空白圖，視為無資料
      img.onload = ()=> finish(img.naturalWidth > 2 && img.naturalHeight > 2);
      img.onerror = ()=> finish(false);
      setTimeout(()=> finish(false), this.timeoutMs);
      img.src = url;
    });
  }

  // 探測單一網址是否有資料。優先讀快取，其次共用進行中的請求，
  // 都沒有才真的發送圖磚請求。
  checkOne(url){
    if(!url) return Promise.resolve(false);
    if(this.cache.has(url)) return Promise.resolve(this.cache.get(url));
    if(this.pending.has(url)) return this.pending.get(url);
    const promise = this._probe(url).then(ok=>{
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

  clearCache(){
    this.cache.clear();
    this.pending.clear();
  }
}
