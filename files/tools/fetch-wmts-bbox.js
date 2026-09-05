/* ---------------------------------------------------------
   tools/fetch-wmts-bbox.js
   ---------------------------------------------------------
   WMTS 圖層空間索引化：把中研院 WMTS Capabilities 文件裡每個
   Layer 的 WGS84BoundingBox 抓下來，寫進對應 data/layers/*.json
   圖層的 region.bbox 欄位（[minLon, minLat, maxLon, maxLat]）。

   之後前端就能先用這個 bbox 做本地空間篩選，只對少量候選圖層
   做 tile file-exists 探測，不用每個圖層都發 HTTP probe。

   Capabilities 結構固定已知，不需要真正的 XML DOM parser，
   直接用正則表達式抓 <Layer>...</Layer> 區塊即可。

   支援多個來源，每個來源各自有自己的 Capabilities 端點與對應的
   data/layers/*.json 檔案，設定在下方 SOURCES 陣列裡。日後要再
   加新來源，只需要在 SOURCES 多加一筆設定，不需要改動解析邏輯。

   執行方式：
       node tools/fetch-wmts-bbox.js

   新增或修改 data/layers/*.json 的圖層清單後，若需要重新對齊
   bbox，可以重新執行這支腳本；執行完別忘了依序跑
       node tools/tag-layer-types.js
       node tools/build-layers-bundle.js
--------------------------------------------------------- */
const fs = require('fs');
const path = require('path');

// 這些來源的 Capabilities 端點與 provider.tileTemplate 都是固定樣式
// https://gis.sinica.edu.tw/<id>/wmts/1.0.0/WMTSCapabilities.xml，
// 對應 data/layers/<id>.json，不需要逐筆手寫設定。
const AUTO_IDS = [
  'ls', 'keelung', 'taipei', 'newtaipei', 'taoyuan', 'hsinchu', 'changhua',
  'taichung', 'chiayi', 'lukang', 'tainan', 'kaohsiung', 'pingtung',
  'hakkaliudui', 'yilan', 'hualien', 'kinmen', 'beijing', 'shanghai',
  'tianjin', 'hangzhou', 'nanjing', 'wuhan', 'guangzhou', 'kunming',
  'suzhou', 'ccts', 'hongkong', 'korea',
  'tamsui', 'puli', 'penghu', 'taitung', 'japan',
];
const AUTO_SOURCES = AUTO_IDS.map(id => ({
  name: id,
  capabilitiesUrl: `https://gis.sinica.edu.tw/${id}/wmts/1.0.0/WMTSCapabilities.xml`,
  jsonPath: path.join(__dirname, '..', 'data', 'layers', `${id}.json`),
}));

const SOURCES = [
  {
    name: 'sinica',
    capabilitiesUrl: 'https://gis.sinica.edu.tw/tileserver/wmts/1.0.0/WMTSCapabilities.xml',
    jsonPath: path.join(__dirname, '..', 'data', 'layers', 'sinica.json'),
  },
  {
    name: 'thm',
    capabilitiesUrl: 'https://gis.sinica.edu.tw/thm/wmts/1.0.0/WMTSCapabilities.xml',
    jsonPath: path.join(__dirname, '..', 'data', 'layers', 'thm.json'),
  },
  ...AUTO_SOURCES,
];

async function fetchCapabilitiesXml(capabilitiesUrl){
  let res;
  try {
    res = await fetch(capabilitiesUrl);
  } catch (err) {
    throw new Error(`下載 WMTS Capabilities 失敗（網路錯誤）：${err.message}`);
  }
  if(!res.ok){
    throw new Error(`下載 WMTS Capabilities 失敗，HTTP 狀態碼 ${res.status} ${res.statusText}`);
  }
  return res.text();
}

