/* ---------------------------------------------------------
   tests/specs/tile-load-guard.test.mjs
   ---------------------------------------------------------
   驗證 core/tileLoadGuard.js：
     1. createGuardedTileLoadFunction()：
        - 邊界保護——圖磚座標跟 regionBbox 完全不相交時，直接
          tile.setState(EMPTY)，不建立/指定 <img src>（不發送請求）。
        - 邊界內／沒有 regionBbox 時正常走逾時＋重試流程：
          - 正常載入 -> LOADED，只發送 1 次請求。
          - 逾時一次後重試成功 -> LOADED，發送 2 次請求。
          - 逾時兩次（含重試）-> ERROR，發送 2 次請求（不會有第三次）。
          - 明確 onerror（伺服器已回應但失敗）不重試，直接 ERROR，
            只發送 1 次請求。
     2. DEFAULT_TILE_CACHE_SIZE：常數本身的合理性（正數、不會過小）。
     3. attachStaleTileAbort()：視角 moveend 安定後，主動放棄 z／bbox
        跟目前視角對不上的在途請求（見案例區塊開頭的完整說明）；放棄後
        的最終狀態應該是 IDLE 而不是永久 ERROR，且同一顆 tile 之後若被
        （模擬 OL 重新進入可視範圍）再次呼叫 tileLoadFunction，應該能
        正常重新走一次完整流程並成功 LOADED，不會被之前的 stale abort
        影響。

   風格比照 tests/specs/tile-request-pool.test.mjs：自訂 FakeImage +
   urlResults 查找表模擬 onload/onerror/逾時；另外自訂 FakeTile 模擬
   OL 的 tile 物件（getTileCoord/getImage/setState）；attachStaleTileAbort
   額外自訂一個 makeFakeMap()，只實作該函式實際用到的 map/view API
   子集（on/getView/getSize，view 的 getResolution/getCenter/getZoom/
   calculateExtent/getProjection），不是完整的 ol.Map 模擬。
--------------------------------------------------------- */
import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue, sleep } from '../assert.mjs';
import {
  createGuardedTileLoadFunction,
  DEFAULT_TILE_LOAD_TIMEOUT_MS,
  DEFAULT_TILE_CACHE_SIZE,
  TILE_STATE,
  attachStaleTileAbort,
  TILE_RENDER_MAX_CONCURRENCY,
  tileRenderRequestPool,
  throttle,
  STALE_TILE_SWEEP_THROTTLE_MS,
  getRecentTileFailures,
  clearRecentTileFailures,
  RECENT_TILE_FAILURE_LIMIT,
  TIMEOUT_RETRY_COOLDOWN_MS,
} from '../../src/core/tileLoadGuard.js';
import { lonLatToTileXY, tileXYToBbox } from '../../src/core/tileGeo.js';

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

