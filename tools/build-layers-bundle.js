/* ---------------------------------------------------------
   tools/build-layers-bundle.js
   ---------------------------------------------------------
   開發時的「來源」是 data/layers/index.json + data/layers/<id>.json
  （每個 WMTS 來源一個檔案，方便編輯、方便看 git diff）。

   但瀏覽器實際載入時，如果逐一 fetch 這 39 個小檔案，會比 fetch
   一個合併過的大檔案多花不少網路來回時間（實測在約 25ms 延遲的
   網路環境下，39 個小檔案比 1 個合併檔案慢了 100ms 以上）。

   這支腳本把 data/layers/ 底下所有來源檔案合併成單一
   data/layers.bundle.json，部署前執行一次即可：

       node tools/build-layers-bundle.js

   新增或修改任何一個 data/layers/<id>.json 之後，記得重新執行
   這支腳本，data.js 實際讀取的是 bundle 檔案，不會自動反映
   來源檔案的最新內容。
--------------------------------------------------------- */
const fs = require('node:fs');
const path = require('node:path');
const { forEachLayer } = require('./lib/layerWalk');

const LAYERS_DIR = path.join(__dirname, '..', 'data', 'layers');
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'layers.bundle.json');

async function main(){
  const index = JSON.parse(fs.readFileSync(path.join(LAYERS_DIR, 'index.json'), 'utf-8'));

  // 順手算出每個來源實際圖層筆數，跟 index.json 手動維護的 layerCount 比對，
  // 不一致時印出警告（不中斷建置，避免小落差就卡住整條資料管線；但足以
  // 讓維護者在執行這支腳本時看到需要回頭修正 index.json 的來源與差異數字）。
  const layerCountWarnings = [];

  const sources = index.sources.map(entry => {
    const filePath = path.join(LAYERS_DIR, entry.file);
    const src = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if(src.id !== entry.id){
      throw new Error(`index.json 裡的 id "${entry.id}" 跟 ${entry.file} 裡的 id "${src.id}" 不一致`);
    }

    let actualCount = 0;
    forEachLayer(src, () => { actualCount += 1; });
    if(typeof entry.layerCount === 'number' && entry.layerCount !== actualCount){
      layerCountWarnings.push({ id: entry.id, expected: entry.layerCount, actual: actualCount });
    }

    return src;
  });

  // 打包完成後、寫檔之前，先跑一次跟瀏覽器執行期完全同一套的結構驗證
  // （src/layersBundleSchema.js，ESM 模組，透過動態 import() 載入），
  // 攔截「某來源檔案 format 欄位是 null／缺 region.bbox」這類會讓瀏覽器
  // 端 loadAppData() 整站白屏的資料問題，讓建置期就以非 0 狀態碼失敗，
  // 不讓壞資料流到 data/layers.bundle.json。
  const { validateLayersBundle } = await import('../src/layersBundleSchema.js');
  validateLayersBundle({ sources });

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ sources }));

  let totalLayers = 0;
  sources.forEach(src => forEachLayer(src, () => { totalLayers += 1; }));

  console.log(`已合併 ${sources.length} 個來源、共 ${totalLayers} 筆圖層 → ${path.relative(process.cwd(), OUTPUT_PATH)}`);

  if(layerCountWarnings.length > 0){
    console.warn(`\n⚠ 發現 ${layerCountWarnings.length} 個來源的 index.json layerCount 與實際圖層數不一致：`);
    layerCountWarnings.forEach(w => {
      console.warn(`  ${w.id}：index.json 記錄 ${w.expected} 筆，實際 ${w.actual} 筆（差 ${w.actual - w.expected}）`);
    });
    console.warn('請檢查是否忘記同步更新 data/layers/index.json 的 layerCount 欄位。');
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
