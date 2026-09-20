import '../env-stub.mjs';
import { test, expect, vi, beforeEach, afterEach } from 'vitest';

// 只驗證 trackRecorderUI 的接線：狀態 → 按鈕文字／狀態條、點擊 → 呼叫對應功能、
// 啟動時的接續詢問。記錄器、對話框、toast 全換成假實作。
const mocks = vi.hoisted(() => ({
  status: { recording: false, weakSignal: false, distanceMeters: 0, durationMs: 0, pointCount: 0 },
  unfinished: null,
  changeCb: null,
  startRecording: vi.fn(),
  stopRecording: vi.fn(async () => {}),
  resumeRecording: vi.fn(),
  finishSavedTrack: vi.fn(async () => {}),
  discardTrack: vi.fn(async () => true),
  confirm: vi.fn(),
  toast: vi.fn()
}));
vi.mock('../../src/features/trackRecorder.js', () => ({
  initTrackRecorder: async () => mocks.unfinished,
  startRecording: mocks.startRecording,
  stopRecording: mocks.stopRecording,
  resumeRecording: mocks.resumeRecording,
  finishSavedTrack: mocks.finishSavedTrack,
  discardTrack: mocks.discardTrack,
  onTrackChange: (fn) => { mocks.changeCb = fn; },
  getTrackStatus: () => mocks.status
}));
vi.mock('../../src/features/location.js', () => ({ showLocateToast: mocks.toast }));
vi.mock('../../src/ui/dialog.js', () => ({ showConfirm: mocks.confirm }));

import { initTrackRecorderUI } from '../../src/ui/trackRecorderUI.js';

const T0 = Date.UTC(2026, 8, 20, 6, 0, 0);
const goodTrack = (extra = {}) => ({
  id: 't1', name: '軌跡 測試', startedAt: T0, endedAt: null, done: false,
  segments: [[[121.5, 25, T0, 10], [121.5, 25.0005, T0 + 60000, 10]]], ...extra
});
const base = { recording: false, weakSignal: false, distanceMeters: 0, durationMs: 0, pointCount: 0 };

// 假 DOM：更多選單的記錄鈕、手機浮動選單的同一顆（同標記）、狀態條。
// 節點在假 DOM 裡跨測試共用，每次都清掉上一個測試綁的 click 監聽器。
function setup(){
  const make = (id, dataset = {}) => {
    const el = document.getElementById(id);
    el._listeners = {};
    Object.assign(el.dataset, dataset);
    el.hidden = false;
    return el;
  };
  return {
    record: make('trackRecordBtn', { trackRecord: '' }),
    mobileRecord: make('mobileTrackRecord', { trackRecord: '' }),
    bar: make('trackRecordStatus'),
    barText: make('trackRecordStatusText'),
    label: make('trackRecordLabel', { trackRecordLabel: '' }),
    mobileLabel: make('mobileTrackRecordLabel', { trackRecordLabel: '' })
  };
}

beforeEach(() => {
  mocks.status = { ...base };
  mocks.unfinished = null;
  mocks.changeCb = null;
  navigator.geolocation = { watchPosition(){}, clearWatch(){} };
});

afterEach(() => {
  vi.clearAllMocks();
});

test('沒在記錄：狀態條隱藏、文字是「記錄軌跡」', async () => {
  const el = setup();
  await initTrackRecorderUI();
  expect(el.bar.hidden).toBe(true);
  expect(el.label.textContent).toBe('記錄軌跡');
  expect(el.record.attrs['aria-pressed']).toBe('false');
});

test('記錄中：兩組入口文字都變「結束記錄軌跡」、active、狀態條顯示里程與時間', async () => {
  const el = setup();
  await initTrackRecorderUI();
  mocks.changeCb({ ...base, recording: true, distanceMeters: 1234, durationMs: 34 * 60000 });
  expect(el.label.textContent).toBe('結束記錄軌跡');
  expect(el.mobileLabel.textContent).toBe('結束記錄軌跡');
  expect(el.record.classList.contains('active')).toBe(true);
  expect(el.mobileRecord.attrs['aria-pressed']).toBe('true');
  expect(el.bar.hidden).toBe(false);
  expect(el.barText.textContent).toBe('記錄中 · 1.23 公里 · 34 分');
});

