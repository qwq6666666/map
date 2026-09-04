import '../env-stub.mjs';
import { test, run, assertTrue, assertEqual } from '../assert.mjs';
import { toTWD97, formatWGS84, formatTWD97 } from '../../src/core/tileGeo.js';
import { buildCoordInfoElement } from '../../src/features/search.js';

// 誤差容許：1 公尺以內（依任務需求的精度基準）
// 注意：toTWD97() 現已改為回傳四捨五入後的整數公尺（Math.round 過），
// 這裡的容許誤差判斷邏輯本身不受影響（整數與浮點期望值相減取絕對值
// 一樣成立），但期望值改用「四捨五入後」的整數，讓斷言訊息更直觀。
const TOLERANCE_M = 1;

function assertNear(actual, expected, tolerance, msg){
  const diff = Math.abs(actual - expected);
  assertTrue(diff <= tolerance, `${msg}：預期 ${expected}，實際 ${actual}，誤差 ${diff} 超過容許值 ${tolerance}`);
}

test('toTWD97：台北車站（25.0478, 121.5170）換算誤差在 1 公尺以內', () => {
  const { x, y } = toTWD97(25.0478, 121.5170);
  // toTWD97 現在回傳整數（已 Math.round），這裡直接用整數斷言是否為整數，
  // 並確認換算數值仍落在原始浮點精度的 1 公尺容許誤差內。
  assertEqual(Number.isInteger(x), true, 'x 應為整數（已 Math.round）');
  assertEqual(Number.isInteger(y), true, 'y 應為整數（已 Math.round）');
  assertNear(x, 302166.2268747693, TOLERANCE_M, 'Easting(x) 誤差過大');
  assertNear(y, 2771171.6410773, TOLERANCE_M, 'Northing(y) 誤差過大');
});

test('toTWD97：中央經線正上方（緯度 23.5, 經度 121.0）應貼近 False Easting 250000', () => {
  const { x, y } = toTWD97(23.5, 121.0);
  // 位於中央經線上時，理論上 Easting 應非常接近 False Easting 250000（無東西偏移）
  assertNear(x, 250000, TOLERANCE_M, 'Easting(x) 應接近 False Easting 250000');
  assertTrue(y > 0, 'Northing(y) 應為正值');
});

test('toTWD97：高雄（22.6273, 120.3014）換算結果應落在合理的 TWD97 平面座標範圍內', () => {
  const { x, y } = toTWD97(22.6273, 120.3014);
  // 台灣本島 TWD97 二分帶座標大致落在 x: 150000~350000，y: 2400000~2800000 之間
  assertTrue(x > 150000 && x < 350000, `Easting(x) 超出合理範圍：${x}`);
  assertTrue(y > 2400000 && y < 2800000, `Northing(y) 超出合理範圍：${y}`);
});

test('formatWGS84：台北車站（25.0478, 121.5170）格式化為「緯度°N/S, 經度°E/W」格式', () => {
  const str = formatWGS84(25.0478, 121.5170);
  assertTrue(/^\d{1,3}\.\d{4}°[NS], \d{1,3}\.\d{4}°[EW]$/.test(str), `格式不符：${str}`);
  assertEqual(str, '25.0478°N, 121.5170°E', '台北車站座標字串應完全相符');
});

test('formatWGS84：南半球、西半球座標應正確附加 S/W 後綴', () => {
  const str = formatWGS84(-25.1234, -121.5678);
  assertEqual(str, '25.1234°S, 121.5678°W', '負緯度應附加 S、負經度應附加 W');
});

test('formatTWD97：千分位逗號格式正確（302166, 2771172）', () => {
  const str = formatTWD97(302166, 2771172);
  assertEqual(str, 'X: 302,166, Y: 2,771,172', 'TWD97 字串千分位格式不符');
});

test('formatTWD97：小於千位數的座標不應多餘加上逗號', () => {
  const str = formatTWD97(999, 12345);
  assertEqual(str, 'X: 999, Y: 12,345', '千位以下不應有逗號、千位以上應正確分隔');
});

test('buildCoordInfoElement：回傳含 .coord-info 容器，內含 2 個 .coord-info-row，各自都有 .coord-copy-btn', () => {
  const lat = 25.0478;
  const lon = 121.5170;
  const el = buildCoordInfoElement(lat, lon);

  assertTrue(el.classList.contains('coord-info'), '容器節點應帶有 .coord-info class');

  const rows = el.querySelectorAll('.coord-info-row');
  assertEqual(rows.length, 2, '應包含 2 個 .coord-info-row（WGS84、TWD97 各一）');

  rows.forEach((row, i) => {
    const btns = row.querySelectorAll('.coord-copy-btn');
    assertEqual(btns.length, 1, `第 ${i + 1} 個 .coord-info-row 應包含 1 個 .coord-copy-btn`);
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
  assertTrue(htmlAll.includes(expectedWGS84), `應包含 WGS84 格式化字串：${expectedWGS84}`);
  assertTrue(htmlAll.includes(expectedTWD97), `應包含 TWD97 格式化字串：${expectedTWD97}`);
});

await run();
