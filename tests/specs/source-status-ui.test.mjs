import '../env-stub.mjs';
import { test, expect, beforeEach, afterAll, vi } from 'vitest';

// openSourceStatusDrawer() 的連點防護測試不需要真的探測主機／清失敗紀錄，
// 換成假實作，避免這裡意外發出真的網路請求。
vi.mock('../../src/features/sourceStatus.js', () => ({
  checkAllSourceStatuses: vi.fn(async () => []),
  buildSourceStatusTargets: vi.fn(() => [])
}));
vi.mock('../../src/core/tileLoadGuard.js', () => ({
  getRecentTileFailures: vi.fn(() => []),
  clearRecentTileFailures: vi.fn()
}));
vi.mock('../../src/features/location.js', () => ({ showLocateToast: vi.fn() }));

import { cacheGroupLabel, formatCacheSize, buildBreakdownRow, countCachedTiles, openSourceStatusDrawer } from '../../src/ui/sourceStatusUI.js';

// countCachedTiles() 讀 globalThis.caches（Cache Storage API），測試環境沒有真的
// Service Worker，這裡搭一個最小假版本：cacheStore 是 { 快取名稱: [{url, contentLength|blobSize}] }。
let cacheStore = {};

function fakeResponse(entry){
  return {
    headers: { get: (k) => (k === 'content-length' && entry.contentLength != null ? String(entry.contentLength) : null) },
    blob: async () => ({ size: entry.blobSize ?? 0 })
  };
}

const originalCaches = globalThis.caches;
globalThis.caches = {
  keys: async () => Object.keys(cacheStore),
  open: async (name) => {
    const entries = cacheStore[name] || [];
    return {
      keys: async () => entries.map((e) => ({ url: e.url })),
      match: async (req) => {
        const entry = entries.find((e) => e.url === req.url);
        return entry ? fakeResponse(entry) : undefined;
      }
    };
  }
};
afterAll(() => { globalThis.caches = originalCaches; });

beforeEach(() => {
  cacheStore = {};
});

test('cacheGroupLabel：依快取名稱前綴分成歷史地圖／現代地圖／衛星影像三類', () => {
  expect(cacheGroupLabel('tile-cache-v3')).toBe('歷史地圖');
  expect(cacheGroupLabel('tile-cache-osm-v3')).toBe('現代地圖');
  expect(cacheGroupLabel('tile-cache-sat-v3')).toBe('衛星影像');
});

test('formatCacheSize：未滿 10 MB 顯示到小數第一位，10 MB 以上取整數', () => {
  expect(formatCacheSize(500 * 1024)).toBe('0.5 MB');
  expect(formatCacheSize(9.96 * 1024 * 1024)).toBe('10.0 MB');
  expect(formatCacheSize(35 * 1024 * 1024)).toBe('35 MB');
});

test('countCachedTiles：跨網域請求依快取名稱分組累加張數與位元組數', async () => {
  cacheStore = {
    'tile-cache-v3': [
      { url: 'https://gis.sinica.edu.tw/a.png', contentLength: 1000 },
      { url: 'https://gis.sinica.edu.tw/b.png', contentLength: 2000 }
    ],
    'tile-cache-osm-v3': [
      { url: 'https://tile.osm.org/c.png', contentLength: 3000 }
    ]
  };
  const result = await countCachedTiles();
  expect(result.count).toBe(3);
  expect(result.bytes).toBe(6000);
  const historyGroup = result.groups.find((g) => g.label === '歷史地圖');
  const osmGroup = result.groups.find((g) => g.label === '現代地圖');
  expect(historyGroup).toEqual({ label: '歷史地圖', count: 2, bytes: 3000 });
  expect(osmGroup).toEqual({ label: '現代地圖', count: 1, bytes: 3000 });
  expect(result.groups.find((g) => g.label === '衛星影像')).toBeUndefined(); // 空群組不列出
});

