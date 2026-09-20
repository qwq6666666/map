import { test, expect, beforeEach } from 'vitest';
import { bindAvailCollapse, isAvailCollapsed, resetAvailCollapse } from '../../src/ui/availCollapse.js';

// 假節點：只需要 classList.toggle／setAttribute／addEventListener／textContent／title
function fakePanel(){
  const classes = new Set();
  return {
    classes,
    classList: { toggle: (c, on) => { if(on) classes.add(c); else classes.delete(c); }, contains: (c) => classes.has(c) }
  };
}
function fakeButton(){
  const listeners = [];
  return {
    textContent: '', title: '', attrs: {},
    setAttribute(k, v){ this.attrs[k] = v; },
    addEventListener(type, fn){ if(type === 'click') listeners.push(fn); },
    click(){ listeners.forEach((fn) => fn()); }
  };
}

beforeEach(() => resetAvailCollapse());

test('預設展開：鈕顯示 ▾、aria-expanded=true、面板沒有收合 class', () => {
  const panel = fakePanel(), btn = fakeButton();
  bindAvailCollapse(panel, btn);
  expect(btn.textContent).toBe('▾');
  expect(btn.attrs['aria-expanded']).toBe('true');
  expect(panel.classList.contains('avail-collapsed')).toBe(false);
});

test('點收合鈕：收合／再點展開，文字與 aria 跟著變', () => {
  const panel = fakePanel(), btn = fakeButton();
  bindAvailCollapse(panel, btn);
  btn.click();
  expect(panel.classList.contains('avail-collapsed')).toBe(true);
  expect(btn.textContent).toBe('▸');
  expect(btn.attrs['aria-expanded']).toBe('false');
  expect(btn.title).toContain('展開');
  btn.click();
  expect(panel.classList.contains('avail-collapsed')).toBe(false);
  expect(btn.textContent).toBe('▾');
});

test('收合偏好跨搜尋保留：下一輪重建面板時仍是收合', () => {
  const p1 = fakePanel(), b1 = fakeButton();
  bindAvailCollapse(p1, b1);
  b1.click();
  expect(isAvailCollapsed()).toBe(true);

  const p2 = fakePanel(), b2 = fakeButton(); // 新搜尋＝全新 DOM
  bindAvailCollapse(p2, b2);
  expect(p2.classList.contains('avail-collapsed')).toBe(true);
  expect(b2.textContent).toBe('▸');
});

test('expand()：收合時展開（多選模式要操作清單）、本來就展開則不動', () => {
  const panel = fakePanel(), btn = fakeButton();
  const c = bindAvailCollapse(panel, btn);
  c.expand();
  expect(isAvailCollapsed()).toBe(false);
  btn.click();
  expect(panel.classList.contains('avail-collapsed')).toBe(true);
  c.expand();
  expect(panel.classList.contains('avail-collapsed')).toBe(false);
  expect(btn.textContent).toBe('▾');
});
