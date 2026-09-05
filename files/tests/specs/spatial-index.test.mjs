import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import { readFileSync } from 'fs';
import path from 'path';
import { lonLatToTileXY, pointInBbox } from '../../src/core/tileGeo.js';
import { TileChecker } from '../../src/tileChecker.js';
import { filterCandidatesByBbox, SEARCH_ZOOM } from '../../src/features/search.js';

/* ---------------------------------------------------------
   1~3：pointInBbox 正常情況、邊界、明顯超出範圍
--------------------------------------------------------- */
const TAIWAN_BBOX = [119, 21, 123, 26]; // 概略涵蓋台灣本島的假 bbox，方便手算驗證

test('pointInBbox：座標在合法 bbox 內部 -> true', () => {
  assertTrue(pointInBbox(121.5654, 25.0330, TAIWAN_BBOX), '台北座標應該落在 bbox 內');
});

test('pointInBbox：座標明確在 bbox 外部 -> false', () => {
  assertTrue(!pointInBbox(150, 25.0330, TAIWAN_BBOX), '經度 150 明顯超出範圍，應為 false');
});

test('pointInBbox：座標剛好等於 minLon/maxLon/minLat/maxLat 邊界 -> 應視為在範圍內（true）', () => {
  const [minLon, minLat, maxLon, maxLat] = TAIWAN_BBOX;
  assertTrue(pointInBbox(minLon, 23, TAIWAN_BBOX), 'lon === minLon 應視為範圍內');
  assertTrue(pointInBbox(maxLon, 23, TAIWAN_BBOX), 'lon === maxLon 應視為範圍內');
  assertTrue(pointInBbox(121, minLat, TAIWAN_BBOX), 'lat === minLat 應視為範圍內');
  assertTrue(pointInBbox(121, maxLat, TAIWAN_BBOX), 'lat === maxLat 應視為範圍內');
});

test('pointInBbox：經度、緯度都明顯超出範圍好幾度 -> false', () => {
  assertTrue(!pointInBbox(90, 40, TAIWAN_BBOX), '經緯度都遠遠超出範圍，應為 false');
});

/* ---------------------------------------------------------
   4~5：bbox 缺失／格式錯誤時的 fallback（一律 true）
--------------------------------------------------------- */
test('pointInBbox：bbox 為 undefined -> fallback true', () => {
  assertTrue(pointInBbox(121.5654, 25.0330, undefined), 'bbox 缺失應該 fallback 為 true');
});

test('pointInBbox：bbox 為 null -> fallback true', () => {
  assertTrue(pointInBbox(121.5654, 25.0330, null), 'bbox 為 null 應該 fallback 為 true');
});

test('pointInBbox：bbox 不是陣列（物件）-> fallback true', () => {
  assertTrue(pointInBbox(121.5654, 25.0330, { minLon: 119, minLat: 21, maxLon: 123, maxLat: 26 }), 'bbox 是物件應該 fallback 為 true');
});

test('pointInBbox：bbox 不是陣列（字串）-> fallback true', () => {
  assertTrue(pointInBbox(121.5654, 25.0330, '119,21,123,26'), 'bbox 是字串應該 fallback 為 true');
});

test('pointInBbox：bbox 陣列長度不是 4（太短）-> fallback true', () => {
  assertTrue(pointInBbox(121.5654, 25.0330, [119, 21, 123]), 'bbox 長度為 3 應該 fallback 為 true');
});

test('pointInBbox：bbox 陣列長度不是 4（太長）-> fallback true', () => {
  assertTrue(pointInBbox(121.5654, 25.0330, [119, 21, 123, 26, 999]), 'bbox 長度為 5 應該 fallback 為 true');
});

test('pointInBbox：bbox 陣列含 NaN -> fallback true', () => {
  assertTrue(pointInBbox(121.5654, 25.0330, [119, NaN, 123, 26]), 'bbox 含 NaN 應該 fallback 為 true');
});

