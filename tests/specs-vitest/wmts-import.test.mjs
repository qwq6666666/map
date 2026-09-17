import '../env-stub.mjs';
import { test, expect } from 'vitest';
import { listLayers, buildWmtsEntryConfig, annotateLayersWithCompatibility, fetchCapabilities } from '../../src/features/wmtsImport.js';
import { state as store, addCustomSource, clearCustomSources, toggleMultiOverlayLayer, clearMultiOverlayLayers } from '../../src/store.js';
import { makeSourceForKey, setCustomSourcesProvider } from '../../src/data.js';

setCustomSourcesProvider(() => store.customSources);

// 模擬一份 GetCapabilities 解析結果：兩張有相容 EPSG:3857 TileMatrixSet
// 的圖層（layerA／layerB），一張沒有（layerC，_fakeOptionsByLayer 裡
// 對應的值是 null，模擬 ol.source.WMTS.optionsFromCapabilities() 真的
// 找不到相容座標系時的行為）。
function buildFakeCapabilities(){
  return {
    Contents: {
      Layer: [
        { Identifier: 'layerA', Title: '圖層 A（地形圖）' },
        { Identifier: 'layerB', Title: '圖層 B（正射影像）' },
        { Identifier: 'layerC', Title: '圖層 C（只支援國家座標系）' }
      ]
    },
    _fakeOptionsByLayer: {
      layerA: {
        urls: ['https://example.com/wmts/layerA/{TileMatrix}/{TileRow}/{TileCol}.png'],
        layer: 'layerA',
        matrixSet: 'GoogleMapsCompatible',
        format: 'image/png',
        projection: { getCode: () => 'EPSG:3857' },
        requestEncoding: 'REST',
        style: 'default',
        tileGrid: {
          getOrigin: () => [-20037508.34, 20037508.34],
          getResolutions: () => [156543.03, 78271.52, 39135.76],
          getMatrixIds: () => ['0', '1', '2'],
          getTileSize: () => 256,
          getExtent: () => undefined
        }
      },
      layerB: {
        urls: ['https://example.com/wmts/layerB/{TileMatrix}/{TileRow}/{TileCol}.png'],
        layer: 'layerB',
        matrixSet: 'GoogleMapsCompatible',
        format: 'image/jpeg',
        projection: { getCode: () => 'EPSG:3857' },
        requestEncoding: 'REST',
        style: 'default',
        tileGrid: {
          getOrigin: () => [-20037508.34, 20037508.34],
          getResolutions: () => [156543.03, 78271.52],
          getMatrixIds: () => ['0', '1'],
          getTileSize: () => 256,
          getExtent: () => undefined
        }
      },
      layerC: null
    }
  };
}

test('listLayers 會列出所有圖層，標題缺漏時退回用 identifier', () => {
  const capabilities = buildFakeCapabilities();
  capabilities.Contents.Layer.push({ Identifier: 'noTitle' });
  const layers = listLayers(capabilities);
  expect(layers.length, '應該有 4 筆').toBe(4);
  expect(layers[0].title, '有 Title 時使用 Title').toBe('圖層 A（地形圖）');
  expect(layers[3].title, '沒有 Title 時退回用 Identifier').toBe('noTitle');
});

test('buildWmtsEntryConfig 對有相容 TileMatrixSet 的圖層，能正確抽出純資料設定', () => {
  const capabilities = buildFakeCapabilities();
  const config = buildWmtsEntryConfig(capabilities, 'layerA');
  expect(!!config, '應該成功建立設定').toBeTruthy();
  expect(config.layer, 'layer 識別碼正確').toBe('layerA');
  expect(config.matrixSet, 'matrixSet 正確').toBe('GoogleMapsCompatible');
  expect(config.projection, '座標系代碼要被展開成純字串，不是物件').toBe('EPSG:3857');
  expect(config.resolutions.length, 'resolutions 陣列要被正確抽出').toBe(3);
  expect(config.matrixIds.length, 'matrixIds 陣列要被正確抽出').toBe(3);
  expect(config.tileSize, 'tileSize 正確').toBe(256);
});

test('buildWmtsEntryConfig 對沒有相容座標系的圖層回傳 null（呼叫端要當成略過，不是錯誤）', () => {
  const capabilities = buildFakeCapabilities();
  const config = buildWmtsEntryConfig(capabilities, 'layerC');
  expect(config, '應該回傳 null').toBe(null);
});

test('把 buildWmtsEntryConfig 的結果存進 customSources 後，makeSourceForKey 能直接重建出 WMTS source（不需要重新讀 capabilities）', () => {
  clearCustomSources();
  clearMultiOverlayLayers();
  const capabilities = buildFakeCapabilities();
  const config = buildWmtsEntryConfig(capabilities, 'layerB');
  const entry = addCustomSource({ type: 'wmts', name: '圖層 B（正射影像）', wmts: config, attribution: '' });
  expect(store.customSources[0].type, '型別應該是 wmts').toBe('wmts');

  const source = makeSourceForKey(`custom:${entry.id}`);
  expect(!!source, '應該回傳一個 source 物件，不是 undefined/null').toBeTruthy();
  expect(source.opts.layer, 'ol.source.WMTS 應該收到正確的 layer 參數').toBe('layerB');
  expect(source.opts.matrixSet, 'ol.source.WMTS 應該收到正確的 matrixSet 參數').toBe('GoogleMapsCompatible');
});

