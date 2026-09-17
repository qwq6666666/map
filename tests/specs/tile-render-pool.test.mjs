/* ---------------------------------------------------------
   tests/specs/tile-render-pool.test.mjs
   ---------------------------------------------------------
   驗證 core/tileRenderPool.js 的 tileRenderRequestPool：歷史／自訂
   圖層圖磚渲染節流池，限制同時真正在進行中的圖磚請求數不超過
   TILE_RENDER_MAX_CONCURRENCY，超過上限的請求先排隊、不會一次全部
   發送；slot 釋放後排隊中的請求應該能依序完成，且每個網址仍然只發送
   1 次請求（排隊不應該造成重複發送）。

   從 tests/specs/tile-load-guard.test.mjs 拆分而來（原檔案已依
   core/tileLoadGuard.js 拆成 tileBoundaryGuard.js／tileRenderPool.js／
   tileTimeoutRetry.js 三個獨立模組 + 組合層），案例逐字保留，只是搬移
   到對應模組的測試檔案。透過組合層 createGuardedTileLoadFunction()
   （而非直接呼叫 tileRenderRequestPool.run()）驗證：真正的使用情境是
   「每次送出 <img src> 前都要先跟這個池要一個 slot」，直接測組合層
   送出多顆圖磚後的池狀態，比自己編造 fn() 呼叫更貼近實際行為。

   slot 有空位時，TileRenderPool.run() 會同步呼叫 fn()（刻意不用
   async function 包裝，理由見 core/tileRenderPool.js 檔頭註解），所以
   下面這個測試不需要等任何 tick，送出全部請求後就能立刻同步檢查
   active／queued 是否符合節流上限。

   風格比照 tests/specs/tile-request-pool.test.mjs：自訂 FakeImage +
   urlResults 查找表模擬 onload/onerror/逾時；另外自訂 FakeTile 模擬
   OL 的 tile 物件（getTileCoord/getImage/setState）。
--------------------------------------------------------- */
import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import {
  createGuardedTileLoadFunction,
  TILE_STATE,
  TILE_RENDER_MAX_CONCURRENCY,
  tileRenderRequestPool,
} from '../../src/core/tileLoadGuard.js';
import { lonLatToTileXY } from '../../src/core/tileGeo.js';

const urlResults = {}; // url -> true(正常載入) | false(明確 onerror) | 'timeout-once' | 'timeout-always'
const urlAttempts = {};
const DELAY_MS = 5;

// 跟其他測試檔案（tile-checker.test.mjs／neighbor-tile-fallback.test.mjs／
// tile-request-pool.test.mjs／spatial-index.test.mjs，已抽成共用的
// tests/tileImageStub.mjs）刻意分開維護，不套用同一個
// createTileImageStub() factory：這裡的觸發時機是 `set src(v)`（配合
// tileLoadGuard.js 逾時後清空 `src=''` 中止載入的語意，空字串不算一次
// 新的嘗試），跟其他檔案「constructor 就觸發」的語意不同；硬套同一個
// factory 只會讓 API 變得彆扭難懂。
class FakeImage {
  set src(v){
    if(v === '') return; // guard 逾時後會清空 src 中止載入，不算一次新的嘗試
    this._url = v;
    urlAttempts[v] = (urlAttempts[v] || 0) + 1;
    const attemptNo = urlAttempts[v];
    const spec = urlResults[v];
    const isTimeoutAttempt = spec === 'timeout-always' || (spec === 'timeout-once' && attemptNo === 1);
    if(isTimeoutAttempt) return; // 完全不呼叫 onload/onerror，模擬逾時
    setTimeout(() => {
      if(spec === false){ if(this.onerror) this.onerror(); return; }
      if(this.onload) this.onload();
    }, DELAY_MS);
  }
}

class FakeTile {
  constructor(tileCoord){
    this._tileCoord = tileCoord; // [z, x, y]
    this._image = new FakeImage();
    this.state = null;
  }
  getTileCoord(){ return this._tileCoord; }
  getImage(){ return this._image; }
  setState(s){ this.state = s; }
}

function withTimeout(promise, ms, msg){
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(msg || `超過 ${ms}ms 沒有完成，可能發生 deadlock`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function waitForState(tile, timeoutMs = 5000){
  return withTimeout(new Promise(resolve => {
    const check = () => {
      if(tile.state !== null) return resolve(tile.state);
      setTimeout(check, 2);
    };
    check();
  }), timeoutMs, '圖磚一直沒有進入最終狀態（可能發生 deadlock）');
}

// 台北市中心一顆有效的 tile 座標，供不需要特別測邊界的案例共用
const TAIPEI_TILE = lonLatToTileXY(121.5654, 25.0330, 15);

test('tileRenderRequestPool：節流池併發上限，超過 TILE_RENDER_MAX_CONCURRENCY 的請求會先排隊，不會一次全部發送', async () => {
  assertEqual(TILE_RENDER_MAX_CONCURRENCY, 4, '目前拍板的上限應該是 4，調整上限時記得同步更新這條斷言');

  const total = 8;
  const urls = Array.from({ length: total }, (_, i) => `http://tile-render-pool/render-pool-${i}`);
  urls.forEach(u => { urlResults[u] = true; });
  const tiles = urls.map(() => new FakeTile([TAIPEI_TILE.z, TAIPEI_TILE.x, TAIPEI_TILE.y]));

  const loadFn = createGuardedTileLoadFunction({ timeoutMs: 5000 }); // 夠長，確保不會被逾時機制搶先判定
  urls.forEach((u, i) => loadFn(tiles[i], u));

  assertEqual(tileRenderRequestPool.getStats().active, TILE_RENDER_MAX_CONCURRENCY, `8 顆圖磚一次送出，應該立刻佔滿節流池上限 ${TILE_RENDER_MAX_CONCURRENCY} 個 slot`);
  assertEqual(tileRenderRequestPool.getStats().queued, total - TILE_RENDER_MAX_CONCURRENCY, '超過上限的請求應該先排隊，不能一次全部發送');

  await Promise.all(tiles.map(t => waitForState(t)));

  tiles.forEach((t, i) => assertEqual(t.state, TILE_STATE.LOADED, `第 ${i} 顆圖磚排隊後仍應該正常載入成功`));
  urls.forEach(u => assertEqual(urlAttempts[u], 1, '每個網址應該只發送 1 次請求，排隊不應該造成重複發送'));
  assertEqual(tileRenderRequestPool.getStats().active, 0, '全部完成後，節流池的 active 應該歸零');
  assertTrue(tileRenderRequestPool.getStats().maxObserved <= TILE_RENDER_MAX_CONCURRENCY, `maxObserved 不應該超過上限 ${TILE_RENDER_MAX_CONCURRENCY}`);
});

await run();