test('pointInBbox：bbox 陣列含 undefined -> fallback true', () => {
  assertTrue(pointInBbox(121.5654, 25.0330, [119, 21, undefined, 26]), 'bbox 含 undefined 應該 fallback 為 true');
});

test('pointInBbox：bbox 陣列含字串（非有限數字）-> fallback true', () => {
  assertTrue(pointInBbox(121.5654, 25.0330, [119, '21', 123, 26]), 'bbox 含字串應該 fallback 為 true（即使字串本身看起來像數字）');
});

/* ---------------------------------------------------------
   6：lonLatToTileXY 換算正確性（台北市中心 + 公式手算交叉驗證）
--------------------------------------------------------- */
test('lonLatToTileXY：台北市中心座標換算出合理且正確的圖磚座標', () => {
  const z = 15;
  const lon = 121.5654, lat = 25.0330;
  const tile = lonLatToTileXY(lon, lat, z);

  assertEqual(tile.z, 15, 'z 應該原樣回傳');
  const n = Math.pow(2, z);
  assertTrue(tile.x >= 0 && tile.x <= n - 1, `x 應在 0 ~ ${n - 1} 範圍內，實際 ${tile.x}`);
  assertTrue(tile.y >= 0 && tile.y <= n - 1, `y 應在 0 ~ ${n - 1} 範圍內，實際 ${tile.y}`);

  // 獨立用標準 Slippy Map 公式手算一次，交叉比對 lonLatToTileXY 的實作結果
  const expectedX = Math.floor((lon + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const expectedY = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  assertEqual(tile.x, expectedX, 'x 座標應符合標準 Slippy Map 公式手算結果');
  assertEqual(tile.y, expectedY, 'y 座標應符合標準 Slippy Map 公式手算結果');
});

/* ---------------------------------------------------------
   7：用 sinica.json 裡 JM20K_1904 實際的 bbox 驗證 pointInBbox
--------------------------------------------------------- */
test('pointInBbox：用 JM20K_1904 實際 bbox，台北座標為 true、北京座標為 false', () => {
  // 注意：env-stub.mjs 會把全域 globalThis.URL 換成假物件（只有
  // createObjectURL/revokeObjectURL），所以這裡不能用 `new URL(...)`
  // 解析路徑，改用 path.join(process.cwd(), ...) 取得絕對路徑。
  const sinicaPath = path.join(process.cwd(), 'data/layers/sinica.json');
  const sinica = JSON.parse(readFileSync(sinicaPath, 'utf-8'));

  // sinica.json 的圖層階層是 categories -> (groups ->) layers，逐層攤平找出 id === 'JM20K_1904' 的那筆
  let target = null;
  (sinica.categories || []).forEach(cat => {
    const layersArr = cat.groups ? cat.groups.flatMap(g => g.layers) : cat.layers;
    (layersArr || []).forEach(layer => { if(layer.id === 'JM20K_1904') target = layer; });
  });

  assertTrue(!!target, '應該要能在 sinica.json 裡找到 JM20K_1904 這筆圖層');
  assertTrue(!!(target.region && Array.isArray(target.region.bbox)), 'JM20K_1904 應該要有 region.bbox');

  const bbox = target.region.bbox;
  assertEqual(bbox.length, 4, 'bbox 應該有 4 個元素');
  assertEqual(bbox[0], 117.84953432, 'minLon 應與 sinica.json 實際數值一致');
  assertEqual(bbox[1], 21.65607265, 'minLat 應與 sinica.json 實際數值一致');

  assertTrue(pointInBbox(121.5654, 25.0330, bbox), '台北座標應該落在 JM20K_1904 的 bbox 內');
  assertTrue(!pointInBbox(116.4074, 39.9042, bbox), '北京座標明顯在台灣以外，應該不在 JM20K_1904 的 bbox 內');
});

/* ---------------------------------------------------------
   8：tile URL 生成——{z}/{x}/{y} 佔位符正確替換
--------------------------------------------------------- */
test('tile URL 生成：{z}/{x}/{y} 佔位符能正確替換成 lonLatToTileXY() 算出的座標', () => {
  const tile = lonLatToTileXY(121.5654, 25.0330, 15);
  const template = 'https://example.com/wmts/{z}/{y}/{x}.jpg';
  const url = template.replace('{z}', tile.z).replace('{x}', tile.x).replace('{y}', tile.y);
  assertEqual(url, `https://example.com/wmts/${tile.z}/${tile.y}/${tile.x}.jpg`, '佔位符應該被正確替換');
  assertTrue(!url.includes('{'), '替換後不應該還殘留未替換的佔位符');
});

test('tile URL 生成：比照 search.js urlOf 的組法（c.src.tileUrl(c.layer) 再替換佔位符）', () => {
  const tile = lonLatToTileXY(121.5654, 25.0330, 15);
  const fakeSrc = { tileUrl: (layer) => `https://x/${layer.id}/{z}/{x}/{y}.png` };
  const fakeLayer = { id: 'JM20K_1904' };
  const c = { src: fakeSrc, layer: fakeLayer };
  const urlOf = (c) => c.src.tileUrl(c.layer).replace('{z}', tile.z).replace('{x}', tile.x).replace('{y}', tile.y);
  const url = urlOf(c);
  assertEqual(url, `https://x/JM20K_1904/${tile.z}/${tile.x}/${tile.y}.png`, 'urlOf 組出的網址應該正確替換座標');
});

/* ---------------------------------------------------------
   9：filterCandidatesByBbox 確實可以減少 candidate layers
--------------------------------------------------------- */
test('filterCandidatesByBbox：篩掉座標落在 bbox 外的候選，保留範圍內的與沒有 bbox 的', () => {
  const lon = 121.5654, lat = 25.0330; // 台北

  const insideCandidate = { src: { id: 'srcA' }, layer: { id: 'inside', region: { bbox: [119, 21, 123, 26] } } };
  const outsideCandidate1 = { src: { id: 'srcB' }, layer: { id: 'outside1', region: { bbox: [110, 30, 112, 32] } } }; // 明顯不涵蓋台北
  const outsideCandidate2 = { src: { id: 'srcC' }, layer: { id: 'outside2', region: { bbox: [-10, -10, -5, -5] } } }; // 更明顯不涵蓋
  const noBboxCandidate = { src: { id: 'srcD' }, layer: { id: 'no-bbox', region: null } };

  const candidates = [insideCandidate, outsideCandidate1, outsideCandidate2, noBboxCandidate];
  const filtered = filterCandidatesByBbox(candidates, lon, lat);

  assertTrue(filtered.length < candidates.length, '篩選後的陣列長度應該比輸入短，證明有起到篩選效果');
  assertEqual(filtered.length, 2, '應該只剩下範圍內的 1 筆 + 沒有 bbox 的 1 筆，共 2 筆');

  const filteredIds = filtered.map(c => c.layer.id).sort();
  assertEqual(JSON.stringify(filteredIds), JSON.stringify(['inside', 'no-bbox']), '剩下的候選應該是 inside 與 no-bbox');

  // 不 mutate 傳入的陣列
  assertEqual(candidates.length, 4, '傳入的原始 candidates 陣列不應該被 mutate');
});

/* ---------------------------------------------------------
   10：全域 tile concurrency 不超過上限（含巢狀 checkBatchAny 的情境）
--------------------------------------------------------- */
let aliveCount = 0;
let maxAlive = 0;
globalThis.Image = class {
  constructor(){
    aliveCount++;
    if(aliveCount > maxAlive) maxAlive = aliveCount;
    const self = this;
    setTimeout(() => {
      aliveCount--;
      self.naturalWidth = 10;
      self.naturalHeight = 10;
      if(self.onload) self.onload();
    }, 5);
  }
  set src(v){ this._url = v; }
};

test('全域 tile concurrency 不超過上限：checkBatchAny 巢狀 Promise.all 探測鄰近圖磚時，同時存活的請求數仍受 request pool 限制', async () => {
  const N = 4;
  const checker = new TileChecker({ concurrency: N, timeoutMs: 2000 });
  aliveCount = 0;
  maxAlive = 0;

  // 6 筆候選項目，每筆各自要探測 6 個不同網址（模擬鄰近圖磚 fallback），
  // 用 checkBatchAny 對每個候選項目內部用 Promise.all 平行探測——這正是
  // 「巢狀 Promise.all 疊加出遠超 concurrency 的請求數」這個 bug 的重現情境。
  const candidates = Array.from({ length: 6 }, (_, i) => ({
    id: i,
    urls: Array.from({ length: 6 }, (_, j) => `http://x/spatial-index/c${i}/n${j}`),
  }));

  await checker.checkBatchAny(candidates, c => c.urls);

  assertTrue(maxAlive > 0, '過程中應該真的有發送請求');
  assertTrue(maxAlive <= N, `同一時間存活中的請求數最大值應該 <= ${N}，實際最大值為 ${maxAlive}`);
});

/* ---------------------------------------------------------
   11~14：thm.json（中研院桃竹苗舊地籍圖）hsinchu_tj7a0510「新埔街」
   完整流程實測：bbox 篩選 → tile 座標計算 → WMTS URL 生成
--------------------------------------------------------- */
const thmPath = path.join(process.cwd(), 'data/layers/thm.json');
const thm = JSON.parse(readFileSync(thmPath, 'utf-8'));

const HSINCHU_BBOX = [121.06843282962, 24.820196012772, 121.08150408131, 24.834666816317];
const TEST_LON = 121.074, TEST_LAT = 24.827;

test('pointInBbox：thm.json 讀出 hsinchu_tj7a0510 實際 bbox 應與預期一致，且測試座標落在範圍內', () => {
  // 從 thm.json 攤平找出 id === 'hsinchu_tj7a0510' 這筆，驗證 bbox 不是憑空捏造
  let target = null;
  (thm.categories || []).forEach(cat => {
    const layersArr = cat.groups ? cat.groups.flatMap(g => g.layers) : cat.layers;
    (layersArr || []).forEach(layer => { if(layer.id === 'hsinchu_tj7a0510') target = layer; });
  });

  assertTrue(!!target, '應該要能在 thm.json 裡找到 hsinchu_tj7a0510 這筆圖層');
  assertTrue(!!(target.region && Array.isArray(target.region.bbox)), 'hsinchu_tj7a0510 應該要有 region.bbox');
  assertEqual(JSON.stringify(target.region.bbox), JSON.stringify(HSINCHU_BBOX), 'thm.json 實際 bbox 應與預期數值一致');

  assertTrue(pointInBbox(TEST_LON, TEST_LAT, target.region.bbox), '測試座標 (121.074, 24.827) 應該落在新埔街圖層 bbox 內');
});

test('filterCandidatesByBbox：thm 來源新埔街候選應被保留，範圍明顯不涵蓋的候選應被排除', () => {
  const insideCandidate = {
    src: { id: 'thm' },
    layer: { id: 'hsinchu_tj7a0510', region: { bbox: HSINCHU_BBOX } }
  };
  // 找一筆 thm.json 裡明顯離新竹很遠、bbox 不涵蓋測試座標的圖層當作對照組
  let farLayer = null;
  (thm.categories || []).forEach(cat => {
    const layersArr = cat.groups ? cat.groups.flatMap(g => g.layers) : cat.layers;
    (layersArr || []).forEach(layer => {
      if(farLayer) return;
      const bbox = layer.region && layer.region.bbox;
      if(Array.isArray(bbox) && bbox.length === 4 && !pointInBbox(TEST_LON, TEST_LAT, bbox)){
        farLayer = layer;
      }
    });
  });
  assertTrue(!!farLayer, '應該能在 thm.json 裡找到至少一筆 bbox 不涵蓋測試座標的圖層當對照組');

  const outsideCandidate = { src: { id: 'thm' }, layer: farLayer };
  const fakeOutsideCandidate = { src: { id: 'thm' }, layer: { id: 'fake-far-away', region: { bbox: [110, 30, 112, 32] } } };

  const candidates = [insideCandidate, outsideCandidate, fakeOutsideCandidate];
  const filtered = filterCandidatesByBbox(candidates, TEST_LON, TEST_LAT);

  const filteredIds = filtered.map(c => c.layer.id);
  assertTrue(filteredIds.includes('hsinchu_tj7a0510'), '篩選結果應該包含 hsinchu_tj7a0510');
  assertTrue(!filteredIds.includes(farLayer.id), `篩選結果不應該包含範圍不涵蓋測試座標的 ${farLayer.id}`);
  assertTrue(!filteredIds.includes('fake-far-away'), '篩選結果不應該包含明顯不涵蓋測試座標的假造候選 fake-far-away');
});

test('lonLatToTileXY：新埔街測試座標用 SEARCH_ZOOM 換算出合理且正確的 tile 座標', () => {
  assertEqual(SEARCH_ZOOM, 15, 'SEARCH_ZOOM 目前應為 15（若未來調整，此斷言會提醒同步更新測試）');

  const tile = lonLatToTileXY(TEST_LON, TEST_LAT, SEARCH_ZOOM);
  assertEqual(tile.z, SEARCH_ZOOM, 'z 應該原樣回傳 SEARCH_ZOOM');

  const n = Math.pow(2, SEARCH_ZOOM);
  assertTrue(Number.isInteger(tile.x) && tile.x >= 0 && tile.x <= n - 1, `x 應為 0 ~ ${n - 1} 範圍內的整數，實際 ${tile.x}`);
  assertTrue(Number.isInteger(tile.y) && tile.y >= 0 && tile.y <= n - 1, `y 應為 0 ~ ${n - 1} 範圍內的整數，實際 ${tile.y}`);

  // 獨立用標準 Slippy Map 公式手算一次，交叉比對 lonLatToTileXY 的實作結果
  const expectedX = Math.floor((TEST_LON + 180) / 360 * n);
  const latRad = TEST_LAT * Math.PI / 180;
  const expectedY = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  assertEqual(tile.x, expectedX, 'x 座標應符合標準 Slippy Map 公式手算結果');
  assertEqual(tile.y, expectedY, 'y 座標應符合標準 Slippy Map 公式手算結果');
});

test('WMTS URL 生成：比照 resolveTileUrl 組法，組出 hsinchu_tj7a0510 的 file-exists.php 網址且無殘留佔位符', () => {
  assertTrue(!!(thm.provider && thm.provider.tileTemplate), 'thm.json 應該要有 provider.tileTemplate');
  const tileTemplate = thm.provider.tileTemplate;
  assertEqual(
    tileTemplate,
    'https://gis.sinica.edu.tw/thm/file-exists.php?img={id}-{format}-{z}-{x}-{y}',
    'thm.json provider.tileTemplate 應與預期樣板一致'
  );

  const layerId = 'hsinchu_tj7a0510';
  const layerFormat = 'png';

  const tile = lonLatToTileXY(TEST_LON, TEST_LAT, SEARCH_ZOOM);

  // 比照 src/data.js resolveTileUrl()：先套 {id}/{format}（來源層級 provider），
  // 再比照 src/features/search.js urlOf()：套上 {z}/{x}/{y}（搜尋當下算出的 tile 座標）
  const url = tileTemplate
    .replace('{id}', layerId)
    .replace('{format}', layerFormat)
    .replace('{z}', tile.z)
    .replace('{x}', tile.x)
    .replace('{y}', tile.y);

  const expectedUrl = `https://gis.sinica.edu.tw/thm/file-exists.php?img=hsinchu_tj7a0510-png-${tile.z}-${tile.x}-${tile.y}`;
  assertEqual(url, expectedUrl, '組出的 URL 應符合 file-exists.php 格式');
  assertTrue(!url.includes('{') && !url.includes('}'), '替換後不應該還殘留任何未替換的佔位符');
});

/* ---------------------------------------------------------
   15~：全站 bbox 覆蓋率回歸測試——防止未來改動 data/layers/*.json
   或 tools/fetch-wmts-bbox.js 時，某個來源的 bbox 資料整批消失卻沒被發現
--------------------------------------------------------- */
function isValidBbox(bbox){
  return Array.isArray(bbox) && bbox.length === 4 &&
    bbox.every(n => typeof n === 'number' && Number.isFinite(n));
}

function countBboxCoverage(src){
  let total = 0, withBbox = 0;
  (src.categories || []).forEach(cat => {
    const layersArr = cat.groups ? cat.groups.flatMap(g => g.layers) : cat.layers;
    (layersArr || []).forEach(layer => {
      total++;
      if(isValidBbox(layer.region && layer.region.bbox)) withBbox++;
    });
  });
  return { total, withBbox };
}

const bundlePath = path.join(process.cwd(), 'data/layers.bundle.json');
const bundle = JSON.parse(readFileSync(bundlePath, 'utf-8'));

// udd 沒有對應的 WMTS Capabilities 端點，目前是預期內、已知的 0% 覆蓋率來源，
// 其餘 29 個來源這次改造後應該全數 100% 補齊 region.bbox。
const KNOWN_ZERO_BBOX_SOURCES = ['udd'];

(bundle.sources || []).forEach(src => {
  const { total, withBbox } = countBboxCoverage(src);

  if(KNOWN_ZERO_BBOX_SOURCES.includes(src.id)){
    test(`全站 bbox 覆蓋率：來源 ${src.id} 目前應為 0 筆有 bbox（無對應 WMTS Capabilities 端點，非本次疏漏）`, () => {
      assertTrue(total > 0, `來源 ${src.id} 應該至少有 1 筆圖層，實際 ${total} 筆`);
      assertEqual(withBbox, 0, `來源 ${src.id} 目前預期為 0 筆有 bbox（無 WMTS Capabilities 端點），實際 ${withBbox}/${total}`);
    });
  } else {
    test(`全站 bbox 覆蓋率：來源 ${src.id} 應該 100% 圖層都有合法 region.bbox`, () => {
      assertTrue(total > 0, `來源 ${src.id} 應該至少有 1 筆圖層，實際 ${total} 筆`);
      assertEqual(withBbox, total, `來源 ${src.id} 應該全部 ${total} 筆圖層都有合法 bbox，實際只有 ${withBbox}/${total}`);
    });
  }
});

test('全站 bbox 覆蓋率：總計圖層數應為 2261 筆（新增 korea 來源 16 筆後同步更新）', () => {
  let totalLayers = 0;
  (bundle.sources || []).forEach(src => { totalLayers += countBboxCoverage(src).total; });
  assertEqual(totalLayers, 2261, `全站圖層總數應為 2261 筆，實際 ${totalLayers} 筆（若有新增/移除圖層來源，請同步更新此測試）`);
});

test('全站 bbox 覆蓋率：有合法 bbox 的圖層總數應 >= 1885 筆（用 >= 而非寫死等於，避免未來補齊 udd 或新增來源時擋路，但仍能抓到既有來源退化的回歸）', () => {
  let totalWithBbox = 0;
  (bundle.sources || []).forEach(src => { totalWithBbox += countBboxCoverage(src).withBbox; });
  assertTrue(totalWithBbox >= 1885, `全站有 bbox 的圖層數應該 >= 1885，實際 ${totalWithBbox}（可能是某個來源的 bbox 資料整批消失了）`);
});

await run();
