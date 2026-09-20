import '../env-stub.mjs';
import { test, expect } from 'vitest';
import {
  parseGpx, parseGeoJsonTracks, parseTrackFile, TRACK_IMPORT_MAX_POINTS
} from '../../src/features/trackImport.js';
import { trackToGpx, trackToGeoJSON, trackDistance } from '../../src/features/trackMath.js';

const T0 = Date.UTC(2026, 8, 20, 6, 0, 0);

const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Strava" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="x">
  <!-- <trk><trkseg><trkpt lat="1" lon="1"/><trkpt lat="2" lon="2"/></trkseg></trk> -->
  <metadata><name>不是軌跡名稱</name></metadata>
  <wpt lat="25.5" lon="121.5"><name>路標</name></wpt>
  <trk>
    <name><![CDATA[淡水 & 河岸 <早晨>]]></name>
    <trkseg>
      <trkpt lat="25.1000" lon="121.4000"><ele>10</ele><name>點名不該被撈到</name><time>2026-09-20T06:00:00Z</time></trkpt>
      <trkpt lon="121.4010" lat="25.1010"><time>2026-09-20T06:01:00Z</time></trkpt>
      <trkpt lat="25.1020" lon="121.4020"/>
    </trkseg>
    <trkseg>
      <trkpt lat="25.2" lon="121.5"><time>2026-09-20T07:00:00Z</time></trkpt>
      <trkpt lat="25.201" lon="121.501"><time>2026-09-20T07:01:00Z</time></trkpt>
    </trkseg>
  </trk>