test('定位不夠準：狀態條改講實話，並提示一次（不會每筆都跳）', async () => {
  const el = setup();
  await initTrackRecorderUI();
  mocks.changeCb({ ...base, recording: true, weakSignal: true });
  mocks.changeCb({ ...base, recording: true, weakSignal: true });
  expect(el.barText.textContent).toContain('定位不夠準');
  expect(el.bar.classList.contains('weak')).toBe(true);
  expect(mocks.toast).toHaveBeenCalledTimes(1);
  expect(mocks.toast.mock.calls[0][0]).toContain('精度不足');
});

test('點「記錄軌跡」：開始記錄；瀏覽器不支援定位就只提示、不開始', async () => {
  const el = setup();
  await initTrackRecorderUI();
  el.record.click();
  expect(mocks.startRecording).toHaveBeenCalledTimes(1);

  mocks.startRecording.mockClear();
  navigator.geolocation = undefined;
  el.record.click();
  expect(mocks.startRecording).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenLastCalledWith('您的瀏覽器不支援定位功能。');
});

test('記錄中再點：結束記錄，並告知里程與到「我的軌跡」管理', async () => {
  const el = setup();
  mocks.status = { ...base, recording: true };
  await initTrackRecorderUI();
  mocks.stopRecording.mockImplementationOnce(async () => {
    mocks.status = { ...base, pointCount: 12, distanceMeters: 800, durationMs: 10 * 60000 };
  });
  el.record.click();
  await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
  expect(mocks.stopRecording).toHaveBeenCalled();
  expect(mocks.toast.mock.calls[0][0]).toContain('800 公尺');
  expect(mocks.toast.mock.calls[0][0]).toContain('我的軌跡');
});

test('記錄中一個點都沒記到就結束：不提示去匯出', async () => {
  const el = setup();
  mocks.status = { ...base, recording: true };
  await initTrackRecorderUI();
  mocks.stopRecording.mockImplementationOnce(async () => { mocks.status = { ...base }; });
  el.record.click();
  await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
  expect(mocks.toast.mock.calls[0][0]).toContain('沒有記到足夠的點');
});

test('啟動時上次沒結束的軌跡：選「接續記錄」→ 接續；選「結束並保留」→ 標成完成、不刪除', async () => {
  setup();
  mocks.unfinished = goodTrack();
  mocks.confirm.mockResolvedValueOnce(true);
  await initTrackRecorderUI();
  expect(mocks.confirm.mock.calls[0][0]).toContain('沒有正常結束');
  expect(mocks.confirm.mock.calls[0][1]).toMatchObject({ confirmText: '接續記錄', cancelText: '結束並保留' });
  expect(mocks.resumeRecording).toHaveBeenCalledWith(mocks.unfinished);

  mocks.confirm.mockResolvedValueOnce(false);
  await initTrackRecorderUI();
  expect(mocks.finishSavedTrack).toHaveBeenCalledWith(mocks.unfinished);
  expect(mocks.discardTrack).not.toHaveBeenCalled();
});

test('啟動時未結束但一個點都沒有的軌跡：直接丟掉，不打擾使用者；沒有未結束的就不詢問', async () => {
  setup();
  mocks.unfinished = goodTrack({ segments: [] });
  await initTrackRecorderUI();
  expect(mocks.discardTrack).toHaveBeenCalledWith('t1');
  expect(mocks.confirm).not.toHaveBeenCalled();

  mocks.unfinished = null;
  await initTrackRecorderUI();
  expect(mocks.confirm).not.toHaveBeenCalled();
});

test('啟動載入的那幾毫秒內使用者已經開始新記錄：不再跳接續詢問', async () => {
  setup();
  mocks.unfinished = goodTrack();
  mocks.status = { ...base, recording: true };
  await initTrackRecorderUI();
  expect(mocks.confirm).not.toHaveBeenCalled();
});
