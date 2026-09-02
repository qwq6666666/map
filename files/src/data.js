/* ---------------------------------------------------------
   data.js — 資料載入與查詢層
   ---------------------------------------------------------
   負責：
     1. fetch() 載入 data/ 目錄下的 JSON（圖層目錄、來源設定、
        地理範圍、縣市→來源對應、歷史地名比對規則）
     2. 把 JSON 轉成其他模組慣用的記憶體內資料形狀
        （layer.year / layer.fmt 對應來源檔案的
        layer.dateLabel / layer.format）
     3. 提供 resolveTileUrl()，取代原本寫死在各個 XXX_TILE()
        函式裡的網址組成規則；每個來源的 tile URL 樣板放在該來源
        自己的 data/layers/<id>.json 裡的 provider 欄位。
     4. 提供跟「資料查詢」有關的共用函式：依 key 找圖層來源、
        依地址縣市／鄉鎮比對可用的圖資來源、地名文字比對。

   資料檔案配置：
     data/layers/index.json     開發用來源清單（id/file/name/layerCount）
     data/layers/<id>.json      開發用：單一來源的圖層目錄 + provider
                                  （tile URL 樣板）+ region（bbox），
                                  方便編輯、方便看 git diff
     data/layers.bundle.json    實際部署時瀏覽器載入的合併檔（由
                                  tools/build-layers-bundle.js 產生），
                                  一次 fetch 取代 19 次，避免請求數過多
                                  拖慢初始載入
     data/source-map.json       縣市→來源的對應規則（跨來源查詢邏輯，
                                  不屬於任何單一來源，所以獨立）
     data/historical-names.json 地名詞尾與未來的新舊地名對照表

   新增一張歷史地圖時：
     1. 新增一個 data/layers/<新id>.json（圖層目錄 + provider + region）
     2. 在 data/layers/index.json 加一筆 { id, file, name, layerCount }
     3. 執行 `node tools/build-layers-bundle.js` 重新產生
        data/layers.bundle.json（部署前一定要做這一步，否則瀏覽器
        載入的還是舊資料）
     4. 視情況在 data/source-map.json 加一筆縣市對應規則
   不需要更動任何既有來源的檔案，也不需要更動任何 .js 檔案。
--------------------------------------------------------- */

export let LAYER_SOURCES = [];
export let REGION_EXTENTS = {};
export let SOURCE_MAP_RULES = null;
export let HISTORICAL_NAMES = null;
export let PLACE_NAME_SUFFIXES = [];

const SAT_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

// udd 來源比較特殊：每個圖層的 tile 網址不是套同一個樣板算出來的，
// 而是分成 ArcGIS WMTS REST 版 / 舊版 UDDWMTS 版兩種，組出來的完整網址
// 直接存在該來源檔案裡每筆圖層的 url 欄位。resolveTileUrl() 依
// 來源檔案 provider 欄位裡的 literalUrl 旗標，決定要套樣板還是直接取 layer.url。
function resolveTileUrl(provider, layer){
  if(!provider) return '';
  if(provider.literalUrl) return layer.url || '';
  return (provider.tileTemplate || '')
    .replace('{id}', layer.id)
    .replace('{format}', layer.fmt);
}

/* ---------------------------------------------------------
   將每個分類內的圖層依年代排序（由舊到新）
   年份格式不一（純西元年、"1930s"、"清"、"日治"、"戰後"等），
   用 yearSortValue 統一轉成可比較的數字後再排序。
--------------------------------------------------------- */
function yearSortValue(y){
  const s = String(y);
  const m = s.match(/\d{3,4}/); // 抓出字串中第一組 3~4 位數字（例：1930s → 1930）
  if(m) return parseInt(m[0], 10);
  if(s === '清') return 1850;    // 清代，無精確年份者排在最前
  if(s === '日治') return 1910;  // 日治時期通用標籤，概略排在日治中期
  if(s === '戰後') return 1950;  // 戰後通用標籤，概略排在戰後初期
  return 9999;                    // 年代不明（如「—」）排在該分類最後
}

function sortAllLayers(){
  LAYER_SOURCES.forEach(src=>{
    src.categories.forEach(cat=>{
      if(cat.groups){
        cat.groups.forEach(g=> g.layers.sort((a,b)=> yearSortValue(a.year) - yearSortValue(b.year)));
      } else {
        cat.layers.sort((a,b)=> yearSortValue(a.year) - yearSortValue(b.year));
      }
    });
  });
}

