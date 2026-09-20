/* ---------------------------------------------------------
   features/trackImport.js — 匯入 GPX／GeoJSON 軌跡（純函式）
   ---------------------------------------------------------
   不碰 DOM／地圖／儲存，單元測試直接呼叫。輸入是檔案文字，輸出是
   trackMath.js 定義的 track 物件陣列（一條 <trk>／<rte>／LineString Feature
   一條軌跡，每條可有多段）。
   GPX 刻意不用 DOMParser：測試環境（node）沒有，而且這裡只要撈 trk／rte／
   trkpt／rtept 幾種固定標籤，用正規表示式就夠、也不會被 XML 命名空間絆住
   （各家 App 匯出的 GPX 命名空間前綴五花八門）。
   匯入的檔案是不可信內容：名稱之後會顯示在畫面上（UI 一律用 textContent），
   座標超出範圍的點直接丟、總點數超過上限整個檔案拒絕，避免一個惡意／異常的
   大檔案把分頁拖垮。
--------------------------------------------------------- */
import { defaultTrackName } from './trackMath.js';

export const TRACK_IMPORT_MAX_BYTES = 15 * 1024 * 1024;
export const TRACK_IMPORT_MAX_POINTS = 300000;
const NAME_MAX_LENGTH = 60;

const validLonLat = (lon, lat) => (
  Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90
);

function decodeEntities(text){
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&'); // 放最後，避免把 &amp;lt; 解成 <
}

// 取標籤內文字（去 CDATA、解實體、修剪、截長）；沒有或空字串回傳 null。
function cleanText(raw){
  if(raw == null) return null;
  const text = decodeEntities(raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim();
  return text ? text.slice(0, NAME_MAX_LENGTH) : null;
}

function firstTag(xml, tag){
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1] : null;
}

function attr(attrs, name){
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'));
  return m ? Number(m[1]) : NaN;
}

// 從一段 XML 撈出所有 <ptTag ... lat lon>（含 <time>），回傳 [lon, lat, t|null, null] 陣列。
function parsePoints(xml, ptTag){
  const re = new RegExp(`<${ptTag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${ptTag}>)`, 'gi');
  const points = [];
  for(const m of xml.matchAll(re)){
    const lat = attr(m[1], 'lat');
    const lon = attr(m[1], 'lon');
    if(!validLonLat(lon, lat)) continue;
    const timeText = m[2] ? firstTag(m[2], 'time') : null;
    const t = timeText ? Date.parse(timeText.trim()) : NaN;
    points.push([lon, lat, Number.isFinite(t) ? t : null, null]);
  }
  return points;
}

// 同一毫秒內連續匯入多條（多檔、多條 <trk>）也不能撞 id，所以用模組層級序號。
let importSeq = 0;

// name 可能是 null（檔案沒給名稱）：由 parseTrackFile() 統一補上檔名或預設名稱。
function makeTrack(name, segments){
  const times = segments.flat().map((pt) => pt[2]).filter(Number.isFinite);
  const now = Date.now();
  const startedAt = times.length ? Math.min(...times) : now;
  return {
    id: `i${now}_${++importSeq}`,
    name,
    startedAt,
    endedAt: times.length ? Math.max(...times) : startedAt,
    done: true,
    imported: true,
    segments
  };
}

// 只留有兩個點以上的段（單點的段畫不成線、也沒有里程）。
const usableSegments = (segments) => segments.filter((seg) => seg.length > 1);

export function parseGpx(text){
  const src = text.replace(/<!--[\s\S]*?-->/g, '');
  const tracks = [];
  for(const m of src.matchAll(/<trk\b[^>]*>([\s\S]*?)<\/trk>/gi)){
    const body = m[1];
    const segments = [...body.matchAll(/<trkseg\b[^>]*>([\s\S]*?)<\/trkseg>/gi)]
      .map((s) => parsePoints(s[1], 'trkpt'));
    // <name> 要在 trkseg 之外找，避免撈到某個點自己的 <name>。
    const name = cleanText(firstTag(body.replace(/<trkseg\b[\s\S]*?<\/trkseg>/gi, ''), 'name'));
    const usable = usableSegments(segments);
    if(usable.length) tracks.push(makeTrack(name, usable));
  }
  for(const m of src.matchAll(/<rte\b[^>]*>([\s\S]*?)<\/rte>/gi)){
    const body = m[1];
    const name = cleanText(firstTag(body.replace(/<rtept\b[\s\S]*?<\/rtept>/gi, ''), 'name'));
    const usable = usableSegments([parsePoints(body, 'rtept')]);
    if(usable.length) tracks.push(makeTrack(name, usable));
  }
  return tracks;
}

