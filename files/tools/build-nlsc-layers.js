/* ---------------------------------------------------------
   tools/build-nlsc-layers.js
   ---------------------------------------------------------
   一次性（可重複執行）腳本：從內政部國土測繪中心 WMTS 服務的
   GetCapabilities 文件抓出「全部」圖層清單，依 id 前綴規則分類、
   分群後寫入 data/layers/nlsc.json，取代原本手選的 5 張精選圖層。

   來源：https://wmts.nlsc.gov.tw/wmts/WMTSCapabilities.xml
   （公開、免金鑰的 WMTS 1.0.0 GetCapabilities，跟 tools/fetch-wmts-bbox.js
   解析的中研院端點是同一種 XML 格式，但這份文件沒有
   <ows:WGS84BoundingBox>，也不符合中研院那批
   https://gis.sinica.edu.tw/<id>/wmts/1.0.0/WMTSCapabilities.xml 的網址
   樣式，所以：

   1. 不要把 "nlsc" 加進 tools/fetch-wmts-bbox.js 的 AUTO_IDS／SOURCES，
      那支腳本會找不到 WGS84BoundingBox 而整批略過，沒有意義。
      nlsc 全部圖層一律沿用同一個台灣概略 bbox（見 TAIWAN_BBOX）。
   2. nlsc 這個來源本身刻意「不」出現在 data/source-map.json 的任何
      名單（alwaysInclude／alwaysIncludeUnless／rules）裡，因為它是
      全國性現代圖資，任何台灣座標幾乎都會「命中」，若被搜尋／地圖
      落點探針拿去發 file-exists 圖磚 HTTP 請求，這麼多圖層等於每次
      搜尋都多打幾百次幾乎必中、毫無篩選意義的請求。300 張圖層放在
      複合疊圖模式的圖層樹讓使用者手動勾選沒有這個成本問題，純粹是
      分類整理問題——這支腳本要做的就是把分類整理好。

   用法：
       node tools/build-nlsc-layers.js

   執行後記得依序跑：
       node tools/tag-layer-types.js
       node tools/build-layers-bundle.js

   日後 NLSC 服務改版（新增/移除圖層）時，可重新執行這支腳本重新產生
   data/layers/nlsc.json；若對方新增了不屬於下面任何分類規則的圖層 id，
   會自動落入「其他圖資」分類，不會讓腳本中斷或漏掉圖層。
--------------------------------------------------------- */
const fs = require('fs');
const path = require('path');

const CAPABILITIES_URL = 'https://wmts.nlsc.gov.tw/wmts/WMTSCapabilities.xml';
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'layers', 'nlsc.json');

// 這份 Capabilities 沒有 ows:WGS84BoundingBox，全部圖層沿用同一個
// 台灣概略 bbox（跟既有 data/layers/nlsc.json 來源層級 region.bbox 一致）。
const TAIWAN_BBOX = [117.84953432, 21.65607265, 123.85924109, 25.64233621];

async function fetchCapabilitiesXml(){
  let res;
  try {
    res = await fetch(CAPABILITIES_URL);
  } catch (err) {
    throw new Error(`下載 NLSC WMTS Capabilities 失敗（網路錯誤）：${err.message}`);
  }
  if(!res.ok){
    throw new Error(`下載 NLSC WMTS Capabilities 失敗，HTTP 狀態碼 ${res.status} ${res.statusText}`);
  }
  const xml = await res.text();
  // 曾實測遇過偶發的內容截斷（同樣的 URL、同樣的檔案長度，但 <Layer>／</Layer>
  // 標籤數量對不上），為避免靜默寫出不完整的圖層清單，這裡先做基本完整性檢查，
  // 對不上就直接丟錯，讓使用者重新執行一次即可（不做自動重試，避免掩蓋真正的問題）。
  const opens = (xml.match(/<Layer>/g) || []).length;
  const closes = (xml.match(/<\/Layer>/g) || []).length;
  if(opens === 0 || opens !== closes || !xml.trim().endsWith('</Capabilities>')){
    throw new Error(`下載到的 NLSC WMTS Capabilities 內容不完整（<Layer> 開始 ${opens} 個、結束 ${closes} 個），請重新執行一次`);
  }
  return xml;
}

