// removeDrawerAnimated：沒有動畫就當場移除（手機版／減少動態效果／假環境），
// 有動畫則等 animationend，animationend 沒來時用逾時保底，動畫中重複呼叫不重複處理。
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { removeDrawerAnimated, registerDrawerEscape } from '../../src/ui/drawerClose.js';

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

// registerDrawerEscape：使用指南／來源狀態／我的軌跡三個抽屜各自在 document
// 掛一個 bubble-phase keydown 監聽器處理 Esc（互不知情、也不會 stopPropagation
// 擋下對方）。若兩個抽屜疊著開（例如開著「使用指南」時又從「⋯更多」開「我的
// 軌跡」），瀏覽器對同一節點、同一事件階段的多個監聽器會依註冊順序全部觸發：
// 按一次 Esc 會把兩個都關掉，而不是只關使用者看得到的最上層那個。
// 修正前（各自呼叫 document.addEventListener('keydown', onKeydown)）就是這樣，
// 這裡改成共用堆疊，只有最後註冊（視覺最上層）的那個回應 Esc。
test('registerDrawerEscape：兩個抽屜疊著開，Esc 只關最上層那個，不會兩個一起關掉', () => {
  const keydownHandlers = [];
  globalThis.document = { addEventListener: (ev, fn) => { if(ev === 'keydown') keydownHandlers.push(fn); } };
  try{
    // 比照真實呼叫端（onboarding.js／trackListUI.js）：close() 自己呼叫
    // registerDrawerEscape() 回傳的 unregister，把自己從堆疊移除。
    const closedOrder = [];
    let unregisterA, unregisterB;
    const closeA = () => { closedOrder.push('A'); unregisterA(); };
    const closeB = () => { closedOrder.push('B'); unregisterB(); };
    unregisterA = registerDrawerEscape(closeA); // 先開：使用指南
    unregisterB = registerDrawerEscape(closeB); // 後開、疊在上面：我的軌跡

    keydownHandlers.forEach((fn) => fn({ key: 'Escape' }));
    expect(closedOrder, '只有最上層的 B 關閉，A 應該還開著').toEqual(['B']);

    // B 已在自己的 close() 裡 unregister，堆疊只剩 A，這次換 A 回應 Esc。
    keydownHandlers.forEach((fn) => fn({ key: 'Escape' }));
    expect(closedOrder, 'B 關閉後改由 A 回應下一次 Esc').toEqual(['B', 'A']);
  } finally {
    delete globalThis.document;
  }
});
