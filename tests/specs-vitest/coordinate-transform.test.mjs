import '../env-stub.mjs';
import { test, expect } from 'vitest';
import { toTWD97, formatWGS84, formatTWD97, tileXYToBbox, lonLatToTileXY, pointInBbox, bboxIntersects } from '../../src/core/tileGeo.js';
import { buildCoordInfoElement } from '../../src/features/search.js';

// 誤差容許：1 公尺以內（依任務需求的精度基準）
// 注意：toTWD97() 現已改為回傳四捨五入後的整數公尺（Math.round 過），
// 這裡的容許誤差判斷邏輯本身不受影響（整數與浮點期望值相減取絕對值
// 一樣成立），但期望值改用「四捨五入後」的整數，讓斷言訊息更直觀。
const TOLERANCE_M = 1;

function assertNear(actual, expected, tolerance, msg){
  const diff = Math.abs(actual - expected);
  expect(diff <= tolerance, `${msg}：預期 ${expected}，實際 ${actual}，誤差 ${diff} 超過容許值 ${tolerance}`).toBeTruthy();
}

test('toTWD97：台北車站（25.0478, 121.5170）換算誤差在 1 公尺以內', () => {
  const { x, y } = toTWD97(25.0478, 121.5170);
  // toTWD97 現在回傳整數（已 Math.round），這裡直接用整數斷言是否為整數，
  // 並確認換算數值仍落在原始浮點精度的 1 公尺容許誤差內。
  expect(Number.isInteger(x), 'x 應為整數（已 Math.round）').toBe(true);
  expect(Number.isInteger(y), 'y 應為整數（已 Math.round）').toBe(true);
  assertNear(x, 302166.2268747693, TOLERANCE_M, 'Easting(x) 誤差過大');
  assertNear(y, 2771171.6410773, TOLERANCE_M, 'Northing(y) 誤差過大');
});

test('toTWD97：中央經線正上方（緯度 23.5, 經度 121.0）應貼近 False Easting 250000', () => {
  const { x, y } = toTWD97(23.5, 121.0);
  // 位於中央經線上時，理論上 Easting 應非常接近 False Easting 250000（無東西偏移）
  assertNear(x, 250000, TOLERANCE_M, 'Easting(x) 應接近 False Easting 250000');
  expect(y > 0, 'Northing(y) 應為正值').toBeTruthy();
});

test('toTWD97：高雄（22.6273, 120.3014）換算結果應落在合理的 TWD97 平面座標範圍內', () => {
  const { x, y } = toTWD97(22.6273, 120.3014);
  // 台灣本島 TWD97 二分帶座標大致落在 x: 150000~350000，y: 2400000~2800000 之間
  expect(x > 150000 && x < 350000, `Easting(x) 超出合理範圍：${x}`).toBeTruthy();
  expect(y > 2400000 && y < 2800000, `Northing(y) 超出合理範圍：${y}`).toBeTruthy();
});

test('formatWGS84：台北車站（25.0478, 121.5170）格式化為「緯度°N/S, 經度°E/W」格式', () => {
  const str = formatWGS84(25.0478, 121.5170);
  expect(/^\d{1,3}\.\d{4}°[NS], \d{1,3}\.\d{4}°[EW]$/.test(str), `格式不符：${str}`).toBeTruthy();
  expect(str, '台北車站座標字串應完全相符').toBe('25.0478°N, 121.5170°E');
});

test('formatWGS84：南半球、西半球座標應正確附加 S/W 後綴', () => {
  const str = formatWGS84(-25.1234, -121.5678);
  expect(str, '負緯度應附加 S、負經度應附加 W').toBe('25.1234°S, 121.5678°W');
});

test('formatTWD97：千分位逗號格式正確（302166, 2771172）', () => {
  const str = formatTWD97(302166, 2771172);
  expect(str, 'TWD97 字串千分位格式不符').toBe('X: 302,166, Y: 2,771,172');
});

