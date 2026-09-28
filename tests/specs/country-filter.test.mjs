import '../env-stub.mjs';
import { test, expect } from 'vitest';
import { createCountryFilterBar } from '../../src/ui/countryFilter.js';

function fakeEntry(country){
  const wrap = document.createElement('div');
  wrap.className = 'source-group open';
  return { src: { country }, wrap };
}

test('預設顯示「台灣」，其餘國家的來源初始就標上 country-hidden', () => {
  const entries = [fakeEntry('tw'), fakeEntry('cn'), fakeEntry('other')];
  const { getCurrent } = createCountryFilterBar(() => entries);
  expect(getCurrent()).toBe('tw');
});

test('refresh()：只顯示目前分類的來源，其餘加上 country-hidden 且收合展開狀態', () => {
  const entries = [fakeEntry('tw'), fakeEntry('cn')];
  const { refresh } = createCountryFilterBar(() => entries);
  refresh();
  expect(entries[0].wrap.classList.contains('country-hidden')).toBe(false);
  expect(entries[1].wrap.classList.contains('country-hidden')).toBe(true);
  expect(entries[1].wrap.classList.contains('open')).toBe(false); // 篩掉時順便收合
});

test('點擊按鈕切換分類：套用篩選、按鈕 active 狀態互斥、呼叫 onChange(current)', () => {
  const entries = [fakeEntry('tw'), fakeEntry('cn'), fakeEntry('other')];
  const onChangeCalls = [];
  const { bar, getCurrent } = createCountryFilterBar(() => entries, (c) => onChangeCalls.push(c));
  const [twBtn, cnBtn, otherBtn] = bar.children;
  expect(twBtn.classList.contains('active')).toBe(true);

  cnBtn.click();
  expect(getCurrent()).toBe('cn');
  expect(twBtn.classList.contains('active')).toBe(false);
  expect(cnBtn.classList.contains('active')).toBe(true);
  expect(entries[1].wrap.classList.contains('country-hidden')).toBe(false); // cn 現在顯示
  expect(entries[0].wrap.classList.contains('country-hidden')).toBe(true); // tw 被篩掉
  expect(onChangeCalls).toEqual(['cn']);

  otherBtn.click();
  expect(getCurrent()).toBe('other');
  expect(onChangeCalls).toEqual(['cn', 'other']);
});

test('點擊目前已選取的分類不做事：不重新 refresh、不呼叫 onChange', () => {
  const entries = [fakeEntry('tw')];
  const onChangeCalls = [];
  const { bar } = createCountryFilterBar(() => entries, (c) => onChangeCalls.push(c));
  const [twBtn] = bar.children;
  twBtn.click(); // 已經是 tw，點了也不算「改變」
  expect(onChangeCalls).toEqual([]);
});

test('沒有傳 onChange 時（multiOverlay.js／compareMode.js 的用法）切換分類不會噴例外', () => {
  const entries = [fakeEntry('tw'), fakeEntry('cn')];
  const { bar } = createCountryFilterBar(() => entries);
  const [, cnBtn] = bar.children;
  expect(() => cnBtn.click()).not.toThrow();
});

test('bar 依 COUNTRY_LABELS 順序建立台灣／中國／其他三顆按鈕', () => {
  const { bar } = createCountryFilterBar(() => []);
  expect(bar.children.map((b) => b.textContent)).toEqual(['台灣', '中國', '其他']);
});