export async function loadAppData(){
  const [layersData, sourceMapData, namesData] = await Promise.all([
    fetch('./data/layers.bundle.json').then(r => r.json()),
    fetch('./data/source-map.json').then(r => r.json()),
    fetch('./data/historical-names.json').then(r => r.json())
  ]);

  const sourceFiles = layersData.sources;

  SOURCE_MAP_RULES = sourceMapData;
  HISTORICAL_NAMES = namesData;
  PLACE_NAME_SUFFIXES = namesData.suffixes;

  // 每個來源檔案自帶 provider（tile URL 樣板／literalUrl 旗標）與
  // region（bbox），不用再另外查表比對 id，直接就地取用。
  REGION_EXTENTS = {};
  sourceFiles.forEach(src => { REGION_EXTENTS[src.id] = src.region.bbox; });

  // src.json -> LAYER_SOURCES
  // （沿用原本 { id, name, tileUrl, attribution, categories:[{category, layers|groups}] } 形狀，
  //   layer.fmt / layer.year 對應回來源檔案的 layer.format / layer.dateLabel，
  //   讓其他模組沒有變動過的渲染、搜尋、比對程式碼可以直接使用。）
  LAYER_SOURCES = sourceFiles.map(src => {
    const provider = src.provider;
    const mapLayer = (l) => ({
      id: l.id,
      title: l.title,
      fmt: l.format,
      year: l.dateLabel,
      url: l.url // 只有 udd 圖層會用到（file-exists 樣板來源沒有這個欄位）
    });
    const categories = src.categories.map(cat => {
      if(cat.groups){
        return {
          category: cat.name,
          groups: cat.groups.map(g => ({ name: g.name, layers: g.layers.map(mapLayer) }))
        };
      }
      return { category: cat.name, layers: cat.layers.map(mapLayer) };
    });
    return {
      id: src.id,
      name: src.name,
      tileUrl: (layer) => resolveTileUrl(provider, layer),
      attribution: src.attribution,
      categories
    };
  });

  sortAllLayers();
}

/* ---------------------------------------------------------
   共用：依 key 建立圖層來源
   key 格式："base:osm" / "base:sat" / "hist:<id>:<fmt>"
--------------------------------------------------------- */
export function findLayerById(src, id){
  for(const cat of src.categories){
    if(cat.groups){
      for(const g of cat.groups){
        const l = g.layers.find(x => x.id === id);
        if(l) return l;
      }
    } else {
      const l = cat.layers.find(x => x.id === id);
      if(l) return l;
    }
  }
  return null;
}

export function makeSourceForKey(key){
  if(key === 'base:osm') return new ol.source.OSM();
  if(key === 'base:sat') return new ol.source.XYZ({ url: SAT_URL, attributions: 'Esri, Maxar, Earthstar Geographics' });
  const parts = key.split(':'); // ["hist", sourceId, id, fmt]
  const src = LAYER_SOURCES.find(s => s.id === parts[1]);
  if(!src) return new ol.source.XYZ({ url: '' });
  const layer = findLayerById(src, parts[2]);
  if(!layer) return new ol.source.XYZ({ url: '' });
  return new ol.source.XYZ({ url: src.tileUrl(layer), attributions: src.attribution });
}

export function titleForKey(key){
  if(key === 'base:osm') return '現代地圖';
  if(key === 'base:sat') return '衛星影像';
  const parts = key.split(':');
  const src = LAYER_SOURCES.find(s => s.id === parts[1]);
  if(!src) return key;
  for(const cat of src.categories){
    const layersArr = cat.groups ? cat.groups.flatMap(g=>g.layers) : cat.layers;
    for(const l of layersArr){
      if(l.id === parts[2]) return `${l.year} ${l.title}`;
    }
  }
  return key;
}

// 把 { src, layer } 組成 store 用的可序列化 key 字串（"hist:sourceId:id:fmt"）。
export function layerKey(src, layer){
  return `hist:${src.id}:${layer.id}:${layer.fmt}`;
}

// layerKey() 的反向操作：把 key 字串解析回 { src, layer }。
// 傳入底圖 key（"base:osm"/"base:sat"）或找不到對應圖層時回傳 null，
// 呼叫端看到 null 就知道這個 key 不是歷史圖層（是底圖，或已經失效）。
export function resolveOverlayKey(key){
  if(!key || key === 'base:osm' || key === 'base:sat') return null;
  const parts = key.split(':'); // ["hist", sourceId, id, fmt]
  const src = LAYER_SOURCES.find(s => s.id === parts[1]);
  if(!src) return null;
  const layer = findLayerById(src, parts[2]);
  if(!layer) return null;
  return { src, layer };
}

/* ---------------------------------------------------------
   依 Nominatim 回傳的地址元件（縣市／鄉鎮），比對出地理範圍相關的
   圖資來源 id。規則資料放在 data/source-map.json（SOURCE_MAP_RULES），
   這裡只是通用的規則解讀器：不再用一長串 if(county.includes(...))
   寫死縣市對應，新增/調整縣市對應時改 JSON 就好，不需要動這支函式。
--------------------------------------------------------- */
export function matchSourceIdsForAddress(addr){
  addr = addr || {};
  const county = (addr.county || addr.city || addr.state || '');
  const district = (addr.town || addr.city_district || addr.suburb || addr.village || '');
  const ids = new Set(SOURCE_MAP_RULES.alwaysInclude); // 全臺涵蓋來源，一律列入候選

  SOURCE_MAP_RULES.rules.forEach(rule => {
    const haystack = rule.match === 'county+district' ? (county + district) : county;
    const hit = rule.includes.some(k => haystack.includes(k));
    if(!hit) return;
    rule.sources.forEach(id => ids.add(id));

    if(rule.districtRule){
      const dr = rule.districtRule;
      const districtList = dr.includes || SOURCE_MAP_RULES.districtSets[dr.includesFromSet] || [];
      if(districtList.some(d => district.includes(d))){
        dr.sources.forEach(id => ids.add(id));
      }
    }
  });

  return Array.from(ids);
}

