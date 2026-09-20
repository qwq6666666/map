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

import { initLocateButton, getTrackState } from '../../src/features/location.js';
import {
  initTrackRecorder, startRecording, stopRecording, resumeRecording, finishSavedTrack,
  discardTrack, renameTrack, listAllTracks, addImportedTracks, isRecordingTrack,
  getTrackStatus, getCurrentTrack, onTrackChange, _resetTrackRecorderForTests
} from '../../src/features/trackRecorder.js';
import { loadTrack, saveTrack, listTracks, _resetTrackStoreForTests } from '../../src/features/trackStore.js';
import { isTrackShown, _resetTrackLayerForTests } from '../../src/features/trackLayer.js';
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
  _resetTrackLayerForTests();
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
  expect(getTrackStatus().pointCount).toBe(0);
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
  expect((await listTracks())[0].done).toBe(true);
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

test('記錄中的軌跡一律顯示在地圖上，並被判定為「正在記錄」', () => {
  startRecording();
  const id = getCurrentTrack().id;
  expect(isRecordingTrack(id)).toBe(true);
  expect(isTrackShown(id)).toBe(true);
  stopRecording();
  expect(isRecordingTrack(id)).toBe(false);
});

test('啟動時回傳「沒有正常結束」的那一條；已結束或匯入的不算；記錄中就不回傳', async () => {
  await saveTrack({
    id: 'tdone', name: '完成的', startedAt: T0 + 5000, endedAt: T0 + 6000, done: true,
    segments: [[[121.5, 25, T0, 10], [121.5, 25.0005, T0 + 30000, 10]]]
  });
  expect(await initTrackRecorder()).toBe(null);

  await saveTrack({
    id: 'tunfinished', name: '軌跡', startedAt: T0, endedAt: null, done: false,
    segments: [[[121.5, 25, T0, 10], [121.5, 25.0005, T0 + 30000, 10]]]
  });
  const unfinished = await initTrackRecorder();
  expect(unfinished.id).toBe('tunfinished'); // 即使有更新的軌跡（startedAt 較晚），也要找到沒結束的

  startRecording();
  expect(await initTrackRecorder()).toBe(null);
});

test('「結束並保留」標成完成、時間取最後一個點；捨棄會刪除', async () => {
  const saved = {
    id: 'tunfinished', name: '軌跡', startedAt: T0, endedAt: null, done: false,
    segments: [[[121.5, 25, T0, 10], [121.5, 25.0005, T0 + 30000, 10]]]
  };
  await saveTrack(saved);
  await finishSavedTrack(saved);
  const stored = await loadTrack('tunfinished');
  expect(stored.done).toBe(true);
  expect(stored.endedAt).toBe(T0 + 30000);

  expect(await discardTrack('tunfinished')).toBe(true);
  expect(await loadTrack('tunfinished')).toBe(null);
});

/* ---------- 軌跡庫（我的軌跡列表） ---------- */

const importedTrack = (id, startedAt) => ({
  id, name: id, startedAt, endedAt: startedAt, done: true, imported: true,
  segments: [[[121.5, 25, null, null], [121.5, 25.001, null, null]]]
});

test('listAllTracks：新的在前；記錄中那條用記憶體版本（含還沒寫入儲存的點）', async () => {
  await saveTrack(importedTrack('old', T0 - 100000));
  startRecording();
  feed(0, 0);
  feed(0.0005, 30);
  const all = await listAllTracks();
  expect(all.map((t) => t.id)).toEqual([getCurrentTrack().id, 'old']);
  expect(all[0].segments[0]).toHaveLength(2); // 儲存裡還是舊快照（0 點），列表要看到最新
});

test('匯入的軌跡：存進儲存、立刻顯示在地圖上，且不影響目前記錄', async () => {
  await addImportedTracks([importedTrack('i1', T0), importedTrack('i2', T0 + 1)]);
  expect(isTrackShown('i1')).toBe(true);
  expect(isTrackShown('i2')).toBe(true);
  expect((await loadTrack('i1')).imported).toBe(true);
  expect(getTrackStatus().recording).toBe(false);
});

test('改名：不是記錄中的直接改儲存；記錄中的改記憶體並寫入（否則下一次寫入會把舊名蓋回去）', async () => {
  await saveTrack(importedTrack('i1', T0));
  expect(await renameTrack('i1', '  淡水河岸  ')).toBe(true);
  expect((await loadTrack('i1')).name).toBe('淡水河岸');
  expect(await renameTrack('i1', '   ')).toBe(false); // 空白名稱不接受
  expect(await renameTrack('nope', 'x')).toBe(false);

  startRecording();
  const id = getCurrentTrack().id;
  await renameTrack(id, '晨跑');
  feed(0, 0);
  feed(0.0005, 30);
  await stopRecording();
  expect((await loadTrack(id)).name).toBe('晨跑');
});

test('刪除：連地圖上的折線一起移除；正在記錄的那條不能刪', async () => {
  await addImportedTracks([importedTrack('i1', T0)]);
  expect(await discardTrack('i1')).toBe(true);
  expect(isTrackShown('i1')).toBe(false);
  expect(await loadTrack('i1')).toBe(null);

  startRecording();
  const id = getCurrentTrack().id;
  expect(await discardTrack(id)).toBe(false);
  expect(getTrackStatus().recording).toBe(true);
  expect(isTrackShown(id)).toBe(true);
});
