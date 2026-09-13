/* ---------------------------------------------------------
   tests/specs/tile-load-guard.test.mjs
   ---------------------------------------------------------
   驗證 core/tileLoadGuard.js 的 createGuardedTileLoadFunction()：
     1. 邊界保護——圖磚座標跟 regionBbox 完全不相交時，直接
        tile.setState(EMPTY)，不建立/指定 <img src>（不發送請求）。
     2. 邊界內／沒有 regionBbox 時正常走逾時＋重試流程：
        - 正常載入 -> LOADED，只發送 1 次請求。
        - 逾時一次後重試成功 -> LOADED，發送 2 次請求。
        - 逾時兩次（含重試）-> ERROR，發送 2 次請求（不會有第三次）。
        - 明確 onerror（伺服器已回應但失敗）不重試，直接 ERROR，
          只發送 1 次請求。

   風格比照 tests/specs/tile-request-pool.test.mjs：自訂 FakeImage +
   urlResults 查找表模擬 onload/onerror/逾時；另外自訂 FakeTile 模擬
   OL 的 tile 物件（getTileCoord/getImage/setState）。
--------------------------------------------------------- */
import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import { createGuardedTileLoadFunction, DEFAULT_TILE_LOAD_TIMEOUT_MS, TILE_STATE } from '../../src/core/tileLoadGuard.js';
import { lonLatToTileXY } from '../../src/core/tileGeo.js';

const urlResults = {}; // url -> true(正常載入) | false(明確 onerror) | 'timeout-once' | 'timeout-always'
const urlAttempts = {};
const DELAY_MS = 5;

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
  const url = 'http://tile-load-guard/outside-bbox';
  urlResults[url] = true; // 就算真的載入一定成功，也不應該被呼叫到
  const tile = new FakeTile([TAIPEI_TILE.z, TAIPEI_TILE.x, TAIPEI_TILE.y]);
  const beforeAttempts = urlAttempts[url] || 0;

  const loadFn = createGuardedTileLoadFunction({ regionBbox: [110, 30, 112, 32], timeoutMs: 30 }); // 明顯不涵蓋台北
  loadFn(tile, url);

  assertEqual(tile.state, TILE_STATE.EMPTY, '邊界外的圖磚應該立刻被標記 EMPTY');
  assertEqual(urlAttempts[url] || 0, beforeAttempts, '邊界外的圖磚不應該發送任何請求');
});

test('邊界內：regionBbox 涵蓋圖磚座標，正常載入一次成功 -> LOADED', async () => {
  const url = 'http://tile-load-guard/inside-bbox';
  urlResults[url] = true;
  const tile = new FakeTile([TAIPEI_TILE.z, TAIPEI_TILE.x, TAIPEI_TILE.y]);

  const loadFn = createGuardedTileLoadFunction({ regionBbox: TAIPEI_BBOX, timeoutMs: 500 });
  loadFn(tile, url);

  const state = await waitForState(tile);
  assertEqual(state, TILE_STATE.LOADED, '邊界內、正常回應的圖磚應該是 LOADED');
  assertEqual(urlAttempts[url], 1, '正常載入只應該發送 1 次請求');
});

test('沒有 regionBbox（custom: 情境）：任何座標都不應被誤判 EMPTY，照常走載入流程', async () => {
  const url = 'http://tile-load-guard/no-bbox';
  urlResults[url] = true;
  const tile = new FakeTile([TAIPEI_TILE.z, TAIPEI_TILE.x, TAIPEI_TILE.y]);

  const loadFn = createGuardedTileLoadFunction({ timeoutMs: 500 }); // 不傳 regionBbox
  loadFn(tile, url);

  const state = await waitForState(tile);
  assertEqual(state, TILE_STATE.LOADED, '沒有 regionBbox 時應該正常載入成功，不應該被誤判為 EMPTY');
  assertEqual(urlAttempts[url], 1, '應該有真的發送請求');
});

test('逾時一次後重試成功 -> LOADED，共發送 2 次請求', async () => {
  const url = 'http://tile-load-guard/timeout-once';
  urlResults[url] = 'timeout-once';
  const tile = new FakeTile([TAIPEI_TILE.z, TAIPEI_TILE.x, TAIPEI_TILE.y]);

  const loadFn = createGuardedTileLoadFunction({ regionBbox: TAIPEI_BBOX, timeoutMs: 20 });
  loadFn(tile, url);

  const state = await waitForState(tile);
  assertEqual(state, TILE_STATE.LOADED, '逾時一次後重試成功，最終應該是 LOADED');
  assertEqual(urlAttempts[url], 2, '應該總共發送 2 次請求（第一次逾時 + 重試 1 次）');
});

test('逾時兩次（含重試）-> ERROR，只重試 1 次、不會有第 3 次請求', async () => {
  const url = 'http://tile-load-guard/timeout-always';
  urlResults[url] = 'timeout-always';
  const tile = new FakeTile([TAIPEI_TILE.z, TAIPEI_TILE.x, TAIPEI_TILE.y]);

  const loadFn = createGuardedTileLoadFunction({ regionBbox: TAIPEI_BBOX, timeoutMs: 20 });
  loadFn(tile, url);

  const state = await waitForState(tile);
  assertEqual(state, TILE_STATE.ERROR, '持續逾時，重試後仍失敗，最終應該是 ERROR');
  assertEqual(urlAttempts[url], 2, '只應該重試 1 次，總共 2 次請求，不會有第 3 次');
});

test('明確 onerror（伺服器已回應但失敗）不重試，直接 ERROR，只發送 1 次請求', async () => {
  const url = 'http://tile-load-guard/explicit-error';
  urlResults[url] = false;
  const tile = new FakeTile([TAIPEI_TILE.z, TAIPEI_TILE.x, TAIPEI_TILE.y]);

  const loadFn = createGuardedTileLoadFunction({ regionBbox: TAIPEI_BBOX, timeoutMs: 500 });
  loadFn(tile, url);

  const state = await waitForState(tile);
  assertEqual(state, TILE_STATE.ERROR, '明確 onerror 應該直接判定 ERROR');
  assertEqual(urlAttempts[url], 1, '明確失敗不應該重試，只應該發送 1 次請求');
});

test('DEFAULT_TILE_LOAD_TIMEOUT_MS 應該明顯短於 tileChecker.js 的預設值（6000ms），確認兩者刻意分開設定', () => {
  assertTrue(DEFAULT_TILE_LOAD_TIMEOUT_MS < 6000, `預設逾時應該明顯短於背景探測用的 6000ms，實際 ${DEFAULT_TILE_LOAD_TIMEOUT_MS}`);
  assertTrue(DEFAULT_TILE_LOAD_TIMEOUT_MS > 0, '預設逾時應該是正數');
});

await run();
