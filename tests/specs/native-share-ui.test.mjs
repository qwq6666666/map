import '../env-stub.mjs';
import { test, expect, vi, afterEach } from 'vitest';

// 只驗證 nativeShareUI 自己的接線：偵測結果 → 按鈕顯示／隱藏、點擊 → 呼叫對應功能與提示。
// 重量級相依（地圖、截圖、分享連結編碼、複製、toast）換成假實作。
const mocks = vi.hoisted(() => ({
  shareImage: vi.fn(),
  exportImage: vi.fn(),
  copyShareLink: vi.fn(async () => true),
  toast: vi.fn(),
  hasCustom: false
}));
vi.mock('../../src/drawTool.js', () => ({ shareImage: mocks.shareImage, exportImage: mocks.exportImage }));
vi.mock('../../src/features/shareLink.js', () => ({
  buildShareURL: () => 'https://example.com/?mode=compare',
  copyShareLink: mocks.copyShareLink,
  shareStateHasCustomLayers: () => mocks.hasCustom
}));
vi.mock('../../src/features/location.js', () => ({ showLocateToast: mocks.toast }));

import { initNativeShareUI } from '../../src/ui/nativeShareUI.js';

const errorNamed = (name) => Object.assign(new Error(name), { name });
const originalMatchMedia = window.matchMedia;
// 模擬觸控裝置（手機／平板）或桌面：nativeShare.prefersNativeShare() 靠 (pointer: coarse) 判斷。
const setPointer = (coarse) => { window.matchMedia = (q) => ({ matches: coarse && q === '(pointer: coarse)' }); };

// 假 DOM：比照 index.html——「分享連結」、更多選單與手機選單各一顆「傳送截圖…」、「下載截圖」。
// 節點在假 DOM 裡跨測試共用，每次都清掉上一個測試綁的 click 監聽器。
function setupButtons(){
  const make = (id, nativeShare) => {
    const el = document.getElementById(id);
    if(nativeShare) el.dataset.nativeShare = nativeShare; else delete el.dataset.nativeShare;
    el.hidden = !!nativeShare;
    el._listeners = {};
    return el;
  };
  return {
    shareLinkBtn: make('shareLinkBtn'),
    imageBtn: make('shareNativeImageBtn', 'image'),
    mobileImage: make('mobileShareNativeImage', 'image'),
    downloadBtn: make('downloadImageBtn')
  };
}

afterEach(() => {
  delete navigator.share;
  delete navigator.canShare;
  window.matchMedia = originalMatchMedia;
  vi.clearAllMocks();
  mocks.copyShareLink.mockImplementation(async () => true);
  mocks.hasCustom = false;
});

test('環境完全不支援分享：「傳送截圖…」兩處入口維持隱藏，「分享連結」「下載截圖」不受影響', () => {
  const b = setupButtons();
  initNativeShareUI();
  expect([b.imageBtn.hidden, b.mobileImage.hidden]).toEqual([true, true]);
  expect(b.shareLinkBtn.hidden).toBeFalsy();
  expect(b.downloadBtn.hidden).toBeFalsy();
});

test('只支援分享連結（沒有檔案分享）：「傳送截圖…」仍隱藏', () => {
  navigator.share = async () => {};
  const b = setupButtons();
  initNativeShareUI();
  expect([b.imageBtn.hidden, b.mobileImage.hidden]).toEqual([true, true]);
});

test('連結與檔案都支援：「傳送截圖…」兩處入口都顯示', () => {
  navigator.share = async () => {};
  navigator.canShare = () => true;
  const b = setupButtons();
  initNativeShareUI();
  expect([b.imageBtn.hidden, b.mobileImage.hidden]).toEqual([false, false]);
});

test('桌面（非觸控）點「分享連結」：即使有 navigator.share 也直接複製，不叫系統面板', async () => {
  setPointer(false);
  const share = vi.fn(async () => {});
  navigator.share = share;
  const { shareLinkBtn } = setupButtons();
  initNativeShareUI();
  shareLinkBtn.click();
  await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
  expect(share).not.toHaveBeenCalled();
  expect(mocks.copyShareLink).toHaveBeenCalledTimes(1);
  expect(mocks.toast).toHaveBeenCalledWith('連結已複製');
});

