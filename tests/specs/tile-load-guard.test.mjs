/* ---------------------------------------------------------
   tests/specs/tile-load-guard.test.mjs
   ---------------------------------------------------------
   驗證 core/tileLoadGuard.js（組合層）本身的職責：串接
   core/tileBoundaryGuard.js（邊界保護）、core/tileRenderPool.js（節流
   池）、core/tileTimeoutRetry.js（逾時重試）三個獨立模組的
   createGuardedTileLoadFunction()，以及只存在於組合層、需要跨三者
   協調視角資訊的邏輯：
     1. DEFAULT_TILE_CACHE_SIZE：常數本身的合理性（正數、不會過小）。
     2. attachStaleTileAbort()：視角 moveend 安定後，主動放棄 z／bbox
        跟目前視角對不上的在途請求（見案例區塊開頭的完整說明）；放棄後
        的最終狀態應該是 IDLE 而不是永久 ERROR，且同一顆 tile 之後若被
        （模擬 OL 重新進入可視範圍）再次呼叫 tileLoadFunction，應該能
        正常重新走一次完整流程並成功 LOADED，不會被之前的 stale abort
        影響。
     3. abortInFlightForKey()：供 core/layerCache.js 淘汰／移除圖層時
        呼叫，只中止指定 sourceKey 的在途請求。
     4. throttle()：通用 leading+trailing 節流器本身的行為。
     5. attachStaleTileAbort() 掛的節流版拖曳中清理（view 的
        change:center／change:resolution），不用等放開滑鼠的 moveend
        就能提早放棄過期請求。

   逾時重試本身（正常載入／逾時重試／明確失敗不重試／失敗紀錄／冷卻
   重試候選名單）見 tests/specs/tile-timeout-retry.test.mjs；邊界保護
   本身（邊界外/邊界內/無 bbox）見 tests/specs/tile-boundary-guard.test.mjs；
   tileRenderRequestPool 併發上限見 tests/specs/tile-render-pool.test.mjs。
   本檔案原本涵蓋以上全部案例，依 core/tileLoadGuard.js 拆成三個獨立
   模組 + 組合層後同步拆分，只保留屬於組合層本身職責的案例。

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
  DEFAULT_TILE_CACHE_SIZE,
  TILE_STATE,
  attachStaleTileAbort,
  throttle,
  STALE_TILE_SWEEP_THROTTLE_MS,
  abortInFlightForKey,
} from '../../src/core/tileLoadGuard.js';
import { lonLatToTileXY, tileXYToBbox } from '../../src/core/tileGeo.js';

const urlResults = {}; // url -> true(正常載入) | false(明確 onerror) | 'timeout-once' | 'timeout-always'
const urlAttempts = {};
const DELAY_MS = 5;

// 跟其他測試檔案（tile-checker.test.mjs／neighbor-tile-fallback.test.mjs／
// tile-request-pool.test.mjs／spatial-index.test.mjs，已抽成共用的
// tests/tileImageStub.mjs）刻意分開維護，不套用同一個
// createTileImageStub() factory：這裡的觸發時機是 `set src(v)`（配合
// tileLoadGuard.js 逾時後清空 `src=''` 中止載入的語意，空字串不算一次
// 新的嘗試），跟其他 4 個檔案「constructor 就觸發」的語意不同；硬套同一個
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
   registry（core/tileTimeoutRetry.js 內部狀態，測試檔案拿不到直接
   參照）。第一個案例必須排在最前面、在任何 guarded 請求被送出之前
   執行，才能驗證 registry 真正是空的那個早退分支；之後每個案例建立
   的圖磚都會在案例結束前想辦法讓它 resolve／被 abort，避免汙染後續
   案例。
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

test('abortInFlightForKey：只中止指定 sourceKey 的在途請求，不影響其他 key（供 core/layerCache.js 淘汰／移除圖層時呼叫，見該檔案的說明）', () => {
  const urlA = 'http://tile-load-guard/abort-by-key-a';
  const urlB = 'http://tile-load-guard/abort-by-key-b';
  urlResults[urlA] = 'timeout-always'; // 模擬「請求已送出、還沒 resolve」
  urlResults[urlB] = 'timeout-always';

  const tileA = new FakeTile([TAIPEI_TILE.z, TAIPEI_TILE.x, TAIPEI_TILE.y]);
  const tileB = new FakeTile([TAIPEI_TILE.z, TAIPEI_TILE.x, TAIPEI_TILE.y]);

  const loadFnA = createGuardedTileLoadFunction({ timeoutMs: 999999, sourceKey: 'hist:test:layerA:jpg' });
  const loadFnB = createGuardedTileLoadFunction({ timeoutMs: 999999, sourceKey: 'hist:test:layerB:jpg' });
  loadFnA(tileA, urlA);
  loadFnB(tileB, urlB);

  assertEqual(tileA.state, null, '送出請求後應該還在等待中');
  assertEqual(tileB.state, null, '送出請求後應該還在等待中');

  abortInFlightForKey('not-a-real-key'); // 不存在的 key 應該安全地什麼都不做
  assertEqual(tileA.state, null, '不相關的 key 不應該影響 A');
  assertEqual(tileB.state, null, '不相關的 key 不應該影響 B');

  abortInFlightForKey('hist:test:layerA:jpg');
  assertEqual(tileA.state, TILE_STATE.IDLE, 'A 對應的 key 被中止後，圖磚應該被 abort 成 IDLE（比照 stale abort，不是永久 ERROR）');
  assertEqual(tileB.state, null, 'B 的 sourceKey 不同，不應該被連帶中止');

  abortInFlightForKey('hist:test:layerB:jpg'); // 收尾，避免遺留逾時計時器影響其他測試
  assertEqual(tileB.state, TILE_STATE.IDLE, '測試結束前主動清理 B');
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
   throttle()：通用節流器
--------------------------------------------------------- */
test('throttle()：窗口內第一次呼叫立即執行（leading），窗口內其餘呼叫合併成窗口結束後最多補跑一次（trailing）', async () => {
  // 這裡是真的在等 throttle() 內部一個沒有掛任何回呼／勾子的
  // setTimeout(窗口 THROTTLE_WINDOW_MS 到期才會觸發 trailing 呼叫，
  // 沒有同步可觀察的訊號可以拿來輪詢，維持固定 sleep() 是合理的；
  // 等待時間抓窗口的 2 倍當緩衝，避免計時器誤差導致偶發失敗。
  const THROTTLE_WINDOW_MS = 30;
  const calls = [];
  const throttled = throttle((label) => calls.push(label), THROTTLE_WINDOW_MS);

  throttled('a');
  assertEqual(calls.length, 1, '第一次呼叫應該立即執行');
  assertEqual(calls[0], 'a', '第一次呼叫應該帶正確的參數');

  throttled('b');
  throttled('c');
  assertEqual(calls.length, 1, '窗口內的後續呼叫不應該立即執行');

  await sleep(THROTTLE_WINDOW_MS * 2);
  assertEqual(calls.length, 2, '窗口結束後應該補跑一次');
  assertEqual(calls[1], 'c', 'trailing 呼叫應該帶最後一次呼叫的參數，不是被吃掉的中間那次');

  await sleep(THROTTLE_WINDOW_MS * 2);
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

await run();