test('自訂 WMTS 圖層一樣可以透過 toggleMultiOverlayLayer 加入複合疊圖組合', () => {
  clearCustomSources();
  clearMultiOverlayLayers();
  const capabilities = buildFakeCapabilities();
  const config = buildWmtsEntryConfig(capabilities, 'layerA');
  const entry = addCustomSource({ type: 'wmts', name: '圖層 A', wmts: config, attribution: '' });
  const key = `custom:${entry.id}`;
  toggleMultiOverlayLayer(key);
  expect(store.multiOverlayLayers.some(e => e.key === key), '應該已經加入疊圖組合').toBeTruthy();
});

test('annotateLayersWithCompatibility 會在渲染清單前就標示每張圖層是否相容，不用等加入才知道', () => {
  const capabilities = buildFakeCapabilities();
  const layers = listLayers(capabilities);
  const annotated = annotateLayersWithCompatibility(capabilities, layers);
  expect(annotated.length, '應該保留全部 3 筆').toBe(3);
  expect(annotated.find(l => l.identifier === 'layerA').compatible, 'layerA 相容').toBe(true);
  expect(annotated.find(l => l.identifier === 'layerB').compatible, 'layerB 相容').toBe(true);
  expect(annotated.find(l => l.identifier === 'layerC').compatible, 'layerC 不相容，應標示為 false').toBe(false);
});

test('fetchCapabilities 對同一網址的快取有 TTL：期限內重複讀取用快取，過期後重新抓取', async () => {
  const fakeXmlText = JSON.stringify({ Contents: { Layer: [{ Identifier: 'x', Title: 'X' }] } });
  let fetchCallCount = 0;
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  globalThis.fetch = async () => {
    fetchCallCount++;
    return { ok: true, text: async () => fakeXmlText };
  };
  let now = 1_700_000_000_000;
  Date.now = () => now;
  try{
    const url = 'https://example.com/ttl-test-capabilities.xml';
    await fetchCapabilities(url);
    expect(fetchCallCount, '第一次應該真的發送請求').toBe(1);

    await fetchCapabilities(url);
    expect(fetchCallCount, 'TTL 內重複讀同一網址應該直接用快取，不重新發送請求').toBe(1);

    now += 6 * 60 * 1000; // 超過 5 分鐘 TTL
    await fetchCapabilities(url);
    expect(fetchCallCount, '超過 TTL 後應該視為過期，重新發送請求').toBe(2);
  }finally{
    globalThis.fetch = originalFetch;
    Date.now = originalDateNow;
  }
});

/* ---------------------------------------------------------
   fetchCapabilities()：直接 fetch 失敗時的代理伺服器 fallback 分支。
   env-stub.mjs 的假 ol.format.WMTSCapabilities 直接把文字內容當 JSON
   parse 回來（見該檔案），所以這裡的「假 XML」實際上是符合
   buildFakeCapabilities() 形狀的 JSON 字串。
--------------------------------------------------------- */
test('fetchCapabilities()：直接 fetch 失敗時會自動改用代理伺服器重試，成功後回傳解析結果', async () => {
  const url = 'https://example.com/direct-fail-proxy-ok/WMTSCapabilities.xml';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (reqUrl) => {
    if(String(reqUrl) === url) throw new Error('模擬 CORS 被擋');
    // 其餘視為打去代理伺服器的請求
    return { ok: true, text: async () => JSON.stringify({ Contents: { Layer: [{ Identifier: 'x', Title: 'X' }] } }) };
  };
  try{
    const caps = await fetchCapabilities(url);
    expect(!!caps, '應該透過代理成功拿到解析結果').toBeTruthy();
    expect(caps.Contents.Layer[0].Identifier, '解析結果應該來自代理伺服器回傳的內容').toBe('x');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchCapabilities()：直接 fetch 與代理伺服器都失敗時，錯誤訊息包含代理伺服器回傳的失敗原因', async () => {
  const url = 'https://example.com/both-fail/WMTSCapabilities.xml';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (reqUrl) => {
    if(String(reqUrl) === url) throw new Error('直接失敗原因');
    return { ok: false, status: 502, json: async () => ({ error: '代理失敗原因' }) };
  };
  try{
    let thrown = null;
    try{ await fetchCapabilities(url); }catch(e){ thrown = e; }
    expect(!!thrown, '應該拋出例外').toBeTruthy();
    expect(thrown.message.includes('代理失敗原因'), '錯誤訊息應該包含代理伺服器回傳的失敗原因').toBeTruthy();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
