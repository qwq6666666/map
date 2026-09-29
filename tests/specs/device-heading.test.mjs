/* ---------------------------------------------------------
   tests/specs/device-heading.test.mjs
   ---------------------------------------------------------
   驗證 features/deviceHeading.js 的純函式與監聽邏輯：
     1. needsOrientationPermission()／requestOrientationPermission()：
        iOS 13+ 才有的 DeviceOrientationEvent.requestPermission()
        偵測與正規化結果（granted/denied/unsupported/not-needed）。
     2. computeCompassHeading()：優先採用 webkitCompassHeading，其次
        用 (360-alpha)%360 換算，alpha 缺失回傳 null。
     3. startWatchingHeading()：掛兩個事件名稱、篩選掉非絕對方位的
        讀數、alpha 缺失不誤呼叫 onHeading、stop() 真的會移除監聽器。

   globalThis.window 是 env-stub.mjs 提供的假物件，已內建
   addEventListener/removeEventListener/_dispatch，可以直接拿來模擬
   deviceorientation／deviceorientationabsolute 事件，不需要另外
   自己刻一個假 window。
--------------------------------------------------------- */
import '../env-stub.mjs';
import { test, expect, afterEach } from 'vitest';
import {
  needsOrientationPermission,
  requestOrientationPermission,
  computeCompassHeading,
  startWatchingHeading,
} from '../../src/features/deviceHeading.js';

afterEach(() => {
  delete globalThis.DeviceOrientationEvent;
});

/* ---------- needsOrientationPermission() / requestOrientationPermission() ---------- */

test('needsOrientationPermission()：全域沒有 DeviceOrientationEvent（桌面/多數瀏覽器測試環境）應該回傳 false', () => {
  expect(needsOrientationPermission()).toBe(false);
});

test('needsOrientationPermission()：DeviceOrientationEvent 存在但沒有 requestPermission 靜態方法（Android 等）應該回傳 false', () => {
  globalThis.DeviceOrientationEvent = class {};
  expect(needsOrientationPermission()).toBe(false);
});

test('needsOrientationPermission()：DeviceOrientationEvent.requestPermission 是函式（iOS 13+）應該回傳 true', () => {
  globalThis.DeviceOrientationEvent = class {};
  globalThis.DeviceOrientationEvent.requestPermission = async () => 'granted';
  expect(needsOrientationPermission()).toBe(true);
});

test('requestOrientationPermission()：完全沒有 DeviceOrientationEvent -> unsupported', async () => {
  expect(await requestOrientationPermission()).toBe('unsupported');
});

test('requestOrientationPermission()：不需要另外要權限的瀏覽器 -> not-needed，且不會呼叫任何東西', async () => {
  globalThis.DeviceOrientationEvent = class {};
  expect(await requestOrientationPermission()).toBe('not-needed');
});

test('requestOrientationPermission()：iOS 使用者同意 -> granted', async () => {
  globalThis.DeviceOrientationEvent = class {};
  globalThis.DeviceOrientationEvent.requestPermission = async () => 'granted';
  expect(await requestOrientationPermission()).toBe('granted');
});

test('requestOrientationPermission()：iOS 使用者拒絕（resolve 非 granted 的字串）-> denied', async () => {
  globalThis.DeviceOrientationEvent = class {};
  globalThis.DeviceOrientationEvent.requestPermission = async () => 'denied';
  expect(await requestOrientationPermission()).toBe('denied');
});

test('requestOrientationPermission()：requestPermission() 本身 reject（例如非 HTTPS）-> denied，不拋例外', async () => {
  globalThis.DeviceOrientationEvent = class {};
  globalThis.DeviceOrientationEvent.requestPermission = async () => { throw new Error('not allowed'); };
  await expect(requestOrientationPermission()).resolves.toBe('denied');
});

/* ---------- computeCompassHeading() ---------- */

test('computeCompassHeading()：有 webkitCompassHeading（iOS）時直接採用，不理會 alpha', () => {
  expect(computeCompassHeading({ webkitCompassHeading: 123.4, alpha: 999 })).toBe(123.4);
});

test('computeCompassHeading()：webkitCompassHeading 為 0（面朝正北）是合法讀數，不能被當成「沒有」', () => {
  expect(computeCompassHeading({ webkitCompassHeading: 0, alpha: 45 })).toBe(0);
});

test('computeCompassHeading()：沒有 webkitCompassHeading 時退回 (360-alpha)%360', () => {
  expect(computeCompassHeading({ alpha: 90 })).toBe(270);
  expect(computeCompassHeading({ alpha: 0 })).toBe(0);
  expect(computeCompassHeading({ alpha: 350 })).toBe(10);
});

test('computeCompassHeading()：alpha 缺失（null/undefined/NaN）回傳 null，呼叫端不應該誤更新成 0', () => {
  expect(computeCompassHeading({ alpha: null })).toBeNull();
  expect(computeCompassHeading({ alpha: undefined })).toBeNull();
  expect(computeCompassHeading({ alpha: NaN })).toBeNull();
  expect(computeCompassHeading({})).toBeNull();
});

/* ---------- startWatchingHeading() ---------- */

test('startWatchingHeading()：deviceorientationabsolute 事件（absolute:true）觸發時，正確算出方位並呼叫 onHeading', () => {
  const headings = [];
  const stop = startWatchingHeading((h) => headings.push(h));
  window._dispatch('deviceorientationabsolute', { alpha: 90, absolute: true });
  expect(headings).toEqual([270]);
  stop();
});

test('startWatchingHeading()：deviceorientation 事件但 absolute 不是 true（部分裝置只有相對角度）應該被忽略，不呼叫 onHeading', () => {
  const headings = [];
  const stop = startWatchingHeading((h) => headings.push(h));
  window._dispatch('deviceorientation', { alpha: 90, absolute: false });
  window._dispatch('deviceorientation', { alpha: 90 }); // 完全沒有 absolute 屬性
  expect(headings).toEqual([]);
  stop();
});

test('startWatchingHeading()：deviceorientation 事件有 webkitCompassHeading（iOS）一律當成可用，不理會 absolute', () => {
  const headings = [];
  const stop = startWatchingHeading((h) => headings.push(h));
  window._dispatch('deviceorientation', { webkitCompassHeading: 45, absolute: false });
  expect(headings).toEqual([45]);
  stop();
});

test('startWatchingHeading()：alpha 缺失的絕對方位事件不應該呼叫 onHeading（避免誤更新成 0）', () => {
  const headings = [];
  const stop = startWatchingHeading((h) => headings.push(h));
  window._dispatch('deviceorientationabsolute', { alpha: null, absolute: true });
  expect(headings).toEqual([]);
  stop();
});

test('startWatchingHeading()：stop() 之後不應該再收到任何事件', () => {
  const headings = [];
  const stop = startWatchingHeading((h) => headings.push(h));
  window._dispatch('deviceorientationabsolute', { alpha: 0, absolute: true });
  expect(headings.length).toBe(1);
  stop();
  window._dispatch('deviceorientationabsolute', { alpha: 90, absolute: true });
  expect(headings.length, 'stop() 之後事件不應該再觸發 onHeading').toBe(1);
});

test('startWatchingHeading()：兩個不同事件名稱各自觸發一次，各自都會呼叫 onHeading（不會互相取消）', () => {
  const headings = [];
  const stop = startWatchingHeading((h) => headings.push(h));
  window._dispatch('deviceorientationabsolute', { alpha: 0, absolute: true });
  window._dispatch('deviceorientation', { webkitCompassHeading: 10 });
  expect(headings).toEqual([0, 10]);
  stop();
});
