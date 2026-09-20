import '../env-stub.mjs';
import { test, expect, afterEach } from 'vitest';
import {
  canShareLink,
  canShareFiles,
  shareLinkNative,
  shareFileNative
} from '../../src/features/nativeShare.js';

// 測試用假 navigator.share／canShare；每個測試結束還原，避免互相影響。
afterEach(() => {
  delete navigator.share;
  delete navigator.canShare;
});

const errorNamed = (name) => Object.assign(new Error(name), { name });
const pngFile = () => new File(['x'], 'a.png', { type: 'image/png' });

test('沒有 navigator.share 時：兩種分享都判定不支援', async () => {
  expect(canShareLink()).toBe(false);
  expect(canShareFiles()).toBe(false);
  expect(await shareLinkNative({ url: 'https://x/', title: 't' })).toBe('unsupported');
  expect(await shareFileNative(pngFile(), { title: 't' })).toBe('unsupported');
});

test('有 share 但沒有 canShare：可分享連結、不可分享檔案', () => {
  navigator.share = async () => {};
  expect(canShareLink()).toBe(true);
  expect(canShareFiles()).toBe(false);
});

test('canShare 說不行（例如桌面 Chrome）：不可分享檔案', () => {
  navigator.share = async () => {};
  navigator.canShare = () => false;
  expect(canShareFiles()).toBe(false);
});

test('canShare 說可以：可分享檔案；探測用的是 PNG 檔案', () => {
  navigator.share = async () => {};
  let probed = null;
  navigator.canShare = (data) => { probed = data; return true; };
  expect(canShareFiles()).toBe(true);
  expect(probed.files[0].type).toBe('image/png');
});

test('canShare 丟例外時視為不支援，不會冒出來', () => {
  navigator.share = async () => {};
  navigator.canShare = () => { throw new TypeError('boom'); };
  expect(canShareFiles()).toBe(false);
});

test('shareLinkNative：把 url／title 交給 navigator.share，成功回傳 shared', async () => {
  let received = null;
  navigator.share = async (data) => { received = data; };
  expect(await shareLinkNative({ url: 'https://x/?a=1', title: '百年歷史地圖' })).toBe('shared');
  expect(received).toEqual({ url: 'https://x/?a=1', title: '百年歷史地圖' });
});

test('shareFileNative：把檔案放進 files 陣列交給 navigator.share', async () => {
  let received = null;
  navigator.share = async (data) => { received = data; };
  navigator.canShare = () => true;
  const file = pngFile();
  expect(await shareFileNative(file, { title: '百年歷史地圖' })).toBe('shared');
  expect(received.files).toEqual([file]);
  expect(received.title).toBe('百年歷史地圖');
});

test('使用者關掉分享面板（AbortError）回傳 cancelled，不當成錯誤', async () => {
  navigator.share = async () => { throw errorNamed('AbortError'); };
  navigator.canShare = () => true;
  expect(await shareLinkNative({ url: 'u', title: 't' })).toBe('cancelled');
  expect(await shareFileNative(pngFile())).toBe('cancelled');
});

test('手勢過期被瀏覽器擋下（NotAllowedError）回傳 blocked，讓呼叫端走下載備援', async () => {
  navigator.share = async () => { throw errorNamed('NotAllowedError'); };
  navigator.canShare = () => true;
  expect(await shareFileNative(pngFile())).toBe('blocked');
});

test('其他錯誤回傳 failed，不會把例外丟出去', async () => {
  navigator.share = async () => { throw errorNamed('DataError'); };
  navigator.canShare = () => true;
  expect(await shareLinkNative({ url: 'u', title: 't' })).toBe('failed');
});
