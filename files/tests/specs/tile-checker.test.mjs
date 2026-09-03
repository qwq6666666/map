import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import { TileChecker } from '../../src/tileChecker.js';

// 這份測試需要精準計算「Image 建構了幾次」（等於真的送出幾次探測），
// 用一個會計數的假 Image 覆蓋掉 env-stub 提供的版本。
let imageCount = 0;
const urlResults = {};
globalThis.Image = class {
  constructor(){
    imageCount++;
    setTimeout(() => {
      const ok = urlResults[this._url] !== false;
      if(ok){ this.naturalWidth = 10; this.naturalHeight = 10; if(this.onload) this.onload(); }
      else if(this.onerror) this.onerror();
    }, 1);
  }
  set src(v){ this._url = v; }
};

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
