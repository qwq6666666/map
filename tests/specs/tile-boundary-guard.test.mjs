/* ---------------------------------------------------------
   tests/specs/tile-boundary-guard.test.mjs
   ---------------------------------------------------------
   驗證 core/tileBoundaryGuard.js 的邊界保護：圖磚座標跟圖層
   region.bbox 比對後決定要不要送出請求。

     - 完全不相交 -> 直接 tile.setState(EMPTY)，不建立/指定 <img src>
       （不發送請求）。
     - 相交／沒有 regionBbox（custom: 圖層情境）-> 正常放行，繼續走
       core/tileTimeoutRetry.js 的逾時重試流程（逾時重試本身的行為見
       tests/specs/tile-timeout-retry.test.mjs，這裡只驗證邊界保護
       沒有誤擋合法請求，最終仍能正常 LOADED）。

   從 tests/specs/tile-load-guard.test.mjs 拆分而來（原檔案已依
   core/tileLoadGuard.js 拆成 tileBoundaryGuard.js／tileRenderPool.js／
   tileTimeoutRetry.js 三個獨立模組 + 組合層），案例本身逐字保留，只是
   搬移到對應模組的測試檔案。透過組合層 createGuardedTileLoadFunction()
   （而非直接呼叫 applyTileBoundaryGuard()）驗證：這樣才能同時確認
   「邊界外真的完全不觸發任何請求」與「邊界內/無 bbox 時仍能正常走完
   整個載入流程」，比只測 applyTileBoundaryGuard() 回傳值更貼近實際
   使用情境。

   風格比照 tests/specs/tile-request-pool.test.mjs：自訂 FakeImage +
   urlResults 查找表模擬 onload/onerror/逾時；另外自訂 FakeTile 模擬
   OL 的 tile 物件（getTileCoord/getImage/setState）。
--------------------------------------------------------- */
import '../env-stub.mjs';
import { test, run, assertEqual } from '../assert.mjs';
import {
  createGuardedTileLoadFunction,
  TILE_STATE,
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
const TAIPEI_BBOX = [119, 21, 123, 26]; // 概略涵蓋台灣本島

test('邊界外：regionBbox 跟圖磚座標完全不相交 -> 直接 EMPTY，不建立任何請求', async () => {
  const url = 'http://tile-boundary-guard/outside-bbox';
  urlResults[url] = true; // 就算真的載入一定成功，也不應該被呼叫到
  const tile = new FakeTile([TAIPEI_TILE.z, TAIPEI_TILE.x, TAIPEI_TILE.y]);
  const beforeAttempts = urlAttempts[url] || 0;

  const loadFn = createGuardedTileLoadFunction({ regionBbox: [110, 30, 112, 32], timeoutMs: 30 }); // 明顯不涵蓋台北
  loadFn(tile, url);

  assertEqual(tile.state, TILE_STATE.EMPTY, '邊界外的圖磚應該立刻被標記 EMPTY');
  assertEqual(urlAttempts[url] || 0, beforeAttempts, '邊界外的圖磚不應該發送任何請求');
});

test('邊界內：regionBbox 涵蓋圖磚座標，正常載入一次成功 -> LOADED', async () => {
  const url = 'http://tile-boundary-guard/inside-bbox';
  urlResults[url] = true;
  const tile = new FakeTile([TAIPEI_TILE.z, TAIPEI_TILE.x, TAIPEI_TILE.y]);

  const loadFn = createGuardedTileLoadFunction({ regionBbox: TAIPEI_BBOX, timeoutMs: 500 });
  loadFn(tile, url);

  const state = await waitForState(tile);
  assertEqual(state, TILE_STATE.LOADED, '邊界內、正常回應的圖磚應該是 LOADED');
  assertEqual(urlAttempts[url], 1, '正常載入只應該發送 1 次請求');
});

test('沒有 regionBbox（custom: 情境）：任何座標都不應被誤判 EMPTY，照常走載入流程', async () => {
  const url = 'http://tile-boundary-guard/no-bbox';
  urlResults[url] = true;
  const tile = new FakeTile([TAIPEI_TILE.z, TAIPEI_TILE.x, TAIPEI_TILE.y]);

  const loadFn = createGuardedTileLoadFunction({ timeoutMs: 500 }); // 不傳 regionBbox
  loadFn(tile, url);

  const state = await waitForState(tile);
  assertEqual(state, TILE_STATE.LOADED, '沒有 regionBbox 時應該正常載入成功，不應該被誤判為 EMPTY');
  assertEqual(urlAttempts[url], 1, '應該有真的發送請求');
});

await run();