// 從 Capabilities XML 抓出 id -> [minLon, minLat, maxLon, maxLat] 對照表
function parseLayerBBoxMap(xml){
  const map = {};
  const layerBlockRe = /<Layer>([\s\S]*?)<\/Layer>/g;
  let blockMatch;
  while((blockMatch = layerBlockRe.exec(xml)) !== null){
    const block = blockMatch[1];

    // 第一個 <ows:Identifier> 是 Layer 自己的 id（Style 底下那個 "default" 排在後面）
    const idMatch = block.match(/<ows:Identifier>([^<]+)<\/ows:Identifier>/);
    if(!idMatch) continue;
    const id = idMatch[1].trim();

    const bboxBlockMatch = block.match(/<ows:WGS84BoundingBox[^>]*>([\s\S]*?)<\/ows:WGS84BoundingBox>/);
    if(!bboxBlockMatch) continue;
    const bboxBlock = bboxBlockMatch[1];

    const lowerMatch = bboxBlock.match(/<ows:LowerCorner>\s*([-\d.]+)\s+([-\d.]+)\s*<\/ows:LowerCorner>/);
    const upperMatch = bboxBlock.match(/<ows:UpperCorner>\s*([-\d.]+)\s+([-\d.]+)\s*<\/ows:UpperCorner>/);
    if(!lowerMatch || !upperMatch) continue;

    const minLon = parseFloat(lowerMatch[1]);
    const minLat = parseFloat(lowerMatch[2]);
    const maxLon = parseFloat(upperMatch[1]);
    const maxLat = parseFloat(upperMatch[2]);

    map[id] = [minLon, minLat, maxLon, maxLat];
  }
  return map;
}

// 走訪 categories -> (groups ->) layers，跟 tools/build-layers-bundle.js /
// src/data.js 一致的巢狀走訪邏輯
function forEachLayer(src, fn){
  src.categories.forEach(cat => {
    if(cat.groups){
      cat.groups.forEach(g => g.layers.forEach(fn));
    } else {
      cat.layers.forEach(fn);
    }
  });
}

async function processSource(source){
  const { name, capabilitiesUrl, jsonPath } = source;
  const jsonFileName = path.relative(path.join(__dirname, '..'), jsonPath).replace(/\\/g, '/');

  console.log(`\n=== 來源：${name} ===`);

  const xml = await fetchCapabilitiesXml(capabilitiesUrl);
  const bboxMap = parseLayerBBoxMap(xml);

  const raw = fs.readFileSync(jsonPath, 'utf-8');
  const src = JSON.parse(raw);

  let totalLayers = 0;
  let writtenCount = 0;
  const matchedIds = new Set();

  forEachLayer(src, (layer) => {
    totalLayers++;
    const bbox = bboxMap[layer.id];
    if(bbox){
      layer.region = { bbox };
      writtenCount++;
      matchedIds.add(layer.id);
    }
  });

  const unmatchedCapabilitiesIds = Object.keys(bboxMap).filter(id => !matchedIds.has(id));

  fs.writeFileSync(jsonPath, JSON.stringify(src, null, 2) + '\n');

  console.log(`Capabilities 共讀到 ${Object.keys(bboxMap).length} 筆 Layer`);
  console.log(`${jsonFileName} 共 ${totalLayers} 筆圖層，成功寫入 region.bbox ${writtenCount} 筆`);
  if(unmatchedCapabilitiesIds.length > 0){
    console.log(`Capabilities 裡有但 ${jsonFileName} 找不到對應 id 的筆數：${unmatchedCapabilitiesIds.length}`);
    console.log(unmatchedCapabilitiesIds.join(', '));
  } else {
    console.log(`Capabilities 裡的每個 id 在 ${jsonFileName} 都有找到對應圖層`);
  }

  return { name, capabilitiesCount: Object.keys(bboxMap).length, totalLayers, writtenCount };
}

async function main(){
  const results = [];
  for(const source of SOURCES){
    const result = await processSource(source);
    results.push(result);
  }

  console.log('\n=== 總結 ===');
  results.forEach(r => {
    console.log(`${r.name}：${r.writtenCount}/${r.totalLayers} 筆圖層成功寫入 region.bbox（Capabilities 共 ${r.capabilitiesCount} 筆）`);
  });
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
