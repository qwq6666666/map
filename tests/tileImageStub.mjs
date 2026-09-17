/* ---------------------------------------------------------
   tests/tileImageStub.mjs — 共用的假 Image（圖磚探測用）
   ---------------------------------------------------------
   tile-checker.test.mjs／neighbor-tile-fallback.test.mjs／
   tile-request-pool.test.mjs／spatial-index.test.mjs 這 4 份測試檔案
   原本各自手刻一份行為幾乎一樣的假 `globalThis.Image`：constructor
   觸發、`setTimeout` 模擬網路延遲後依 `urlResults[url]` 的 spec 決定
   要不要呼叫 `onload`/`onerror`（或完全不呼叫、模擬逾時）。抽成這裡的
   `createTileImageStub()` factory，四邊改成呼叫它，避免重複維護四份
   幾乎相同的邏輯。

   注意：`tile-load-guard.test.mjs` 的假 Image（`FakeImage`）刻意沒有
   整合進這個 factory——它的觸發時機是 `set src(v)`（不是 constructor），
   配合 `tileLoadGuard.js` 逾時後清空 `src=''` 中止載入的語意，`src`
   為空字串時不算一次新的嘗試；這跟這裡 4 個檔案「constructor 就觸發」
   的語意不同，硬套同一個 factory 只會讓 API 變得彆扭難懂，見該檔案
   自己的說明註解。

   spec 詞彙（`urlResults[url]` 的值，比照 neighbor-tile-fallback.test.mjs
   原本就有的最豐富版本）：
     true / undefined  — 成功（onload，預設值，未設定時視為成功）
     false             — 伺服器明確回應沒有資料（onerror）
     'tiny'            — 伺服器明確回應了，但圖太小（onload 但視為無資料）
     'timeout-once'    — 第一次探測完全不回應、觸發逾時；之後每次成功
     'timeout-always'  — 每一次探測都完全不回應、一律觸發逾時
--------------------------------------------------------- */

/**
 * @param {object} [options]
 * @param {object} [options.urlResults] 網址 -> spec 的對照表（同一個物件參照，
 *   呼叫端之後繼續 mutate 這個物件也會生效，不需要重新建立 class）。
 * @param {number} [options.delayMs=1] 模擬網路延遲的毫秒數。
 * @param {(instance: any) => void} [options.onConstruct] 每次 `new Image()`
 *   時同步呼叫一次，供呼叫端疊加自己的計數／併發追蹤邏輯
 *   （例如 tile-request-pool.test.mjs 的 liveImages/maxLiveImages）。
 * @param {(instance: any) => void} [options.onSettle] 延遲時間到、正要決定
 *   這次探測結果之前呼叫一次（在 onload/onerror 之前），供呼叫端疊加
 *   「這個模擬請求即將結束」的計數邏輯。
 * @returns {new () => any} 可以直接指派給 `globalThis.Image` 的假 class。
 */
export function createTileImageStub({ urlResults = {}, delayMs = 1, onConstruct, onSettle } = {}){
  const urlAttempts = {}; // url -> 已經被探測過幾次，只用來判斷 'timeout-once'
  return class {
    constructor(){
      onConstruct?.(this);
      const self = this;
      setTimeout(() => {
        onSettle?.(self);
        const url = self._url;
        urlAttempts[url] = (urlAttempts[url] || 0) + 1;
        const spec = urlResults[url];
        const isTimeoutAttempt = spec === 'timeout-always' ||
          (spec === 'timeout-once' && urlAttempts[url] === 1);
        if(isTimeoutAttempt) return; // 完全不呼叫 onload/onerror，模擬逾時
        if(spec === false){ if(self.onerror) self.onerror(); return; }
        const size = spec === 'tiny' ? 1 : 10;
        self.naturalWidth = size;
        self.naturalHeight = size;
        if(self.onload) self.onload();
      }, delayMs);
    }
    set src(v){ this._url = v; }
  };
}
