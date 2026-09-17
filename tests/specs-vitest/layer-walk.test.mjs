import { createRequire } from 'node:module';
import { test, expect } from 'vitest';

/* ---------------------------------------------------------
   tests/specs/layer-walk.test.mjs
   ---------------------------------------------------------
   tools/lib/layerWalk.js 是 tools/build-layers-bundle.js、
   tools/tag-layer-types.js、tools/fetch-legend-map.js、
   tools/fetch-wmts-bbox.js 四支腳本共用的巢狀圖層走訪邏輯，
   驗證：
     - 有 group 與沒有 group 的 category 都能正確走訪到每一筆 layer
     - 走訪順序（先 category 順序、group 內再依 layers 順序）
     - parentText 第二參數在有無 group 時的組成內容
     - 呼叫端只取用第一個參數（忽略 parentText）時仍正常運作
--------------------------------------------------------- */
const require = createRequire(import.meta.url);
const { forEachLayer } = require('../../tools/lib/layerWalk.js');

test('forEachLayer：沒有 group 的 category，依序走訪每一筆 layer', () => {
  const src = {
    categories: [
      { name: 'A', layers: [{ id: 'a1' }, { id: 'a2' }] },
      { name: 'B', layers: [{ id: 'b1' }] },
    ],
  };
  const ids = [];
  forEachLayer(src, (layer) => ids.push(layer.id));
  expect(ids.join(','), '應依 category 順序、layers 順序走訪').toBe('a1,a2,b1');
});

test('forEachLayer：有 group 的 category，走訪每個 group 底下的 layer', () => {
  const src = {
    categories: [
      {
        name: 'A',
        groups: [
          { name: 'A1', layers: [{ id: 'x1' }] },
          { name: 'A2', layers: [{ id: 'x2' }, { id: 'x3' }] },
        ],
      },
    ],
  };
  const ids = [];
  forEachLayer(src, (layer) => ids.push(layer.id));
  expect(ids.join(','), '應依 group 順序、layers 順序走訪').toBe('x1,x2,x3');
});

test('forEachLayer：混合有無 group 的 category', () => {
  const src = {
    categories: [
      { name: 'A', layers: [{ id: 'a1' }] },
      { name: 'B', groups: [{ name: 'B1', layers: [{ id: 'b1' }] }] },
    ],
  };
  const ids = [];
  forEachLayer(src, (layer) => ids.push(layer.id));
  expect(ids.join(','), '應正確走訪混合結構').toBe('a1,b1');
});

test('forEachLayer：沒有 group 時，parentText 只帶 category.name', () => {
  const src = { categories: [{ name: 'A', layers: [{ id: 'a1' }] }] };
  let parentTextSeen = null;
  forEachLayer(src, (layer, parentText) => { parentTextSeen = parentText; });
  expect(parentTextSeen, 'parentText 應等於 category.name').toBe('A');
});

test('forEachLayer：有 group 時，parentText 併上 category.name 與 group.name', () => {
  const src = {
    categories: [{ name: 'A', groups: [{ name: 'A1', layers: [{ id: 'x1' }] }] }],
  };
  let parentTextSeen = null;
  forEachLayer(src, (layer, parentText) => { parentTextSeen = parentText; });
  expect(parentTextSeen, 'parentText 應為 "category.name group.name"').toBe('A A1');
});

test('forEachLayer：category／group 缺少 name 欄位時，parentText 不應出現 "undefined"', () => {
  const src = { categories: [{ groups: [{ layers: [{ id: 'x1' }] }] }] };
  let parentTextSeen = null;
  forEachLayer(src, (layer, parentText) => { parentTextSeen = parentText; });
  expect(parentTextSeen, '缺少 name 時應以空字串取代，不應出現 undefined 字樣').toBe(' ');
});

test('forEachLayer：呼叫端只取用第一個參數（忽略 parentText）時仍正常運作', () => {
  const src = { categories: [{ name: 'A', layers: [{ id: 'a1' }, { id: 'a2' }] }] };
  let count = 0;
  forEachLayer(src, () => { count += 1; });
  expect(count, '只取用第一個參數的呼叫端應仍能正確計數每一筆 layer').toBe(2);
});
