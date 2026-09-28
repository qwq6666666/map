import '../env-stub.mjs';
import { test, expect, beforeEach } from 'vitest';
import { map } from '../../src/core/map.js';
import { showAccuracyCircle, hideAccuracyCircle, _resetAccuracyCircleForTests } from '../../src/features/locateAccuracyLayer.js';

beforeEach(() => {
  _resetAccuracyCircleForTests();
});

function findLayer(){
  return map._layers.find((l) => l.opts?.zIndex === 48);
}

test('圖層第一次用到才建立，且只建立一次', () => {
  showAccuracyCircle([100, 200], 50);
  expect(findLayer()).toBeTruthy();
  expect(map._layers.filter((l) => l.opts?.zIndex === 48)).toHaveLength(1);
  showAccuracyCircle([110, 210], 60);
  expect(map._layers.filter((l) => l.opts?.zIndex === 48)).toHaveLength(1);
});

test('重複呼叫原地更新同一個 feature 的中心點與半徑，不會累積出第二個圓', () => {
  showAccuracyCircle([100, 200], 50);
  const layer = findLayer();
  expect(layer.opts.source.getFeatures()).toHaveLength(1);
  showAccuracyCircle([300, 400], 80);
  expect(layer.opts.source.getFeatures()).toHaveLength(1);
  const geometry = layer.opts.source.getFeatures()[0].getGeometry();
  expect(geometry.getCenter()).toEqual([300, 400]);
  expect(geometry.getRadius()).toBe(80);
});

test('半徑 <= 0（沒有精度資訊）不畫圓；已經畫著的圓也會被收掉，不留舊資料誤導', () => {
  showAccuracyCircle([100, 200], 50);
  const layer = findLayer();
  expect(layer.opts.source.getFeatures()).toHaveLength(1);
  showAccuracyCircle([100, 200], 0);
  expect(layer.opts.source.getFeatures()).toHaveLength(0);
});

test('hideAccuracyCircle：手動隱藏，之後再顯示會是全新的 feature', () => {
  showAccuracyCircle([100, 200], 50);
  hideAccuracyCircle();
  const layer = findLayer();
  expect(layer.opts.source.getFeatures()).toHaveLength(0);
  showAccuracyCircle([100, 200], 50);
  expect(layer.opts.source.getFeatures()).toHaveLength(1);
});

test('hideAccuracyCircle：從未顯示過就呼叫不會噴例外', () => {
  expect(() => hideAccuracyCircle()).not.toThrow();
});
