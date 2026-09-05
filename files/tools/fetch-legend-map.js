/* ---------------------------------------------------------
   tools/fetch-legend-map.js
   ---------------------------------------------------------
   圖例(Legend)對照建置：中研院 WMTS Capabilities 本身沒有圖例
   資訊，但中研院各縣市百年歷史地圖入口網站（twhgis.aspx、
   taipei.aspx……）共用同一套圖層清單 AJAX API，內含部分圖層的
   圖例連結（Zoomify 可縮放圖例頁面），差別只在 querystring 的
   tc 參數。

   這支腳本會針對 TC_SOURCES 列出的每個 { tc, jsonFile }：
     1. 呼叫該 API 一次抓回該 tc 底下的全部圖層清單（rows=300）
     2. 從每筆的第二個 <cell> 裡的 window.open('<url>', 'Legend', ...)
        抓出圖例 URL
     3. 只處理 https://gis.sinica.edu.tw/legend/<id> 這種型態的網址，
        反推出 <id>，跟我們 data/layers/<jsonFile> 裡圖層物件的 id 對照
     4. 比對到的圖層就寫入 layer.legend = <url>

   其他型態的圖例網址（gissrv4.sinica.edu.tw/gis/img/legend/*.htm、
   外部圖片網址等）反推不出跟我們 layer.id 一致的 id，直接跳過。

   注意：同一個 data/layers/*.json 檔案可能被多個 tc 來源命中
   （例如 taipei.json 裡的全國性圖層，在 twhgis 和 taipei 兩個入口
   都查得到、網址通常一樣），這是正常現象，後面的來源查到同一個
   layer.id 已有 legend 就直接覆蓋，不特別去重比對。

   已實測確認「沒有資料」（<records>0</records>）、故不列入
   TC_SOURCES 的來源：thm, ls, ccts, korea, kunming, nlsc, udd。

   執行方式：
       node tools/fetch-legend-map.js

   執行完別忘了依序跑
       node tools/tag-layer-types.js
       node tools/build-layers-bundle.js
--------------------------------------------------------- */
const fs = require('fs');
const path = require('path');

// tc 參數值 -> 對應要寫回的 data/layers/*.json 檔名
// twhgis 是總站入口，例外對應到 sinica.json；其餘皆為
// 「tc 值 == 來源 id == json 檔名（去掉副檔名）」
const TC_SOURCES = [
  { tc: 'twhgis', jsonFile: 'sinica.json' },
  { tc: 'taipei', jsonFile: 'taipei.json' },
  { tc: 'keelung', jsonFile: 'keelung.json' },
  { tc: 'newtaipei', jsonFile: 'newtaipei.json' },
  { tc: 'taoyuan', jsonFile: 'taoyuan.json' },
  { tc: 'hsinchu', jsonFile: 'hsinchu.json' },
  { tc: 'taichung', jsonFile: 'taichung.json' },
  { tc: 'changhua', jsonFile: 'changhua.json' },
  { tc: 'lukang', jsonFile: 'lukang.json' },
  { tc: 'chiayi', jsonFile: 'chiayi.json' },
  { tc: 'tainan', jsonFile: 'tainan.json' },
  { tc: 'kaohsiung', jsonFile: 'kaohsiung.json' },
  { tc: 'pingtung', jsonFile: 'pingtung.json' },
  { tc: 'hakkaliudui', jsonFile: 'hakkaliudui.json' },
  { tc: 'yilan', jsonFile: 'yilan.json' },
  { tc: 'hualien', jsonFile: 'hualien.json' },
  { tc: 'kinmen', jsonFile: 'kinmen.json' },
  { tc: 'hongkong', jsonFile: 'hongkong.json' },
  { tc: 'beijing', jsonFile: 'beijing.json' },
  { tc: 'tianjin', jsonFile: 'tianjin.json' },
  { tc: 'shanghai', jsonFile: 'shanghai.json' },
  { tc: 'nanjing', jsonFile: 'nanjing.json' },
  { tc: 'hangzhou', jsonFile: 'hangzhou.json' },
  { tc: 'wuhan', jsonFile: 'wuhan.json' },
  { tc: 'guangzhou', jsonFile: 'guangzhou.json' },
  { tc: 'suzhou', jsonFile: 'suzhou.json' },
  { tc: 'tamsui', jsonFile: 'tamsui.json' },
  { tc: 'puli', jsonFile: 'puli.json' },
  { tc: 'penghu', jsonFile: 'penghu.json' },
  { tc: 'taitung', jsonFile: 'taitung.json' },
];

const LAYERS_DIR = path.join(__dirname, '..', 'data', 'layers');

function buildLayersApiUrl(tc){
  return `https://gissrv4.sinica.edu.tw/gis/config/layers.aspx?tc=${encodeURIComponent(tc)}&nd=` +
    Date.now() + '&_search=false&rows=300&page=1&sidx=sy&sord=asc';
}

async function fetchLayersXml(tc){
  const url = buildLayersApiUrl(tc);
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`下載圖層清單 API 失敗（網路錯誤，tc=${tc}）：${err.message}`);
  }
  if(!res.ok){
    throw new Error(`下載圖層清單 API 失敗，HTTP 狀態碼 ${res.status} ${res.statusText}（tc=${tc}）`);
  }
  return res.text();
}

