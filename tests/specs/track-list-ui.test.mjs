import '../env-stub.mjs';
import { test, expect, vi, beforeEach, afterEach } from 'vitest';

// 只驗證「我的軌跡」抽屜自己的接線：列表渲染、各按鈕呼叫對應功能、匯入流程、
// 記錄進行中的原地更新。記錄器、圖層、繪圖、對話框、匯出、toast 全換成假實作；
// 匯入解析（trackImport.js）與統計（trackMath.js）用真的。
const mocks = vi.hoisted(() => ({
  tracks: [],
  shown: new Set(),
  recordingId: null,
  status: { recording: false, distanceMeters: 0, durationMs: 0 },
  changeCb: null,
  unsubscribed: 0,
  listAllTracks: vi.fn(),
  addImportedTracks: vi.fn(async () => {}),
  renameTrack: vi.fn(async () => true),
  discardTrack: vi.fn(async () => true),
  showTrack: vi.fn(),
  hideTrack: vi.fn(),
  zoomToTrack: vi.fn(() => true),
  importGeoJSON: vi.fn(() => 2),
  exportTrackFile: vi.fn(async () => {}),
  toast: vi.fn(),
  alert: vi.fn(async () => {}),
  confirm: vi.fn(),
  prompt: vi.fn()
}));
vi.mock('../../src/features/trackRecorder.js', () => ({
  listAllTracks: mocks.listAllTracks,
  addImportedTracks: mocks.addImportedTracks,
  renameTrack: mocks.renameTrack,
  discardTrack: mocks.discardTrack,
  isRecordingTrack: (id) => id === mocks.recordingId,
  onTrackChange: (fn) => { mocks.changeCb = fn; return () => { mocks.unsubscribed++; }; },
  getTrackStatus: () => mocks.status
}));
vi.mock('../../src/features/trackLayer.js', () => ({
  showTrack: (t) => { mocks.shown.add(t.id); mocks.showTrack(t); },
  hideTrack: (id) => { mocks.shown.delete(id); mocks.hideTrack(id); },
  isTrackShown: (id) => mocks.shown.has(id),
  zoomToTrack: mocks.zoomToTrack,
  colorForTrack: () => '#1971c2'
}));
vi.mock('../../src/drawTool.js', () => ({ importGeoJSON: mocks.importGeoJSON }));
vi.mock('../../src/features/location.js', () => ({ showLocateToast: mocks.toast }));
vi.mock('../../src/ui/dialog.js', () => ({ showAlert: mocks.alert, showConfirm: mocks.confirm, showPrompt: mocks.prompt }));
vi.mock('../../src/ui/trackExport.js', () => ({ exportTrackFile: mocks.exportTrackFile }));

import { openTrackListDrawer, initTrackListUI } from '../../src/ui/trackListUI.js';

const T0 = Date.UTC(2026, 8, 20, 6, 0, 0);
const mk = (id, extra = {}) => ({
  id, name: `軌跡 ${id}`, startedAt: T0, endedAt: T0 + 600000, done: true,
  segments: [[[121.5, 25, T0, 10], [121.5, 25.0005, T0 + 60000, 10]]], ...extra
});

// 假 DOM 沒有 removeEventListener、也不會派送 keydown：補上並記下監聽器，才測得到 Esc 關閉。
const keydownHandlers = new Set();
document.addEventListener = (ev, fn) => { if(ev === 'keydown') keydownHandlers.add(fn); };
document.removeEventListener = (ev, fn) => { if(ev === 'keydown') keydownHandlers.delete(fn); };

const drawerEl = () => document.querySelector('.track-list-drawer');
const items = () => document.querySelectorAll('.track-item');
const btn = (item, label) => item.querySelectorAll('.track-item-btn').find((b) => b.textContent === label);
const openAndWait = async (expectedItems) => {
  openTrackListDrawer();
  await vi.waitFor(() => expect(items()).toHaveLength(expectedItems));
};

beforeEach(() => {
  mocks.tracks = [];
  mocks.shown = new Set();
  mocks.recordingId = null;
  mocks.status = { recording: false, distanceMeters: 0, durationMs: 0 };
  mocks.changeCb = null;
  mocks.unsubscribed = 0;
  mocks.listAllTracks.mockImplementation(async () => mocks.tracks);
});