/* ---------------------------------------------------------
   文字比對候選圖層

   用途：像 thm（桃竹苗舊地籍圖）這種單一來源底下就有數百筆「堡→庄」圖層
   的資料，只靠 matchSourceIdsForAddress() 篩到「來源」還不夠，這裡再用
   Nominatim 回傳的鄉鎮／村里等地址元件，跟每個來源「內部」的圖層標題做
   純文字子字串比對，先篩出候選、減少要發送 file-exists 圖磚請求的筆數。

   注意：這不是地理邊界判斷（沒有用到任何向量圖資或座標運算），單純比對
   文字是否相符，新舊地名對不上時可能篩不出東西，因此一定要保留「完全沒
   命中就退回全部檢查」這個備援，避免因為文字比對誤判而漏掉真正有資料的
   圖層。
--------------------------------------------------------- */

// 常見的行政區／地籍圖名稱詞尾。比對前把這些詞尾去掉，取地名的核心字，
// 讓「新埔鎮」（現代行政區）跟「新埔街」（日治地籍圖標題）能對得上。
// 詞尾清單放在 data/historical-names.json 的 suffixes 欄位（PLACE_NAME_SUFFIXES）。
function stripPlaceNameSuffix(name){
  let s = (name || '').trim();
  // 只在還剩至少 2 個字的情況下才繼續去尾，避免把兩個字的地名（例如「五股」）
  // 誤砍到只剩 1 個字，變成比對什麼都會命中的無意義關鍵字。
  while(s.length > 2 && PLACE_NAME_SUFFIXES.includes(s[s.length - 1])){
    s = s.slice(0, -1);
  }
  return s;
}

// 從 Nominatim 回傳的地址元件中，取出可能對應到舊地名（堡、庄、街）的
// 關鍵字候選：鄉鎮市區、村里、鄰里等欄位都納入，因為地籍圖標題的「庄」
// 有時對應現在的鄉鎮（例如「新埔街」對「新埔鎮」），有時對應到村里
// （例如較小的聚落）。同時保留「去尾前」與「去尾後」兩種寫法，增加比對到
// 的機會；只留 2 個字以上的關鍵字，避免單一個字大量誤中。
//
// 除了動態去尾之外，也查 historical-names.json 的 aliases 對照表：
// 如果去尾前或去尾後的名稱剛好是對照表裡登記過的現代地名（例如
// 「竹北市」「竹北」），就把對照表裡登記的舊地名（例如「竹北二堡」）
// 也一併加進關鍵字，讓比對能命中完全對不上字面、100 年前的地名。
// 對照表不用做到逐庄，做到「堡」這種較粗的層級即可：堡名本來就包含在
// 每一筆圖層標題裡（例如「新竹廳竹北二堡塔仔脚庄」），命中堡名關鍵字
// 就會篩出該堡底下全部圖層，範圍雖然比逐庄篩選寬一點，但後面還有圖磚
// 探測把關，不會因此篩出錯誤結果，只是候選數量比逐庄篩選略多而已。
export function extractPlaceKeywords(addr){
  addr = addr || {};
  const rawFields = [addr.town, addr.city_district, addr.suburb, addr.village, addr.neighbourhood];
  const keywords = new Set();
  const aliases = (HISTORICAL_NAMES && HISTORICAL_NAMES.aliases) || {};
  rawFields.forEach(name=>{
    const trimmed = (name || '').trim();
    if(!trimmed) return;
    if(trimmed.length >= 2) keywords.add(trimmed);
    const stripped = stripPlaceNameSuffix(trimmed);
    if(stripped.length >= 2) keywords.add(stripped);

    // 對照表查詢：去尾前、去尾後的名稱都試著查一次
    [trimmed, stripped].forEach(name=>{
      const oldNames = aliases[name];
      if(oldNames) oldNames.forEach(old => keywords.add(old));
    });
  });
  return Array.from(keywords);
}

// 用地址關鍵字，從某個來源的候選圖層裡先篩出「標題包含關鍵字」的圖層。
// 找不到任何關鍵字，或關鍵字完全沒有命中任何標題時回傳 null，
// 呼叫端看到 null 就知道要退回「這個來源全部圖層都檢查」當備援。
export function prefilterLayersByPlaceName(sourceCandidates, keywords){
  if(!keywords || keywords.length === 0) return null;
  const matched = sourceCandidates.filter(c =>
    keywords.some(k => c.layer.title.includes(k))
  );
  return matched.length > 0 ? matched : null;
}