// 從 <row>...</row> 區塊裡抓出第二個 <cell> 的 window.open 圖例網址
function parseLegendUrls(xml){
  const urls = [];
  const rowBlockRe = /<row\s+id="[^"]*">([\s\S]*?)<\/row>/g;
  let rowMatch;
  while((rowMatch = rowBlockRe.exec(xml)) !== null){
    const block = rowMatch[1];
    const cellRe = /<cell><!\[CDATA\[([\s\S]*?)\]\]><\/cell>/g;
    const cells = [];
    let cellMatch;
    while((cellMatch = cellRe.exec(block)) !== null){
      cells.push(cellMatch[1]);
    }
    if(cells.length < 2) continue;
    const secondCell = cells[1];
    const openMatch = secondCell.match(/window\.open\('([^']+)'\s*,\s*'Legend'/);
    if(!openMatch) continue;
    urls.push(openMatch[1]);
  }
  return urls;
}

// 只處理 gis.sinica.edu.tw/legend/<id> 這種型態，反推出 id -> legendUrl 對照表
function buildLegendMap(urls){
  const map = {};
  const legendUrlRe = /^https?:\/\/gis\.sinica\.edu\.tw\/legend\/([^/?#]+)\/?/i;
  urls.forEach(url => {
    const m = url.match(legendUrlRe);
    if(!m) return;
    const id = m[1];
    if(!id) return;
    // 正規化成 https 開頭，避免 mixed content
    const normalizedUrl = url.replace(/^http:/i, 'https:');
    map[id] = normalizedUrl;
  });
  return map;
}

// 走訪 categories -> (groups ->) layers，跟 tools/fetch-wmts-bbox.js /
// tools/build-layers-bundle.js / src/data.js 一致的巢狀走訪邏輯
function forEachLayer(src, fn){
  src.categories.forEach(cat => {
    if(cat.groups){
      cat.groups.forEach(g => g.layers.forEach(fn));
    } else {
      cat.layers.forEach(fn);
    }
  });
}

// 同一個 jsonFile 可能被多個 tc 來源命中，寫回時直接覆蓋，不判斷是否
// 已被別的來源處理過。回傳值區分「新增/更新」與「已是最新值不需變更」。
function processSourceFile(fileName, legendMap, tc){
  const jsonPath = path.join(LAYERS_DIR, fileName);
  if(!fs.existsSync(jsonPath)){
    console.log(`檔案不存在，跳過：${fileName}`);
    return { tc, fileName, totalLayers: 0, matchedCount: 0, writtenCount: 0 };
  }

  const raw = fs.readFileSync(jsonPath, 'utf-8');
  const src = JSON.parse(raw);

  let totalLayers = 0;
  let matchedCount = 0;
  let writtenCount = 0; // 新增或更新（值有變化）的筆數
  let changed = false;
  const writtenIds = [];

  forEachLayer(src, (layer) => {
    totalLayers++;
    const legendUrl = legendMap[layer.id];
    if(!legendUrl) return;
    matchedCount++;
    if(layer.legend !== legendUrl){
      layer.legend = legendUrl;
      writtenCount++;
      changed = true;
      writtenIds.push(layer.id);
    }
  });

  if(changed){
    fs.writeFileSync(jsonPath, JSON.stringify(src, null, 2) + '\n');
  }

  console.log(`\n--- tc=${tc} -> ${fileName} ---`);
  console.log(`共 ${totalLayers} 筆圖層，比對到圖例 ${matchedCount} 筆，新增/更新 ${writtenCount} 筆${changed ? '（已寫回檔案）' : '（無變更）'}`);
  if(writtenIds.length > 0){
    console.log(writtenIds.join(', '));
  }

  return { tc, fileName, totalLayers, matchedCount, writtenCount };
}

async function processTcSource(tc, jsonFile){
  console.log(`\n=== 來源 tc=${tc} ===`);
  const xml = await fetchLayersXml(tc);
  const urls = parseLegendUrls(xml);
  const legendMap = buildLegendMap(urls);
  console.log(`圖層清單 API 共讀到 ${urls.length} 筆含圖例連結的圖層，可反推出 id 的共 ${Object.keys(legendMap).length} 筆`);
  return processSourceFile(jsonFile, legendMap, tc);
}

async function main(){
  const results = [];
  for(const { tc, jsonFile } of TC_SOURCES){
    const result = await processTcSource(tc, jsonFile);
    results.push(result);
  }

  const totalWritten = results.reduce((sum, r) => sum + r.writtenCount, 0);
  const totalMatched = results.reduce((sum, r) => sum + r.matchedCount, 0);

  console.log('\n=== 總結（依來源）===');
  results.forEach(r => {
    console.log(`tc=${r.tc} (${r.fileName})：比對到 ${r.matchedCount} 筆，新增/更新 ${r.writtenCount} 筆`);
  });
  console.log(`\n全站共比對到 ${totalMatched} 筆，新增/更新 ${totalWritten} 筆 legend 欄位`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
