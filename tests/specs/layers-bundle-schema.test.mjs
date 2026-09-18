import { test, expect } from 'vitest';
import { validateLayersBundle } from '../../src/layersBundleSchema.js';

function minimalValidBundle(){
  return {
    sources: [
      {
        id: 'demo',
        name: '示範來源',
        provider: { tileTemplate: 'https://example.com/{id}/{z}/{y}/{x}.{format}' },
        region: { bbox: [120, 21, 122, 25] },
        categories: [
          {
            name: '示範分類',
            layers: [
              { id: 'demo-layer', title: '示範圖層', format: 'png' }
            ]
          }
        ]
      }
    ]
  };
}

function assertThrows(fn, msgFragment){
  let threw = false;
  let errMsg = '';
  try {
    fn();
  } catch (err) {
    threw = true;
    errMsg = err.message;
  }
  expect(threw, '預期會拋出例外，但沒有').toBeTruthy();
  if(msgFragment){
    expect(errMsg.includes(msgFragment), `錯誤訊息「${errMsg}」應包含「${msgFragment}」`).toBeTruthy();
  }
  return errMsg;
}

test('validateLayersBundle：合法的最小 bundle 不應該 throw', () => {
  validateLayersBundle(minimalValidBundle());
});

test('validateLayersBundle：layer 缺少 format（undefined）應該 throw，且錯誤訊息能定位到哪個 layer/source', () => {
  const bundle = minimalValidBundle();
  delete bundle.sources[0].categories[0].layers[0].format;
  const msg = assertThrows(() => validateLayersBundle(bundle), '缺少 format');
  expect(msg.includes('demo-layer'), `錯誤訊息「${msg}」應包含 layer id "demo-layer"`).toBeTruthy();
});

test('validateLayersBundle：layer 的 format 為 null 應該 throw（build-nlsc-layers.js 未知 MIME 時的情境）', () => {
  const bundle = minimalValidBundle();
  bundle.sources[0].categories[0].layers[0].format = null;
  const msg = assertThrows(() => validateLayersBundle(bundle), '缺少 format');
  expect(msg.includes('demo-layer'), `錯誤訊息「${msg}」應包含 layer id "demo-layer"`).toBeTruthy();
});

test('validateLayersBundle：source 缺少 region.bbox 應該 throw，且錯誤訊息能定位到哪個 source', () => {
  const bundle = minimalValidBundle();
  delete bundle.sources[0].region;
  const msg = assertThrows(() => validateLayersBundle(bundle), 'region.bbox');
  expect(msg.includes('demo'), `錯誤訊息「${msg}」應包含 source id "demo"`).toBeTruthy();
});
