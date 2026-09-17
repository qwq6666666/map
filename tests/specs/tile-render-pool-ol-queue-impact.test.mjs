/* ---------------------------------------------------------
   tests/specs/tile-render-pool-ol-queue-impact.test.mjs
   ---------------------------------------------------------
   背景：map-core-agent 先前一輪唯讀體檢的【架構改善】發現——
   `tileRenderRequestPool`（core/tileLoadGuard.js 內的 TileRenderPool，
   TILE_RENDER_MAX_CONCURRENCY = 4）只限制「真正送出 <img src> 的併發
   數」，但 OpenLayers 的 Tile.load() 在呼叫 tileLoadFunction **之前**
   就已經把 tile.state 設成 LOADING、計入全域 16 個 LOADING 名額
   （tileQueue_.loadMoreTiles(16, 16)，見 tileLoadGuard.js 檔頭/
   attachStaleTileAbort() 上方註解的反解結論）。guardedTileLoadFunction
   拿到呼叫時圖磚早已是 LOADING，若這次嘗試因為 tileRenderRequestPool
   滿而在 `_queue` 裡排隊，這顆圖磚在整個排隊期間仍然持續佔用 OL 的
   全域 LOADING 名額，只是還沒有真的發送網路請求。

   本檔案要驗證/量化的是「這個排隊機制對 OL 全域佇列造成的真實影響」：
     - 情境 A：≤4 顆歷史圖磚同時進入 LOADING 時，檔頭註解宣稱的「至少
       留 12 個名額給底圖」是否成立。
     - 情境 B：>4 顆（8、16 顆）同時進入 LOADING 時，尖峰佔用名額
       （peak）與佔用名額的「持續時間」，分別跟「完全不節流、只受 OL
       全域 16 個名額本身限制」的基準情境相比差異多少。
     - 情境 C：attachStaleTileAbort() 的 stale-abort 機制，對「還在
       tileRenderRequestPool 排隊、根本還沒真的發送網路請求」的圖磚，
       是否也能同步釋放 OL 全域名額（不用乾等排到 slot 才能被放棄）。

   這不是在測 TileRenderPool 這個 class 本身的基本行為（併發上限、
   排隊/釋放邏輯）——那些案例已經在 tests/specs/tile-load-guard.test.mjs
   的「tileRenderRequestPool：節流池併發上限」測試覆蓋過了。這裡要測的
   是它跟 OL 全域圖磚佇列機制交互作用後的「真實」效果，所以額外自建一個
   GlobalLoadingQueueTracker 模擬 OL 在呼叫 tileLoadFunction 之前就已經
   把圖磚計入全域 LOADING 名額、只有 tile.setState() 被呼叫（LOADED／
   ERROR／EMPTY／IDLE 皆算，對應 OL 認定這顆圖磚已經離開 LOADING）才會
   釋放名額的機制。

   基準情境（「完全不節流」）刻意直接沿用正式程式碼的
   createGuardedTileLoadFunction() + tileRenderRequestPool（不是另外
   重新刻一套 stub），只在測試範圍內把 tileRenderRequestPool.maxConcurrency
   臨時調大（模擬「拿掉這一層節流，只剩 OL 全域 16 個名額本身的限制」），
   跑完後在 finally 裡還原——比起重新刻一份平行邏輯，更能反映正式程式碼
   的實際行為，且不需要修改 src/core/tileLoadGuard.js 本身。

   風格比照 tests/specs/tile-load-guard.test.mjs：自訂 FakeImage +
   urlResults 查找表模擬 onload/逾時；FakeTile 模擬 OL 的 tile 物件；
   makeFakeMap() 只實作 attachStaleTileAbort() 實際用到的 map/view API
   子集。
--------------------------------------------------------- */
import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import {
  createGuardedTileLoadFunction,
  TILE_STATE,
  attachStaleTileAbort,
  TILE_RENDER_MAX_CONCURRENCY,
  tileRenderRequestPool,
} from '../../src/core/tileLoadGuard.js';
import { lonLatToTileXY, tileXYToBbox } from '../../src/core/tileGeo.js';

// OL 全域 LOADING 名額上限，抄自 tileLoadGuard.js 檔頭／
// attachStaleTileAbort() 上方註解已反解確認的常數（ol.js 內部固定呼叫
// tileQueue_.loadMoreTiles(16, 16)）。這裡沒有從 src 匯入（該常數只存在
// 於 OL 原始碼內部，tileLoadGuard.js 也是用註解記載、沒有另外定義成
// 具名常數），測試自己宣告一份，數值调整時要跟 tileLoadGuard.js 的
// 註解、attachStaleTileAbort() 的說明同步更新。
const OL_GLOBAL_LOADING_CAP = 16;

