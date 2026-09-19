// removeDrawerAnimated：沒有動畫就當場移除（手機版／減少動態效果／假環境），
// 有動畫則等 animationend，animationend 沒來時用逾時保底，動畫中重複呼叫不重複處理。
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { removeDrawerAnimated } from '../../src/ui/drawerClose.js';

function makeEl(){
  const classes = new Set();
  const listeners = {};
  return {
    removed: false,
    classList: {
      add: (c) => classes.add(c),
      contains: (c) => classes.has(c)
    },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    fire: (type) => listeners[type]?.(),
    remove(){ this.removed = true; }
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  vi.useRealTimers();
  delete globalThis.getComputedStyle;
});

test('沒有 getComputedStyle（假環境）→ 立即移除', () => {
  const overlay = makeEl();
  const drawer = makeEl();
  removeDrawerAnimated(overlay, drawer);
  expect(overlay.removed).toBe(true);
  expect(drawer.removed).toBe(true);
});

test('animationName 為 none（手機版／減少動態效果）→ 立即移除', () => {
  globalThis.getComputedStyle = () => ({ animationName: 'none' });
  const overlay = makeEl();
  const drawer = makeEl();
  removeDrawerAnimated(overlay, drawer);
  expect(overlay.removed).toBe(true);
  expect(drawer.removed).toBe(true);
});

test('有動畫 → 先加 is-closing、不立即移除，animationend 後才移除', () => {
  globalThis.getComputedStyle = () => ({ animationName: 'drawer-slide-out' });
  const overlay = makeEl();
  const drawer = makeEl();
  removeDrawerAnimated(overlay, drawer);
  expect(drawer.classList.contains('is-closing')).toBe(true);
  expect(overlay.classList.contains('is-closing')).toBe(true);
  expect(drawer.removed).toBe(false);
  drawer.fire('animationend');
  expect(overlay.removed).toBe(true);
  expect(drawer.removed).toBe(true);
});

test('有動畫但 animationend 沒觸發 → 逾時保底移除，遮罩不會卡在畫面上', () => {
  globalThis.getComputedStyle = () => ({ animationName: 'drawer-slide-out' });
  const overlay = makeEl();
  const drawer = makeEl();
  removeDrawerAnimated(overlay, drawer);
  vi.advanceTimersByTime(399);
  expect(drawer.removed).toBe(false);
  vi.advanceTimersByTime(2);
  expect(overlay.removed).toBe(true);
  expect(drawer.removed).toBe(true);
});

test('動畫進行中重複呼叫（連點、Esc）→ 不重複處理', () => {
  const getStyle = vi.fn(() => ({ animationName: 'drawer-slide-out' }));
  globalThis.getComputedStyle = getStyle;
  const overlay = makeEl();
  const drawer = makeEl();
  removeDrawerAnimated(overlay, drawer);
  removeDrawerAnimated(overlay, drawer);
  expect(getStyle).toHaveBeenCalledTimes(1);
});
