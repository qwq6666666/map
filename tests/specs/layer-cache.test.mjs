/* ---------------------------------------------------------
   layer-cache.test.mjs — core/layerCache.js 回歸測試
   ---------------------------------------------------------
   不透過完整 UI 初始化（不需要 initMapCore()／initSidebar()）：
   core/map.js 的 `map` 是 import 時就建立好的單例，layerCache.js
   依賴的只有 store 與 DATA 就位（見 multi-overlay-manager.test.mjs
   同樣的既有慣例）。

   核心案例：createEntry() 對「已解析不出來源」的殭屍 key（自訂圖層
   已刪除、或圖層已從資料下架）要留下 console.warn 診斷訊息，但仍然
   照舊回傳一個可用的 layer/source 物件（不是 null／不拋例外），維持
   既有 contract 不變。
--------------------------------------------------------- */
import { test, expect } from 'vitest';
import '../env-stub.mjs';
import { loadAppData, DATA } from '../../src/data.js';
import {
  getOrCreateLayer,
  getOrCreateSource,
  hasCachedLayer,
  getCachedLayer,
  getCachedSource,
  showLayer,
  hideLayer,
  setLayerOpacity,
  removeCachedLayer,
  clearCache,
  getCacheStats,
} from '../../src/core/layerCache.js';
import { TILE_STATE } from '../../src/core/tileLoadGuard.js';
import { lonLatToTileXY } from '../../src/core/tileGeo.js';

await loadAppData();

const sinica = DATA.LAYER_SOURCES.find(s => s.id === 'sinica');
const layerA = sinica.categories[0].layers[0];
const keyA = `hist:sinica:${layerA.id}:${layerA.fmt}`;

const INVALID_CUSTOM_KEY = 'custom:__does_not_exist__';
const INVALID_HIST_KEY = 'hist:__no_such_source__:__no_such_layer__:jpg';

function withWarnSpy(fn){
  const calls = [];
  const original = console.warn;
  console.warn = (...args) => { calls.push(args); };
  try{
    fn(calls);
  }finally{
    console.warn = original;
  }
  return calls;
}

test('有效 key（hist:）：getOrCreateLayer 正常建立且不觸發 console.warn', () => {
  clearCache();
  const calls = withWarnSpy(() => {
    const layer = getOrCreateLayer(keyA);
    expect(!!layer, '應回傳一個 layer 物件').toBeTruthy();
  });
  expect(calls.length, '有效 key 不應觸發 console.warn').toBe(0);
  clearCache();
});

test('有效 key（base:osm／base:sat）：getOrCreateSource 正常建立且不觸發 console.warn', () => {
  clearCache();
  const calls = withWarnSpy(() => {
    const osmSource = getOrCreateSource('base:osm');
    const satSource = getOrCreateSource('base:sat');
    expect(!!osmSource, 'base:osm 應回傳 source 物件').toBeTruthy();
    expect(!!satSource, 'base:sat 應回傳 source 物件').toBeTruthy();
  });
  expect(calls.length, '有效底圖 key 不應觸發 console.warn').toBe(0);
  clearCache();
});

test('cache hit：同一個有效 key 第二次呼叫拿到同一個物件參照', () => {
  clearCache();
  const first = getOrCreateLayer(keyA);
  const second = getOrCreateLayer(keyA);
  expect(first === second, '第二次呼叫應重用快取中的同一個 layer 物件').toBeTruthy();
  const firstSource = getOrCreateSource(keyA);
  const secondSource = getOrCreateSource(keyA);
  expect(firstSource === secondSource, '第二次呼叫應重用快取中的同一個 source 物件').toBeTruthy();
  clearCache();
});

test('失效 key（custom:，自訂圖層已被刪除）：仍正常回傳 layer 物件，但觸發一次 console.warn 且內容包含該 key', () => {
  clearCache();
  const calls = withWarnSpy(() => {
    const layer = getOrCreateLayer(INVALID_CUSTOM_KEY);
    expect(!!layer, '即使 key 無法解析，仍應回傳一個 layer 物件（維持既有 contract）').toBeTruthy();
  });
  expect(calls.length, '失效 key 應觸發恰好一次 console.warn').toBe(1);
  const warnedText = calls[0].join(' ');
  expect(warnedText.includes(INVALID_CUSTOM_KEY), 'console.warn 內容應包含這個失效的 key').toBeTruthy();
  clearCache();
});

test('失效 key（hist:，來源/圖層 id 不存在）：仍正常回傳 source 物件，但觸發一次 console.warn 且內容包含該 key', () => {
  clearCache();
  const calls = withWarnSpy(() => {
    const source = getOrCreateSource(INVALID_HIST_KEY);
    expect(!!source, '即使 key 無法解析，仍應回傳一個 source 物件（維持既有 contract）').toBeTruthy();
  });
  expect(calls.length, '失效 key 應觸發恰好一次 console.warn').toBe(1);
  const warnedText = calls[0].join(' ');
  expect(warnedText.includes(INVALID_HIST_KEY), 'console.warn 內容應包含這個失效的 key').toBeTruthy();
  clearCache();
});