test('formatTWD97：小於千位數的座標不應多餘加上逗號', () => {
  const str = formatTWD97(999, 12345);
  expect(str, '千位以下不應有逗號、千位以上應正確分隔').toBe('X: 999, Y: 12,345');
});

test('buildCoordInfoElement：回傳含 .coord-info 容器，內含 2 個 .coord-info-row，各自都有 .coord-copy-btn', () => {
  const lat = 25.0478;
  const lon = 121.5170;
  const el = buildCoordInfoElement(lat, lon);

  expect(el.classList.contains('coord-info'), '容器節點應帶有 .coord-info class').toBeTruthy();

  const rows = el.querySelectorAll('.coord-info-row');
  expect(rows.length, '應包含 2 個 .coord-info-row（WGS84、TWD97 各一）').toBe(2);

  rows.forEach((row, i) => {
    const btns = row.querySelectorAll('.coord-copy-btn');
    expect(btns.length, `第 ${i + 1} 個 .coord-info-row 應包含 1 個 .coord-copy-btn`).toBe(1);
  });
});

test('buildCoordInfoElement：內容包含正確換算後的 WGS84／TWD97 座標數值', () => {
  const lat = 25.0478;
  const lon = 121.5170;
  const el = buildCoordInfoElement(lat, lon);

  const expectedWGS84 = formatWGS84(lat, lon);
  const { x, y } = toTWD97(lat, lon);
  const expectedTWD97 = formatTWD97(x, y);

  const rows = el.querySelectorAll('.coord-info-row');
  // 測試環境的假 DOM（tests/env-stub.mjs）不會把 innerHTML 字串解析回
  // 真正的子節點樹，因此這裡直接檢查各列的 innerHTML 原始字串是否包含
  // 換算後的座標文字，而不是依賴 textContent（在假 DOM 底下不會反映
  // innerHTML 賦值的內容）。
  const htmlAll = rows.map(row => row.innerHTML).join('\n');
  expect(htmlAll.includes(expectedWGS84), `應包含 WGS84 格式化字串：${expectedWGS84}`).toBeTruthy();
  expect(htmlAll.includes(expectedTWD97), `應包含 TWD97 格式化字串：${expectedTWD97}`).toBeTruthy();
});

/* ---------------------------------------------------------
   tileXYToBbox：lonLatToTileXY 的反函式
--------------------------------------------------------- */
test('tileXYToBbox：算出的 bbox 應該包住原始經緯度（跟 lonLatToTileXY 互為反函式）', () => {
  const z = 15;
  const lon = 121.5654, lat = 25.0330; // 台北市中心
  const tile = lonLatToTileXY(lon, lat, z);
  const bbox = tileXYToBbox(tile.x, tile.y, tile.z);

  expect(bbox.length, 'bbox 應該是長度 4 的陣列').toBe(4);
  expect(pointInBbox(lon, lat, bbox), '算出的 bbox 應該包住原始經緯度').toBeTruthy();
  expect(bbox[0] < bbox[2], 'minLon 應小於 maxLon').toBeTruthy();
  expect(bbox[1] < bbox[3], 'minLat 應小於 maxLat').toBeTruthy();
});

test('tileXYToBbox：世界地圖邊緣圖磚（x=0、z=0）不應出現 NaN 或 Infinity', () => {
  const bbox = tileXYToBbox(0, 0, 0);
  bbox.forEach(v => expect(Number.isFinite(v), `bbox 元素應為有限數字，實際 ${v}`).toBeTruthy());
  expect(bbox[0] >= -180 && bbox[2] <= 180, `經度應落在 -180~180 範圍內，實際 ${JSON.stringify(bbox)}`).toBeTruthy();
});

test('tileXYToBbox：z=0 唯一一顆圖磚應涵蓋全世界經度範圍 -180~180', () => {
  const bbox = tileXYToBbox(0, 0, 0);
  assertNear(bbox[0], -180, 1e-9, 'minLon 應為 -180');
  assertNear(bbox[2], 180, 1e-9, 'maxLon 應為 180');
});

