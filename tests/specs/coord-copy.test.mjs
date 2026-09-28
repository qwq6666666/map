/* ---------------------------------------------------------
   tests/specs/coord-copy.test.mjs
   ---------------------------------------------------------
   src/features/coordCopy.js 原本完全沒有直接對應的測試檔（`buildCoordInfoElement`
   透過 features/search.js re-export 被 coordinate-transform.test.mjs 間接覆蓋，
   `copyCoordText()` 的 navigator.clipboard 成功路徑也只在 location-tracking.test.mjs
   裡被順帶跑到），以下三段完全沒有任何測試覆蓋：
     - copyCoordText() 的 document.execCommand('copy') 退回路徑（navigator.clipboard
       不可用時，例如非安全上下文）
     - copyCoordText() 的 navigator.clipboard.writeText() 失敗（例如使用者拒絕權限）
       時應靜默略過、不丟例外、不顯示 .copied 回饋
     - buildCoordRow() 的 getText 選填參數：沒有 getText 應複製「建立當下」的固定
       文字，有 getText 應在點擊當下即時取值（定位彈窗持續更新座標時仰賴這個行為）
--------------------------------------------------------- */
import '../env-stub.mjs';
import { test, expect, vi } from 'vitest';
import { copyCoordText, buildCoordRow } from '../../src/features/coordCopy.js';

test('copyCoordText()：navigator.clipboard 可用時，寫入成功後按鈕短暫顯示 .copied，1.5 秒後移除', async () => {
  const written = [];
  navigator.clipboard = { writeText: (t) => { written.push(t); return Promise.resolve(); } };
  const btn = document.createElement('button');
  vi.useFakeTimers();
  try{
    copyCoordText('23.5, 120.5', btn);
    await vi.advanceTimersByTimeAsync(0); // 讓 writeText().then(flash) 的 microtask 跑完
    expect(written[0], '應該把傳入的文字寫入剪貼簿').toBe('23.5, 120.5');
    expect(btn.classList.contains('copied'), '寫入成功後應該加上 .copied 視覺回饋').toBeTruthy();
    await vi.advanceTimersByTimeAsync(1500);
    expect(btn.classList.contains('copied'), '1.5 秒後應該移除 .copied').toBeFalsy();
  }finally{
    vi.useRealTimers();
    delete navigator.clipboard;
  }
});

test('copyCoordText()：navigator.clipboard.writeText() 失敗（例如使用者拒絕權限）時，靜默略過，不丟例外、不顯示 .copied', async () => {
  navigator.clipboard = { writeText: () => Promise.reject(new Error('denied')) };
  const btn = document.createElement('button');

  expect(() => copyCoordText('23.5, 120.5', btn), 'writeText 被拒絕不應該讓呼叫端拋出例外').not.toThrow();
  await Promise.resolve();
  await Promise.resolve();
  expect(btn.classList.contains('copied'), '寫入失敗不應該顯示 .copied 回饋').toBeFalsy();

  delete navigator.clipboard;
});

test('copyCoordText()：navigator.clipboard 不可用時，退回 document.execCommand("copy")，照常顯示 .copied 回饋', () => {
  delete navigator.clipboard;
  const calls = [];
  const originalExec = document.execCommand;
  document.execCommand = (...args) => { calls.push(args); return true; };
  const btn = document.createElement('button');

  copyCoordText('23.5, 120.5', btn);

  expect(calls.length, '應該呼叫一次 document.execCommand').toBe(1);
  expect(calls[0][0], '應該用 "copy" 指令').toBe('copy');
  expect(btn.classList.contains('copied'), 'execCommand 退回路徑成功後也應該顯示 .copied 回饋').toBeTruthy();

  document.execCommand = originalExec;
});

test('buildCoordRow()：沒有 getText 時，點擊複製的是建立當下的固定文字，不受之後狀態改變影響', async () => {
  const written = [];
  navigator.clipboard = { writeText: (t) => { written.push(t); return Promise.resolve(); } };

  const row = buildCoordRow('WGS84', '25.0000, 121.0000');
  const btn = row.querySelectorAll('.coord-copy-btn')[0];
  expect(btn, '應該包含一個 .coord-copy-btn').toBeTruthy();

  btn.click();
  await Promise.resolve();
  await Promise.resolve();

  expect(written[0], '沒有 getText 時應該複製建立當下傳入的固定文字').toBe('25.0000, 121.0000');
  delete navigator.clipboard;
});

test('buildCoordRow()：有 getText 時，點擊複製的是點擊當下的即時取值，反映最新狀態而非建立當下的舊文字', async () => {
  const written = [];
  navigator.clipboard = { writeText: (t) => { written.push(t); return Promise.resolve(); } };

  let current = '25.0000, 121.0000';
  const row = buildCoordRow('WGS84', '25.0000, 121.0000', () => current);
  const btn = row.querySelectorAll('.coord-copy-btn')[0];

  current = '25.9999, 121.9999'; // 模擬持續定位期間座標已經更新，但這一列是原地更新、沒有重建 DOM
  btn.click();
  await Promise.resolve();
  await Promise.resolve();

  expect(written[0], '有 getText 時應該複製點擊當下的最新座標，而非建立列當下的舊文字').toBe('25.9999, 121.9999');
  delete navigator.clipboard;
});