const urlResults = {}; // url -> true(正常載入) | 'timeout-always'(逾時且永遠不 resolve，供逼近真實情境使用)
const urlAttempts = {};
const DELAY_MS = 25; // 模擬一次網路請求來回耗時，刻意跟 tile-load-guard.test.mjs 的 5ms 拉開一點，讓「批次序列化」造成的延遲倍數在計時上更明顯、不容易被排程雜訊淹沒

class FakeImage {
  set src(v){
    if(v === '') return; // guard 逾時後會清空 src 中止載入，不算一次新的嘗試
    this._url = v;
    urlAttempts[v] = (urlAttempts[v] || 0) + 1;
    const spec = urlResults[v];
    if(spec === 'timeout-always') return; // 完全不呼叫 onload/onerror，模擬「已送出、還沒 resolve」
    setTimeout(() => { if(this.onload) this.onload(); }, DELAY_MS);
  }
}

// ---------------------------------------------------------
// GlobalLoadingQueueTracker：模擬 OL 的全域 LOADING 名額佔用
// ---------------------------------------------------------
// enter(tile) 對應「OL 的 Tile.load() 在呼叫 tileLoadFunction 之前，就
// 已經把這顆圖磚標記為 LOADING、計入全域名額」——測試裡在每次呼叫
// loadFn(tile, url) 之前手動呼叫，代表這個時間點；leave(tile) 掛在
// TrackedFakeTile.setState() 上，只要 guardedTileLoadFunction／
// entry.abort() 呼叫過一次 tile.setState()（不論是 LOADED／ERROR／
// EMPTY／IDLE 哪一種終態），就代表 OL 認定這顆圖磚已經離開 LOADING，
// 名額釋放——這正是驗證「排隊中但還沒真的發送網路請求」的圖磚，是否
// 仍然持續佔用名額的關鍵：只要 enter() 之後、leave() 之前這段期間，
// 不論 tileRenderRequestPool 內部是 active 還是 queued 都一樣持續佔用。
class GlobalLoadingQueueTracker {
  constructor(cap){
    this.cap = cap;
    this._enteredAt = new Map(); // tile -> 進入 LOADING 的時間戳記
    this.peak = 0;
    this.durations = []; // 每顆圖磚從 enter 到 leave 實際佔用名額的毫秒數
  }
  enter(tile){
    this._enteredAt.set(tile, Date.now());
    if(this._enteredAt.size > this.peak) this.peak = this._enteredAt.size;
  }
  leave(tile){
    const enteredAt = this._enteredAt.get(tile);
    if(enteredAt === undefined) return; // 已經釋放過（例如 entry.abort 連續呼叫兩次 setState），不重複計算
    this._enteredAt.delete(tile);
    this.durations.push(Date.now() - enteredAt);
  }
  get active(){ return this._enteredAt.size; }
  availableForBasemap(){ return this.cap - this.active; }
  maxDuration(){ return this.durations.length ? Math.max(...this.durations) : 0; }
}

