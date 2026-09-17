import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import { TileChecker } from '../../src/tileChecker.js';
import { createTileImageStub } from '../tileImageStub.mjs';

// 這份測試需要精準計算「Image 建構了幾次」（等於真的送出幾次探測），
// 用共用的 createTileImageStub() 覆蓋掉 env-stub 提供的版本，疊加自己
// 的計數邏輯（見 tests/tileImageStub.mjs 檔頭說明）。
let imageCount = 0;
const urlResults = {};
globalThis.Image = createTileImageStub({ urlResults, onConstruct: () => { imageCount++; } });

test('相同網址第二次查詢會命中快取，不會重新發送請求', async () => {
  const checker = new TileChecker({ concurrency: 4, timeoutMs: 500 });
  urlResults['http://x/a'] = true;
  await checker.checkOne('http://x/a');
  const countAfterFirst = imageCount;
  await checker.checkOne('http://x/a');
  assertEqual(imageCount, countAfterFirst, '第二次查詢不該增加請求次數');
});

test('同一網址同時查詢兩次，只會真的發送一次請求（in-flight 去重）', async () => {
  const checker = new TileChecker({ concurrency: 4, timeoutMs: 500 });
  urlResults['http://x/b'] = true;
  const before = imageCount;
  await Promise.all([checker.checkOne('http://x/b'), checker.checkOne('http://x/b')]);
  assertEqual(imageCount - before, 1, '應該只發送 1 次請求');
});

test('checkOne：即使 _probeWithRetry() 意外 reject（目前保證只會 resolve，這裡模擬防禦性分支），pending 也要被清掉，不會永久卡住同一個 url', async () => {
  const checker = new TileChecker({ concurrency: 4, timeoutMs: 500 });
  const url = 'http://x/unexpected-reject';
  // 覆蓋掉 prototype 方法，模擬「_probeWithRetry() 這次意外 reject」——
  // 只影響這個 checker 實例，不影響其他測試案例。
  checker._probeWithRetry = () => Promise.reject(new Error('模擬非預期例外'));

  const originalWarn = console.warn;
  const warnCalls = [];
  console.warn = (...args) => warnCalls.push(args);
  let result;
  try{
    result = await checker.checkOne(url);
  } finally {
    console.warn = originalWarn;
  }
  assertEqual(result, false, '意外 reject 應該視為「探測失敗」，回傳 false 而不是讓例外往外拋');
  assertTrue(warnCalls.length > 0, '應該有留下 console.warn 診斷訊息，不能悄悄吞掉');
  assertTrue(!checker.pending.has(url), 'pending 應該已經被清掉，不會永久卡住這個 url');

  // 換回正常的 _probeWithRetry（恢復用 prototype 上的原始方法），驗證
  // 同一個 url 之後還能正常再查一次，不會因為第一次意外失敗就永久卡死。
  delete checker._probeWithRetry;
  urlResults[url] = true;
  const retryResult = await checker.checkOne(url);
  assertEqual(retryResult, true, '清掉 pending 後，同一個 url 應該可以重新正常探測');
});

test('checkBatch 會回傳有資料的候選項目，且進度回呼會被呼叫', async () => {
  const checker = new TileChecker({ concurrency: 4, timeoutMs: 500 });
  urlResults['http://x/c'] = true;
  urlResults['http://x/d'] = false;
  const candidates = [{ id: 1, url: 'http://x/c' }, { id: 2, url: 'http://x/d' }];
  let progressCalls = 0;
  const available = await checker.checkBatch(candidates, c => c.url, () => progressCalls++);
  assertEqual(available.length, 1, '應該只有一筆有資料');
  assertEqual(available[0].id, 1, '有資料的應該是 id=1');
  assertEqual(progressCalls, 2, '進度回呼應該被呼叫 2 次（候選數）');
});

await run();
