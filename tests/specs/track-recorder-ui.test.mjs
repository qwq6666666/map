import '../env-stub.mjs';
import { test, expect, vi, beforeEach, afterEach } from 'vitest';

// 只驗證 trackRecorderUI 的接線：狀態 → 按鈕文字／顯示、點擊 → 呼叫對應功能、
// 啟動時的接續詢問。記錄器、對話框、下載、分享、toast 全換成假實作。
const mocks = vi.hoisted(() => ({
  status: { recording: false, weakSignal: false, hasTrack: false, canExport: false, distanceMeters: 0, durationMs: 0, pointCount: 0 },
  track: null,
  latest: null,
  changeCb: null,
  startRecording: vi.fn(),
  stopRecording: vi.fn(async () => {}),
  resumeRecording: vi.fn(),
  finishSavedTrack: vi.fn(async () => {}),
  discardTrack: vi.fn(async () => {}),
  confirm: vi.fn(),
  download: vi.fn(),
  share: vi.fn(),
  toast: vi.fn()
}));
vi.mock('../../src/features/trackRecorder.js', () => ({
  initTrackRecorder: async () => mocks.latest,
  startRecording: mocks.startRecording,
  stopRecording: mocks.stopRecording,
  resumeRecording: mocks.resumeRecording,
  finishSavedTrack: mocks.finishSavedTrack,
  discardTrack: mocks.discardTrack,
  onTrackChange: (fn) => { mocks.changeCb = fn; },
  getTrackStatus: () => mocks.status,
  getCurrentTrack: () => mocks.track
}));
vi.mock('../../src/features/nativeShare.js', () => ({ shareFileNative: mocks.share }));
vi.mock('../../src/features/location.js', () => ({ showLocateToast: mocks.toast }));
vi.mock('../../src/drawTool.js', () => ({ downloadBlob: mocks.download }));
vi.mock('../../src/ui/dialog.js', () => ({ showConfirm: mocks.confirm }));

import { initTrackRecorderUI } from '../../src/ui/trackRecorderUI.js';

const T0 = Date.UTC(2026, 8, 20, 6, 0, 0);
const goodTrack = (extra = {}) => ({
  id: 't1', name: '軌跡 測試', startedAt: T0, endedAt: null, done: false,
  segments: [[[121.5, 25, T0, 10], [121.5, 25.0005, T0 + 60000, 10]]], ...extra
});
const base = { recording: false, weakSignal: false, hasTrack: false, canExport: false, distanceMeters: 0, durationMs: 0, pointCount: 0 };

// 假 DOM：更多選單的三顆按鈕、手機浮動選單的兩顆（同標記）、狀態條。
// 節點在假 DOM 裡跨測試共用，每次都清掉上一個測試綁的 click 監聽器。
function setup(){
  const make = (id, dataset = {}) => {
    const el = document.getElementById(id);
    el._listeners = {};
    Object.assign(el.dataset, dataset);
    el.hidden = false;
    return el;
  };
  const els = {
    record: make('trackRecordBtn', { trackRecord: '' }),
    gpx: make('trackExportGpxBtn', { trackExport: 'gpx' }),
    geojson: make('trackExportGeoJsonBtn', { trackExport: 'geojson' }),
    mobileRecord: make('mobileTrackRecord', { trackRecord: '' }),
    mobileGpx: make('mobileTrackExportGpx', { trackExport: 'gpx' }),
    bar: make('trackRecordStatus'),
    barText: make('trackRecordStatusText'),
    label: make('trackRecordLabel', { trackRecordLabel: '' }),
    mobileLabel: make('mobileTrackRecordLabel', { trackRecordLabel: '' })
  };
  return els;
}

beforeEach(() => {
  mocks.status = { ...base };
  mocks.track = null;
  mocks.latest = null;
  mocks.changeCb = null;
  navigator.geolocation = { watchPosition(){}, clearWatch(){} };
});

afterEach(() => {
  vi.clearAllMocks();
});

test('沒有軌跡：匯出鈕全部隱藏、狀態條隱藏、文字是「記錄軌跡」', async () => {
  const el = setup();
  await initTrackRecorderUI();
  expect([el.gpx.hidden, el.geojson.hidden, el.mobileGpx.hidden]).toEqual([true, true, true]);
  expect(el.bar.hidden).toBe(true);
  expect(el.label.textContent).toBe('記錄軌跡');
  expect(el.record.attrs['aria-pressed']).toBe('false');
});

