/* ---------------------------------------------------------
   tools/build-layers-bundle.js
   ---------------------------------------------------------
   開發時的「來源」是 data/layers/index.json + data/layers/<id>.json
  （每個 WMTS 來源一個檔案，方便編輯、方便看 git diff）。

   但瀏覽器實際載入時，如果逐一 fetch 這 19 個小檔案，會比 fetch
   一個合併過的大檔案多花不少網路來回時間（實測在約 25ms 延遲的
   網路環境下，19 個小檔案比 1 個合併檔案慢了 100ms 以上）。

   這支腳本把 data/layers/ 底下所有來源檔案合併成單一
   data/layers.bundle.json，部署前執行一次即可：

       node tools/build-layers-bundle.js

   新增或修改任何一個 data/layers/<id>.json 之後，記得重新執行
   這支腳本，data.js 實際讀取的是 bundle 檔案，不會自動反映
   來源檔案的最新內容。
--------------------------------------------------------- */
const fs = require('fs');
const path = require('path');

const LAYERS_DIR = path.join(__dirname, '..', 'data', 'layers');
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'layers.bundle.json');

const index = JSON.parse(fs.readFileSync(path.join(LAYERS_DIR, 'index.json'), 'utf-8'));

const sources = index.sources.map(entry => {
  const filePath = path.join(LAYERS_DIR, entry.file);
  const src = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  if(src.id !== entry.id){
    throw new Error(`index.json 裡的 id "${entry.id}" 跟 ${entry.file} 裡的 id "${src.id}" 不一致`);
  }
  return src;
});

fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ sources }));

let totalLayers = 0;
sources.forEach(src => src.categories.forEach(cat => {
  if(cat.groups) cat.groups.forEach(g => totalLayers += g.layers.length);
  else totalLayers += cat.layers.length;
}));

console.log(`已合併 ${sources.length} 個來源、共 ${totalLayers} 筆圖層 → ${path.relative(process.cwd(), OUTPUT_PATH)}`);