test('lonLatToTileXY：緯度超出 Web Mercator 有效範圍（接近或超過 ±90 度）不應出現 NaN，會被夾回合法範圍計算', () => {
  const nearNorthPole = lonLatToTileXY(121, 89.9, 5);
  const northPole = lonLatToTileXY(121, 90, 5);
  const southPole = lonLatToTileXY(121, -90, 5);
  [nearNorthPole, northPole, southPole].forEach(t => {
    expect(Number.isFinite(t.x) && Number.isFinite(t.y), `x/y 應為有限數字，實際 ${JSON.stringify(t)}`).toBeTruthy();
  });
  // 超過 Web Mercator 上限（85.05112878）的緯度應該被夾回上限計算，
  // 所以「剛好在上限附近」跟「明顯超過上限（含剛好 90 度）」應該算出
  // 同一顆圖磚，不會因為夾值前的原始緯度不同而得到不同結果。
  const atLimit = lonLatToTileXY(121, 85.05112878, 5);
  expect(`${northPole.x},${northPole.y}`, '超過 Mercator 緯度上限應該被夾回上限，等同直接算上限緯度').toBe(`${atLimit.x},${atLimit.y}`);
});

test('lonLatToTileXY：非有限數字輸入（NaN/Infinity）不應出現 NaN，會退回安全預設值', () => {
  const cases = [
    lonLatToTileXY(NaN, 25, 10),
    lonLatToTileXY(121, NaN, 10),
    lonLatToTileXY(Infinity, 25, 10),
    lonLatToTileXY(121, -Infinity, 10),
  ];
  cases.forEach(t => {
    expect(Number.isFinite(t.x) && Number.isFinite(t.y), `x/y 應為有限數字，實際 ${JSON.stringify(t)}`).toBeTruthy();
  });
});

test('pointInBbox／bboxIntersects：minLon>maxLon 代表跨越國際換日線的合法範圍，不是方向顛倒的錯誤資料', () => {
  const antimeridianBbox = [170, -10, -170, 10]; // 橫跨 180 度經線，涵蓋東經 170~180 與西經 180~170
  expect(pointInBbox(175, 0, antimeridianBbox), '東經 175 應落在跨換日線 bbox 內').toBeTruthy();
  expect(pointInBbox(-175, 0, antimeridianBbox), '西經 175（即 -175）應落在跨換日線 bbox 內').toBeTruthy();
  expect(!pointInBbox(0, 0, antimeridianBbox), '經度 0 明顯不在跨換日線 bbox 的涵蓋範圍內，應為 false').toBeTruthy();

  const overlapping = [175, -5, 179, 5]; // 完全落在東經那一段子區間內
  const nonOverlapping = [0, -5, 10, 5]; // 完全落在涵蓋範圍外
  expect(bboxIntersects(antimeridianBbox, overlapping), '跟東經那一段子區間重疊，應該回傳 true').toBeTruthy();
  expect(!bboxIntersects(antimeridianBbox, nonOverlapping), '完全落在涵蓋範圍外，應該回傳 false').toBeTruthy();
});

test('pointInBbox／bboxIntersects：minLat>maxLat 是緯度方向顛倒的錯誤資料（緯度沒有跨界的合法情況），一律 fallback true 不排除', () => {
  const invertedLatBbox = [119, 26, 123, 21]; // minLat(26) > maxLat(21)，緯度上下界顛倒
  expect(pointInBbox(121, 23, invertedLatBbox), 'minLat>maxLat 視為格式不合法，應該 fallback 為 true').toBeTruthy();
  expect(bboxIntersects(invertedLatBbox, [119, 21, 123, 26]), 'minLat>maxLat 視為格式不合法，應該 fallback 為 true').toBeTruthy();
});
