/* ---------------------------------------------------------
   tests/specs/tile-request-pool.test.mjs
   ---------------------------------------------------------
   驗證 tileChecker.js 的全域 RequestPool：不論請求來自單一 check()、
   checkBatch()、還是 checkBatchAny() 的鄰近圖磚 fallback（含 timeout
   後的 retry），實際「同時進行中」的 HTTP（這裡是 Image）請求數都
   不會超過 pool 的 maxConcurrency 上限；cache hit／in-flight 去重
   不佔用名額；timeout 一定會釋放 slot，不會卡死排隊中的下一筆請求。
--------------------------------------------------------- */
import '../env-stub.mjs';
import { test, expect } from 'vitest';
import { TileChecker, RequestPool, globalTileRequestPool } from '../../src/tileChecker.js';
import { tileChecker as searchTileChecker } from '../../src/features/search.js';
import { tileChecker as timelineTileChecker } from '../../src/timelineMode.js';
import { createTileImageStub } from '../tileImageStub.mjs';

// 手動再獨立追蹤一次「目前存活中的 Image（等於真正進行中的請求）」，
// 跟 pool.getStats().maxObserved 互相印證，避免測試只是在驗證實作
// 本身有沒有正確更新自己的計數。用共用的 createTileImageStub()（見
// tests/tileImageStub.mjs）疊加 onConstruct／onSettle 兩個 hook 做這份
// 併發追蹤，取代原本整份手刻的 Image class。
let liveImages = 0;
let maxLiveImages = 0;
const urlResults = {}; // url -> true｜false｜'timeout-always'｜'timeout-once'
// 外部再獨立追蹤一次「每個網址真的被送出過幾次探測」，供 Test 3／4
// 驗證 cache hit／in-flight dedup 沒有讓 Image 被重新建構（工廠內部
// 自己也維護一份 attempts 計數來判斷 'timeout-once' 行為，但那份是
// 內部實作細節不對外開放，這裡透過 onSettle hook 另外累計一份）。
const urlAttempts = {};
const DELAY_MS = 15;

function makeImageClass(){
  return createTileImageStub({
    urlResults,
    delayMs: DELAY_MS,
    onConstruct: () => {
      liveImages++;
      if(liveImages > maxLiveImages) maxLiveImages = liveImages;
    },
    // 這裡的 liveImages-- 只代表「模擬網路層在 DELAY_MS 後给出結果」，
    // 不代表 pool slot 何時真的釋放（timeout 情境下 pool 要等
    // TileChecker 自己的 timeoutMs 逾時機制判定失敗才會釋放，比
    // DELAY_MS 晚很多）——所以 maxLiveImages 只當作下限的輔助佐證，
    // 真正判斷 pool 上限有沒有被突破，以 pool.getStats().maxObserved
    // 為準（在 pool.run() 內部、slot 真正 acquire/release 時同步更新）。
    onSettle: (self) => {
      liveImages--;
      const url = self._url;
      urlAttempts[url] = (urlAttempts[url] || 0) + 1;
    },
  });
}
globalThis.Image = makeImageClass();