afterEach(() => {
  // 關掉殘留的抽屜，避免影響下一個測試（openTrackListDrawer 會擋住重複開啟）
  [...keydownHandlers].forEach((fn) => fn({ key: 'Escape' }));
  document.querySelectorAll('.guide-drawer-overlay').forEach((n) => n.remove());
  document.querySelectorAll('.track-list-drawer').forEach((n) => n.remove());
  vi.clearAllMocks();
});

test('沒有軌跡：顯示空狀態說明與匯入鈕', async () => {
  openTrackListDrawer();
  await vi.waitFor(() => expect(document.querySelector('.track-list-empty')).not.toBeNull());
  expect(document.querySelector('.track-list-import').textContent).toContain('匯入');
  expect(items()).toHaveLength(0);
});

test('列出軌跡：名稱、日期／里程／時間、顏色色塊；匯入與記錄中各有標籤', async () => {
  mocks.tracks = [mk('a'), mk('b', { imported: true }), mk('c')];
  mocks.recordingId = 'c';
  await openAndWait(3);
  const [a, b, c] = items();
  expect(a.querySelector('.track-item-name').textContent).toBe('軌跡 a');
  expect(a.querySelector('.track-item-meta').textContent).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} · \d+ 公尺 · 1 分$/);
  expect(a.querySelector('.track-item-swatch').style.background).toBe('#1971c2');
  expect(a.querySelector('.track-item-badge')).toBeNull();
  expect(b.querySelector('.track-item-badge').textContent).toBe('匯入');
  expect(c.querySelector('.track-item-badge').textContent).toBe('記錄中');
});

test('記錄中的軌跡：不能隱藏、不能刪除（按鈕停用），其他動作照常', async () => {
  mocks.tracks = [mk('c')];
  mocks.recordingId = 'c';
  await openAndWait(1);
  const [c] = items();
  expect(btn(c, '隱藏').disabled).toBe(true); // 一律顯示，所以文字是「隱藏」但不能按
  expect(btn(c, '刪除').disabled).toBe(true);
  expect(btn(c, '改名').disabled).toBe(false);
  expect(btn(c, 'GPX').disabled).toBe(false);
});

test('不到兩個點的軌跡：定位／匯出／存成繪圖都停用', async () => {
  mocks.tracks = [mk('tiny', { segments: [[[121.5, 25, T0, 10]]] })];
  await openAndWait(1);
  const [t] = items();
  ['定位', 'GPX', 'GeoJSON', '存成繪圖'].forEach((label) => expect(btn(t, label).disabled, label).toBe(true));
  expect(btn(t, '刪除').disabled).toBe(false);
});

test('軌跡名稱是不可信內容：一律當純文字顯示，不會變成 HTML 節點', async () => {
  const evil = '<img src=x onerror=alert(1)><b>粗</b>';
  mocks.tracks = [mk('x', { name: evil })];
  await openAndWait(1);
  const nameEl = items()[0].querySelector('.track-item-name');
  expect(nameEl.textContent).toBe(evil);
  expect(nameEl.children).toHaveLength(0);
});

test('顯示／隱藏：依目前狀態切換圖層、按鈕文字與 aria-pressed 跟著變', async () => {
  mocks.tracks = [mk('a')];
  await openAndWait(1);
  const toggle = btn(items()[0], '顯示');
  expect(toggle.attrs['aria-pressed']).toBe('false');
  toggle.click();
  expect(mocks.showTrack).toHaveBeenCalledWith(mocks.tracks[0]);
  expect(toggle.textContent).toBe('隱藏');
  expect(toggle.attrs['aria-pressed']).toBe('true');
  toggle.click();
  expect(mocks.hideTrack).toHaveBeenCalledWith('a');
  expect(toggle.textContent).toBe('顯示');
});

test('定位：沒顯示的先顯示再飛過去，並關閉抽屜；沒有可定位的點就只提示、抽屜留著', async () => {
  mocks.tracks = [mk('a')];
  await openAndWait(1);
  btn(items()[0], '定位').click();
  expect(mocks.showTrack).toHaveBeenCalledTimes(1);
  expect(mocks.zoomToTrack).toHaveBeenCalledWith(mocks.tracks[0]);
  expect(drawerEl()).toBeNull();

  mocks.zoomToTrack.mockReturnValueOnce(false);
  await openAndWait(1);
  btn(items()[0], '定位').click();
  expect(mocks.toast.mock.calls.at(-1)[0]).toContain('沒有可以定位');
  expect(drawerEl()).not.toBeNull();
});

