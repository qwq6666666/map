import { test, expect, vi } from 'vitest';
import { initPopoverViews, liveBadgeKind, POPOVER_VIEWS } from '../../src/ui/mobilePopoverView.js';

// 假節點：只需要 dataset／scrollTop／addEventListener／querySelectorAll，不必整套假 DOM。
function fakeButton(go){
  const listeners = [];
  return {
    dataset: { popoverGo: go },
    addEventListener: (type, fn) => { if(type === 'click') listeners.push(fn); },
    click(){ listeners.forEach((fn) => fn()); }
  };
}
function fakePopover(buttons){
  return {
    dataset: {},
    scrollTop: 0,
    querySelectorAll: (sel) => (sel === '[data-popover-go]' ? buttons : [])
  };
}

test('初始是主頁；帶 data-popover-go 的按鈕負責換頁', () => {
  const more = fakeButton('more'), back = fakeButton('main');
  const pop = fakePopover([more, back]);
  const views = initPopoverViews(pop);
  expect(pop.dataset.view).toBe('main');
  more.click();
  expect(views.current()).toBe('more');
  back.click();
  expect(views.current()).toBe('main');
});

test('換頁才會通知（選單開著時要重新定位）、同一頁不重複通知', () => {
  const more = fakeButton('more');
  const pop = fakePopover([more]);
  const onChange = vi.fn();
  const views = initPopoverViews(pop, { onChange });
  views.show('main'); // 已經在主頁
  expect(onChange).not.toHaveBeenCalled();
  more.click();
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith('more');
  more.click();
  expect(onChange).toHaveBeenCalledTimes(1);
});

test('換頁時捲動位置歸零（次頁比主頁長，不能停在中間）', () => {
  const pop = fakePopover([]);
  const views = initPopoverViews(pop);
  pop.scrollTop = 120;
  views.show('more');
  expect(pop.scrollTop).toBe(0);
});

test('reset 回主頁；不認得的頁名一律當主頁', () => {
  const pop = fakePopover([]);
  const views = initPopoverViews(pop);
  views.show('more');
  views.reset();
  expect(views.current()).toBe('main');
  views.show('more');
  views.show('不存在的頁');
  expect(views.current()).toBe('main');
  expect(POPOVER_VIEWS).toEqual(['main', 'more']);
});

test('狀態角標：記錄軌跡優先，其次持續追蹤，都沒有就不顯示', () => {
  expect(liveBadgeKind({ recording: true, tracking: true })).toBe('rec');
  expect(liveBadgeKind({ recording: true })).toBe('rec');
  expect(liveBadgeKind({ tracking: true })).toBe('track');
  expect(liveBadgeKind({})).toBeNull();
  expect(liveBadgeKind()).toBeNull();
});
