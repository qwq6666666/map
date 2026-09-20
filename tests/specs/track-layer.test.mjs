import '../env-stub.mjs';
import { test, expect, beforeEach } from 'vitest';
import { map } from '../../src/core/map.js';
import {
  setTrackCoords, showTrack, hideTrack, isTrackShown, zoomToTrack, colorForTrack,
  TRACK_COLORS, _resetTrackLayerForTests
} from '../../src/features/trackLayer.js';

// 假視角：記下 fit() 的參數。
const fitCalls = [];
map.getView = () => ({ fit: (extent, opts) => fitCalls.push({ extent, opts }) });

const track = (id, segments) => ({ id, name: id, startedAt: 0, endedAt: 0, done: true, segments });
const P = (lon, lat) => [lon, lat, null, null];

beforeEach(() => {
  _resetTrackLayerForTests();
  fitCalls.length = 0;
});

test('圖層第一次用到才建立，並加到地圖上、蓋在歷史圖層之上但在繪圖圖層（50）之下', () => {
  showTrack(track('a', [[P(121, 25), P(121.1, 25.1)]]));
  const layer = map._layers.find((l) => l.opts?.zIndex === 49);
  expect(layer).toBeTruthy();
  expect(map._layers.filter((l) => l.opts?.zIndex === 49)).toHaveLength(1); // 再顯示別條也不會重複建立
  showTrack(track('b', [[P(122, 25), P(122.1, 25.1)]]));
  expect(map._layers.filter((l) => l.opts?.zIndex === 49)).toHaveLength(1);
});

test('顯示／隱藏／查詢：每條軌跡一個 feature，隱藏後真的從圖層移除', () => {
  const a = track('a', [[P(121, 25), P(121.1, 25.1)]]);
  expect(isTrackShown('a')).toBe(false);
  showTrack(a);
  expect(isTrackShown('a')).toBe(true);
  showTrack(a); // 重複顯示不會多出第二個 feature
  const layer = map._layers.find((l) => l.opts?.zIndex === 49);
  expect(layer.opts.source.getFeatures()).toHaveLength(1);
  hideTrack('a');
  expect(isTrackShown('a')).toBe(false);
  expect(layer.opts.source.getFeatures()).toHaveLength(0);
  hideTrack('a'); // 已經隱藏了，再隱藏不出錯
});

test('單點的段畫不成線，一律略過；setTrackCoords 更新既有 feature 而不是新增', () => {
  setTrackCoords('a', [[[1, 1]], [[2, 2], [3, 3]]]);
  const layer = map._layers.find((l) => l.opts?.zIndex === 49);
  const [feature] = layer.opts.source.getFeatures();
  expect(feature.getGeometry().getCoordinates()).toEqual([[[2, 2], [3, 3]]]);
  setTrackCoords('a', [[[2, 2], [3, 3], [4, 4]]]);
  expect(layer.opts.source.getFeatures()).toHaveLength(1);
  expect(feature.getGeometry().getCoordinates()).toEqual([[[2, 2], [3, 3], [4, 4]]]);
});

test('顏色依 id 固定挑選：同一個 id 永遠同色、且都落在色盤內，不同 id 大致分散', () => {
  expect(colorForTrack('t123')).toBe(colorForTrack('t123'));
  const seen = new Set();
  for(let i = 0; i < 40; i++){
    const c = colorForTrack(`t${i}`);
    expect(TRACK_COLORS).toContain(c);
    seen.add(c);
  }
  expect(seen.size).toBeGreaterThan(3);
  showTrack(track('t123', [[P(121, 25), P(121.1, 25.1)]]));
  const layer = map._layers.find((l) => l.opts?.zIndex === 49);
  expect(layer.opts.source.getFeatures()[0].get('color')).toBe(colorForTrack('t123'));
});

test('圖層樣式函式：依 feature 顏色回傳「白色外框＋顏色線」兩層，同色重用快取', () => {
  showTrack(track('a', [[P(121, 25), P(121.1, 25.1)]]));
  const layer = map._layers.find((l) => l.opts?.zIndex === 49);
  const feature = layer.opts.source.getFeatures()[0];
  const styles = layer.opts.style(feature);
  expect(styles).toHaveLength(2);
  expect(styles[0].opts.stroke.opts.color).toBe('#ffffff');
  expect(styles[1].opts.stroke.opts.color).toBe(feature.get('color'));
  expect(layer.opts.style(feature)).toBe(styles);
});

test('zoomToTrack：飛到涵蓋所有段的範圍，留邊界；沒有任何點回傳 false', () => {
  const t = track('a', [[P(121, 25), P(121.5, 25.2)], [P(120.5, 24.9), P(121, 25.5)]]);
  expect(zoomToTrack(t)).toBe(true);
  expect(fitCalls).toHaveLength(1);
  expect(fitCalls[0].extent).toEqual([120.5, 24.9, 121.5, 25.5]); // env-stub 的 fromLonLat 是 identity
  expect(fitCalls[0].opts.padding).toHaveLength(4);
  expect(fitCalls[0].opts.maxZoom).toBeLessThanOrEqual(18);

  expect(zoomToTrack(track('empty', []))).toBe(false);
  expect(fitCalls).toHaveLength(1);
});

test('zoomToTrack 的左邊界：桌面版展開的側邊欄不能蓋住軌跡；收合、手機版、量不到寬度時用一般邊界', () => {
  const t = track('a', [[P(121, 25), P(121.5, 25.2)]]);
  const sidebar = document.getElementById('sidebar');
  const realMatchMedia = globalThis.matchMedia;
  sidebar.classList.remove('collapsed');
  sidebar.getBoundingClientRect = () => ({ right: 356 });
  const leftOf = () => fitCalls.at(-1).opts.padding[3];
  try{
    zoomToTrack(t);
    expect(leftOf()).toBe(396); // 側邊欄右緣 356 + 40（env-stub 地圖寬 800，一半是 400，沒超過）

    sidebar.getBoundingClientRect = () => ({ right: 700 });
    zoomToTrack(t);
    expect(leftOf()).toBe(400); // 最多佔地圖寬度一半

    sidebar.getBoundingClientRect = () => ({ right: 356 });
    sidebar.classList.add('collapsed');
    zoomToTrack(t);
    expect(leftOf()).toBe(60);
    sidebar.classList.remove('collapsed');

    globalThis.matchMedia = () => ({ matches: true });
    zoomToTrack(t);
    expect(leftOf()).toBe(60); // 手機版側邊欄是底部 Sheet，不吃左邊界
  }finally{
    globalThis.matchMedia = realMatchMedia;
  }
});