test('匯出按鈕：把該條軌跡與格式交給 exportTrackFile', async () => {
  mocks.tracks = [mk('a'), mk('b')];
  await openAndWait(2);
  btn(items()[1], 'GPX').click();
  btn(items()[0], 'GeoJSON').click();
  expect(mocks.exportTrackFile).toHaveBeenNthCalledWith(1, mocks.tracks[1], 'gpx');
  expect(mocks.exportTrackFile).toHaveBeenNthCalledWith(2, mocks.tracks[0], 'geojson');
});

test('存成繪圖：轉成繪圖用的 FeatureCollection（帶該軌跡顏色）交給 importGeoJSON，並告知條數', async () => {
  mocks.tracks = [mk('a')];
  await openAndWait(1);
  btn(items()[0], '存成繪圖').click();
  const fc = mocks.importGeoJSON.mock.calls[0][0];
  expect(fc.type).toBe('FeatureCollection');
  expect(fc.features[0].properties).toMatchObject({ kind: 'line', stroke: '#1971c2' });
  expect(mocks.toast.mock.calls.at(-1)[0]).toContain('2 條');

  mocks.importGeoJSON.mockReturnValueOnce(0);
  btn(items()[0], '存成繪圖').click();
  expect(mocks.toast.mock.calls.at(-1)[0]).toContain('沒有可以轉換');
});

test('改名：輸入新名稱才呼叫並重畫列表；取消或空白不動', async () => {
  mocks.tracks = [mk('a')];
  await openAndWait(1);
  mocks.prompt.mockResolvedValueOnce('新名字');
  btn(items()[0], '改名').click();
  await vi.waitFor(() => expect(mocks.renameTrack).toHaveBeenCalledWith('a', '新名字'));
  expect(mocks.prompt.mock.calls[0][1]).toMatchObject({ defaultValue: '軌跡 a', maxLength: 60 });
  await vi.waitFor(() => expect(mocks.listAllTracks).toHaveBeenCalledTimes(2)); // 重畫

  mocks.renameTrack.mockClear();
  mocks.prompt.mockResolvedValueOnce(null);
  btn(items()[0], '改名').click();
  await Promise.resolve();
  await Promise.resolve();
  expect(mocks.renameTrack).not.toHaveBeenCalled();
});

test('刪除：要先確認（危險樣式）；確認才刪並重畫，取消什麼都不做', async () => {
  mocks.tracks = [mk('a')];
  await openAndWait(1);
  mocks.confirm.mockResolvedValueOnce(false);
  btn(items()[0], '刪除').click();
  await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
  expect(mocks.confirm.mock.calls[0][1]).toMatchObject({ danger: true, confirmText: '刪除' });
  expect(mocks.discardTrack).not.toHaveBeenCalled();

  mocks.confirm.mockResolvedValueOnce(true);
  btn(items()[0], '刪除').click();
  await vi.waitFor(() => expect(mocks.discardTrack).toHaveBeenCalledWith('a'));
  await vi.waitFor(() => expect(mocks.listAllTracks).toHaveBeenCalledTimes(2));
});

/* ---------- 匯入 ---------- */

const GOOD_GPX = '<gpx><trk><name>河岸</name><trkseg><trkpt lat="25" lon="121"/><trkpt lat="25.001" lon="121.001"/></trkseg></trk></gpx>';
const fakeFile = (name, text, size = text.length) => ({ name, size, text: async () => text });

async function importFiles(files){
  const input = document.querySelector('input');
  input.files = files;
  await Promise.all((input._listeners.change || []).map((fn) => fn()));
}

test('匯入鈕：轉發點擊給隱藏的檔案選擇器（可複選）', async () => {
  openTrackListDrawer();
  await vi.waitFor(() => expect(document.querySelector('.track-list-import')).not.toBeNull());
  const input = document.querySelector('input');
  expect(input.type).toBe('file');
  expect(input.multiple).toBe(true);
  expect(input.hidden).toBe(true);
  let clicked = 0;
  input.addEventListener('click', () => { clicked++; });
  document.querySelector('.track-list-import').click();
  expect(clicked).toBe(1);
});