function withTimeout(promise, ms, msg){
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(msg || `超過 ${ms}ms 沒有完成，可能發生 deadlock`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

test('Test 1：RequestPool 全域 concurrency 上限，20 個任務同時排隊也不會超過上限', async () => {
  const pool = new RequestPool(3);
  let active = 0;
  let maxObserved = 0;
  const tasks = Array.from({ length: 20 }, () => pool.run(() => new Promise(resolve => {
    active++;
    if(active > maxObserved) maxObserved = active;
    setTimeout(() => { active--; resolve(true); }, 10);
  })));
  await Promise.all(tasks);
  expect(maxObserved <= 3, `手動追蹤的 maxObserved (${maxObserved}) 不應該超過上限 3`).toBeTruthy();
  expect(maxObserved, '20 個任務、上限 3，應該確實有搶到滿 3 個 slot 的時刻').toBe(3);
  expect(pool.getStats().maxObserved <= 3, `pool.getStats().maxObserved (${pool.getStats().maxObserved}) 不應該超過上限 3`).toBeTruthy();
  expect(pool.getStats().active, '全部任務完成後，pool 的 active 應該歸零').toBe(0);
});

test('Test 2：10 個 layer 各自用 Promise.all 做鄰近圖磚 fallback，仍共用同一個 global pool 上限', async () => {
  maxLiveImages = 0;
  const pool = new RequestPool(4);
  const layerCount = 10;
  const checkers = Array.from({ length: layerCount }, () => new TileChecker({ concurrency: 8, timeoutMs: 2000, pool }));
  const jobs = checkers.map((checker, layerIdx) => {
    const candidate = {
      id: layerIdx,
      neighbors: Array.from({ length: 8 }, (_, n) => {
        const url = `http://pool-test/layer${layerIdx}-neighbor${n}`;
        urlResults[url] = n === 0; // 每個 layer 只有第一顆鄰近圖磚有資料，其餘沒有
        return url;
      }),
    };
    return checker.checkBatchAny([candidate], c => c.neighbors);
  });
  await withTimeout(Promise.all(jobs), 5000, 'checkBatchAny 鄰近圖磚 fallback 沒有在時限內完成');
  expect(maxLiveImages <= 4, `手動追蹤的 maxLiveImages (${maxLiveImages}) 不應該超過上限 4，不能讓 10 layer x 8 neighbor 疊加成 80 個並行請求`).toBeTruthy();
  expect(pool.getStats().maxObserved <= 4, `pool.getStats().maxObserved (${pool.getStats().maxObserved}) 不應該超過上限 4`).toBeTruthy();
});

test('Test 3：cache hit 不會增加 active request（也不會建立新的 Image）', async () => {
  const pool = new RequestPool(4);
  const checker = new TileChecker({ concurrency: 4, timeoutMs: 500, pool });
  const url = 'http://pool-test/cache-hit';
  urlResults[url] = true;
  await checker.checkOne(url);
  const attemptsAfterFirst = urlAttempts[url];
  const ok = await checker.checkOne(url);
  expect(ok, '快取的結果應該還是 true').toBeTruthy();
  expect(urlAttempts[url], '第二次是 cache hit，不應該再送出新的 Image 請求').toBe(attemptsAfterFirst);
  expect(pool.getStats().active, 'cache hit 不應該佔用 pool 的 active slot').toBe(0);
});

test('Test 4：同一網址同時查詢 4 次，只會真的發送 1 次請求（in-flight dedup 仍然生效）', async () => {
  const pool = new RequestPool(4);
  const checker = new TileChecker({ concurrency: 4, timeoutMs: 500, pool });
  const url = 'http://pool-test/in-flight-dedup';
  urlResults[url] = true;
  const before = urlAttempts[url] || 0;
  const results = await Promise.all([
    checker.checkOne(url), checker.checkOne(url), checker.checkOne(url), checker.checkOne(url),
  ]);
  expect((urlAttempts[url] || 0) - before, '4 次同時查詢應該只真的送出 1 次請求').toBe(1);
  expect(results.every(r => r === true), '4 次查詢都應該拿到同樣的結果').toBeTruthy();
});

test('Test 5：maxConcurrency=1 時，A 逾時後會釋放 slot，B 才能接著拿到 slot 完成，不會 deadlock', async () => {
  const pool = new RequestPool(1);
  const checkerA = new TileChecker({ concurrency: 1, timeoutMs: 60, pool });
  const checkerB = new TileChecker({ concurrency: 1, timeoutMs: 500, pool });
  const urlA = 'http://pool-test/timeout-blocks-slot';
  const urlB = 'http://pool-test/waits-behind-timeout';
  urlResults[urlA] = 'timeout-always';
  urlResults[urlB] = true;

  const resultA = checkerA.checkOne(urlA);
  // 確保 B 是在 A 已經拿到（唯一的）slot 之後才排隊，重現「B 卡在 A 後面」的情境
  await new Promise(resolve => setTimeout(resolve, 1));
  const resultB = checkerB.checkOne(urlB);

  const [okA, okB] = await withTimeout(
    Promise.all([resultA, resultB]),
    5000,
    'A timeout 後 slot 沒有釋放，B 被卡死（deadlock）'
  );
  expect(!okA, 'A 應該因為持續逾時被判定沒資料').toBeTruthy();
  expect(okB, 'B 應該能在 A 釋放 slot 後正常完成，得到 true').toBeTruthy();
  expect(pool.getStats().active, '兩個請求都結束後，pool 的 active 應該歸零').toBe(0);
});

test('Test 6：center timeout + retry + neighbor fallback 全部經過同一個 pool，仍不超過上限', async () => {
  maxLiveImages = 0;
  const pool = new RequestPool(3);
  const checker = new TileChecker({ concurrency: 4, timeoutMs: 40, pool });
  const centerUrl = 'http://pool-test/retry-center';
  urlResults[centerUrl] = 'timeout-always'; // center 探測（含 retry）都逾時，逼出 retry 路徑
  const neighborUrls = Array.from({ length: 8 }, (_, n) => {
    const u = `http://pool-test/retry-neighbor${n}`;
    urlResults[u] = n === 3; // 其中一顆鄰近圖磚有資料
    return u;
  });

  const candidate = { id: 'retry-item', urls: [centerUrl, ...neighborUrls] };
  const available = await withTimeout(
    checker.checkBatchAny([candidate], c => c.urls),
    5000,
    'center timeout + retry + neighbor fallback 沒有在時限內完成'
  );
  expect(available.length, 'neighbor 裡有一顆成功，這個候選項目應該算有資料').toBe(1);
  expect(maxLiveImages <= 3, `手動追蹤的 maxLiveImages (${maxLiveImages}) 不應該超過上限 3`).toBeTruthy();
  expect(pool.getStats().maxObserved <= 3, `pool.getStats().maxObserved (${pool.getStats().maxObserved}) 不應該超過上限 3`).toBeTruthy();
});

test('features/search.js 與 timelineMode.js 的 TileChecker 真的共用同一個 globalTileRequestPool（不是各自獨立的 pool）', () => {
  expect(searchTileChecker.pool === globalTileRequestPool, 'search.js 的 tileChecker 應該用 globalTileRequestPool').toBeTruthy();
  expect(timelineTileChecker.pool === globalTileRequestPool, 'timelineMode.js 的 tileChecker 應該用 globalTileRequestPool').toBeTruthy();
  expect(searchTileChecker.pool === timelineTileChecker.pool, '兩邊的 tileChecker 應該共用同一個 pool 物件').toBeTruthy();
});
