/* ---------------------------------------------------------
   tools/lib/layerWalk.js
   ---------------------------------------------------------
   共用的圖層走訪邏輯：走訪單一來源設定物件（data/layers/<id>.json
   parse 後的物件）的 categories -> (groups ->) layers 巢狀結構。

   原本 tools/build-layers-bundle.js、tools/tag-layer-types.js、
   tools/fetch-legend-map.js、tools/fetch-wmts-bbox.js 四支腳本各自
   重複實作幾乎逐字相同的走訪邏輯，靠註解互相引用「跟其他腳本一致」
   手動同步，抽成這支共用模組後四支腳本改為 import 使用，行為完全
   保留（含呼叫端只取用第一個參數 layer 時的相容性）。

   @param {object} src 單一來源的設定物件（含 categories 陣列）
   @param {(layer: object, parentText: string) => void} fn
   *   對每筆圖層呼叫一次，第二個參數 parentText 是該圖層所屬
   *   category（若有 group，則再併上 group.name）組成的字串，
   *   供 tag-layer-types.js 的父層關鍵字比對（Step 2）使用；
   *   其餘呼叫端若不需要，直接忽略第二個參數即可。
--------------------------------------------------------- */
function forEachLayer(src, fn){
  src.categories.forEach(cat => {
    if(cat.groups){
      cat.groups.forEach(g => {
        const parentText = `${cat.name || ''} ${g.name || ''}`;
        g.layers.forEach(layer => fn(layer, parentText));
      });
    } else {
      const parentText = `${cat.name || ''}`;
      cat.layers.forEach(layer => fn(layer, parentText));
    }
  });
}

module.exports = { forEachLayer };