test('匯入成功：解析後存進軌跡庫、提示條數並重畫列表', async () => {
  openTrackListDrawer();
  await vi.waitFor(() => expect(document.querySelector('input')).not.toBeNull());
  await importFiles([fakeFile('a.gpx', GOOD_GPX)]);
  expect(mocks.addImportedTracks).toHaveBeenCalledTimes(1);
  const [tracks] = mocks.addImportedTracks.mock.calls[0];
  expect(tracks).toHaveLength(1);
  expect(tracks[0]).toMatchObject({ name: '河岸', imported: true, done: true });
  expect(mocks.toast.mock.calls.at(-1)[0]).toContain('1 條');
  expect(mocks.alert).not.toHaveBeenCalled();
  expect(mocks.listAllTracks.mock.calls.length).toBeGreaterThanOrEqual(2);
});

test('匯入多個檔案：好的照收，壞的、太大的集中在一則提示裡說明原因', async () => {
  openTrackListDrawer();
  await vi.waitFor(() => expect(document.querySelector('input')).not.toBeNull());
  await importFiles([
    fakeFile('好.gpx', GOOD_GPX),
    fakeFile('壞.json', '{ not json'),
    fakeFile('大.gpx', GOOD_GPX, 999 * 1024 * 1024),
    { name: '讀不到.gpx', size: 10, text: async () => { throw new Error('io'); } }
  ]);
  expect(mocks.addImportedTracks.mock.calls[0][0]).toHaveLength(1);
  expect(mocks.alert).toHaveBeenCalledTimes(1);
  const message = mocks.alert.mock.calls[0][0];
  expect(message).toContain('「壞.json」');
  expect(message).toContain('「大.gpx」檔案太大');
  expect(message).toContain('「讀不到.gpx」讀取失敗');
  expect(message).not.toContain('「好.gpx」');
});

test('全部都失敗：不呼叫存入、不假裝成功', async () => {
  openTrackListDrawer();
  await vi.waitFor(() => expect(document.querySelector('input')).not.toBeNull());
  await importFiles([fakeFile('空.gpx', '')]);
  expect(mocks.addImportedTracks).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled();
  expect(mocks.alert).toHaveBeenCalledTimes(1);
});

/* ---------- 記錄進行中 ---------- */

test('記錄中每筆更新：只原地改那一條的統計文字，不重畫列表（不換掉手指底下的按鈕）', async () => {
  mocks.tracks = [mk('c')];
  mocks.recordingId = 'c';
  mocks.status = { recording: true, distanceMeters: 0, durationMs: 0 };
  await openAndWait(1);
  const before = items()[0];
  mocks.changeCb({ recording: true, distanceMeters: 1500, durationMs: 20 * 60000 });
  expect(before.querySelector('.track-item-meta').textContent).toBe('1.50 公里 · 20 分');
  expect(items()[0]).toBe(before);
  expect(mocks.listAllTracks).toHaveBeenCalledTimes(1);
});

test('開始／結束記錄這種結構變化：整個列表重畫', async () => {
  mocks.tracks = [mk('a')];
  await openAndWait(1);
  mocks.changeCb({ recording: true, distanceMeters: 0, durationMs: 0 });
  await vi.waitFor(() => expect(mocks.listAllTracks).toHaveBeenCalledTimes(2));
  mocks.changeCb({ recording: false, distanceMeters: 0, durationMs: 0 });
  await vi.waitFor(() => expect(mocks.listAllTracks).toHaveBeenCalledTimes(3));
});

/* ---------- 開關 ---------- */

test('連點入口：已經開著就不再開第二個；按 Esc 關閉並取消訂閱', async () => {
  await openAndWait(0).catch(() => {});
  openTrackListDrawer();
  expect(document.querySelectorAll('.track-list-drawer')).toHaveLength(1);
  [...keydownHandlers].forEach((fn) => fn({ key: 'Escape' }));
  expect(drawerEl()).toBeNull();
  expect(mocks.unsubscribed).toBe(1);
  expect(keydownHandlers.size).toBe(0);
});

test('點遮罩、點關閉鈕都會關閉', async () => {
  openTrackListDrawer();
  document.querySelector('.guide-drawer-overlay').click();
  expect(drawerEl()).toBeNull();
  openTrackListDrawer();
  document.querySelector('.guide-drawer-close').click();
  expect(drawerEl()).toBeNull();
});

test('initTrackListUI：#trackListBtn 點擊開啟抽屜', () => {
  const entry = document.getElementById('trackListBtn');
  entry._listeners = {};
  initTrackListUI();
  entry.click();
  expect(drawerEl()).not.toBeNull();
});
