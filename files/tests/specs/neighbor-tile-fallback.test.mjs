import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import { lonLatToTileXY, neighborTiles } from '../../src/core/tileGeo.js';
import { TileChecker } from '../../src/tileChecker.js';

test('neighborTiles 一般情況下回傳 8 顆鄰近圖磚，不含自己', () => {
  const tile = { x: 100, y: 100, z: 15 };
  const neighbors = neighborTiles(tile);
  assertEqual(neighbors.length, 8, '一般情況應該是 8 顆');
  assertTrue(!neighbors.some(t => t.x === 100 && t.y === 100), '不應該包含自己');
  const keys = new Set(neighbors.map(t => `${t.x}/${t.y}`));
  assertEqual(keys.size, 8, '8 顆座標應該彼此不重複');
});

test('neighborTiles 在世界地圖邊界（x=0）會夾回合法範圍，並排除跟自己或彼此重複的圖磚', () => {
  const tile = { x: 0, y: 100, z: 15 };
  const neighbors = neighborTiles(tile);
  // x-1 會被夾回 0（跟自己重複，剔除），所以只剩「同一列＋下一列」共 5 顆
  assertEqual(neighbors.length, 5, '邊界情況應該剩 5 顆（夾回後跟自己重複的被剔除）');
  assertTrue(neighbors.every(t => t.x >= 0), '不該出現負的 x 座標');
  assertTrue(!neighbors.some(t => t.x === 0 && t.y === 100), '不應該包含自己');
});

test('lonLatToTileXY 換算出的座標會被夾在合法範圍內（不會出現負值或超出 2^z-1）', () => {
  const tile = lonLatToTileXY(121.5, 25.05, 15); // 台北市中心附近
  const n = Math.pow(2, 15);
  assertTrue(tile.x >= 0 && tile.x < n, 'x 應該在合法範圍內');
  assertTrue(tile.y >= 0 && tile.y < n, 'y 應該在合法範圍內');
});

// 這份測試需要精準計算「Image 建構了幾次」，用一個會計數、且可以模擬
// 「先失敗一次、重試後成功」的假 Image 覆蓋掉 env-stub 提供的版本。
let imageCount = 0;
const urlAttempts = {}; // url -> 已經被探測過幾次
const urlResults = {};  // url -> true / false / 'fail-once'（第一次失敗，第二次成功）
globalThis.Image = class {
  constructor(){
    imageCount++;
    setTimeout(() => {
      const url = this._url;
      urlAttempts[url] = (urlAttempts[url] || 0) + 1;
      const spec = urlResults[url];
      const ok = spec === 'fail-once' ? urlAttempts[url] >= 2 : spec !== false;
      if(ok){ this.naturalWidth = 10; this.naturalHeight = 10; if(this.onload) this.onload(); }
      else if(this.onerror) this.onerror();
    }, 1);
  }
  set src(v){ this._url = v; }
};

test('探測失敗會自動重試一次：第一次失敗、第二次成功，最終視為有資料', async () => {
  const checker = new TileChecker({ concurrency: 4, timeoutMs: 500 });
  urlResults['http://x/retry-ok'] = 'fail-once';
  const ok = await checker.checkOne('http://x/retry-ok');
  assertTrue(ok, '重試後成功，應該視為有資料');
  assertEqual(urlAttempts['http://x/retry-ok'], 2, '應該總共探測了 2 次（原本 1 次 + 重試 1 次）');
});

test('探測兩次都失敗，才真的判定為沒資料', async () => {
  const checker = new TileChecker({ concurrency: 4, timeoutMs: 500 });
  urlResults['http://x/always-fail'] = false;
  const ok = await checker.checkOne('http://x/always-fail');
  assertTrue(!ok, '兩次都失敗，應該視為沒資料');
  assertEqual(urlAttempts['http://x/always-fail'], 2, '應該總共探測了 2 次（原本 1 次 + 重試 1 次）才判定沒資料');
});

test('checkBatchAny：候選項目的其中一個鄰近網址成功，就算該候選項目有資料', async () => {
  const checker = new TileChecker({ concurrency: 4, timeoutMs: 500 });
  urlResults['http://x/n1'] = false;
  urlResults['http://x/n2'] = true; // 鄰近圖磚裡有一顆成功
  urlResults['http://x/n3'] = false;
  urlResults['http://x/m1'] = false; // 這個候選項目全部鄰近圖磚都沒資料
  const candidates = [
    { id: 'a', neighbors: ['http://x/n1', 'http://x/n2', 'http://x/n3'] },
    { id: 'b', neighbors: ['http://x/m1'] },
  ];
  const available = await checker.checkBatchAny(candidates, c => c.neighbors);
  assertEqual(available.length, 1, '應該只有一筆候選項目有資料');
  assertEqual(available[0].id, 'a', '有資料的應該是 id=a');
});

await run();
