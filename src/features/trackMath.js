/* ---------------------------------------------------------
   features/trackMath.js — 軌跡記錄的純函式
   ---------------------------------------------------------
   不碰 DOM／地圖／IndexedDB，單元測試直接呼叫。資料模型：
     track = { id, name, startedAt, endedAt, done, segments }
     segments = 多段折線，每段是 [lon, lat, timestampMs, accuracyM] 的陣列。
   為什麼分「段」：螢幕鎖定、進隧道、重開頁面接續時定位會中斷，中斷前後
   直接連線會憑空多出一條穿牆的直線，所以中斷超過 TRACK_GAP_MS 就另起一段
   （GPX 的 <trkseg>、GeoJSON 的 MultiLineString 都原生支援）。
--------------------------------------------------------- */
import { haversineDistanceMeters } from './placeNames.js';

// 精度比這差的定位點不採用（室內／樹林／都市峽谷常見，畫出來會是鋸齒）。
export const TRACK_MAX_ACCURACY_M = 50;
// 原地不動時 GPS 仍會抖動，離上一個採用點太近就略過，避免軌跡糊成一團、
// 里程被抖動灌水。門檻隨精度放寬：精度越差，抖動範圍越大。
export const TRACK_MIN_STEP_M = 5;
// 兩點之間換算速度超過這個值（約 250 km/h）就是定位跳點，不是真的移動。
export const TRACK_MAX_SPEED_MPS = 70;
// 超過這麼久沒有可用的定位，就當成記錄中斷、另起一段。
export const TRACK_GAP_MS = 120000;

const pad2 = (n) => String(n).padStart(2, '0');

// 判斷一筆新定位要不要採用。回傳原因字串：
//   'ok'         採用（接在目前這一段後面）
//   'newSegment' 採用，但距離上次可用定位太久，要另起一段
//   'inaccurate' 精度太差
//   'still'      離上一個採用點太近（原地抖動）
//   'jump'       換算速度不合理（定位跳點）
// last：目前這一段最後一個採用的點（沒有＝null）；lastGoodT：最後一次「精度合格」
// 定位的時間（含被判 still 略過的）——用它算中斷，才不會在紅燈前站 3 分鐘就被切段。
export function classifyFix(last, lastGoodT, fix){
  const { accuracy, t } = fix;
  if(Number.isFinite(accuracy) && accuracy > TRACK_MAX_ACCURACY_M) return 'inaccurate';
  if(!last) return 'newSegment';
  if(Number.isFinite(lastGoodT) && t - lastGoodT > TRACK_GAP_MS) return 'newSegment';
  const dist = haversineDistanceMeters(last[0], last[1], fix.lon, fix.lat);
  const minStep = Math.max(TRACK_MIN_STEP_M, Number.isFinite(accuracy) ? accuracy / 2 : 0);
  if(dist < minStep) return 'still';
  const dt = (t - last[2]) / 1000;
  if(dt <= 0 || dist / dt > TRACK_MAX_SPEED_MPS) return 'jump';
  return 'ok';
}

export function segmentDistance(segment){
  let sum = 0;
  for(let i = 1; i < segment.length; i++){
    sum += haversineDistanceMeters(segment[i - 1][0], segment[i - 1][1], segment[i][0], segment[i][1]);
  }
  return sum;
}

export function trackDistance(track){
  return track.segments.reduce((sum, seg) => sum + segmentDistance(seg), 0);
}

export function trackPointCount(track){
  return track.segments.reduce((sum, seg) => sum + seg.length, 0);
}

// 有效經過時間（毫秒）：每一段自己的頭尾相減後加總，中斷期間不算。
export function trackDurationMs(track){
  return track.segments.reduce((sum, seg) => (
    seg.length > 1 ? sum + (seg[seg.length - 1][2] - seg[0][2]) : sum
  ), 0);
}

export function formatDistance(meters){
  if(!Number.isFinite(meters) || meters < 0) return '0 公尺';
  return meters < 1000 ? `${Math.round(meters)} 公尺` : `${(meters / 1000).toFixed(2)} 公里`;
}

export function formatDuration(ms){
  const totalMin = Math.max(0, Math.floor(ms / 60000));
  if(totalMin < 60) return `${totalMin} 分`;
  return `${Math.floor(totalMin / 60)} 小時 ${totalMin % 60} 分`;
}

// 預設軌跡名稱：「軌跡 2026-09-20 14:05」（本機時間）。
export function defaultTrackName(startedAt){
  const d = new Date(startedAt);
  return `軌跡 ${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// 檔名用的時間戳，跟 drawTool 的匯出檔名一致（YYYYMMDD_HHmm）。
export function trackFileStamp(startedAt){
  const d = new Date(startedAt);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

function escapeXml(text){
  return String(text).replace(/[<>&"']/g, (ch) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]
  ));
}

const iso = (ms) => new Date(ms).toISOString();

// GPX 1.1：戶外 App（Strava、Garmin、Gaia GPS、OsmAnd…）與 QGIS 都能讀。
// 每一段輸出成一個 <trkseg>，單點的段也照實輸出（不像 GeoJSON 的 LineString 有點數限制）。
export function trackToGpx(track){
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="百年歷史地圖" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <metadata><name>${escapeXml(track.name)}</name><time>${iso(track.startedAt)}</time></metadata>`,
    '  <trk>',
    `    <name>${escapeXml(track.name)}</name>`
  ];
  for(const seg of track.segments){
    if(!seg.length) continue;
    lines.push('    <trkseg>');
    for(const [lon, lat, t] of seg){
      lines.push(`      <trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"><time>${iso(t)}</time></trkpt>`);
    }
    lines.push('    </trkseg>');
  }
  lines.push('  </trk>', '</gpx>', '');
  return lines.join('\n');
}

// GeoJSON（EPSG:4326）：一個 Feature。單點的段畫不成線，略過；只剩一段就用
// LineString、多段用 MultiLineString。時間放在 coordinateProperties.times
// （togeojson 慣例），形狀與 coordinates 一一對應。
export function trackToGeoJSON(track){
  const segs = track.segments.filter((seg) => seg.length > 1);
  const coords = segs.map((seg) => seg.map(([lon, lat]) => [lon, lat]));
  const times = segs.map((seg) => seg.map(([, , t]) => iso(t)));
  const single = coords.length === 1;
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {
        name: track.name,
        startedAt: iso(track.startedAt),
        endedAt: track.endedAt ? iso(track.endedAt) : null,
        distanceMeters: Math.round(trackDistance(track)),
        coordinateProperties: { times: single ? times[0] : times }
      },
      geometry: single
        ? { type: 'LineString', coordinates: coords[0] }
        : { type: 'MultiLineString', coordinates: coords }
    }]
  };
}
