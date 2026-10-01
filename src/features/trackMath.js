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
// 匯入的檔案不一定有時間戳，缺時間的段不算（整條都沒有就是 0）。
export function trackDurationMs(track){
  return track.segments.reduce((sum, seg) => {
    if(seg.length < 2) return sum;
    const span = seg[seg.length - 1][2] - seg[0][2];
    return Number.isFinite(span) && span > 0 ? sum + span : sum;
  }, 0);
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

// 「2026-09-20 14:05」（本機時間）。
export function formatTrackDate(ms){
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// 預設軌跡名稱：「軌跡 2026-09-20 14:05」。
export function defaultTrackName(startedAt){
  return `軌跡 ${formatTrackDate(startedAt)}`;
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
const timeTag = (t) => (Number.isFinite(t) ? `<time>${iso(t)}</time>` : '');

// GPX 1.1：戶外 App（Strava、Garmin、Gaia GPS、OsmAnd…）與 QGIS 都能讀。
// 每一段輸出成一個 <trkseg>，單點的段也照實輸出（不像 GeoJSON 的 LineString 有點數限制）。
// 沒有時間戳的點（匯入的檔案）不輸出 <time>，不要編造 1970 年。
export function trackToGpx(track){
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="百年歷史地圖" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <metadata><name>${escapeXml(track.name)}</name>${timeTag(track.startedAt)}</metadata>`,
    '  <trk>',
    `    <name>${escapeXml(track.name)}</name>`
  ];
  for(const seg of track.segments){
    if(!seg.length) continue;
    lines.push('    <trkseg>');
    for(const [lon, lat, t] of seg){
      lines.push(`      <trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}">${timeTag(t)}</trkpt>`);
    }
    lines.push('    </trkseg>');
  }
  lines.push('  </trk>', '</gpx>', '');
  return lines.join('\n');
}

// GeoJSON（EPSG:4326）：一個 Feature。單點的段畫不成線，略過；只剩一段就用
// LineString、多段用 MultiLineString。時間放在 coordinateProperties.times
// （togeojson 慣例），形狀與 coordinates 一一對應。
// 若整條軌跡沒有任何可畫成線的段（例如兩段各只有 1 個點——trackPointCount()
// 算的是總點數、不分段，trackExport.js 匯出前的「總點數 < 2」門檻擋不到
// 這種情況），回傳空 FeatureCollection，不要硬生出一個 coordinates:[] 的
// MultiLineString——那不是合法的線幾何，QGIS／GDAL／turf.js 等下游工具
// 讀到很可能直接報錯或整檔匯入失敗，使用者在匯出當下卻看不到任何提示
// （這裡不丟例外）。
export function trackToGeoJSON(track){
  const segs = track.segments.filter((seg) => seg.length > 1);
  if(segs.length === 0) return { type: 'FeatureCollection', features: [] };
  const coords = segs.map((seg) => seg.map(([lon, lat]) => [lon, lat]));
  // 只要有任何一個點沒有時間，整條就不輸出 times（陣列長度必須跟座標一一對應）。
  const hasTimes = segs.length > 0 && segs.every((seg) => seg.every((pt) => Number.isFinite(pt[2])));
  const times = hasTimes ? segs.map((seg) => seg.map(([, , t]) => iso(t))) : null;
  const single = coords.length === 1;
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {
        name: track.name,
        startedAt: Number.isFinite(track.startedAt) ? iso(track.startedAt) : null,
        endedAt: Number.isFinite(track.endedAt) ? iso(track.endedAt) : null,
        distanceMeters: Math.round(trackDistance(track)),
        ...(times ? { coordinateProperties: { times: single ? times[0] : times } } : {})
      },
      geometry: single
        ? { type: 'LineString', coordinates: coords[0] }
        : { type: 'MultiLineString', coordinates: coords }
    }]
  };
}

// 「沿途百年導覽」預設取樣點數：上限 5 顆，太多清單會跟手機螢幕寬度打架
// （ui/trackListUI.js 用一排可以直接點的小按鈕呈現，不是下拉選單）。
export const TRACK_TOUR_MAX_SAMPLES = 5;