// 只實作 attachStaleTileAbort() 實際用到的 map/view API 子集：
// on('moveend', handler)（記住 handler，供測試用 _trigger() 手動觸發）、
// getView()／getSize()，view 上的 getResolution/getCenter/getZoom/
// calculateExtent/getProjection，以及節流版拖曳中清理用到的
// view.on('change:center'/'change:resolution', handler)（同樣記在
// viewHandlers，供測試用 _triggerView() 手動觸發）。calculateExtent()
// 不理會傳入的 size 參數，直接回傳目前 extent（測試只關心「掃描比對用
// 的目前可視範圍」，不需要真的模擬依視窗尺寸換算 extent 的邏輯）；
// extent／zoom 允許事後用 _setViewState() 更新，模擬拖曳過程中視角
// 持續改變。ol.proj.transformExtent 在 env-stub.mjs 裡是 identity
// （直接回傳傳入的 extent，不理會來源/目標投影參數），所以這裡回傳的
// extent 可以直接當成呼叫端拿到的 WGS84 extent 使用，不需要另外做
// 座標轉換。
// 注意：getView() 每次呼叫都要回傳同一個 view 物件（不是每次都 new 一個
// 新的），attachStaleTileAbort() 只會在建立時呼叫一次 map.getView() 來
// 掛 view.on()，如果每次呼叫都回傳不同物件，掛上去的 handler 會跟
// _triggerView() 操作的物件對不上。
function makeFakeMap({ zoom, extent, size = [800, 600], resolution = 100, center = [0, 0] }){
  const handlers = {};
  const viewHandlers = {};
  let currentZoom = zoom;
  let currentExtent = extent;
  const view = {
    getResolution: () => resolution,
    getCenter: () => center,
    getZoom: () => currentZoom,
    calculateExtent: () => currentExtent,
    getRotation: () => 0,
    getProjection: () => 'EPSG:3857',
    on(ev, fn){ (viewHandlers[ev] = viewHandlers[ev] || []).push(fn); },
  };
  return {
    on(ev, fn){ (handlers[ev] = handlers[ev] || []).push(fn); },
    _trigger(ev){ (handlers[ev] || []).forEach(fn => fn()); },
    _triggerView(ev){ (viewHandlers[ev] || []).forEach(fn => fn()); },
    // 供測試模擬「拖曳中視角已經改變，但還沒到 moveend」：更新
    // getZoom()/calculateExtent() 之後回傳的值，不影響已經掛上的
    // handler 參照。
    _setViewState({ zoom: z, extent: e }){
      if(z !== undefined) currentZoom = z;
      if(e !== undefined) currentExtent = e;
    },
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

test('DEFAULT_TILE_CACHE_SIZE 應該是正數，且不會小到讓 LRU 過期機制形同虛設', () => {
  assertTrue(Number.isInteger(DEFAULT_TILE_CACHE_SIZE), 'cacheSize 應該是整數');
  assertTrue(DEFAULT_TILE_CACHE_SIZE > 0, 'cacheSize 必須是正數，0 會讓 OL 的 canExpireCache() 永遠不觸發清除');
  // 一般視窗＋平移緩衝同時用到的圖磚數量大約是數十顆量級，這裡只驗證
  // 「明顯不會小到跟沒設一樣」，不鎖死成某個精確值（之後想調參數不用
  // 特地回來改這條斷言）。
  assertTrue(DEFAULT_TILE_CACHE_SIZE >= 64, `cacheSize 太小可能起不到留住回訪圖磚的效果，實際 ${DEFAULT_TILE_CACHE_SIZE}`);
});

/* ---------------------------------------------------------
   attachStaleTileAbort()：以下測試共用模組層級的 inFlightGuardedTiles
   registry（tileLoadGuard.js 內部狀態，測試檔案拿不到直接參照）。第一個
   案例必須排在最前面、在任何 guarded 請求被送出之前執行，才能驗證
   registry 真正是空的那個早退分支；之後每個案例建立的圖磚都會在案例
   結束前想辦法讓它 resolve／被 abort，避免汙染後續案例。
--------------------------------------------------------- */

test('attachStaleTileAbort：registry 是空的時候觸發 moveend 不應該拋例外', () => {
  const fakeMap = makeFakeMap({ zoom: 15, extent: [119, 21, 123, 26] });
  attachStaleTileAbort(fakeMap);
  fakeMap._trigger('moveend'); // 沒有任何在途請求，應該直接早退，不拋例外
});

test('attachStaleTileAbort：z／bbox 跟目前視角對不上的在途請求同步 abort 成 IDLE（非永久 ERROR），對得上的維持不變', () => {
  const urlKeep = 'http://tile-load-guard/stale-keep';
  const urlBboxMismatch = 'http://tile-load-guard/stale-bbox-mismatch';
  const urlZoomMismatch = 'http://tile-load-guard/stale-zoom-mismatch';
  // 'timeout-always'：FakeImage 完全不呼叫 onload/onerror，模擬「請求
  // 已送出、還沒 resolve」；搭配很長的 timeoutMs，確保測試視窗內
  // loadWithTimeoutRetry() 自己的逾時計時器不會先觸發，狀態變化只可能
  // 來自 attachStaleTileAbort() 的 abort()。
  urlResults[urlKeep] = 'timeout-always';
  urlResults[urlBboxMismatch] = 'timeout-always';
  urlResults[urlZoomMismatch] = 'timeout-always';

  const taipei15 = TAIPEI_TILE; // z15，台北
  const kaohsiung15 = lonLatToTileXY(120.3010, 22.6273, 15); // z 相同、bbox 明顯對不上
  const taipei10 = lonLatToTileXY(121.5654, 25.0330, 10); // bbox 涵蓋台北、但 z 對不上

  const tileKeep = new FakeTile([taipei15.z, taipei15.x, taipei15.y]);
  const tileBboxMismatch = new FakeTile([kaohsiung15.z, kaohsiung15.x, kaohsiung15.y]);
  const tileZoomMismatch = new FakeTile([taipei10.z, taipei10.x, taipei10.y]);

  // 不傳 regionBbox：這個測試只關心 attachStaleTileAbort() 的行為，
  // 不需要再疊加 createGuardedTileLoadFunction() 自己的邊界保護。
  const loadFn = createGuardedTileLoadFunction({ timeoutMs: 999999 });
  loadFn(tileKeep, urlKeep);
  loadFn(tileBboxMismatch, urlBboxMismatch);
  loadFn(tileZoomMismatch, urlZoomMismatch);

  assertEqual(tileKeep.state, null, '送出請求後、moveend 觸發前應該還在等待中');
  assertEqual(tileBboxMismatch.state, null, '送出請求後、moveend 觸發前應該還在等待中');
  assertEqual(tileZoomMismatch.state, null, '送出請求後、moveend 觸發前應該還在等待中');

  // 目前視角：z15、範圍剛好等於 tileKeep 的 bbox（保證相交），藉此讓
  // tileKeep 的 z 與 bbox 都對得上，另外兩顆分別因為 bbox、z 對不上。
  const currentExtent = tileXYToBbox(taipei15.x, taipei15.y, taipei15.z);
  const fakeMap = makeFakeMap({ zoom: 15, extent: currentExtent });
  attachStaleTileAbort(fakeMap);
  fakeMap._trigger('moveend');

  assertEqual(tileKeep.state, null, 'z、bbox 都對得上目前視角，不應該被 abort（應同步發生，不用等待）');
  // 放棄的是「視角過期」而非真正逾時/失敗，最終狀態應該是 IDLE 而不是
  // ERROR：OL 只有 IDLE 的 Tile 才會在下次重新進入可視範圍時被排回
  // 載入佇列，卡在 ERROR 會永久顯示空白（見 tileLoadGuard.js entry.abort
  // 的完整說明）。
  assertEqual(tileBboxMismatch.state, TILE_STATE.IDLE, 'z 相同但 bbox 對不上目前視角，應該同步被 abort 成 IDLE，讓它之後能重新載入');
  assertEqual(tileZoomMismatch.state, TILE_STATE.IDLE, 'bbox 對得上但 z 不同，應該同步被 abort 成 IDLE，讓它之後能重新載入');
  assertEqual(urlAttempts[urlKeep], 1, '未被 abort 的請求不應該產生額外的重新嘗試');

  // 第二次 moveend：模擬使用者又移動視角、這次 tileKeep 的位置也不再
  // 相關（extent 換成跟 tileKeep 明顯不相交的範圍），驗證它一樣會被
  // abort，同時清乾淨 registry，不留到下一個測試案例。
  const fakeMap2 = makeFakeMap({ zoom: 15, extent: [130, 30, 131, 31] });
  attachStaleTileAbort(fakeMap2);
  fakeMap2._trigger('moveend');
  assertEqual(tileKeep.state, TILE_STATE.IDLE, '視角再次改變、涵蓋範圍已不相關時，應該同樣被 abort 成 IDLE');
});

test('attachStaleTileAbort：已經 resolve（LOADED）的圖磚，moveend 觸發時不應該被重複處理或拋例外', async () => {
  const url = 'http://tile-load-guard/stale-already-loaded';
  urlResults[url] = true;
  const tile = new FakeTile([TAIPEI_TILE.z, TAIPEI_TILE.x, TAIPEI_TILE.y]);

  const loadFn = createGuardedTileLoadFunction({ timeoutMs: 500 });
  loadFn(tile, url);
  const state = await waitForState(tile);
  assertEqual(state, TILE_STATE.LOADED, '前置條件：載入應該正常成功');

  // resolve 後 entry 已經從 registry 移除；用一個跟這顆圖磚座標完全對不上
  // 的視角觸發 moveend，確認不會拋例外，且不會把已經 LOADED 的狀態改掉。
  const fakeMap = makeFakeMap({ zoom: 3, extent: [1, 1, 2, 2] });
  attachStaleTileAbort(fakeMap);
  fakeMap._trigger('moveend');
  assertEqual(tile.state, TILE_STATE.LOADED, '已經 resolve 的圖磚不應該被 moveend 掃描影響');
});

test('attachStaleTileAbort：邊界保護已經直接判 EMPTY 的圖磚，從未進入 registry，moveend 掃描不應該誤傷它', () => {
  const url = 'http://tile-load-guard/stale-empty-by-boundary';
  urlResults[url] = true; // 就算真的載入一定成功，也不應該被呼叫到
  const tile = new FakeTile([TAIPEI_TILE.z, TAIPEI_TILE.x, TAIPEI_TILE.y]);
  const beforeAttempts = urlAttempts[url] || 0;

  const loadFn = createGuardedTileLoadFunction({ regionBbox: [110, 30, 112, 32], timeoutMs: 30 }); // 明顯不涵蓋台北
  loadFn(tile, url);
  assertEqual(tile.state, TILE_STATE.EMPTY, '前置條件：邊界外應該直接 EMPTY');

  const fakeMap = makeFakeMap({ zoom: TAIPEI_TILE.z, extent: [119, 21, 123, 26] });
  attachStaleTileAbort(fakeMap);
  fakeMap._trigger('moveend');

  assertEqual(tile.state, TILE_STATE.EMPTY, '從未送出請求的 EMPTY 圖磚，moveend 掃描不應該改變它的狀態');
  assertEqual(urlAttempts[url] || 0, beforeAttempts, 'EMPTY 圖磚不應該因為 moveend 掃描而多發送任何請求');
});

/* ---------------------------------------------------------
   tileRenderRequestPool：歷史／自訂圖層圖磚渲染節流池
   ---------------------------------------------------------
   slot 有空位時，TileRenderPool.run() 會同步呼叫 fn()（刻意不用
   async function 包裝，理由見 tileLoadGuard.js 檔頭註解），所以下面
   這個測試不需要等任何 tick，送出全部請求後就能立刻同步檢查
   active／queued 是否符合節流上限。
--------------------------------------------------------- */
test('tileRenderRequestPool：節流池併發上限，超過 TILE_RENDER_MAX_CONCURRENCY 的請求會先排隊，不會一次全部發送', async () => {
  assertEqual(TILE_RENDER_MAX_CONCURRENCY, 4, '目前拍板的上限應該是 4，調整上限時記得同步更新這條斷言');

  const total = 8;
  const urls = Array.from({ length: total }, (_, i) => `http://tile-load-guard/render-pool-${i}`);
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

/* ---------------------------------------------------------
   throttle()：通用節流器
--------------------------------------------------------- */
test('throttle()：窗口內第一次呼叫立即執行（leading），窗口內其餘呼叫合併成窗口結束後最多補跑一次（trailing）', async () => {
  const calls = [];
  const throttled = throttle((label) => calls.push(label), 30);

  throttled('a');
  assertEqual(calls.length, 1, '第一次呼叫應該立即執行');
  assertEqual(calls[0], 'a', '第一次呼叫應該帶正確的參數');

  throttled('b');
  throttled('c');
  assertEqual(calls.length, 1, '窗口內的後續呼叫不應該立即執行');

  await sleep(60);
  assertEqual(calls.length, 2, '窗口結束後應該補跑一次');
  assertEqual(calls[1], 'c', 'trailing 呼叫應該帶最後一次呼叫的參數，不是被吃掉的中間那次');

  await sleep(60);
  assertEqual(calls.length, 2, '窗口結束後如果沒有新呼叫，不應該無中生有再多跑一次');
});

/* ---------------------------------------------------------
   attachStaleTileAbort()：拖曳互動中的節流版清理
   ---------------------------------------------------------
   跟前面 moveend 的案例對照：這裡改用 view 的 change:center 觸發，
   驗證不用等放開滑鼠的 moveend，互動過程中一樣能提早放棄過期請求。
--------------------------------------------------------- */
test('attachStaleTileAbort：拖曳中透過 change:center 節流清理，不用等 moveend 就能放棄過期請求', async () => {
  const urlStale = 'http://tile-load-guard/drag-throttle-stale';
  const urlKeep = 'http://tile-load-guard/drag-throttle-keep';
  urlResults[urlStale] = 'timeout-always';
  urlResults[urlKeep] = 'timeout-always';

  const taipei15 = TAIPEI_TILE;
  const kaohsiung15 = lonLatToTileXY(120.3010, 22.6273, 15); // z 相同、bbox 跟目前視角對不上

  const tileStale = new FakeTile([kaohsiung15.z, kaohsiung15.x, kaohsiung15.y]);
  const tileKeep = new FakeTile([taipei15.z, taipei15.x, taipei15.y]);

  const loadFn = createGuardedTileLoadFunction({ timeoutMs: 999999 });
  loadFn(tileStale, urlStale);
  loadFn(tileKeep, urlKeep);

  assertEqual(tileStale.state, null, '前置條件：請求還在進行中');
  assertEqual(tileKeep.state, null, '前置條件：請求還在進行中');

  // 目前視角：z15、範圍剛好等於 tileKeep 的 bbox（保證相交），tileStale
  // （高雄）明顯不相交，模擬「使用者正在拖曳、還沒放開滑鼠到 moveend」。
  const currentExtent = tileXYToBbox(taipei15.x, taipei15.y, taipei15.z);
  const fakeMap = makeFakeMap({ zoom: 15, extent: currentExtent });
  attachStaleTileAbort(fakeMap);

  assertEqual(tileStale.state, null, '掛上監聽器本身不應該立刻觸發清理');

  fakeMap._triggerView('change:center');

  // 放棄的是「視角過期」而非真正逾時/失敗，最終狀態應該是 IDLE（見上一個
  // 案例的說明），不是永久 ERROR。
  assertEqual(tileStale.state, TILE_STATE.IDLE, 'change:center 節流的第一次觸發（leading）應該立即掃描並放棄過期請求成 IDLE，不用等 moveend');
  assertEqual(tileKeep.state, null, '沒有過期的請求不應該被拖曳中的節流清理誤傷');

  // 節流窗口內立刻再次觸發：tileStale 已經被 abort、從 registry 移除，
  // 這裡主要驗證重複觸發不會拋例外、也不會改變已經結束的狀態。
  fakeMap._triggerView('change:center');
  assertEqual(tileStale.state, TILE_STATE.IDLE, '重複觸發不應該改變已經 abort 的狀態');
  assertEqual(tileKeep.state, null, '重複觸發不應該誤傷沒有過期的請求');

  // throttle() 是 leading+trailing：上面第二次 change:center 落在節流窗口
  // 內，會排一個約 STALE_TILE_SWEEP_THROTTLE_MS 後才觸發的真實 setTimeout
  // 補跑一次 sweep（trailing）。若不在這裡主動等它消化掉，這個計時器會
  // 遺留到測試結束後才觸發，屆時可能誤掃到其他測試當下正在跑的、完全不
  // 相關的 in-flight 請求（用的是這個測試已經過期的 fakeMap 視角），造成
  // 間歇性誤判 stale abort。在這裡等待讓它於本測試範圍內先觸發完，此時
  // tileStale 已經被 abort 從 registry 移除、tileKeep 的 bbox 仍跟目前視角
  // 相交，trailing sweep 對兩者都是無害的 no-op。
  await sleep(STALE_TILE_SWEEP_THROTTLE_MS + 50);
  assertEqual(tileKeep.state, null, 'trailing 節流補跑一次 sweep 不應該誤傷仍相交的請求');

  // 測試結束前主動清掉 tileKeep：它刻意用 999999ms 的 timeoutMs 模擬
  // 「請求還在進行中」，不清乾淨的話會留下一個真正的 setTimeout，讓
  // Node process 沒辦法自然結束（要等 999999ms 才會觸發）。改用
  // moveend（不受節流影響，立即執行）搭配跟 tileKeep 也對不上的視角，
  // 比照檔案開頭其他案例「結束前想辦法讓它 resolve／被 abort」的慣例。
  fakeMap._setViewState({ extent: [130, 30, 131, 31] });
  fakeMap._trigger('moveend');
  assertEqual(tileKeep.state, TILE_STATE.IDLE, '測試結束前主動清理 tileKeep，避免遺留逾時計時器');
});

/* ---------------------------------------------------------
   Bug 修正回歸：stale abort 不應該讓圖磚永久卡在 ERROR
   ---------------------------------------------------------
   背景：attachStaleTileAbort() 原本讓過期請求跟真正逾時/失敗共用同一個
   TILE_STATE.ERROR 終態；OL 只有 getState()===IDLE 的 Tile 才會在下次
   重新進入可視範圍時被排回載入佇列，卡在 ERROR 會永久顯示空白，即使
   實際上有歷史圖資。修正後 stale abort 的最終狀態應該是 IDLE，且模擬
   OL「之後又呼叫一次 tileLoadFunction」（等同圖磚重新進入可視範圍、
   OL 的 renderer 看到 IDLE 狀態重新呼叫 tile.load()）應該能正常走完
   整個流程並成功 LOADED。
--------------------------------------------------------- */
test('Bug 修正回歸：stale abort 後同一顆 tile 被重新呼叫 tileLoadFunction，應該能正常重新載入成功', async () => {
  const url = 'http://tile-load-guard/stale-then-reload';
  urlResults[url] = 'timeout-always'; // 第一次呼叫：模擬請求已送出、還沒 resolve
  const tile = new FakeTile([TAIPEI_TILE.z, TAIPEI_TILE.x, TAIPEI_TILE.y]);

  const loadFn = createGuardedTileLoadFunction({ timeoutMs: 999999 });
  loadFn(tile, url);
  assertEqual(tile.state, null, '前置條件：請求還在進行中');

  // 用跟這顆圖磚完全對不上的視角觸發 moveend，模擬使用者已經看不到它。
  const fakeMap = makeFakeMap({ zoom: 3, extent: [1, 1, 2, 2] });
  attachStaleTileAbort(fakeMap);
  fakeMap._trigger('moveend');
  assertEqual(tile.state, TILE_STATE.IDLE, 'stale abort 後應該是 IDLE，不是永久 ERROR');

  // 模擬圖磚重新進入可視範圍：OL 看到 getState()===IDLE，重新呼叫
  // tile.load() -> 我們的 guardedTileLoadFunction，這裡直接再呼叫一次
  // loadFn(tile, url) 等價模擬。這次改成正常回應，驗證新的一次嘗試不
  // 會被前一次 stale abort 留下的任何內部旗標卡住。
  //
  // 注意：不能直接沿用 waitForState()——它只檢查「state !== null」就
  // 視為完成，但這裡的 tile.state 已經是 IDLE（0，不是 null）而不是
  // 初始的 null，會被誤判成「已經到達最終狀態」而立刻用舊的 IDLE
  // resolve，完全不會等到這次重新載入真的完成。改成明確等到狀態變成
  // LOADED 或 ERROR（脫離 IDLE）才算數。
  urlResults[url] = true;
  loadFn(tile, url);
  const state = await withTimeout(new Promise(resolve => {
    const check = () => {
      if(tile.state === TILE_STATE.LOADED || tile.state === TILE_STATE.ERROR) return resolve(tile.state);
      setTimeout(check, 2);
    };
    check();
  }), 5000, '重新載入後一直沒有進入 LOADED/ERROR（可能發生 deadlock）');
  assertEqual(state, TILE_STATE.LOADED, '重新進入可視範圍後應該能正常重新載入成功，不會因為之前被 stale abort 而卡住');
  assertEqual(urlAttempts[url], 2, '應該有真的重新發送第 2 次請求（第 1 次是被 stale abort 放棄的那次）');
});

/* ---------------------------------------------------------
   Bug 修正回歸：逾時終局失敗的冷卻重試（timeoutFailedGuardedTiles）
   ---------------------------------------------------------
   背景：上面「stale-then-reload」修正的是「視角已經換過」這種情境，
   但使用者回報「圖磚原地不動、不縮放的話永遠空白」的另一半成因是
   loadWithTimeoutRetry() 自己判定的逾時終局失敗——這種情況下視角
   根本沒換過，attachStaleTileAbort() 的 z／bbox 過期判斷永遠不會命中，
   需要另一套「冷卻一段時間後給一次額外重試機會」的機制才能救回來。

   以下測試透過 mock Date.now()（比照 wmts-import.test.mjs 既有手法）
   模擬「時間經過」，不需要真的等待 TIMEOUT_RETRY_COOLDOWN_MS（8000ms）
   那麼久；loadWithTimeoutRetry() 內部的逾時計時器本身用的是真正的
   setTimeout（不受 Date.now() mock 影響，只影響雙方拿去算冷卻時間差
   的時間戳記），所以搭配很短的 timeoutMs（20ms）可以讓終局失敗很快
   發生，冷卻時間則靠 mock 的 now 變數直接快轉。
--------------------------------------------------------- */
test('逾時終局失敗、冷卻時間已過、tile 仍在目前可視範圍內 -> sweep 後應撥回 IDLE，且重新指定 src 後可以再次成功 LOADED', async () => {
  const url = 'http://tile-load-guard/cooldown-retry-success';
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

test('逾時終局失敗、冷卻時間還沒過 -> sweep 後應該維持 ERROR，不會被撥回', async () => {
  const url = 'http://tile-load-guard/cooldown-retry-too-soon';
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
  const url = 'http://tile-load-guard/cooldown-retry-explicit-error-excluded';
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
  const url = 'http://tile-load-guard/cooldown-retry-once-only';
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
  const url = 'http://tile-load-guard/failure-log-explicit-error';
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
  const url = 'http://tile-load-guard/failure-log-timeout';
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
  const url = 'http://tile-load-guard/failure-log-success';
  urlResults[url] = true;
  const tile = new FakeTile([TAIPEI_TILE.z, TAIPEI_TILE.x, TAIPEI_TILE.y]);

  const loadFn = createGuardedTileLoadFunction({ regionBbox: TAIPEI_BBOX, timeoutMs: 500, label: '測試圖層／成功' });
  loadFn(tile, url);
  await waitForState(tile);

  assertEqual(getRecentTileFailures().length, 0, '成功載入不應該產生任何失敗紀錄');
});

test('recordTileFailure：邊界保護判定的 EMPTY 不應該被記錄為失敗（平移到範圍外是預期行為，不是故障）', () => {
  clearRecentTileFailures();
  const url = 'http://tile-load-guard/failure-log-bbox-empty';
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
    const url = `http://tile-load-guard/failure-log-overflow-${i}`;
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
  const url = 'http://tile-load-guard/failure-log-copy';
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
  const url = 'http://tile-load-guard/failure-log-clear';
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
