import '../env-stub.mjs';
import { test, expect, vi, afterEach } from 'vitest';

// 只驗證 trackExport 自己的邏輯：手機先分享、退回下載、少於兩點不匯出。
const mocks = vi.hoisted(() => ({
  share: vi.fn(),
  toast: vi.fn(),
  download: vi.fn()
}));
vi.mock('../../src/features/nativeShare.js', () => ({ shareFileNative: mocks.share }));
vi.mock('../../src/features/location.js', () => ({ showLocateToast: mocks.toast }));
vi.mock('../../src/drawTool.js', () => ({ downloadBlob: mocks.download }));

import { exportTrackFile } from '../../src/ui/trackExport.js';

const T0 = Date.UTC(2026, 8, 20, 6, 0, 0);
const track = (extra = {}) => ({
  id: 't1', name: '軌跡 測試', startedAt: T0, endedAt: T0 + 60000, done: true,
  segments: [[[121.5, 25, T0, 10], [121.5, 25.0005, T0 + 60000, 10]]], ...extra
});

afterEach(() => { vi.clearAllMocks(); });

test('桌面：直接下載，檔名含開始時間與副檔名，內容型別正確', async () => {
  await exportTrackFile(track(), 'gpx');
  expect(mocks.download).toHaveBeenCalledTimes(1);
  const [blob, name] = mocks.download.mock.calls[0];
  expect(name).toMatch(/^軌跡_\d{8}_\d{4}\.gpx$/);
  expect(blob.type).toBe('application/gpx+xml');
  expect(mocks.share).not.toHaveBeenCalled();

  await exportTrackFile(track(), 'geojson');
  expect(mocks.download.mock.calls[1][1]).toMatch(/\.geojson$/);
  expect(mocks.download.mock.calls[1][0].type).toBe('application/geo+json');
});

test('手機：先叫分享面板；分享成功或使用者取消就不再下載，環境不支援才退回下載', async () => {
  const realMatchMedia = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true });
  try{
    mocks.share.mockResolvedValueOnce('shared');
    await exportTrackFile(track(), 'gpx');
    expect(mocks.share.mock.calls[0][0].name).toMatch(/\.gpx$/);
    expect(mocks.download).not.toHaveBeenCalled();

    mocks.share.mockResolvedValueOnce('cancelled');
    await exportTrackFile(track(), 'gpx');
    expect(mocks.download).not.toHaveBeenCalled();

    for(const result of ['unsupported', 'blocked', 'failed']){
      mocks.download.mockClear();
      mocks.share.mockResolvedValueOnce(result);
      await exportTrackFile(track(), 'gpx');
      expect(mocks.download, result).toHaveBeenCalledTimes(1);
    }
  }finally{
    globalThis.matchMedia = realMatchMedia;
  }
});

test('少於兩個點、未知格式：不匯出，提示原因', async () => {
  await exportTrackFile(track({ segments: [[[121.5, 25, T0, 10]]] }), 'gpx');
  expect(mocks.toast.mock.calls[0][0]).toContain('兩個點');
  await exportTrackFile(track(), 'kml');
  await exportTrackFile(null, 'gpx');
  expect(mocks.download).not.toHaveBeenCalled();
  expect(mocks.share).not.toHaveBeenCalled();
});
