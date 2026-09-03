import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import { listLayers, buildWmtsEntryConfig } from '../../src/features/wmtsImport.js';
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
  assertEqual(layers.length, 4, '應該有 4 筆');
  assertEqual(layers[0].title, '圖層 A（地形圖）', '有 Title 時使用 Title');
  assertEqual(layers[3].title, 'noTitle', '沒有 Title 時退回用 Identifier');
});

test('buildWmtsEntryConfig 對有相容 TileMatrixSet 的圖層，能正確抽出純資料設定', () => {
  const capabilities = buildFakeCapabilities();
  const config = buildWmtsEntryConfig(capabilities, 'layerA');
  assertTrue(!!config, '應該成功建立設定');
  assertEqual(config.layer, 'layerA', 'layer 識別碼正確');
  assertEqual(config.matrixSet, 'GoogleMapsCompatible', 'matrixSet 正確');
  assertEqual(config.projection, 'EPSG:3857', '座標系代碼要被展開成純字串，不是物件');
  assertEqual(config.resolutions.length, 3, 'resolutions 陣列要被正確抽出');
  assertEqual(config.matrixIds.length, 3, 'matrixIds 陣列要被正確抽出');
  assertEqual(config.tileSize, 256, 'tileSize 正確');
});

test('buildWmtsEntryConfig 對沒有相容座標系的圖層回傳 null（呼叫端要當成略過，不是錯誤）', () => {
  const capabilities = buildFakeCapabilities();
  const config = buildWmtsEntryConfig(capabilities, 'layerC');
  assertEqual(config, null, '應該回傳 null');
});

test('把 buildWmtsEntryConfig 的結果存進 customSources 後，makeSourceForKey 能直接重建出 WMTS source（不需要重新讀 capabilities）', () => {
  clearCustomSources();
  clearMultiOverlayLayers();
  const capabilities = buildFakeCapabilities();
  const config = buildWmtsEntryConfig(capabilities, 'layerB');
  const entry = addCustomSource({ type: 'wmts', name: '圖層 B（正射影像）', wmts: config, attribution: '' });
  assertEqual(store.customSources[0].type, 'wmts', '型別應該是 wmts');

  const source = makeSourceForKey(`custom:${entry.id}`);
  assertTrue(!!source, '應該回傳一個 source 物件，不是 undefined/null');
  assertEqual(source.opts.layer, 'layerB', 'ol.source.WMTS 應該收到正確的 layer 參數');
  assertEqual(source.opts.matrixSet, 'GoogleMapsCompatible', 'ol.source.WMTS 應該收到正確的 matrixSet 參數');
});

test('自訂 WMTS 圖層一樣可以透過 toggleMultiOverlayLayer 加入複合疊圖組合', () => {
  clearCustomSources();
  clearMultiOverlayLayers();
  const capabilities = buildFakeCapabilities();
  const config = buildWmtsEntryConfig(capabilities, 'layerA');
  const entry = addCustomSource({ type: 'wmts', name: '圖層 A', wmts: config, attribution: '' });
  const key = `custom:${entry.id}`;
  toggleMultiOverlayLayer(key);
  assertTrue(store.multiOverlayLayers.some(e => e.key === key), '應該已經加入疊圖組合');
});

await run();