// 從 Capabilities XML 抓出 [{ id, title, mimeFormat }]，跟
// tools/fetch-wmts-bbox.js 一樣用正則抓 <Layer>...</Layer> 區塊，
// 不需要真正的 XML DOM parser。
function parseLayers(xml){
  const rows = [];
  const layerBlockRe = /<Layer>([\s\S]*?)<\/Layer>/g;
  let blockMatch;
  while((blockMatch = layerBlockRe.exec(xml)) !== null){
    const block = blockMatch[1];

    // 第一個 <ows:Identifier> 是 Layer 自己的 id（Style 底下那個 "default" 排在後面）
    const idMatch = block.match(/<ows:Identifier>([^<]+)<\/ows:Identifier>/);
    if(!idMatch) continue;
    const id = idMatch[1].trim();

    const titleMatch = block.match(/<ows:Title>([^<]*)<\/ows:Title>/);
    const title = titleMatch ? titleMatch[1].trim() : id;

    const formatMatch = block.match(/<Format>([^<]+)<\/Format>/);
    const mimeFormat = formatMatch ? formatMatch[1].trim() : null;

    rows.push({ id, title, mimeFormat });
  }
  return rows;
}

function formatFromMime(mimeFormat){
  if(mimeFormat === 'image/jpeg') return 'jpg';
  if(mimeFormat === 'image/png') return 'png';
  return null;
}

// ---------------------------------------------------------
// 分類規則：依 id 前綴／完整比對，把每個圖層歸進一個分類 key。
// 順序沒有交集疑慮，前面比對不到才會往下試，最後都比對不到歸 'other'。
// ---------------------------------------------------------
const CATEGORY_RULES = [
  { key: 'emap', test: id => /^EMAP/.test(id) },
  { key: 'photo', test: id => /^PHOTO/.test(id) },
  { key: 'topo', test: id => /^(?:B100000|B25000|B50000|B5000|TOPO25K_|TOPO50K_|TOPO10M_|TOPO10KPHOTO$|TOPO05KPHOTO_)/.test(id) },
  { key: 'luimap', test: id => /^LUIMAP/.test(id) },
  { key: 'terrain-analysis', test: id => [
    'MOI_ASPECT', 'MOI_CONTOUR', 'MOI_CONTOUR_2', 'MOI_HILLSHADE', 'MOI_SHADERMAP',
    'MOI_SLOPEP_GT30', 'MOI_SLOPEP_LV7', 'MOI_SLOPEP_GT30_2', 'MOI_SLOPEP_LV7_2',
    'DDEM05', 'DDEM052',
  ].includes(id) },
  { key: 'admin', test: id => [
    'CITY', 'TOWN', 'Village', 'Village201910', 'LandOffice', 'LANDSECT', 'LANDSECT2', 'MB5000',
  ].includes(id) },
  { key: 'landuse-zone', test: id => ['LAND_OPENDATA', 'nURBAN1', 'nURBAN2'].includes(id) },
  { key: 'hazard', test: id => [
    'GeoSensitive', 'GeoSensitive2', 'SoilLiquefaction', 'SoilLiquefaction2', 'SHELTERS',
  ].includes(id) },
  { key: 'poi', test: id => ['SCHOOL', 'AED', 'ConvenienceStore', 'fireplug'].includes(id) },
  { key: 'road', test: id => id === 'ROAD' },
  { key: 'asrs', test: id => /^Asrs_/.test(id) },
];

function classify(id){
  const rule = CATEGORY_RULES.find(r => r.test(id));
  return rule ? rule.key : 'other';
}

const CATEGORY_META = {
  'emap': { name: '現代電子地圖', grouped: false },
  'photo': { name: '歷年正射影像', grouped: true },
  'topo': { name: '歷年地形圖', grouped: true },
  'luimap': { name: '國土利用現況調查', grouped: true },
  'terrain-analysis': { name: '地形分析圖', grouped: false },
  'admin': { name: '行政區界', grouped: false },
  'landuse-zone': { name: '土地使用分區', grouped: false },
  'hazard': { name: '防災與敏感區', grouped: false },
  'poi': { name: '民生設施點位', grouped: false },
  'road': { name: '路網', grouped: false },
  'asrs': { name: '馬太鞍溪事件航照', grouped: true },
  'other': { name: '其他圖資', grouped: false },
};

// 分類輸出順序
const CATEGORY_ORDER = [
  'emap', 'photo', 'topo', 'luimap', 'terrain-analysis',
  'admin', 'landuse-zone', 'hazard', 'poi', 'road', 'asrs', 'other',
];

