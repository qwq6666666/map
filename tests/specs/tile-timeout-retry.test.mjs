/* ---------------------------------------------------------
   tests/specs/tile-timeout-retry.test.mjs
   ---------------------------------------------------------
   驗證 core/tileTimeoutRetry.js：
     1. loadWithTimeoutRetry()（透過組合層 createGuardedTileLoadFunction()
        觸發）：
        - 正常載入 -> LOADED，只發送 1 次請求。
        - 逾時一次後重試成功 -> LOADED，發送 2 次請求。
        - 逾時兩次（含重試）-> ERROR，發送 2 次請求（不會有第三次）。
        - 明確 onerror（伺服器已回應但失敗）不重試，直接 ERROR，只發送
          1 次請求。
     2. DEFAULT_TILE_LOAD_TIMEOUT_MS：常數本身跟 tileChecker.js 的
        6000ms 刻意分開設定。
     3. 逾時終局失敗的冷卻重試候選名單（timeoutFailedGuardedTiles）：
        冷卻時間已過／還沒過的撥回 IDLE 行為、明確 onerror 永遠不撥回、
        每顆 tile 只有一次額外機會、abortInFlightForKey() 一併清掉屬於
        該 key 的候選。這些行為的「撥回」動作實際是組合層
        core/tileLoadGuard.js 的 sweepStaleGuardedTiles()（透過
        attachStaleTileAbort() 掛的 moveend 觸發）在做，但候選名單本身
        （TIMEOUT_RETRY_COOLDOWN_MS／登記時機／每顆 tile 只有一次機會）
        是 tileTimeoutRetry.js 的職責，所以測試留在這裡。
     4. getRecentTileFailures()／clearRecentTileFailures()：供
        ui/sourceStatusUI.js「最近圖磚載入失敗」面板顯示的診斷紀錄。

   從 tests/specs/tile-load-guard.test.mjs 拆分而來（原檔案已依
   core/tileLoadGuard.js 拆成 tileBoundaryGuard.js／tileRenderPool.js／
   tileTimeoutRetry.js 三個獨立模組 + 組合層），案例逐字保留，只是搬移
   到對應模組的測試檔案。

   風格比照 tests/specs/tile-request-pool.test.mjs：自訂 FakeImage +
   urlResults 查找表模擬 onload/onerror/逾時；另外自訂 FakeTile 模擬
   OL 的 tile 物件（getTileCoord/getImage/setState）；冷卻重試候選相關
   案例額外自訂一個 makeFakeMap()，只實作 attachStaleTileAbort() 實際
   用到的 map/view API 子集（on/getView/getSize，view 的
   getResolution/getCenter/getZoom/calculateExtent/getProjection），不是
   完整的 ol.Map 模擬。
--------------------------------------------------------- */
import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import {
  createGuardedTileLoadFunction,
  DEFAULT_TILE_LOAD_TIMEOUT_MS,
  TILE_STATE,
  attachStaleTileAbort,
  getRecentTileFailures,
  clearRecentTileFailures,
  RECENT_TILE_FAILURE_LIMIT,
  TIMEOUT_RETRY_COOLDOWN_MS,
  abortInFlightForKey,
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

// 只實作冷卻重試候選案例實際用到的 map/view API 子集：on('moveend', ...)
// （記住 handler，供測試用 _trigger() 手動觸發）、getView()／getSize()，
// view 上的 getResolution/getCenter/getZoom/calculateExtent/getProjection。
// calculateExtent() 不理會傳入的 size 參數，直接回傳目前 extent（測試
// 只關心「掃描比對用的目前可視範圍」，不需要真的模擬依視窗尺寸換算
// extent 的邏輯）。ol.proj.transformExtent 在 env-stub.mjs 裡是 identity
// （直接回傳傳入的 extent，不理會來源/目標投影參數），所以這裡回傳的
// extent 可以直接當成呼叫端拿到的 WGS84 extent 使用，不需要另外做座標
// 轉換。
function makeFakeMap({ zoom, extent, size = [800, 600], resolution = 100, center = [0, 0] }){
  const handlers = {};
  const view = {
    getResolution: () => resolution,
    getCenter: () => center,
    getZoom: () => zoom,
    calculateExtent: () => extent,
    getRotation: () => 0,
    getProjection: () => 'EPSG:3857',
    on(){}, // 這裡的案例都用 moveend（不節流），不需要節流版 change:center 監聽
  };
  return {
    on(ev, fn){ (handlers[ev] = handlers[ev] || []).push(fn); },
    _trigger(ev){ (handlers[ev] || []).forEach(fn => fn()); },
    getView(){ return view; },
    getSize(){ return size; },
  };
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

test('逾時一次後重試成功 -> LOADED，共發送 2 次請求', async () => {
  const url = 'http://tile-timeout-retry/timeout-once';
  urlResults[url] = 'timeout-once';
  const tile = new FakeTile([TAIPEI_TILE.z, TAIPEI_TILE.x, TAIPEI_TILE.y]);

  const loadFn = createGuardedTileLoadFunction({ regionBbox: TAIPEI_BBOX, timeoutMs: 20 });
  loadFn(tile, url);

  const state = await waitForState(tile);
  assertEqual(state, TILE_STATE.LOADED, '逾時一次後重試成功，最終應該是 LOADED');
  assertEqual(urlAttempts[url], 2, '應該總共發送 2 次請求（第一次逾時 + 重試 1 次）');
});

test('逾時兩次（含重試）-> ERROR，只重試 1 次、不會有第 3 次請求', async () => {
  const url = 'http://tile-timeout-retry/timeout-always';
  urlResults[url] = 'timeout-always';
  const tile = new FakeTile([TAIPEI_TILE.z, TAIPEI_TILE.x, TAIPEI_TILE.y]);

  const loadFn = createGuardedTileLoadFunction({ regionBbox: TAIPEI_BBOX, timeoutMs: 20 });
  loadFn(tile, url);

  const state = await waitForState(tile);
  assertEqual(state, TILE_STATE.ERROR, '持續逾時，重試後仍失敗，最終應該是 ERROR');
  assertEqual(urlAttempts[url], 2, '只應該重試 1 次，總共 2 次請求，不會有第 3 次');
});

test('明確 onerror（伺服器已回應但失敗）不重試，直接 ERROR，只發送 1 次請求', async () => {
  const url = 'http://tile-timeout-retry/explicit-error';
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

/* ---------------------------------------------------------
   Bug 修正回歸：逾時終局失敗的冷卻重試（timeoutFailedGuardedTiles）
   ---------------------------------------------------------
   背景：使用者回報「圖磚原地不動、不縮放的話永遠空白」——
   loadWithTimeoutRetry() 判定的逾時終局失敗，視角根本沒換過，
   attachStaleTileAbort() 的 z／bbox 過期判斷永遠不會命中，需要另一套
   「冷卻一段時間後給一次額外重試機會」的機制才能救回來。

   以下測試透過 mock Date.now()（比照 wmts-import.test.mjs 既有手法）
   模擬「時間經過」，不需要真的等待 TIMEOUT_RETRY_COOLDOWN_MS（8000ms）
   那麼久；loadWithTimeoutRetry() 內部的逾時計時器本身用的是真正的
   setTimeout（不受 Date.now() mock 影響，只影響雙方拿去算冷卻時間差
   的時間戳記），所以搭配很短的 timeoutMs（20ms）可以讓終局失敗很快
   發生，冷卻時間則靠 mock 的 now 變數直接快轉。
--------------------------------------------------------- */
test('逾時終局失敗、冷卻時間已過、tile 仍在目前可視範圍內 -> sweep 後應撥回 IDLE，且重新指定 src 後可以再次成功 LOADED', async () => {
  const url = 'http://tile-timeout-retry/cooldown-retry-success';
  urlResults[url] = 'timeout-always';
  const tile = new FakeTile([TAIPEI_TILE.z, TAIPEI_TILE.x, TAIPEI_TILE.y]);

  const originalDateNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  try{
    const loadFn = createGuardedTileLoadFunction({ regionBbox: TAIPEI_BBOX, timeoutMs: 20 });
    loadFn(tile, url);
    const state = await waitForState(tile);
    assertEqual(state, TILE_STATE.ERROR, '前置條件：逾時重試一次後仍逾時，應該終局判定 ERROR');
    assertEqual(urlAttempts[url], 2, '前置條件：終局失敗前應該已經重試過 1 次，共 2 次請求');

    now += TIMEOUT_RETRY_COOLDOWN_MS + 1000; // 快轉到冷卻時間已過

    const fakeMap = makeFakeMap({ zoom: TAIPEI_TILE.z, extent: TAIPEI_BBOX });
    attachStaleTileAbort(fakeMap);
    fakeMap._trigger('moveend');

    assertEqual(tile.state, TILE_STATE.IDLE, '冷卻時間已過、bbox 仍與目前可視範圍相交，應該被 sweep 撥回 IDLE');

    // 不是只有狀態變化：驗證撥回 IDLE 後，模擬 OL 重新呼叫
    // tileLoadFunction（等同圖磚重新進入可視範圍）真的可以再次成功。
    urlResults[url] = true;
    loadFn(tile, url);
    const finalState = await withTimeout(new Promise(resolve => {
      const check = () => {
        if(tile.state === TILE_STATE.LOADED || tile.state === TILE_STATE.ERROR) return resolve(tile.state);
        setTimeout(check, 2);
      };
      check();
    }), 5000, '撥回 IDLE 後重新載入一直沒有進入 LOADED/ERROR（可能發生 deadlock）');
    assertEqual(finalState, TILE_STATE.LOADED, '撥回 IDLE 後重新載入應該能正常成功 LOADED');
    assertEqual(urlAttempts[url], 3, '應該有真的發送第 3 次請求（前 2 次是終局失敗前的逾時嘗試，第 3 次才是冷卻重試後的重新載入）');
  }finally{
    Date.now = originalDateNow;
  }
});

test('abortInFlightForKey：圖層被移除時，也要清掉 timeoutFailedGuardedTiles 裡屬於這個 key 的冷卻重試候選（回歸：曾經只清 inFlightGuardedTiles，孤兒 entry 會留到冷卻時間到或名單滿了才消失）', async () => {
  const url = 'http://tile-timeout-retry/abort-by-key-cooldown';
  urlResults[url] = 'timeout-always';
  const tile = new FakeTile([TAIPEI_TILE.z, TAIPEI_TILE.x, TAIPEI_TILE.y]);
  const sourceKey = 'hist:test:abort-cooldown-layer:jpg';

  const originalDateNow = Date.now;
  let now = 1_700_000_200_000;
  Date.now = () => now;
  try{
    const loadFn = createGuardedTileLoadFunction({ regionBbox: TAIPEI_BBOX, timeoutMs: 20, sourceKey });
    loadFn(tile, url);
    const state = await waitForState(tile);
    assertEqual(state, TILE_STATE.ERROR, '前置條件：逾時重試一次後仍逾時，應該終局判定 ERROR，並登記進冷卻重試候選名單');

    // 圖層被移除（比照 core/layerCache.js 的 removeCachedLayer()）：這個
    // key 底下的冷卻重試候選應該被一併清掉。
    abortInFlightForKey(sourceKey);

    now += TIMEOUT_RETRY_COOLDOWN_MS + 1000; // 快轉到冷卻時間已過
    const fakeMap = makeFakeMap({ zoom: TAIPEI_TILE.z, extent: TAIPEI_BBOX });
    attachStaleTileAbort(fakeMap);
    fakeMap._trigger('moveend');

    assertEqual(tile.state, TILE_STATE.ERROR, '候選已經被 abortInFlightForKey 清掉，之後的 sweep 不應該再把它撥回 IDLE');
  }finally{
    Date.now = originalDateNow;
  }
});

test('逾時終局失敗、冷卻時間還沒過 -> sweep 後應該維持 ERROR，不會被撥回', async () => {
  const url = 'http://tile-timeout-retry/cooldown-retry-too-soon';
  urlResults[url] = 'timeout-always';
  const tile = new FakeTile([TAIPEI_TILE.z, TAIPEI_TILE.x, TAIPEI_TILE.y]);

  const originalDateNow = Date.now;
  let now = 1_700_000_100_000;
  Date.now = () => now;
  try{
    const loadFn = createGuardedTileLoadFunction({ regionBbox: TAIPEI_BBOX, timeoutMs: 20 });
    loadFn(tile, url);
    const state = await waitForState(tile);
    assertEqual(state, TILE_STATE.ERROR, '前置條件：逾時重試一次後仍逾時，應該終局判定 ERROR');

    now += TIMEOUT_RETRY_COOLDOWN_MS - 1000; // 快轉到「還沒到」冷卻時間

    const fakeMap = makeFakeMap({ zoom: TAIPEI_TILE.z, extent: TAIPEI_BBOX });
    attachStaleTileAbort(fakeMap);
    fakeMap._trigger('moveend');

    assertEqual(tile.state, TILE_STATE.ERROR, '冷卻時間還沒到，不應該被撥回 IDLE，應該留著等下次 sweep');
  }finally{
    Date.now = originalDateNow;
  }
});

test('明確 onerror 終局失敗，即使冷卻時間過了很久、tile 在目前可視範圍內 -> sweep 後仍應維持 ERROR，永遠不會被撥回', async () => {
  const url = 'http://tile-timeout-retry/cooldown-retry-explicit-error-excluded';
  urlResults[url] = false; // 明確 onerror，不是逾時
  const tile = new FakeTile([TAIPEI_TILE.z, TAIPEI_TILE.x, TAIPEI_TILE.y]);

  const originalDateNow = Date.now;
  let now = 1_700_000_200_000;
  Date.now = () => now;
  try{
    const loadFn = createGuardedTileLoadFunction({ regionBbox: TAIPEI_BBOX, timeoutMs: 500 });
    loadFn(tile, url);
    const state = await waitForState(tile);
    assertEqual(state, TILE_STATE.ERROR, '前置條件：明確 onerror 應該直接終局判定 ERROR');
    assertEqual(urlAttempts[url], 1, '前置條件：明確失敗不應該重試，只發送 1 次請求');

    now += TIMEOUT_RETRY_COOLDOWN_MS * 100; // 遠超過冷卻時間，排除「其實只是還沒到」的可能

    const fakeMap = makeFakeMap({ zoom: TAIPEI_TILE.z, extent: TAIPEI_BBOX });
    attachStaleTileAbort(fakeMap);
    fakeMap._trigger('moveend');

    assertEqual(tile.state, TILE_STATE.ERROR, '明確 onerror 判定的失敗刻意不納入冷卻重試名單，不論冷卻多久都不應該被撥回 IDLE');
  }finally{
    Date.now = originalDateNow;
  }
});

test('逾時終局失敗撥回 IDLE 一次後，若再次逾時終局失敗 -> 每顆 tile 只有一次額外機會，不會有第二次冷卻重試', async () => {
  const url = 'http://tile-timeout-retry/cooldown-retry-once-only';
  urlResults[url] = 'timeout-always';
  const tile = new FakeTile([TAIPEI_TILE.z, TAIPEI_TILE.x, TAIPEI_TILE.y]);

  const originalDateNow = Date.now;
  let now = 1_700_000_300_000;
  Date.now = () => now;
  try{
    const loadFn = createGuardedTileLoadFunction({ regionBbox: TAIPEI_BBOX, timeoutMs: 20 });
    loadFn(tile, url);
    let state = await waitForState(tile);
    assertEqual(state, TILE_STATE.ERROR, '前置條件：第一次逾時重試一次後仍逾時，應該終局判定 ERROR');
    assertEqual(urlAttempts[url], 2, '前置條件：第一次終局失敗前應該重試過 1 次，共 2 次請求');

    now += TIMEOUT_RETRY_COOLDOWN_MS + 1000; // 第一次冷卻時間已過
    const fakeMap1 = makeFakeMap({ zoom: TAIPEI_TILE.z, extent: TAIPEI_BBOX });
    attachStaleTileAbort(fakeMap1);
    fakeMap1._trigger('moveend');
    assertEqual(tile.state, TILE_STATE.IDLE, '第一次冷卻重試機會：應該被撥回 IDLE');

    // 模擬圖磚重新進入可視範圍、OL 重新呼叫 tileLoadFunction；這次同樣
    // 持續逾時（urlResults[url] 仍是 'timeout-always'），驗證再次終局
    // 失敗的行為。
    loadFn(tile, url);
    state = await withTimeout(new Promise(resolve => {
      const check = () => {
        if(tile.state === TILE_STATE.ERROR) return resolve(tile.state);
        setTimeout(check, 2);
      };
      check();
    }), 5000, '第二次逾時後一直沒有回到 ERROR（可能發生 deadlock）');
    assertEqual(state, TILE_STATE.ERROR, '第二次逾時重試一次後仍逾時，應該再次終局判定 ERROR');
    assertEqual(urlAttempts[url], 4, '第二次終局失敗前應該又重試過 1 次，累計共 4 次請求');

    now += TIMEOUT_RETRY_COOLDOWN_MS + 1000; // 再快轉過一次完整冷卻時間
    const fakeMap2 = makeFakeMap({ zoom: TAIPEI_TILE.z, extent: TAIPEI_BBOX });
    attachStaleTileAbort(fakeMap2);
    fakeMap2._trigger('moveend');

    assertEqual(tile.state, TILE_STATE.ERROR, '每顆 tile 物件只有一次額外冷卻重試機會，第二次終局失敗不應該再被登記、不會再被撥回 IDLE');
  }finally{
    Date.now = originalDateNow;
  }
});

/* ---------------------------------------------------------
   getRecentTileFailures() / clearRecentTileFailures()：供
   ui/sourceStatusUI.js「最近圖磚載入失敗」面板顯示的診斷紀錄。
   --------------------------------------------------------- */
test('recordTileFailure：明確 onerror 會記錄一筆 reason=error，帶正確的 label／座標', async () => {
  clearRecentTileFailures(); // 清掉前面其他案例累積的紀錄，取得乾淨的比對基準
  const url = 'http://tile-timeout-retry/failure-log-explicit-error';
  urlResults[url] = false;
  const tile = new FakeTile([TAIPEI_TILE.z, TAIPEI_TILE.x, TAIPEI_TILE.y]);

  const loadFn = createGuardedTileLoadFunction({ regionBbox: TAIPEI_BBOX, timeoutMs: 500, label: '測試圖層／明確錯誤' });
  loadFn(tile, url);
  await waitForState(tile);

  const failures = getRecentTileFailures();
  assertEqual(failures.length, 1, '明確 onerror 應該記錄剛好 1 筆失敗');
  assertEqual(failures[0].reason, 'error', '失敗原因應該分類成 error');
  assertEqual(failures[0].label, '測試圖層／明確錯誤', '應該帶上呼叫端傳入的 label');
  assertEqual(failures[0].z, TAIPEI_TILE.z, '應該記錄正確的 z');
  assertEqual(failures[0].x, TAIPEI_TILE.x, '應該記錄正確的 x');
  assertEqual(failures[0].y, TAIPEI_TILE.y, '應該記錄正確的 y');
});

test('recordTileFailure：逾時兩次（含重試）後仍失敗，只記錄 1 筆 reason=timeout（不是每次逾時都記）', async () => {
  clearRecentTileFailures();
  const url = 'http://tile-timeout-retry/failure-log-timeout';
  urlResults[url] = 'timeout-always';
  const tile = new FakeTile([TAIPEI_TILE.z, TAIPEI_TILE.x, TAIPEI_TILE.y]);

  const loadFn = createGuardedTileLoadFunction({ regionBbox: TAIPEI_BBOX, timeoutMs: 20, label: '測試圖層／逾時' });
  loadFn(tile, url);
  await waitForState(tile);

  const failures = getRecentTileFailures();
  assertEqual(failures.length, 1, '重試一次後仍逾時，最終只應該記錄 1 筆（第一次逾時只是觸發重試，不算最終失敗）');
  assertEqual(failures[0].reason, 'timeout', '失敗原因應該分類成 timeout');
  assertEqual(failures[0].label, '測試圖層／逾時', '應該帶上呼叫端傳入的 label');
});

test('recordTileFailure：正常載入成功不應該留下任何失敗紀錄', async () => {
  clearRecentTileFailures();
  const url = 'http://tile-timeout-retry/failure-log-success';
  urlResults[url] = true;
  const tile = new FakeTile([TAIPEI_TILE.z, TAIPEI_TILE.x, TAIPEI_TILE.y]);

  const loadFn = createGuardedTileLoadFunction({ regionBbox: TAIPEI_BBOX, timeoutMs: 500, label: '測試圖層／成功' });
  loadFn(tile, url);
  await waitForState(tile);

  assertEqual(getRecentTileFailures().length, 0, '成功載入不應該產生任何失敗紀錄');
});

test('recordTileFailure：邊界保護判定的 EMPTY 不應該被記錄為失敗（平移到範圍外是預期行為，不是故障）', () => {
  clearRecentTileFailures();
  const url = 'http://tile-timeout-retry/failure-log-bbox-empty';
  urlResults[url] = true;
  const tile = new FakeTile([TAIPEI_TILE.z, TAIPEI_TILE.x, TAIPEI_TILE.y]);

  const loadFn = createGuardedTileLoadFunction({ regionBbox: [110, 30, 112, 32], timeoutMs: 30, label: '測試圖層／邊界外' });
  loadFn(tile, url);

  assertEqual(tile.state, TILE_STATE.EMPTY, '前置條件：邊界外應該直接 EMPTY');
  assertEqual(getRecentTileFailures().length, 0, '邊界保護判定的 EMPTY 不應該計入失敗紀錄，只有真正逾時/明確錯誤才算');
});

test('getRecentTileFailures()：只保留最近 RECENT_TILE_FAILURE_LIMIT 筆，最新的排最前面', async () => {
  clearRecentTileFailures();
  const total = RECENT_TILE_FAILURE_LIMIT + 5;
  for(let i = 0; i < total; i++){
    const url = `http://tile-timeout-retry/failure-log-overflow-${i}`;
    urlResults[url] = false; // 明確 onerror，同步判定失敗，不需要等逾時
    const tile = new FakeTile([TAIPEI_TILE.z, TAIPEI_TILE.x, TAIPEI_TILE.y]);
    const loadFn = createGuardedTileLoadFunction({ regionBbox: TAIPEI_BBOX, timeoutMs: 500, label: `第${i}筆` });
    loadFn(tile, url);
    await waitForState(tile);
  }

  const failures = getRecentTileFailures();
  assertEqual(failures.length, RECENT_TILE_FAILURE_LIMIT, `超過上限的紀錄應該被丟棄，只保留最近 ${RECENT_TILE_FAILURE_LIMIT} 筆`);
  assertEqual(failures[0].label, `第${total - 1}筆`, '最新的一筆應該排在最前面');
});

test('getRecentTileFailures()：回傳的是複本，呼叫端修改回傳陣列不會影響內部狀態', async () => {
  clearRecentTileFailures();
  const url = 'http://tile-timeout-retry/failure-log-copy';
  urlResults[url] = false;
  const tile = new FakeTile([TAIPEI_TILE.z, TAIPEI_TILE.x, TAIPEI_TILE.y]);
  const loadFn = createGuardedTileLoadFunction({ regionBbox: TAIPEI_BBOX, timeoutMs: 500, label: '測試圖層／複本' });
  loadFn(tile, url);
  await waitForState(tile);

  const failures = getRecentTileFailures();
  failures.pop();
  assertEqual(getRecentTileFailures().length, 1, '呼叫端清空回傳陣列不應該影響下次呼叫拿到的內部狀態');
});

test('clearRecentTileFailures()：清空後 getRecentTileFailures() 應該回傳空陣列', async () => {
  const url = 'http://tile-timeout-retry/failure-log-clear';
  urlResults[url] = false;
  const tile = new FakeTile([TAIPEI_TILE.z, TAIPEI_TILE.x, TAIPEI_TILE.y]);
  const loadFn = createGuardedTileLoadFunction({ regionBbox: TAIPEI_BBOX, timeoutMs: 500 });
  loadFn(tile, url);
  await waitForState(tile);
  assertTrue(getRecentTileFailures().length > 0, '前置條件：應該至少有 1 筆紀錄');

  clearRecentTileFailures();
  assertEqual(getRecentTileFailures().length, 0, '清空後應該回傳空陣列');
});

await run();