</gpx>`;

/* ---------- GPX ---------- */

test('GPX：名稱（CDATA＋實體）、多段、屬性順序不拘、自閉合點、時間；註解與路標不誤撈', () => {
  const tracks = parseGpx(GPX);
  expect(tracks).toHaveLength(1);
  const t = tracks[0];
  expect(t.name).toBe('淡水 & 河岸 <早晨>');
  expect(t.segments.map((s) => s.length)).toEqual([3, 2]);
  expect(t.segments[0][1]).toEqual([121.401, 25.101, Date.UTC(2026, 8, 20, 6, 1, 0), null]);
  expect(t.segments[0][2][2]).toBe(null); // 沒有 <time> 的點
  expect(t.imported).toBe(true);
  expect(t.done).toBe(true);
  expect(t.startedAt).toBe(Date.UTC(2026, 8, 20, 6, 0, 0));
  expect(t.endedAt).toBe(Date.UTC(2026, 8, 20, 7, 1, 0));
});

test('GPX：<rte>／<rtept> 也當成一條軌跡；座標超出範圍的點丟掉；不到兩點的軌跡不收', () => {
  const gpx = `<gpx><rte><name>路線</name>
    <rtept lat="25" lon="121"/><rtept lat="999" lon="121"/><rtept lat="25.001" lon="121.001"/></rte>
    <trk><trkseg><trkpt lat="25" lon="121"/></trkseg></trk></gpx>`;
  const tracks = parseGpx(gpx);
  expect(tracks).toHaveLength(1);
  expect(tracks[0].name).toBe('路線');
  expect(tracks[0].segments[0]).toHaveLength(2);
});

test('GPX：連續匯入的軌跡 id 不會重複（即使同一毫秒）', () => {
  const ids = [...parseGpx(GPX), ...parseGpx(GPX), ...parseGpx(GPX)].map((t) => t.id);
  expect(new Set(ids).size).toBe(3);
});

/* ---------- GeoJSON ---------- */

test('GeoJSON：LineString／MultiLineString／FeatureCollection／裸幾何都能讀；點與面略過', () => {
  const fc = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { name: 'A' }, geometry: { type: 'LineString', coordinates: [[121, 25], [121.001, 25.001, 30]] } },
      { type: 'Feature', properties: { name: 'B' }, geometry: { type: 'MultiLineString', coordinates: [[[121, 25], [121.001, 25]], [[122, 25], [122.001, 25]]] } },
      { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [121, 25] } },
      { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }
    ]
  };
  const tracks = parseGeoJsonTracks(fc);
  expect(tracks.map((t) => t.name)).toEqual(['A', 'B']);
  expect(tracks[1].segments).toHaveLength(2);
  expect(tracks[0].segments[0][1]).toEqual([121.001, 25.001, null, null]); // 第三個值（海拔）不收

  expect(parseGeoJsonTracks({ type: 'LineString', coordinates: [[121, 25], [121.1, 25.1]] })).toHaveLength(1);
  expect(parseGeoJsonTracks({ type: 'GeometryCollection', geometries: [{ type: 'LineString', coordinates: [[1, 1], [2, 2]] }] })).toHaveLength(1);
});

test('GeoJSON：本站匯出的檔案匯回來，座標、時間、名稱、里程都一致（來回不失真）', () => {
  const original = {
    id: 't1', name: '晨跑 <1>', startedAt: T0, endedAt: T0 + 120000, done: true,
    segments: [
      [[121.5, 25, T0, 10], [121.5, 25.0005, T0 + 30000, 10]],
      [[121.6, 25.1, T0 + 90000, 10], [121.6, 25.1005, T0 + 120000, 10]]
    ]
  };
  const back = parseGeoJsonTracks(JSON.parse(JSON.stringify(trackToGeoJSON(original))))[0];
  expect(back.name).toBe('晨跑 <1>');
  expect(back.segments.map((s) => s.map(([lon, lat, t]) => [lon, lat, t])))
    .toEqual(original.segments.map((s) => s.map(([lon, lat, t]) => [lon, lat, t])));
  expect(trackDistance(back)).toBeCloseTo(trackDistance(original), 6);
});

test('GPX：本站匯出的檔案匯回來，一樣來回不失真', () => {
  const original = {
    id: 't1', name: '傍晚散步 & 拍照', startedAt: T0, endedAt: T0 + 60000, done: true,
    segments: [[[121.5, 25, T0, 10], [121.5, 25.0005, T0 + 60000, 10]]]
  };
  const back = parseGpx(trackToGpx(original))[0];
  expect(back.name).toBe('傍晚散步 & 拍照');
  expect(back.segments[0].map(([lon, lat, t]) => [lon, lat, t])).toEqual([[121.5, 25, T0], [121.5, 25.0005, T0 + 60000]]);
});

test('GeoJSON：times 長度跟座標對不上就不採用（不能讓時間錯位）', () => {
  const t = parseGeoJsonTracks({
    type: 'Feature',
    properties: { coordinateProperties: { times: ['2026-09-20T06:00:00Z'] } },
    geometry: { type: 'LineString', coordinates: [[121, 25], [121.001, 25.001]] }
  })[0];
  expect(t.segments[0].map((p) => p[2])).toEqual([null, null]);
});

/* ---------- parseTrackFile ---------- */

test('parseTrackFile：依內容判斷格式；沒給名稱用檔名（多條加序號）', () => {
  const noName = '<gpx><trk><trkseg><trkpt lat="25" lon="121"/><trkpt lat="25.001" lon="121.001"/></trkseg></trk></gpx>';
  const r1 = parseTrackFile('週末登山.gpx', noName);
  expect(r1.error).toBe(null);
  expect(r1.tracks[0].name).toBe('週末登山');

  const two = { type: 'FeatureCollection', features: [1, 2].map(() => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[1, 1], [2, 2]] } })) };
  const r2 = parseTrackFile('two.geojson', JSON.stringify(two));
  expect(r2.tracks.map((t) => t.name)).toEqual(['two 1', 'two 2']);

  expect(parseTrackFile('', noName).tracks[0].name).toMatch(/^軌跡 \d{4}-/); // 連檔名都沒有
  expect(parseTrackFile('x.gpx', GPX).tracks[0].name).toBe('淡水 & 河岸 <早晨>'); // 有名稱就不被檔名蓋掉
});

test('parseTrackFile：各種壞檔案回傳給使用者看的原因，不丟例外', () => {
  expect(parseTrackFile('a.gpx', '').error).toContain('空的');
  expect(parseTrackFile('a.txt', 'hello world').error).toContain('格式');
  expect(parseTrackFile('a.json', '{ not json').error).toContain('無法解析');
  expect(parseTrackFile('a.gpx', '<gpx><wpt lat="1" lon="1"/></gpx>').error).toContain('找不到軌跡');
  expect(parseTrackFile('a.json', '{"type":"Point","coordinates":[1,1]}').error).toContain('找不到軌跡');
  expect(parseTrackFile('a.json', null).error).toContain('空的');
});

test('parseTrackFile：點數超過上限整個拒絕（避免拖垮分頁）', () => {
  const coords = Array.from({ length: TRACK_IMPORT_MAX_POINTS + 1 }, (_, i) => [121 + i * 1e-6, 25]);
  const r = parseTrackFile('big.json', JSON.stringify({ type: 'LineString', coordinates: coords }));
  expect(r.tracks).toEqual([]);
  expect(r.error).toContain('點數太多');
});

test('名稱會被截到 60 字以內（不可信內容不能無限長）', () => {
  const gpx = `<gpx><trk><name>${'長'.repeat(500)}</name><trkseg><trkpt lat="25" lon="121"/><trkpt lat="25.1" lon="121.1"/></trkseg></trk></gpx>`;
  expect(parseGpx(gpx)[0].name).toHaveLength(60);
});