test('記錄中：兩組入口文字都變「結束記錄軌跡」、active、狀態條顯示里程與時間', async () => {
  const el = setup();
  await initTrackRecorderUI();
  mocks.changeCb({ ...base, recording: true, canExport: true, distanceMeters: 1234, durationMs: 34 * 60000 });
  expect(el.label.textContent).toBe('結束記錄軌跡');
  expect(el.mobileLabel.textContent).toBe('結束記錄軌跡');
  expect(el.record.classList.contains('active')).toBe(true);
  expect(el.mobileRecord.attrs['aria-pressed']).toBe('true');
  expect(el.bar.hidden).toBe(false);
  expect(el.barText.textContent).toBe('記錄中 · 1.23 公里 · 34 分');
  expect([el.gpx.hidden, el.geojson.hidden, el.mobileGpx.hidden]).toEqual([false, false, false]);
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

test('記錄中再點：結束記錄，並告知里程與去哪裡匯出', async () => {
  const el = setup();
  mocks.status = { ...base, recording: true };
  await initTrackRecorderUI();
  mocks.stopRecording.mockImplementationOnce(async () => {
    mocks.status = { ...base, canExport: true, distanceMeters: 800, durationMs: 10 * 60000 };
  });
  el.record.click();
  await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
  expect(mocks.stopRecording).toHaveBeenCalled();
  expect(mocks.toast.mock.calls[0][0]).toContain('800 公尺');
  expect(mocks.toast.mock.calls[0][0]).toContain('匯出');
});

test('匯出 GPX／GeoJSON（桌面）：下載檔，檔名含開始時間與副檔名', async () => {
  const el = setup();
  mocks.track = goodTrack({ done: true });
  await initTrackRecorderUI();
  el.gpx.click();
  await vi.waitFor(() => expect(mocks.download).toHaveBeenCalledTimes(1));
  const [blob, name] = mocks.download.mock.calls[0];
  expect(name).toMatch(/^軌跡_\d{8}_\d{4}\.gpx$/);
  expect(blob.type).toBe('application/gpx+xml');
  expect(mocks.share).not.toHaveBeenCalled();

  el.geojson.click();
  await vi.waitFor(() => expect(mocks.download).toHaveBeenCalledTimes(2));
  expect(mocks.download.mock.calls[1][1]).toMatch(/\.geojson$/);
});

test('匯出（手機）：先叫分享面板；分享成功或使用者取消就不再下載，環境不支援才退回下載', async () => {
  const el = setup();
  mocks.track = goodTrack({ done: true });
  const realMatchMedia = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true });
  try{
    await initTrackRecorderUI();
    mocks.share.mockResolvedValueOnce('shared');
    el.gpx.click();
    await vi.waitFor(() => expect(mocks.share).toHaveBeenCalledTimes(1));
    expect(mocks.share.mock.calls[0][0].name).toMatch(/\.gpx$/);
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.download).not.toHaveBeenCalled();

    mocks.share.mockResolvedValueOnce('cancelled');
    el.gpx.click();
    await vi.waitFor(() => expect(mocks.share).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.download).not.toHaveBeenCalled();

    mocks.share.mockResolvedValueOnce('unsupported');
    el.gpx.click();
    await vi.waitFor(() => expect(mocks.download).toHaveBeenCalledTimes(1));
  }finally{
    globalThis.matchMedia = realMatchMedia;
  }
});

test('軌跡少於兩個點：不匯出，提示原因', async () => {
  const el = setup();
  mocks.track = goodTrack({ segments: [[[121.5, 25, T0, 10]]] });
  await initTrackRecorderUI();
  el.gpx.click();
  await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
  expect(mocks.download).not.toHaveBeenCalled();
  expect(mocks.toast.mock.calls[0][0]).toContain('兩個點');
});

test('啟動時上次沒結束的軌跡：選「接續記錄」→ 接續；選「結束並保留」→ 標成完成、不刪除', async () => {
  setup();
  mocks.latest = goodTrack();
  mocks.confirm.mockResolvedValueOnce(true);
  await initTrackRecorderUI();
  expect(mocks.confirm.mock.calls[0][0]).toContain('沒有正常結束');
  expect(mocks.confirm.mock.calls[0][1]).toMatchObject({ confirmText: '接續記錄', cancelText: '結束並保留' });
  expect(mocks.resumeRecording).toHaveBeenCalledWith(mocks.latest);

  mocks.confirm.mockResolvedValueOnce(false);
  await initTrackRecorderUI();
  expect(mocks.finishSavedTrack).toHaveBeenCalledWith(mocks.latest);
  expect(mocks.discardTrack).not.toHaveBeenCalled();
});

test('啟動時未結束但一個點都沒有的軌跡：直接丟掉，不打擾使用者；已結束的軌跡不詢問', async () => {
  setup();
  mocks.latest = goodTrack({ segments: [] });
  await initTrackRecorderUI();
  expect(mocks.discardTrack).toHaveBeenCalledWith('t1');
  expect(mocks.confirm).not.toHaveBeenCalled();

  mocks.latest = goodTrack({ done: true });
  await initTrackRecorderUI();
  expect(mocks.confirm).not.toHaveBeenCalled();
});

test('啟動載入的那幾毫秒內使用者已經開始新記錄：不再跳接續詢問', async () => {
  setup();
  mocks.latest = goodTrack();
  mocks.status = { ...base, recording: true };
  await initTrackRecorderUI();
  expect(mocks.confirm).not.toHaveBeenCalled();
});
