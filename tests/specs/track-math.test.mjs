import '../env-stub.mjs';
import { test, expect } from 'vitest';
import {
  classifyFix, segmentDistance, trackDistance, trackDurationMs, trackPointCount,
  formatDistance, formatDuration, defaultTrackName, trackFileStamp,
  trackToGpx, trackToGeoJSON, trackToDrawingGeoJSON, formatTrackDate,
  TRACK_MAX_ACCURACY_M, TRACK_GAP_MS
} from '../../src/features/trackMath.js';

const T0 = Date.UTC(2026, 8, 20, 6, 0, 0);
// 緯度 0.0005 度約 55 公尺
const P = (dLat, sec, acc = 10) => ({ lon: 121.5, lat: 25 + dLat, accuracy: acc, t: T0 + sec * 1000 });
const point = (dLat, sec) => [121.5, 25 + dLat, T0 + sec * 1000, 10];

/* ---------- classifyFix ---------- */

test('classifyFix：第一個點、沒有上一點時另起一段', () => {
  expect(classifyFix(null, NaN, P(0, 0))).toBe('newSegment');
});

test('classifyFix：精度超過門檻就不採用（即使沒有上一點）', () => {
  expect(classifyFix(null, NaN, P(0, 0, TRACK_MAX_ACCURACY_M + 1))).toBe('inaccurate');
  expect(classifyFix(point(0, 0), T0, P(0.0005, 30, 200))).toBe('inaccurate');
});

test('classifyFix：合理位移採用；原地抖動略過；門檻隨精度放寬', () => {
  const last = point(0, 0);
  expect(classifyFix(last, T0, P(0.0005, 30))).toBe('ok');
  expect(classifyFix(last, T0, P(0.00002, 5))).toBe('still'); // 約 2 公尺
  // 約 11 公尺：精度 10 時算移動，精度 40（門檻 20 公尺）時算抖動
  expect(classifyFix(last, T0, P(0.0001, 10, 10))).toBe('ok');
  expect(classifyFix(last, T0, P(0.0001, 10, 40))).toBe('still');
});

test('classifyFix：換算速度不合理是跳點；時間沒往前也是', () => {
  const last = point(0, 0);
  expect(classifyFix(last, T0, P(0.1, 10))).toBe('jump'); // 約 11 公里／10 秒
  expect(classifyFix(last, T0, P(0.0005, 0))).toBe('jump'); // dt = 0
});

test('classifyFix：太久沒有合格定位就另起一段；但「原地不動」的點也算有訊號', () => {
  const last = point(0, 0);
  expect(classifyFix(last, T0, P(0.0005, TRACK_GAP_MS / 1000 + 1))).toBe('newSegment');
  // 最後一筆合格定位是 60 秒前（原地站著被略過）：距離最後採用點雖久，仍是同一段
  expect(classifyFix(last, T0 + 200000, P(0.0005, 230))).toBe('ok');
});

/* ---------- 統計 ---------- */

const trackOf = (segments) => ({ id: 't1', name: '測試', startedAt: T0, endedAt: T0 + 600000, done: true, segments });

test('里程：各段內部相加，段與段之間不連線；點數與有效時間也同理', () => {
  const seg1 = [point(0, 0), point(0.0005, 60)];
  const seg2 = [point(0.01, 1000), point(0.0105, 1060)];
  expect(segmentDistance(seg1)).toBeGreaterThan(50);
  expect(segmentDistance(seg1)).toBeLessThan(60);
  const track = trackOf([seg1, seg2]);
  expect(trackDistance(track)).toBeCloseTo(segmentDistance(seg1) + segmentDistance(seg2), 6);
  expect(trackPointCount(track)).toBe(4);
  expect(trackDurationMs(track)).toBe(120000); // 兩段各 60 秒，中間的空檔不算
});

test('formatDistance／formatDuration', () => {
  expect(formatDistance(0)).toBe('0 公尺');
  expect(formatDistance(432.4)).toBe('432 公尺');
  expect(formatDistance(1234)).toBe('1.23 公里');
  expect(formatDistance(Number.NaN)).toBe('0 公尺');
  expect(formatDuration(0)).toBe('0 分');
  expect(formatDuration(34 * 60000)).toBe('34 分');
  expect(formatDuration(75 * 60000)).toBe('1 小時 15 分');
});