function lonLatOf(coord){
  if(!Array.isArray(coord)) return null;
  const [lon, lat] = coord;
  return validLonLat(lon, lat) ? [lon, lat] : null;
}

// coordinateProperties.times（togeojson 慣例，也是本站匯出的格式）跟座標一一對應才採用。
function segmentFromLine(line, times){
  const useTimes = Array.isArray(times) && times.length === line.length;
  const seg = [];
  line.forEach((coord, i) => {
    const ll = lonLatOf(coord);
    if(!ll) return;
    const t = useTimes ? Date.parse(times[i]) : NaN;
    seg.push([ll[0], ll[1], Number.isFinite(t) ? t : null, null]);
  });
  return seg;
}

function collectFeatures(node, out){
  if(!node || typeof node !== 'object') return;
  if(node.type === 'FeatureCollection') (node.features || []).forEach((f) => collectFeatures(f, out));
  else if(node.type === 'Feature') out.push({ props: node.properties || {}, geometry: node.geometry });
  else if(node.type) out.push({ props: {}, geometry: node });
}

function linesOf(geometry){
  if(!geometry) return [];
  if(geometry.type === 'LineString') return [{ lines: [geometry.coordinates], multi: false }];
  if(geometry.type === 'MultiLineString') return [{ lines: geometry.coordinates, multi: true }];
  if(geometry.type === 'GeometryCollection') return (geometry.geometries || []).flatMap(linesOf);
  return []; // 點、面（含 Polygon）不是軌跡，略過
}

export function parseGeoJsonTracks(obj){
  const feats = [];
  collectFeatures(obj, feats);
  const tracks = [];
  for(const { props, geometry } of feats){
    for(const { lines, multi } of linesOf(geometry)){
      if(!Array.isArray(lines)) continue;
      const times = props.coordinateProperties?.times;
      const segments = usableSegments(lines.map((line, i) => (
        Array.isArray(line) ? segmentFromLine(line, multi ? times?.[i] : times) : []
      )));
      if(segments.length){
        const name = cleanText(typeof props.name === 'string' ? props.name : null);
        tracks.push(makeTrack(name, segments));
      }
    }
  }
  return tracks;
}

/**
 * 依內容判斷格式並解析。回傳 { tracks, error }（parseGpx／parseGeoJsonTracks 單獨呼叫時，
 * 檔案沒給名稱的軌跡 name 是 null，由這裡補上）：
 *   error 為 null 表示成功（tracks 至少一條）；否則是給使用者看的原因。
 * fileName 只用來當沒有名稱時的預設名稱（去副檔名）。
 */
export function parseTrackFile(fileName, text){
  if(typeof text !== 'string' || !text.trim()) return { tracks: [], error: '檔案是空的。' };
  const head = text.trimStart();
  let tracks;
  try{
    if(head.startsWith('<')) tracks = parseGpx(text);
    else if(head.startsWith('{')) tracks = parseGeoJsonTracks(JSON.parse(text));
    else return { tracks: [], error: '看不出檔案格式，目前支援 GPX 與 GeoJSON。' };
  }catch{
    return { tracks: [], error: '檔案內容無法解析，請確認是完整的 GPX 或 GeoJSON。' };
  }
  if(!tracks.length) return { tracks: [], error: '檔案裡找不到軌跡（需要至少含兩個點的路線；只有點或面的資料不會匯入）。' };
  const total = tracks.reduce((sum, t) => sum + t.segments.reduce((n, s) => n + s.length, 0), 0);
  if(total > TRACK_IMPORT_MAX_POINTS){
    return { tracks: [], error: `軌跡點數太多（${total.toLocaleString('zh-TW')} 個，上限 ${TRACK_IMPORT_MAX_POINTS.toLocaleString('zh-TW')}），請先在其他軟體簡化後再匯入。` };
  }
  // 檔案沒給名稱的軌跡：用檔名（多條加序號），連檔名都沒有就用預設名稱。
  const base = String(fileName || '').replace(/\.[^.]+$/, '').slice(0, NAME_MAX_LENGTH);
  tracks.forEach((t, i) => {
    if(t.name) return;
    if(base) t.name = tracks.length > 1 ? `${base} ${i + 1}` : base;
    else t.name = defaultTrackName(t.startedAt);
  });
  return { tracks, error: null };
}
