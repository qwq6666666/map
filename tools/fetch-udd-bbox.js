/* ---------------------------------------------------------
   tools/fetch-udd-bbox.js
   ---------------------------------------------------------
   udd（臺北市都發局「歷史圖資展示系統」）的 bbox 空間索引化。

   跟 tools/fetch-wmts-bbox.js 處理的其他 38 個來源不同，udd 不在
   gis.sinica.edu.tw 上、也沒有單一 Capabilities 端點列出全部圖層
   （data/layers/udd.json 的 provider 是 literalUrl:true，每個圖層
   直接帶完整 tile URL）。實測 historygis.udd.gov.taipei 的
   /arcgis/rest/services 目錄後發現：

   1. 直接使用 .../arcgis/rest/services/<Group>/<Name>/MapServer/WMTS/...
      的圖層（DGN_M080~114、Image_1973 以後、Urban 群組），可以照
      標準 ArcGIS WMTS 慣例，對 .../MapServer/WMTS/1.0.0/WMTSCapabilities.xml
      發請求，取得跟 fetch-wmts-bbox.js 完全同格式的
      <ows:WGS84BoundingBox>（該檔案通常只有 1 個 <Layer>，不需要按
      id 比對，直接抓第一個 WGS84BoundingBox 即可）。
   2. 走自訂代理 .../UDDWMTS/tile/<ProxyId>/{z}/{y}/{x} 的圖層
      （History_TM*、Image_1945~1972 一帶），ProxyId 其實是
      `<Group>_<Name>` 疊接而成（跟 WMTS Capabilities 裡的
      <ows:Identifier> 同一套命名慣例，例如 Aerial_Ortho_1957 對應
      Aerial/Ortho_1957），從第一個底線切開就能還原出對應的
      MapServer 路徑，一樣可以用上面同一支 Capabilities 端點。
   3. 但並非每個 ProxyId 都能還原出真的存在的 MapServer——
      History_TM47/58/69（TP_History_H_T19xx）與 Image_1945A/B、
      Image_1947/1948/1956/1963/1965/1967/1972 這 12 筆，實測
      /arcgis/rest/services 目錄下找不到對應資料夾與服務名稱
      （TP_History 資料夾甚至是空的），Capabilities 端點回 500。
      這些圖層目前沒有已知方法能取得精確 bbox，維持 region:null，
      前端 fallback（pointInBbox()／bboxIntersects() 缺 bbox 一律
      視為相交）本來就安全，不會因為留白而誤排除，不強行湊一個
      不準的來源層級 bbox 進去。

   執行方式：
       node tools/fetch-udd-bbox.js

   執行完別忘了依序跑
       node tools/tag-layer-types.js
       node tools/build-layers-bundle.js
--------------------------------------------------------- */
const fs = require('node:fs');
const path = require('node:path');
const { forEachLayer } = require('./lib/layerWalk');

const HOST = 'https://www.historygis.udd.gov.taipei';
const jsonPath = path.join(__dirname, '..', 'data', 'layers', 'udd.json');

// 從圖層的完整 tile URL 還原出 <Group>/<Name> 這組 ArcGIS MapServer 路徑，
// 找不出來（不符合任何已知樣式）回傳 null。
function extractArcgisService(url) {
  const direct = /\/arcgis\/rest\/services\/([^/]+\/[^/]+)\/MapServer\//.exec(url);
  if (direct) return direct[1];

  const proxy = /\/UDDWMTS\/tile\/([^/]+)\//.exec(url);
  if (proxy) {
    const id = proxy[1];
    const underscoreIdx = id.indexOf('_');
    if (underscoreIdx === -1) return null;
    return `${id.slice(0, underscoreIdx)}/${id.slice(underscoreIdx + 1)}`;
  }
  return null;
}

// 對單一 MapServer 的 WMTS Capabilities 發請求，抓第一個 WGS84BoundingBox。
// 服務不存在／格式不符時回傳 null，呼叫端當成「這筆探測失敗」處理，不拋例外
// 中斷整支腳本（54 筆圖層裡本來就預期有一部分探測不到）。
async function fetchServiceBBox(service) {
  const capUrl = `${HOST}/arcgis/rest/services/${service}/MapServer/WMTS/1.0.0/WMTSCapabilities.xml`;
  let res;
  try {
    res = await fetch(capUrl);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const xml = await res.text();

  const bboxBlockMatch = /<ows:WGS84BoundingBox[^>]*>([\s\S]*?)<\/ows:WGS84BoundingBox>/.exec(xml);
  if (!bboxBlockMatch) return null;
  const bboxBlock = bboxBlockMatch[1];

  const lowerMatch = /<ows:LowerCorner>\s*([-\d.]+)\s+([-\d.]+)\s*<\/ows:LowerCorner>/.exec(bboxBlock);
  const upperMatch = /<ows:UpperCorner>\s*([-\d.]+)\s+([-\d.]+)\s*<\/ows:UpperCorner>/.exec(bboxBlock);
  if (!lowerMatch || !upperMatch) return null;

  let minLon = Number.parseFloat(lowerMatch[1]);
  let minLat = Number.parseFloat(lowerMatch[2]);
  let maxLon = Number.parseFloat(upperMatch[1]);
  let maxLat = Number.parseFloat(upperMatch[2]);

  // 比照 fetch-wmts-bbox.js 對中研院端點踩過的坑，這裡一樣做防呆：
  // 上下界順序異常就自動交換，不要整筆放棄（放棄會被前端當成
  // 「無索引」處理，反而讓這筆圖層的 bbox 篩選整個失效）。
  if (minLon > maxLon) { console.warn(`  [警告] ${service} 的經度上下界顛倒，已自動交換`); [minLon, maxLon] = [maxLon, minLon]; }
  if (minLat > maxLat) { console.warn(`  [警告] ${service} 的緯度上下界顛倒，已自動交換`); [minLat, maxLat] = [maxLat, minLat]; }

  return [minLon, minLat, maxLon, maxLat];
}

async function main() {
  const raw = fs.readFileSync(jsonPath, 'utf-8');
  const src = JSON.parse(raw);

  let totalLayers = 0;
  let writtenCount = 0;
  const unresolvedIds = []; // 從 URL 還原不出 <Group>/<Name> 的圖層
  const failedIds = [];     // 還原得出路徑，但 Capabilities 探測失敗的圖層

  const layers = [];
  forEachLayer(src, (layer) => { totalLayers++; layers.push(layer); });

  for (const layer of layers) {
    const service = extractArcgisService(layer.url);
    if (!service) {
      unresolvedIds.push(layer.id);
      continue;
    }

    console.log(`探測 ${layer.id}（${service}）...`);
    const bbox = await fetchServiceBBox(service);
    if (bbox) {
      layer.region = { bbox };
      writtenCount++;
    } else {
      failedIds.push(`${layer.id}（${service}）`);
    }
  }

  fs.writeFileSync(jsonPath, JSON.stringify(src, null, 2) + '\n');

  console.log('\n=== 總結 ===');
  console.log(`udd.json 共 ${totalLayers} 筆圖層，成功寫入 region.bbox ${writtenCount} 筆`);
  if (unresolvedIds.length > 0) {
    console.log(`\n無法從 URL 還原出 MapServer 路徑（維持 region:null）共 ${unresolvedIds.length} 筆：`);
    console.log(unresolvedIds.join(', '));
  }
  if (failedIds.length > 0) {
    console.log(`\n還原出路徑但 Capabilities 探測失敗（維持 region:null）共 ${failedIds.length} 筆：`);
    console.log(failedIds.join(', '));
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