test('失效 key 建立過一次後即進入快取：第二次呼叫命中快取，不會再重複觸發 console.warn', () => {
  clearCache();
  withWarnSpy(() => { getOrCreateLayer(INVALID_CUSTOM_KEY); });
  const calls = withWarnSpy(() => {
    getOrCreateLayer(INVALID_CUSTOM_KEY);
  });
  expect(calls.length, '第二次呼叫應是 cache hit，不會重新跑 createEntry() 的警告邏輯').toBe(0);
  clearCache();
});

test('hasCachedLayer／getCachedLayer／getCachedSource：建立前後狀態正確', () => {
  clearCache();
  expect(hasCachedLayer(keyA), '尚未建立前不應存在於快取').toBe(false);
  expect(getCachedLayer(keyA), '尚未建立前 getCachedLayer 應回傳 null').toBe(null);
  expect(getCachedSource(keyA), '尚未建立前 getCachedSource 應回傳 null').toBe(null);
  const layer = getOrCreateLayer(keyA);
  expect(hasCachedLayer(keyA), '建立後應存在於快取').toBe(true);
  expect(getCachedLayer(keyA) === layer, 'getCachedLayer 應回傳同一個物件參照').toBeTruthy();
  expect(getCachedSource(keyA) === layer.opts.source, 'getCachedSource 應回傳該 layer 對應的 source').toBeTruthy();
  clearCache();
});

test('showLayer／hideLayer／setLayerOpacity：控制既有快取圖層的 opacity', () => {
  clearCache();
  const layer = getOrCreateLayer(keyA);
  expect(layer.getOpacity(), '新建立的 layer 預設 opacity 應為 0').toBe(0);
  showLayer(keyA);
  expect(layer.getOpacity(), 'showLayer 後 opacity 應為 1').toBe(1);
  hideLayer(keyA);
  expect(layer.getOpacity(), 'hideLayer 後 opacity 應為 0').toBe(0);
  setLayerOpacity(keyA, 0.5);
  expect(layer.getOpacity(), 'setLayerOpacity 應可設定任意數值').toBe(0.5);
  clearCache();
});

test('removeCachedLayer：移除後 hasCachedLayer 回傳 false，且下次呼叫視為全新建立', () => {
  clearCache();
  getOrCreateLayer(keyA);
  expect(hasCachedLayer(keyA)).toBe(true);
  removeCachedLayer(keyA);
  expect(hasCachedLayer(keyA), '移除後不應再存在於快取').toBe(false);
  clearCache();
});

test('removeCachedLayer：圖層被移除時，也要一併中止這個 key 底下還在 tileLoadGuard 進行中的請求（回歸：曾經只移除圖層物件，遺留的請求會繼續佔用 tileRenderRequestPool 的 slot，直到自然逾時）', () => {
  clearCache();
  getOrCreateLayer(keyA);
  const source = getCachedSource(keyA);
  const tileLoadFn = source.opts.tileLoadFunction;
  expect(typeof tileLoadFn === 'function', '前置條件：應該有 tileLoadFunction 可以呼叫').toBeTruthy();

  // 一顆確定落在 keyA（sinica 圖層）bbox 內的圖磚座標，避免邊界保護
  // 直接判 EMPTY、根本沒有真的送出請求。用一個永遠不會呼叫
  // onload/onerror 的假 Image，模擬「請求已送出、還沒 resolve」。
  const taipei15 = lonLatToTileXY(121.5654, 25.0330, 15);
  const fakeImage = { onload: null, onerror: null, set src(v){ this._src = v; } };
  let finalState = null;
  const fakeTile = {
    getTileCoord(){ return [taipei15.z, taipei15.x, taipei15.y]; },
    getImage(){ return fakeImage; },
    setState(s){ finalState = s; },
  };
  tileLoadFn(fakeTile, 'http://layer-cache-test/in-flight.png');
  expect(finalState, '前置條件：送出請求後應該還在等待中，不應該是 EMPTY（代表邊界保護誤判）').toBe(null);

  removeCachedLayer(keyA);
  expect(finalState, '移除圖層後，這個 key 底下進行中的請求應該被主動中止（比照 stale abort，不是永久 ERROR）').toBe(TILE_STATE.IDLE);
  clearCache();
});

test('clearCache：清空所有快取項目', () => {
  clearCache();
  getOrCreateLayer(keyA);
  getOrCreateLayer('base:osm');
  expect(getCacheStats().size, '清空前應有兩筆快取').toBe(2);
  clearCache();
  expect(getCacheStats().size, 'clearCache 後應歸零').toBe(0);
});
