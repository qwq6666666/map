import '../env-stub.mjs';
import { test, expect, vi, afterEach } from 'vitest';

// 只驗證 nativeShareUI 自己的接線：偵測結果 → 按鈕顯示／隱藏、點擊 → 呼叫對應
// 功能與提示。重量級相依（地圖、截圖、分享連結編碼、toast）換成假實作。
const mocks = vi.hoisted(() => ({
  shareImage: vi.fn(),
  toast: vi.fn(),
  hasCustom: false
}));
vi.mock('../../src/drawTool.js', () => ({ shareImage: mocks.shareImage }));
vi.mock('../../src/features/shareLink.js', () => ({
  buildShareURL: () => 'https://example.com/?mode=compare',
  shareStateHasCustomLayers: () => mocks.hasCustom
}));
vi.mock('../../src/features/location.js', () => ({ showLocateToast: mocks.toast }));

import { initNativeShareUI } from '../../src/ui/nativeShareUI.js';

const errorNamed = (name) => Object.assign(new Error(name), { name });

// 假 DOM：四顆按鈕（更多選單兩顆＋手機浮動選單兩顆），比照 index.html 的 data-native-share 標記。
function setupButtons(){
  const make = (id, kind) => {
    const el = document.getElementById(id);
    el.dataset.nativeShare = kind;
    el.hidden = true;
    el._listeners = {}; // 節點在假 DOM 裡跨測試共用，先清掉上一個測試綁的 click 監聽器
    return el;
  };
  const linkBtn = make('shareNativeLinkBtn', 'link');
  const imageBtn = make('shareNativeImageBtn', 'image');
  const mobileLink = make('mobileShareNativeLink', 'link');
  const mobileImage = make('mobileShareNativeImage', 'image');
  return { linkBtn, imageBtn, mobileLink, mobileImage };
}

afterEach(() => {
  delete navigator.share;
  delete navigator.canShare;
  mocks.shareImage.mockClear();
  mocks.toast.mockClear();
  mocks.hasCustom = false;
});

test('環境完全不支援分享：所有「傳送…」按鈕維持隱藏', () => {
  const b = setupButtons();
  initNativeShareUI();
  expect([b.linkBtn.hidden, b.imageBtn.hidden, b.mobileLink.hidden, b.mobileImage.hidden]).toEqual([true, true, true, true]);
});

test('只支援分享連結（沒有檔案分享）：只顯示「傳送連結」兩處入口', () => {
  navigator.share = async () => {};
  const b = setupButtons();
  initNativeShareUI();
  expect(b.linkBtn.hidden).toBe(false);
  expect(b.mobileLink.hidden).toBe(false);
  expect(b.imageBtn.hidden).toBe(true);
  expect(b.mobileImage.hidden).toBe(true);
});

test('連結與檔案都支援：四顆按鈕都顯示', () => {
  navigator.share = async () => {};
  navigator.canShare = () => true;
  const b = setupButtons();
  initNativeShareUI();
  expect([b.linkBtn.hidden, b.imageBtn.hidden, b.mobileLink.hidden, b.mobileImage.hidden]).toEqual([false, false, false, false]);
});

test('點「傳送連結」：把目前分享網址交給分享面板；一般狀況分享成功不多跳提示', async () => {
  let received = null;
  navigator.share = async (d) => { received = d; };
  const { linkBtn } = setupButtons();
  initNativeShareUI();
  linkBtn.click();
  await vi.waitFor(() => expect(received).not.toBeNull());
  expect(received).toEqual({ url: 'https://example.com/?mode=compare', title: '百年歷史地圖' });
  expect(mocks.toast).not.toHaveBeenCalled();
});

test('分享成功且含自訂圖層：提醒自訂圖層不會包含在連結內', async () => {
  navigator.share = async () => {};
  mocks.hasCustom = true;
  const { linkBtn } = setupButtons();
  initNativeShareUI();
  linkBtn.click();
  await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
  expect(mocks.toast.mock.calls[0][0]).toContain('自訂圖層不會包含在分享連結內');
});

test('使用者自己關掉分享面板：不跳任何提示', async () => {
  let called = false;
  navigator.share = async () => { called = true; throw errorNamed('AbortError'); };
  const { linkBtn } = setupButtons();
  initNativeShareUI();
  linkBtn.click();
  await vi.waitFor(() => expect(called).toBe(true));
  await Promise.resolve();
  expect(mocks.toast).not.toHaveBeenCalled();
});

test('分享失敗：提示改用「分享連結」複製網址', async () => {
  navigator.share = async () => { throw errorNamed('DataError'); };
  const { linkBtn } = setupButtons();
  initNativeShareUI();
  linkBtn.click();
  await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
  expect(mocks.toast.mock.calls[0][0]).toContain('分享連結');
});

test('點「傳送截圖」：呼叫 drawTool.shareImage()', () => {
  navigator.share = async () => {};
  navigator.canShare = () => true;
  const { imageBtn } = setupButtons();
  initNativeShareUI();
  imageBtn.click();
  expect(mocks.shareImage).toHaveBeenCalledTimes(1);
});