// 「沿途百年導覽」取樣：依累積距離大致平均，從軌跡實際走過的點裡（不內插）
// 挑幾個出來，供 ui/trackListUI.js 的「沿途歷史」清單串接
// timelineMode.js 的 startLocationTour(lon, lat) 使用。
//
// 多段軌跡（segments）視為依序串接的同一條路徑：段與段之間的距離跳躍不計入
// 累積距離——那是訊號中斷造成的空檔（見檔頭 TRACK_GAP_MS 說明），不是使用者
// 真的走過的路，算進去會讓取樣點的間距失真。
//
// 刻意不內插出軌跡上原本不存在的座標：GPS 定位點本身已經有量測誤差，內插
// 出來的「理論座標」沒有比最近的實際定位點更準，徒增複雜度；直接挑「離目標
// 累積距離最近的那個實際點」，點數不足時自然跟著變少，不會無中生有。
//
// @param {object} track
// @param {object} [options]
// @param {number} [options.maxPoints] 最多取幾個點（實際點數不足時會更少）。
// @returns {Array<{lon:number, lat:number, distanceM:number}>} distanceM 是
//   這個點距離軌跡起點的累積距離（公尺），供呼叫端標示「距起點 850 公尺」。
//   軌跡完全沒有點時回傳空陣列。
export function sampleTrackPointsForTour(track, { maxPoints = TRACK_TOUR_MAX_SAMPLES } = {}){
  const points = []; // { lon, lat, distanceM }
  let cumulative = 0;
  track.segments.forEach((seg) => {
    seg.forEach((pt, i) => {
      if(i > 0) cumulative += haversineDistanceMeters(seg[i - 1][0], seg[i - 1][1], pt[0], pt[1]);
      points.push({ lon: pt[0], lat: pt[1], distanceM: cumulative });
    });
  });
  if(points.length === 0) return [];
  if(points.length === 1 || maxPoints <= 1) return [points[0]];

  const totalDistance = points[points.length - 1].distanceM;
  const sampleCount = Math.min(maxPoints, points.length);

  // 每個目標累積距離（0、1/(n-1)、2/(n-1)…、1 倍總距離），找離它最近的實際點。
  // points 本身已經依累積距離遞增排序（逐段逐點建立），可以用單調遞增的
  // 指標往前掃，不用每個目標都重新線性搜尋整個陣列。
  const result = [];
  let idx = 0;
  for(let i = 0; i < sampleCount; i++){
    const target = (totalDistance * i) / (sampleCount - 1);
    while(idx < points.length - 1 && points[idx + 1].distanceM <= target) idx++;
    const candidate = (idx + 1 < points.length && Math.abs(points[idx + 1].distanceM - target) < Math.abs(points[idx].distanceM - target))
      ? points[idx + 1]
      : points[idx];
    result.push(candidate);
  }

  // 短軌跡、或目標距離很接近時可能挑到同一個實際點，去重（維持原順序）。
  const seen = new Set();
  return result.filter((p) => {
    const key = `${p.lon.toFixed(6)},${p.lat.toFixed(6)},${p.distanceM.toFixed(1)}`;
    if(seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// 「存成繪圖圖形」：轉成繪圖工具（drawTool.js importGeoJSON）認得的 FeatureCollection——
// 每一段一條線（kind:'line'），帶 SimpleStyle 顏色與「名稱（長度）」標籤，之後就是
// 一般的繪圖線條，可以編輯、改色、隨繪圖一起匯出。單點的段略過。
export function trackToDrawingGeoJSON(track, color){
  const segs = track.segments.filter((seg) => seg.length > 1);
  return {
    type: 'FeatureCollection',
    features: segs.map((seg, i) => {
      const name = segs.length > 1 ? `${track.name} ${i + 1}` : track.name;
      return {
        type: 'Feature',
        properties: {
          kind: 'line',
          name,
          label: `${name}（${formatDistance(segmentDistance(seg))}）`,
          stroke: color,
          'stroke-width': 3,
          'stroke-opacity': 0.8
        },
        geometry: { type: 'LineString', coordinates: seg.map(([lon, lat]) => [lon, lat]) }
      };
    })
  };
}