test('countCachedTiles：同源請求與 LRU 索引本身不計入張數（不是使用者要清的圖磚）', async () => {
  cacheStore = {
    'tile-cache-v3': [
      { url: 'https://example.local/assets/icon.svg', contentLength: 100 }, // 同源
      { url: 'https://tile-lru.local/index', contentLength: 100 }, // LRU 索引
      { url: 'https://gis.sinica.edu.tw/real.png', contentLength: 500 }
    ]
  };
  const result = await countCachedTiles();
  expect(result.count).toBe(1);
  expect(result.bytes).toBe(500);
});

test('countCachedTiles：缺 Content-Length 標頭時退回讀 blob().size', async () => {
  cacheStore = {
    'tile-cache-v3': [
      { url: 'https://gis.sinica.edu.tw/no-length.png', blobSize: 777 }
    ]
  };
  const result = await countCachedTiles();
  expect(result.bytes).toBe(777);
});

test('countCachedTiles：沒有任何圖磚快取時回傳全零，不會是 null', async () => {
  const result = await countCachedTiles();
  expect(result).toEqual({ count: 0, bytes: 0, groups: [] });
});

test('countCachedTiles：caches 未定義（不支援 Service Worker 的環境）回傳 null', async () => {
  const saved = globalThis.caches;
  globalThis.caches = undefined;
  try{
    const result = await countCachedTiles();
    expect(result).toBeNull();
  }finally{
    globalThis.caches = saved;
  }
});

// 假 DOM 的 querySelector 不支援 ">" 子代選擇器（見 env-stub.mjs 的 matchesSelector 註解），
// 直接取 .cache-bd-bar 的第一個子節點即可（buildBreakdownRow() 只會塞一個 span 進去）。
function barFillOf(row){
  return row.querySelector('.cache-bd-bar').children[0];
}

test('buildBreakdownRow：比例條依體積佔比計算，且最小維持 3% 讓小群組也看得見', () => {
  const row = buildBreakdownRow({ label: '歷史地圖', count: 10, bytes: 100 }, 10000);
  expect(barFillOf(row).style.width).toBe('3.0%'); // 100/10000=1% 會被拉到最小值 3%
  expect(row.querySelector('.cache-bd-label').textContent).toBe('歷史地圖');
  expect(row.querySelector('.cache-bd-count').textContent).toBe('10 張');
  expect(row.querySelector('.cache-bd-size').textContent).toBe('0.0 MB');
});

test('buildBreakdownRow：totalBytes 為 0 時比例條不會是 NaN%，退回最小值', () => {
  const row = buildBreakdownRow({ label: '歷史地圖', count: 0, bytes: 0 }, 0);
  expect(barFillOf(row).style.width).toBe('3.0%');
});

// buildDrawer() 用 innerHTML 組整個抽屜內容，假 DOM（env-stub.mjs）的 innerHTML
// setter 不會真的解析出子節點（見檔頭註解），querySelector('.guide-drawer-close')
// 在這個假環境裡一定拿 null，所以這裡不整個渲染，只驗證「已經開著就擋住第二次」
// 這個 guard 本身：手動塞一個代表「已開啟」的節點進 document.body，呼叫
// openSourceStatusDrawer() 應該提早 return，不會再去呼叫 buildSourceStatusTargets()/
// checkAllSourceStatuses()（也就不會走到 buildDrawer() 那段在這個假環境會噴例外的
// innerHTML 渲染路徑）。修正前沒有這個 guard，同樣的呼叫會直接嘗試 buildDrawer()
// 而拋出例外，這個測試會如預期失敗。
test('連點「來源狀態／快取」入口：已經開著就擋住第二次，不會重新渲染', async () => {
  const { buildSourceStatusTargets } = await import('../../src/features/sourceStatus.js');
  const fakeOpen = document.createElement('div');
  fakeOpen.className = 'source-status-drawer';
  document.body.appendChild(fakeOpen);
  try{
    expect(() => openSourceStatusDrawer()).not.toThrow();
    expect(buildSourceStatusTargets).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.source-status-drawer')).toHaveLength(1);
  } finally {
    fakeOpen.remove();
  }
});
