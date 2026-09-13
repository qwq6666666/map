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
        跟目前視角對不上的在途請求（見案例區塊開頭的完整說明）。

   風格比照 tests/specs/tile-request-pool.test.mjs：自訂 FakeImage +
   urlResults 查找表模擬 onload/onerror/逾時；另外自訂 FakeTile 模擬
   OL 的 tile 物件（getTileCoord/getImage/setState）；attachStaleTileAbort
   額外自訂一個 makeFakeMap()，只實作該函式實際用到的 map/view API
   子集（on/getView/getSize，view 的 getResolution/getCenter/getZoom/
   calculateExtent/getProjection），不是完整的 ol.Map 模擬。
--------------------------------------------------------- */
import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import {
  createGuardedTileLoadFunction,
  DEFAULT_TILE_LOAD_TIMEOUT_MS,
  DEFAULT_TILE_CACHE_SIZE,
  TILE_STATE,
  attachStaleTileAbort,
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
// calculateExtent/getProjection。calculateExtent() 不理會傳入的 size
// 參數，直接回傳建構時指定的 extent（測試只關心「掃描比對用的目前
// 可視範圍」，不需要真的模擬依視窗尺寸換算 extent 的邏輯）。
// ol.proj.transformExtent 在 env-stub.mjs 裡是 identity（直接回傳傳入
// 的 extent，不理會來源/目標投影參數），所以這裡回傳的 extent 可以
// 直接當成呼叫端拿到的 WGS84 extent 使用，不需要另外做座標轉換。
function makeFakeMap({ zoom, extent, size = [800, 600], resolution = 100, center = [0, 0] }){
  const handlers = {};
  return {
    on(ev, fn){ (handlers[ev] = handlers[ev] || []).push(fn); },
    _trigger(ev){ (handlers[ev] || []).forEach(fn => fn()); },
    getView(){
      return {
        getResolution: () => resolution,
        getCenter: () => center,
        getZoom: () => zoom,
        calculateExtent: () => extent,
        getRotation: () => 0,
        getProjection: () => 'EPSG:3857',
      };
    },
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

test('attachStaleTileAbort：z／bbox 跟目前視角對不上的在途請求同步 abort 成 ERROR，對得上的維持不變', () => {
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
  assertEqual(tileBboxMismatch.state, TILE_STATE.ERROR, 'z 相同但 bbox 對不上目前視角，應該同步被 abort 成 ERROR');
  assertEqual(tileZoomMismatch.state, TILE_STATE.ERROR, 'bbox 對得上但 z 不同，應該同步被 abort 成 ERROR');
  assertEqual(urlAttempts[urlKeep], 1, '未被 abort 的請求不應該產生額外的重新嘗試');

  // 第二次 moveend：模擬使用者又移動視角、這次 tileKeep 的位置也不再
  // 相關（extent 換成跟 tileKeep 明顯不相交的範圍），驗證它一樣會被
  // abort，同時清乾淨 registry，不留到下一個測試案例。
  const fakeMap2 = makeFakeMap({ zoom: 15, extent: [130, 30, 131, 31] });
  attachStaleTileAbort(fakeMap2);
  fakeMap2._trigger('moveend');
  assertEqual(tileKeep.state, TILE_STATE.ERROR, '視角再次改變、涵蓋範圍已不相關時，應該同樣被 abort');
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

await run();