class TrackedFakeTile {
  constructor(tileCoord, queue){
    this._tileCoord = tileCoord;
    this._image = new FakeImage();
    this.state = null;
    this._queue = queue;
  }
  getTileCoord(){ return this._tileCoord; }
  getImage(){ return this._image; }
  setState(s){
    this.state = s;
    this._queue.leave(this);
  }
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

// 只實作 attachStaleTileAbort() 實際用到的 map/view API 子集，抄自
// tile-load-guard.test.mjs 的 makeFakeMap()（該檔案沒有 export，這裡
// 依專案慣例各測試檔案自帶一份）。
function makeFakeMap({ zoom, extent, size = [800, 600], resolution = 100, center = [0, 0] }){
  const handlers = {};
  const view = {
    getResolution: () => resolution,
    getCenter: () => center,
    getZoom: () => zoom,
    calculateExtent: () => extent,
    getRotation: () => 0,
    getProjection: () => 'EPSG:3857',
    on(){},
  };
  return {
    on(ev, fn){ (handlers[ev] = handlers[ev] || []).push(fn); },
    _trigger(ev){ (handlers[ev] || []).forEach(fn => fn()); },
    getView(){ return view; },
    getSize(){ return size; },
  };
}

// 一顆台北市中心的 tile 座標，供不需要特別測邊界/位置的情境共用
// （情境 A／B 不需要 bbox 交集判斷，全部用同一顆座標即可）。
const TAIPEI_TILE = lonLatToTileXY(121.5654, 25.0330, 15);

let batchCounter = 0;

// 送出 n 顆歷史圖磚的 guarded 載入請求，模擬「OL 一次把 n 顆圖磚排入
// LOADING」的情境（例如疊加高密度歷史圖層、快速平移跨越多顆圖磚）。
// throttled=false 時把 tileRenderRequestPool 的上限臨時調大，模擬「拿掉
// tileRenderRequestPool 這層節流，只剩 OL 全域 16 個名額本身限制」的
// 基準情境；throttled=true（預設）則是正式程式碼目前實際的節流上限
// （TILE_RENDER_MAX_CONCURRENCY = 4）。
async function runLoadBatch(n, { throttled = true } = {}){
  const queue = new GlobalLoadingQueueTracker(OL_GLOBAL_LOADING_CAP);
  const originalMax = tileRenderRequestPool.maxConcurrency;
  if(!throttled) tileRenderRequestPool.maxConcurrency = 9999;
  try{
    const loadFn = createGuardedTileLoadFunction({ timeoutMs: 5000 }); // 夠長，確保量測期間不會被逾時機制打斷
    const tag = `batch-${batchCounter++}`;
    const tiles = [];
    for(let i = 0; i < n; i++){
      const url = `http://tile-render-pool-impact/${tag}-${i}`;
      urlResults[url] = true;
      const tile = new TrackedFakeTile([TAIPEI_TILE.z, TAIPEI_TILE.x, TAIPEI_TILE.y], queue);
      tiles.push(tile);
      queue.enter(tile); // 模擬 OL 在呼叫 tileLoadFunction 之前就已經計入全域 LOADING 名額
      loadFn(tile, url);
    }
    await Promise.all(tiles.map(t => waitForState(t)));
    return queue;
  }finally{
    tileRenderRequestPool.maxConcurrency = originalMax;
  }
}

/* ---------------------------------------------------------
   情境 A：歷史圖磚 LOADING 請求數 ≤ TILE_RENDER_MAX_CONCURRENCY（4）
--------------------------------------------------------- */
test('情境 A：4 顆歷史圖磚同時進入 LOADING（未超過節流池上限）-> 尖峰佔用 4 個名額，底圖理論可用名額維持 12 個，符合檔頭註解宣稱', async () => {
  assertEqual(TILE_RENDER_MAX_CONCURRENCY, 4, '目前拍板的節流池上限應該是 4，調整時記得同步檢視這個情境的假設是否仍成立');

  const queue = await runLoadBatch(4, { throttled: true });

  assertEqual(queue.peak, 4, '4 顆圖磚同時請求，尖峰應該剛好佔滿節流池上限、不多不少');
  assertEqual(OL_GLOBAL_LOADING_CAP - queue.peak, 12, '底圖理論可用名額應該剛好是 16 - 4 = 12，符合 tileLoadGuard.js 檔頭「平時至少留 12 個名額給底圖」的宣稱');
});

/* ---------------------------------------------------------
   情境 B：歷史圖磚 LOADING 請求數明顯超過 4
--------------------------------------------------------- */
test('情境 B1：8 顆歷史圖磚同時進入 LOADING -> 尖峰佔用 8 個名額（不是 4），底圖可用名額剩 8 個，明顯低於檔頭宣稱的 12 個', async () => {
  const queue = await runLoadBatch(8, { throttled: true });

  // 關鍵點：tileRenderRequestPool 只限制「真正在下載」的併發數（上限
  // 4），但 OL 早在呼叫 tileLoadFunction 前就把全部 8 顆都標記
  // LOADING——排隊中的另外 4 顆並沒有因為「還沒真的發送網路請求」而
  // 少算進全域名額，尖峰仍然是 8，不是被壓低到 4。
  assertEqual(queue.peak, 8, '8 顆同時請求時，OL 認定的 LOADING 尖峰應該是 8（排隊中的圖磚一樣持續佔用全域名額，不會因為排隊而少算）');
  assertEqual(OL_GLOBAL_LOADING_CAP - queue.peak, 8, '底圖可用名額應該只剩 8 個，比檔頭宣稱的「至少 12 個」少了 4 個');
});

test('情境 B2：16 顆歷史圖磚同時進入 LOADING（例如複合疊圖＋快速平移跨多顆圖磚）-> 尖峰佔滿全部 16 個名額，底圖完全沒有可用名額', async () => {
  const queue = await runLoadBatch(16, { throttled: true });

  assertEqual(queue.peak, 16, '16 顆同時請求時，OL 認定的 LOADING 尖峰應該佔滿全部 16 個全域名額');
  assertEqual(OL_GLOBAL_LOADING_CAP - queue.peak, 0, '底圖可用名額應該是 0，完全沒有餘裕，跟檔頭「平時至少留 12 個」的假設完全不成立');
});

test('情境 B：跟「完全不節流」基準情境相比，尖峰佔用名額其實一樣（都是 N），但節流會讓佔用名額的持續時間明顯拉長（約 ceil(N/4) 倍）', async () => {
  // 這是本次量化最重要的發現：tileRenderRequestPool 並沒有「降低」OL
  // 認定的尖峰佔用（那是由 OL 自己一次排入多少顆 LOADING 決定，不受
  // 我們的節流池影響），它真正造成的差異是「這些名額被佔用多久」——
  // 節流池把原本可以平行下載、很快 resolve 釋放名額的請求，改成分批
  // 序列化處理，讓部分圖磚閒置排隊、拉長了整批請求佔用全域名額的總
  // 時間，這段時間內底圖同樣拿不到這些被佔用的名額。
  const n = 16;
  const baseline = await runLoadBatch(n, { throttled: false }); // 模擬「拿掉 tileRenderRequestPool，只受 OL 全域 16 個名額限制」
  const throttledQueue = await runLoadBatch(n, { throttled: true }); // 正式程式碼目前的節流上限（4）

  assertEqual(baseline.peak, throttledQueue.peak, '兩種情境的尖峰佔用名額應該相同（都取決於 OL 一次排入幾顆 LOADING，不受節流池影響）');

  const baselineMax = baseline.maxDuration();
  const throttledMax = throttledQueue.maxDuration();

  assertTrue(baselineMax < DELAY_MS * 2, `基準情境（不節流）應該接近一次來回耗時（${DELAY_MS}ms）就全部釋放完畢，實際最長佔用 ${baselineMax}ms`);
  // ceil(16/4) = 4 輪；只要求明顯超過基準情境的 2.5 倍（保守門檻，避免
  // CI 機器排程雜訊造成偶發性失敗），實際上應該接近 4 倍。
  assertTrue(throttledMax >= baselineMax * 2.5, `節流後最長佔用時間應該明顯拉長（約 4 倍），實際基準 ${baselineMax}ms、節流後 ${throttledMax}ms`);
});

test('情境 B：8 顆歷史圖磚時，節流後的佔用時間也應該明顯拉長（約 ceil(8/4)=2 倍），不是只有 16 顆才有感', async () => {
  const n = 8;
  const baseline = await runLoadBatch(n, { throttled: false });
  const throttledQueue = await runLoadBatch(n, { throttled: true });

  assertEqual(baseline.peak, throttledQueue.peak, '兩種情境的尖峰佔用名額應該相同');

  const baselineMax = baseline.maxDuration();
  const throttledMax = throttledQueue.maxDuration();
  assertTrue(throttledMax >= baselineMax * 1.5, `8 顆圖磚時，節流後最長佔用時間應該明顯拉長（約 2 倍），實際基準 ${baselineMax}ms、節流後 ${throttledMax}ms`);
});

/* ---------------------------------------------------------
   情境 C：attachStaleTileAbort() 對「還在節流池排隊、根本還沒真的
   發送網路請求」的圖磚，是否也能同步釋放 OL 全域名額
--------------------------------------------------------- */
test('情境 C：16 顆歷史圖磚同時進入 LOADING、其中 8 顆因視角改變而 stale -> moveend 觸發後應同步釋放這 8 個全域名額，不用乾等排到節流池 slot', async () => {
  const queue = new GlobalLoadingQueueTracker(OL_GLOBAL_LOADING_CAP);
  // timeoutMs 刻意設很長，確保這批圖磚不會在測試視窗內因為逾時機制
  // 自然 resolve，狀態變化只可能來自 stale abort 的介入，量測才乾淨。
  const loadFn = createGuardedTileLoadFunction({ timeoutMs: 999999 });

  const taipei15 = TAIPEI_TILE;
  const kaohsiung15 = lonLatToTileXY(120.3010, 22.6273, 15); // 跟目前視角明顯不相交，之後會變成 stale

  urlResults['stale-keep'] = 'timeout-always'; // 不會被真的用到，只是保留慣例命名

  const staleTiles = [];
  const keepTiles = [];
  for(let i = 0; i < 8; i++){
    const url = `http://tile-render-pool-impact/queue-mitigation-stale-${i}`;
    urlResults[url] = 'timeout-always';
    const tile = new TrackedFakeTile([kaohsiung15.z, kaohsiung15.x, kaohsiung15.y], queue);
    staleTiles.push(tile);
    queue.enter(tile);
    loadFn(tile, url);
  }
  for(let i = 0; i < 8; i++){
    const url = `http://tile-render-pool-impact/queue-mitigation-keep-${i}`;
    urlResults[url] = 'timeout-always';
    const tile = new TrackedFakeTile([taipei15.z, taipei15.x, taipei15.y], queue);
    keepTiles.push(tile);
    queue.enter(tile);
    loadFn(tile, url);
  }

  // 前置條件：16 顆全部計入 LOADING，節流池本身只有 4 個真正在下載，
  // 其餘 12 個（含之後要被判定 stale 的 8 顆裡，至少一部分）還在排隊、
  // 根本還沒發送過網路請求——用來確認「排隊中」跟「真正在下載」是分開
  // 的兩件事，接下來的 abort 要驗證的正是排隊中的那些也能被同步釋放。
  assertEqual(queue.active, 16, '前置條件：16 顆圖磚應該全部計入 OL 全域 LOADING（不受節流池排隊與否影響）');
  assertEqual(tileRenderRequestPool.getStats().active, TILE_RENDER_MAX_CONCURRENCY, `節流池本身應該只有 ${TILE_RENDER_MAX_CONCURRENCY} 個真正在下載`);
  assertEqual(tileRenderRequestPool.getStats().queued, 16 - TILE_RENDER_MAX_CONCURRENCY, '其餘應該都還在節流池排隊，尚未真的發送網路請求');
  assertEqual(queue.availableForBasemap(), 0, '前置條件：全域 16 個名額已被歷史圖磚佔滿，底圖完全沒有可用名額');

  const currentExtent = tileXYToBbox(taipei15.x, taipei15.y, taipei15.z);
  const fakeMap = makeFakeMap({ zoom: taipei15.z, extent: currentExtent });
  attachStaleTileAbort(fakeMap);
  fakeMap._trigger('moveend');

  // 關鍵驗證：這 8 顆「高雄」圖磚裡，有些根本還沒排到節流池 slot（從未
  // 真的呼叫過 img.src），但 entry.abort 在呼叫 tileRenderRequestPool.run()
  // 之前就已經同步指定好，所以 moveend 觸發當下就能同步 setState()、
  // 立刻釋放這些圖磚佔用的 OL 全域名額，不需要等它們排到 slot 或等
  // 逾時（999999ms）才釋放。
  assertEqual(queue.active, 8, 'stale abort 應該同步釋放全部 8 顆過期圖磚佔用的全域名額，不論它們當下是真的在下載還是還在節流池排隊');
  assertEqual(queue.availableForBasemap(), 8, '釋放後底圖應該恢復 8 個可用名額');
  staleTiles.forEach((t, i) => assertEqual(t.state, TILE_STATE.IDLE, `第 ${i} 顆過期圖磚應該被同步放棄成 IDLE（不是永久 ERROR），才能之後重新進入可視範圍時正常重新載入`));
  keepTiles.forEach((t, i) => assertEqual(t.state, null, `第 ${i} 顆仍相關的圖磚不應該被誤傷，應該維持在途狀態`));

  // 測試結束前清乾淨剩下的 8 顆「仍相關」圖磚，避免遺留 999999ms 的
  // 計時器讓 Node process 無法自然結束（比照 tile-load-guard.test.mjs
  // 既有案例「結束前想辦法讓它 resolve／被 abort」的慣例）。
  const fakeMap2 = makeFakeMap({ zoom: 3, extent: [1, 1, 2, 2] });
  attachStaleTileAbort(fakeMap2);
  fakeMap2._trigger('moveend');
  assertEqual(queue.active, 0, '測試結束前應該清空所有剩餘的在途請求，避免遺留計時器');
});

await run();