// ---------------------------------------------------------
// 年份／群組判定：依分類各自邏輯換算西元年（民國年 + 1911）
// ---------------------------------------------------------
function computeYearInfo(category, id, title){
  switch(category){
    case 'photo': {
      const m = id.match(/^PHOTO(\d{4})$/);
      if(m) return { year: parseInt(m[1], 10), dateLabel: m[1] };
      const ty = title.match(/(\d+)年/);
      if(ty){
        const west = parseInt(ty[1], 10) + 1911;
        return { year: west, dateLabel: String(west) };
      }
      return { year: null, dateLabel: '現代' };
    }
    case 'topo': {
      const m = id.match(/^(?:TOPO25K_|TOPO50K_|TOPO10M_|TOPO05KPHOTO_)(\d+)$/);
      if(m){
        const west = parseInt(m[1], 10) + 1911;
        return { year: west, dateLabel: String(west) };
      }
      return { year: null, dateLabel: '現代' }; // B100000/B25000/B50000/B5000/TOPO10KPHOTO
    }
    case 'luimap': {
      const m = id.match(/^LUIMAP(\d+)$/);
      if(!m) return { year: null, dateLabel: '現代' }; // 裸 LUIMAP（綜合成果圖，無單一年份）
      const num = parseInt(m[1], 10);
      if(num <= 9) return { year: null, dateLabel: '現代' }; // LUIMAP01~09：土地利用類別，非年份
      const rangeM = title.match(/(\d+)-(\d+)年/);
      if(rangeM){
        const w1 = parseInt(rangeM[1], 10) + 1911;
        const w2 = parseInt(rangeM[2], 10) + 1911;
        return { year: w1, dateLabel: `${w1}-${w2}` };
      }
      const west = num + 1911;
      return { year: west, dateLabel: String(west) };
    }
    case 'terrain-analysis': {
      const rangeM = title.match(/\((\d{4})-(\d{4})\)/); // 已是西元年區間，不用換算
      if(rangeM) return { year: parseInt(rangeM[1], 10), dateLabel: `${rangeM[1]}-${rangeM[2]}` };
      return { year: null, dateLabel: '現代' };
    }
    case 'admin': {
      const m = title.match(/(\d+)年(\d+)月/); // 例：村里界(108年10月)
      if(m){
        const west = parseInt(m[1], 10) + 1911;
        return { year: west, dateLabel: String(west) };
      }
      return { year: null, dateLabel: '現代' };
    }
    case 'asrs': {
      if(id === 'Asrs_2025_ortho') return { year: 2025, dateLabel: '2025' };
      const m = id.match(/^Asrs_(\d{4})(\d{2})(\d{2})_\d+$/);
      if(m){
        const [, y, mo, d] = m;
        return { year: parseInt(y, 10), dateLabel: `${y}/${mo}/${d}` };
      }
      return { year: null, dateLabel: '現代' };
    }
    default:
      return { year: null, dateLabel: '現代' };
  }
}

function computeScale(category, id){
  if(category !== 'topo') return null;
  if(/^(?:B100000|TOPO10M_)/.test(id)) return '1:100000';
  if(/^(?:B25000|TOPO25K_)/.test(id)) return '1:25000';
  if(/^(?:B50000|TOPO50K_)/.test(id)) return '1:50000';
  if(/^(?:B5000|TOPO05KPHOTO_)/.test(id)) return '1:5000';
  if(id === 'TOPO10KPHOTO') return '1:10000';
  return null;
}

// 群組判定：只有 grouped === true 的分類需要
function computeGroupName(category, id){
  switch(category){
    case 'photo':
      return /^PHOTO\d{4}$/.test(id) ? '各年正射影像' : '综合影像';
    case 'topo': {
      if(/^(?:B25000|TOPO25K_)/.test(id)) return '1/25000地形圖';
      if(/^(?:B50000|TOPO50K_)/.test(id)) return '1/50000地形圖';
      if(/^(?:B100000|TOPO10M_)/.test(id)) return '1/10萬地形圖';
      if(/^(?:B5000|TOPO05KPHOTO_)/.test(id)) return '1/5000像片基本圖';
      return '其他比例尺圖幅'; // TOPO10KPHOTO
    }
    case 'luimap': {
      const m = id.match(/^LUIMAP(\d+)$/);
      if(m && parseInt(m[1], 10) <= 9) return '土地利用類別';
      return '歷年更新區';
    }
    case 'asrs':
      return id === 'Asrs_2025_ortho' ? '災前正射影像' : null; // 其餘用 dateLabel 當群組名，下面組裝時處理
    default:
      return null;
  }
}

// 分組排序順序（同一分類內，group 出現順序）
const GROUP_ORDER = {
  photo: ['综合影像', '各年正射影像'],
  topo: ['1/25000地形圖', '1/50000地形圖', '1/10萬地形圖', '1/5000像片基本圖', '其他比例尺圖幅'],
  luimap: ['歷年更新區', '土地利用類別'],
};

