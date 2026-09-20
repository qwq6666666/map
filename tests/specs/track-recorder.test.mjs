import '../env-stub.mjs';
import { test, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { runtime } from '../../src/runtime.js';

// 假 geolocation：記下 watchPosition 的成功回呼，測試用 feed() 餵定位。
let watchCalls = 0;
let fixCb;
navigator.geolocation = {
  watchPosition(success){ watchCalls++; fixCb = success; return 7; },
  clearWatch(){},
  getCurrentPosition(){}
};

// env-stub 沒有 ol.Feature／ol.geom：補最小假物件，讓記錄器的折線圖層跑得起來。
class FakeGeom { constructor(c){ this.coords = c; } setCoordinates(c){ this.coords = c; } }
globalThis.ol.geom = { MultiLineString: FakeGeom };
globalThis.ol.Feature = class { constructor(g){ this.geom = g; } getGeometry(){ return this.geom; } };

import { initLocateButton, getTrackState } from '../../src/features/location.js';
import {
  initTrackRecorder, startRecording, stopRecording, resumeRecording, finishSavedTrack,
  discardTrack, getTrackStatus, getCurrentTrack, onTrackChange, _resetTrackRecorderForTests
} from '../../src/features/trackRecorder.js';
import { loadTrack, loadLatestTrack, saveTrack, _resetTrackStoreForTests } from '../../src/features/trackStore.js';
import { TRACK_GAP_MS } from '../../src/features/trackMath.js';

initLocateButton();
const trackBtn = document.getElementById('trackBtn');

const T0 = Date.UTC(2026, 8, 20, 6, 0, 0);
// 緯度 0.0005 度約 55 公尺。sec 是相對 T0 的秒數。
const feed = (dLat, sec, acc = 10) => fixCb({
  coords: { latitude: 25 + dLat, longitude: 121.5, accuracy: acc },
  timestamp: T0 + sec * 1000
});
const segs = () => getCurrentTrack().segments;
const lens = () => segs().map((s) => s.length);

beforeAll(async () => { await initTrackRecorder(); });

beforeEach(() => {
  if(getTrackState() === 'paused') trackBtn.click();
  if(getTrackState() === 'following') trackBtn.click(); // 會通知記錄器「追蹤停止」
  _resetTrackRecorderForTests();
  _resetTrackStoreForTests();
  watchCalls = 0;
});

afterAll(() => {
  if(runtime.locateToastTimer) clearTimeout(runtime.locateToastTimer);
});

test('開始記錄：沒在追蹤就幫忙開啟持續追蹤；已經在追蹤則不重複開', () => {
  startRecording();
  expect(getTrackStatus().recording).toBe(true);
  expect(getTrackState()).toBe('following');
  expect(watchCalls).toBe(1);

  stopRecording();
  startRecording(); // 追蹤本來就開著（結束記錄不會停追蹤）
  expect(watchCalls).toBe(1);
});

test('沒按開始記錄之前，追蹤收到的定位一概不記', () => {
  trackBtn.click(); // 只有持續追蹤
  feed(0, 0);
  expect(getCurrentTrack()).toBe(null);
  expect(getTrackStatus().hasTrack).toBe(false);
});

test('濾點：精度差、原地抖動、跳點都不會進軌跡，合理位移才會', () => {
  startRecording();
  feed(0, 0);                 // 採用
  feed(0.00002, 1);           // 原地抖動
  feed(0.0003, 5, 80);        // 精度太差
  feed(0.0005, 30);           // 採用
  feed(1, 31);                // 跳點（約 111 公里／1 秒）
  expect(lens()).toEqual([2]);
  expect(getTrackStatus().pointCount).toBe(2);
  expect(getTrackStatus().distanceMeters).toBeGreaterThan(50);
  expect(getTrackStatus().canExport).toBe(true);
});

test('中斷超過門檻另起一段；紅燈前站著不動（被略過的點）不會被誤判成中斷', () => {
  startRecording();
  feed(0, 0);
  feed(0.0005, 30);
  // 站了 3 分鐘不動，每 30 秒一筆合格定位都被當成「原地抖動」略過
  for(let s = 60; s <= 210; s += 30) feed(0.0005, s);
  feed(0.001, 240);           // 繼續走：仍是同一段
  expect(lens()).toEqual([3]);
  feed(0.0015, 240 + TRACK_GAP_MS / 1000 + 1); // 訊號中斷 2 分鐘以上才恢復
  expect(lens()).toEqual([3, 1]);
});

test('連續三筆跳點：判定先前採用的點才是離群值，從目前位置重新起一段，不會永遠丟掉正確的點', () => {
  startRecording();
  feed(0, 0);
  feed(0.5, 10);              // 跳點 1
  feed(0.5005, 20);           // 跳點 2
  expect(lens()).toEqual([1]);
  feed(0.501, 30);            // 跳點 3 → 重新起段
  expect(lens()).toEqual([1, 1]);
  feed(0.5015, 60);
  expect(lens()).toEqual([1, 2]);
});

test('連續精度不足：狀態標成 weakSignal 並通知一次；恢復合格後解除', () => {
  const seen = [];
  onTrackChange((s) => seen.push(s.weakSignal));
  startRecording();
  feed(0, 0, 500);
  feed(0, 1, 500);
  expect(getTrackStatus().weakSignal).toBe(false);
  feed(0, 2, 500);
  expect(getTrackStatus().weakSignal).toBe(true);
  feed(0, 3, 500); // 第四筆不重複通知
  expect(seen.filter(Boolean)).toHaveLength(1);
  feed(0, 4, 10);
  expect(getTrackStatus().weakSignal).toBe(false);
  expect(getTrackStatus().pointCount).toBe(1);
});

test('結束記錄：標成完成、時間取最後一個點、寫進儲存；追蹤照舊', async () => {
  startRecording();
  feed(0, 0);
  feed(0.0005, 30);
  await stopRecording();
  const t = getCurrentTrack();
  expect(t.done).toBe(true);
  expect(t.endedAt).toBe(T0 + 30000);
  expect(getTrackStatus().recording).toBe(false);
  expect(getTrackState()).toBe('following');

  const stored = await loadTrack(t.id);
  expect(stored.done).toBe(true);
  expect(stored.segments).toEqual(t.segments);
});

test('追蹤被停止（含權限被拒自動停止）時，記錄跟著結束並存檔', async () => {
  startRecording();
  feed(0, 0);
  feed(0.0005, 30);
  trackBtn.click(); // following → off
  expect(getTrackStatus().recording).toBe(false);
  expect(getCurrentTrack().done).toBe(true);
  await Promise.resolve();
  expect((await loadLatestTrack()).done).toBe(true);
});

test('結束後又來的定位不再記錄', () => {
  startRecording();
  feed(0, 0);
  stopRecording();
  feed(0.0005, 30);
  expect(lens()).toEqual([1]);
});

test('每 10 個點寫入一次儲存（不必等結束就有備份）', async () => {
  startRecording();
  for(let i = 0; i < 12; i++) feed(i * 0.0005, i * 10);
  await Promise.resolve();
  const stored = await loadTrack(getCurrentTrack().id);
  expect(stored).not.toBe(null);
  expect(stored.done).toBe(false);
  expect(stored.segments[0].length).toBeGreaterThanOrEqual(10);
});

test('接續舊軌跡：保留舊的段，第一筆新定位另起一段（不會連出穿牆直線）', () => {
  const saved = {
    id: 'told', name: '軌跡', startedAt: T0 - 3600000, endedAt: null, done: false,
    segments: [[[121.5, 25, T0 - 3600000, 10], [121.5, 25.0005, T0 - 3590000, 10]]]
  };
  resumeRecording(saved);
  expect(getTrackStatus().recording).toBe(true);
  feed(0.01, 0);
  expect(lens()).toEqual([2, 1]);
  feed(0.0105, 30);
  expect(lens()).toEqual([2, 2]);
});

test('啟動時讀回最新軌跡：未完成的回傳給 UI 詢問；「結束並保留」標成完成；捨棄會刪除', async () => {
  await saveTrack({
    id: 'tunfinished', name: '軌跡', startedAt: T0, endedAt: null, done: false,
    segments: [[[121.5, 25, T0, 10], [121.5, 25.0005, T0 + 30000, 10]]]
  });
  const latest = await initTrackRecorder();
  expect(latest.id).toBe('tunfinished');
  expect(latest.done).toBe(false);
  expect(getTrackStatus().canExport, '已讀回的軌跡可直接匯出').toBe(true);

  await finishSavedTrack(latest);
  expect(getCurrentTrack().done).toBe(true);
  expect(getCurrentTrack().endedAt).toBe(T0 + 30000);
  expect((await loadTrack('tunfinished')).done).toBe(true);

  await discardTrack('tunfinished');
  expect(await loadTrack('tunfinished')).toBe(null);
  expect(getCurrentTrack()).toBe(null);
});