test('預設名稱與檔名時間戳用本機時間、格式固定', () => {
  expect(defaultTrackName(T0)).toMatch(/^軌跡 \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  expect(trackFileStamp(T0)).toMatch(/^\d{8}_\d{4}$/);
});

/* ---------- GPX ---------- */

test('GPX：每段一個 trkseg、經緯度七位小數、帶 ISO 時間；名稱做 XML 跳脫', () => {
  const track = trackOf([[point(0, 0), point(0.0005, 60)], [point(0.01, 1000)]]);
  track.name = '淡水 <老街> & "河岸"';
  const gpx = trackToGpx(track);
  expect(gpx.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  expect(gpx).toContain('<gpx version="1.1"');
  expect(gpx.match(/<trkseg>/g)).toHaveLength(2);
  expect(gpx.match(/<trkpt /g)).toHaveLength(3); // 單點的段照實輸出
  expect(gpx).toContain('<trkpt lat="25.0000000" lon="121.5000000"><time>2026-09-20T06:00:00.000Z</time></trkpt>');
  expect(gpx).toContain('淡水 &lt;老街&gt; &amp; &quot;河岸&quot;');
  expect(gpx).not.toContain('<老街>');
});

/* ---------- GeoJSON ---------- */

test('GeoJSON：只剩一段用 LineString，時間平的；多段用 MultiLineString，時間是巢狀', () => {
  const single = trackToGeoJSON(trackOf([[point(0, 0), point(0.0005, 60)]]));
  const f1 = single.features[0];
  expect(f1.geometry.type).toBe('LineString');
  expect(f1.geometry.coordinates).toEqual([[121.5, 25], [121.5, 25.0005]]);
  expect(f1.properties.coordinateProperties.times).toEqual(['2026-09-20T06:00:00.000Z', '2026-09-20T06:01:00.000Z']);
  expect(f1.properties.distanceMeters).toBeGreaterThan(50);

  const multi = trackToGeoJSON(trackOf([[point(0, 0), point(0.0005, 60)], [point(0.01, 1000), point(0.0105, 1060)]]));
  const f2 = multi.features[0];
  expect(f2.geometry.type).toBe('MultiLineString');
  expect(f2.geometry.coordinates).toHaveLength(2);
  expect(f2.properties.coordinateProperties.times[1]).toHaveLength(2);
});

test('GeoJSON：單點的段畫不成線，直接略過（不會把它變成只有一個座標的 LineString）', () => {
  const gj = trackToGeoJSON(trackOf([[point(0, 0), point(0.0005, 60)], [point(0.01, 1000)]]));
  expect(gj.features[0].geometry.type).toBe('LineString');
  expect(gj.features[0].geometry.coordinates).toHaveLength(2);
});

/* ---------- 匯入的軌跡沒有時間戳 ---------- */

const noTimes = () => ({
  id: 'i1', name: '匯入的', startedAt: T0, endedAt: T0, done: true, imported: true,
  segments: [[[121.5, 25, null, null], [121.5, 25.0005, null, null]]]
});

test('沒有時間戳：有效時間是 0、不會變成 NaN；GPX 不輸出 <time>；GeoJSON 不輸出 times', () => {
  const t = noTimes();
  expect(trackDurationMs(t)).toBe(0);
  const gpx = trackToGpx(t);
  expect(gpx).toContain('<trkpt lat="25.0000000" lon="121.5000000"></trkpt>');
  expect(gpx).not.toContain('1970');
  const props = trackToGeoJSON(t).features[0].properties;
  expect(props.coordinateProperties).toBeUndefined();
  expect(Number.isFinite(props.distanceMeters)).toBe(true);
});

test('只有部分點有時間：整條不輸出 times（陣列長度必須跟座標一一對應）', () => {
  const t = noTimes();
  t.segments[0][0][2] = T0;
  expect(trackToGeoJSON(t).features[0].properties.coordinateProperties).toBeUndefined();
});

test('formatTrackDate：本機時間 YYYY-MM-DD HH:mm', () => {
  expect(formatTrackDate(T0)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  expect(defaultTrackName(T0)).toBe(`軌跡 ${formatTrackDate(T0)}`);
});

/* ---------- 存成繪圖圖形 ---------- */

test('trackToDrawingGeoJSON：每一段一條 kind:line，帶顏色與「名稱（長度）」標籤；單點的段略過', () => {
  const track = trackOf([[point(0, 0), point(0.0005, 60)], [point(0.01, 1000), point(0.0105, 1060)], [point(0.02, 2000)]]);
  const fc = trackToDrawingGeoJSON(track, '#1971c2');
  expect(fc.features).toHaveLength(2);
  const [f1, f2] = fc.features;
  expect(f1.geometry.type).toBe('LineString');
  expect(f1.properties).toMatchObject({ kind: 'line', name: '測試 1', stroke: '#1971c2' });
  expect(f1.properties.label).toMatch(/^測試 1（\d+ 公尺）$/);
  expect(f2.properties.name).toBe('測試 2');
  const single = trackToDrawingGeoJSON(trackOf([[point(0, 0), point(0.0005, 60)]]), '#000');
  expect(single.features[0].properties.name).toBe('測試'); // 只有一段就不加序號
});