function sortLayersByYear(layers){
  return layers.slice().sort((a, b) => {
    const ay = a.year == null ? -Infinity : a.year;
    const by = b.year == null ? -Infinity : b.year;
    if(ay !== by) return ay - by;
    return a.id.localeCompare(b.id);
  });
}

function buildLayer(row, category){
  const { id, title, mimeFormat } = row;
  const format = formatFromMime(mimeFormat);
  const { year, dateLabel } = computeYearInfo(category, id, title);
  const scale = computeScale(category, id);
  return {
    id,
    title,
    format,
    year,
    dateLabel,
    type: null, // 稍後由 tools/tag-layer-types.js 自動打標
    scale,
    region: { bbox: TAIWAN_BBOX },
    keywords: [],
  };
}

async function main(){
  const xml = await fetchCapabilitiesXml();
  const rows = parseLayers(xml);
  console.log(`Capabilities 共讀到 ${rows.length} 筆 Layer`);

  const byCategory = new Map(); // category -> row[]
  rows.forEach(row => {
    const category = classify(row.id);
    if(!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push(row);
  });

  const categories = [];
  const summary = [];

  CATEGORY_ORDER.forEach(category => {
    const categoryRows = byCategory.get(category) || [];
    if(categoryRows.length === 0) return;
    const meta = CATEGORY_META[category];

    if(!meta.grouped){
      const layers = sortLayersByYear(categoryRows.map(r => buildLayer(r, category)));
      categories.push({ id: null, name: meta.name, layers });
      summary.push(`${meta.name}：${layers.length} 筆`);
      return;
    }

    // 分組分類：先依 computeGroupName 分桶，asrs 特例（用日期字串當桶）另外處理
    const buckets = new Map(); // groupName -> layer[]
    categoryRows.forEach(row => {
      const layer = buildLayer(row, category);
      let groupName = computeGroupName(category, row.id);
      if(category === 'asrs' && groupName === null){
        // 用 dateLabel（YYYY/MM/DD）當群組名稱，符合規格「例如『2025/09/25 航照』」
        groupName = layer.dateLabel === '現代' ? '其他航照' : `${layer.dateLabel} 航照`;
      }
      if(!buckets.has(groupName)) buckets.set(groupName, []);
      buckets.get(groupName).push(layer);
    });

    let groupNames;
    if(GROUP_ORDER[category]){
      // 先按預先定義的順序排，asrs 沒有固定順序表，改用日期排序
      groupNames = GROUP_ORDER[category].filter(name => buckets.has(name));
      buckets.forEach((_, name) => { if(!groupNames.includes(name)) groupNames.push(name); });
    } else {
      groupNames = [...buckets.keys()];
    }

    if(category === 'asrs'){
      // 災前正射影像優先，其餘依群組內第一筆的 year/dateLabel 由小到大排序
      groupNames = [...buckets.keys()].sort((a, b) => {
        if(a === '災前正射影像') return -1;
        if(b === '災前正射影像') return 1;
        return a.localeCompare(b, 'zh-Hant');
      });
    }

    const groups = groupNames.map(name => ({
      name,
      layers: sortLayersByYear(buckets.get(name)).sort((a, b) => {
        // 同一天多張航照（asrs）依 id 尾碼數字排序；其餘分類保留 sortLayersByYear 結果
        if(category !== 'asrs') return 0;
        const an = parseInt((a.id.match(/_(\d+)$/) || [])[1] || '0', 10);
        const bn = parseInt((b.id.match(/_(\d+)$/) || [])[1] || '0', 10);
        return an - bn;
      }),
    }));

    const total = groups.reduce((sum, g) => sum + g.layers.length, 0);
    categories.push({ id: null, name: meta.name, groups });
    summary.push(`${meta.name}：${total} 筆（${groups.map(g => `${g.name} ${g.layers.length}`).join('、')}）`);
  });

  const output = {
    id: 'nlsc',
    name: '國土測繪圖資（現代參考圖層）',
    attribution: '內政部國土測繪中心 國土測繪圖資服務雲',
    provider: {
      tileTemplate: 'https://wmts.nlsc.gov.tw/wmts/{id}/default/GoogleMapsCompatible/{z}/{y}/{x}',
    },
    region: {
      bbox: TAIWAN_BBOX,
    },
    categories,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n');

  let totalLayers = 0;
  categories.forEach(cat => {
    if(cat.groups) cat.groups.forEach(g => totalLayers += g.layers.length);
    else totalLayers += cat.layers.length;
  });

  console.log('\n=== 分類統計 ===');
  summary.forEach(line => console.log(`  ${line}`));
  console.log(`\n已寫入 ${path.relative(process.cwd(), OUTPUT_PATH)}，共 ${categories.length} 個分類、${totalLayers} 筆圖層`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
