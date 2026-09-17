/* ---------------------------------------------------------
   layersBundleSchema.js — data/layers.bundle.json 結構驗證（共用純函式）
   ---------------------------------------------------------
   同一套驗證邏輯有兩個呼叫端：
     1. src/data.js（瀏覽器執行期）loadAppData() fetch 完 bundle 後立即驗證。
     2. tools/build-layers-bundle.js（建置期，Node CommonJS 腳本，透過
        動態 import() 載入這個 ESM 模組）打包完立即驗證，失敗就讓建置
        以非 0 狀態碼結束，不讓壞資料流到 data/layers.bundle.json。
   兩邊各自維護一份很容易讓行為兜不起來，所以抽成這支零依賴的純 ESM
   模組共用。不要在這裡 import 任何假設瀏覽器環境（Image/document等）
   存在的模組，否則 tools/build-layers-bundle.js 在純 Node 環境下
   import 會出錯。
--------------------------------------------------------- */

export function assertShape(cond, message){
  if(!cond) throw new Error(`[資料格式錯誤] ${message}`);
}

export function validateLayersBundle(layersData){
  assertShape(layersData && typeof layersData === 'object', 'layers.bundle.json 不是有效的物件');
  assertShape(Array.isArray(layersData.sources), 'layers.bundle.json 缺少 sources 陣列');
  layersData.sources.forEach((src, i) => {
    const tag = `layers.bundle.json：sources[${i}]`;
    assertShape(src && typeof src === 'object', `${tag} 不是有效的物件`);
    assertShape(typeof src.id === 'string' && src.id, `${tag} 缺少 id`);
    assertShape(typeof src.name === 'string' && src.name, `${tag}（id=${src.id}） 缺少 name`);
    assertShape(src.provider && typeof src.provider === 'object', `${tag}（id=${src.id}） 缺少 provider`);
    assertShape(src.region && Array.isArray(src.region.bbox) && src.region.bbox.length === 4,
      `${tag}（id=${src.id}） 缺少合法的 region.bbox（需為 [minLon,minLat,maxLon,maxLat]）`);
    assertShape(Array.isArray(src.categories), `${tag}（id=${src.id}） 缺少 categories 陣列`);
    src.categories.forEach((cat, ci) => {
      const ctag = `${tag}（id=${src.id}）categories[${ci}]`;
      assertShape(cat && typeof cat.name === 'string', `${ctag} 缺少 name`);
      assertShape(Array.isArray(cat.layers) || Array.isArray(cat.groups),
        `${ctag} 需要有 layers 或 groups 其中一個陣列`);
      const layerLists = cat.groups
        ? cat.groups.map(g => g.layers)
        : [cat.layers];
      layerLists.forEach((layers, gi) => {
        const groupSuffix = cat.groups ? ` groups[${gi}]` : '';
        assertShape(Array.isArray(layers), `${ctag}${groupSuffix} 缺少 layers 陣列`);
        layers.forEach((l, li) => {
          const ltag = `${ctag} layers[${li}]`;
          assertShape(typeof l.id === 'string' && l.id, `${ltag} 缺少 id`);
          assertShape(typeof l.title === 'string', `${ltag}（id=${l.id}） 缺少 title`);
          assertShape(typeof l.format === 'string', `${ltag}（id=${l.id}） 缺少 format`);
        });
      });
    });
  });
}