test('手機點「分享連結」：把目前分享網址交給系統分享面板，成功就不再複製、不多跳提示', async () => {
  setPointer(true);
  let received = null;
  navigator.share = async (d) => { received = d; };
  const { shareLinkBtn } = setupButtons();
  initNativeShareUI();
  shareLinkBtn.click();
  await vi.waitFor(() => expect(received).not.toBeNull());
  expect(received).toEqual({ url: 'https://example.com/?mode=compare', title: '百年歷史地圖' });
  await Promise.resolve();
  expect(mocks.copyShareLink).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled();
});

test('手機分享成功且含自訂圖層：提醒自訂圖層不會包含在連結內', async () => {
  setPointer(true);
  navigator.share = async () => {};
  mocks.hasCustom = true;
  const { shareLinkBtn } = setupButtons();
  initNativeShareUI();
  shareLinkBtn.click();
  await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
  expect(mocks.toast.mock.calls[0][0]).toContain('自訂圖層不會包含在分享連結內');
  expect(mocks.copyShareLink).not.toHaveBeenCalled();
});

test('使用者自己關掉分享面板：不複製、不跳任何提示', async () => {
  setPointer(true);
  let called = false;
  navigator.share = async () => { called = true; throw errorNamed('AbortError'); };
  const { shareLinkBtn } = setupButtons();
  initNativeShareUI();
  shareLinkBtn.click();
  await vi.waitFor(() => expect(called).toBe(true));
  await Promise.resolve();
  await Promise.resolve();
  expect(mocks.copyShareLink).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled();
});

test('分享面板叫不出來（失敗／被擋）：退回直接複製網址，不讓這次操作白做', async () => {
  setPointer(true);
  for(const name of ['DataError', 'NotAllowedError']){
    navigator.share = async () => { throw errorNamed(name); };
    const { shareLinkBtn } = setupButtons();
    initNativeShareUI();
    shareLinkBtn.click();
    await vi.waitFor(() => expect(mocks.copyShareLink).toHaveBeenCalledTimes(1));
    expect(mocks.toast).toHaveBeenCalledWith('連結已複製');
    vi.clearAllMocks();
  }
});

test('手機但瀏覽器沒有 navigator.share：直接複製', async () => {
  setPointer(true);
  const { shareLinkBtn } = setupButtons();
  initNativeShareUI();
  shareLinkBtn.click();
  await vi.waitFor(() => expect(mocks.copyShareLink).toHaveBeenCalledTimes(1));
  expect(mocks.toast).toHaveBeenCalledWith('連結已複製');
});

test('複製：含自訂圖層要提醒', async () => {
  setPointer(false);
  mocks.hasCustom = true;
  const { shareLinkBtn } = setupButtons();
  initNativeShareUI();
  shareLinkBtn.click();
  await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
  expect(mocks.toast.mock.calls[0][0]).toContain('自訂圖層不會包含在分享連結內');
});

test('複製失敗：請使用者手動複製網址列', async () => {
  setPointer(false);
  mocks.copyShareLink.mockImplementation(async () => false);
  const { shareLinkBtn } = setupButtons();
  initNativeShareUI();
  shareLinkBtn.click();
  await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
  expect(mocks.toast).toHaveBeenCalledWith('複製失敗，請手動複製網址列');
});

test('點「傳送截圖」：呼叫 drawTool.shareImage()', () => {
  navigator.share = async () => {};
  navigator.canShare = () => true;
  const { imageBtn } = setupButtons();
  initNativeShareUI();
  imageBtn.click();
  expect(mocks.shareImage).toHaveBeenCalledTimes(1);
  expect(mocks.exportImage).not.toHaveBeenCalled();
});

test('點「下載截圖」：直接呼叫 drawTool.exportImage()（不必先打開繪圖工具列）', () => {
  const { downloadBtn } = setupButtons();
  initNativeShareUI();
  downloadBtn.click();
  expect(mocks.exportImage).toHaveBeenCalledTimes(1);
  expect(mocks.shareImage).not.toHaveBeenCalled();
});
