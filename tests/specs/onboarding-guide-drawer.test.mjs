import '../env-stub.mjs';
import { test, expect, afterEach } from 'vitest';
import { openGuideDrawer } from '../../src/ui/onboarding.js';

// buildGuideDrawer() 用 innerHTML 組整個抽屜內容，假 DOM（env-stub.mjs）的 innerHTML
// setter 不會真的解析出子節點，drawer.querySelector('.guide-drawer-close') 在這個
// 假環境裡一定拿 null 而丟例外，沒辦法端對端渲染整個抽屜。這裡只驗證 openGuideDrawer()
// 的「已經開著就擋住第二次」guard 本身：手動塞一個代表「已開啟」的節點進
// document.body，呼叫 openGuideDrawer() 應該提早 return，不會再去呼叫
// buildGuideDrawer()（也就不會走到那段在假環境會噴例外的 innerHTML 渲染路徑）。
// 修正前沒有這個 guard，同樣的呼叫會直接嘗試渲染而拋出例外，這個測試會如預期失敗。
afterEach(() => {
  document.querySelectorAll('.guide-help-drawer').forEach((n) => n.remove());
});

test('連點「使用指南」入口：已經開著就擋住第二次，不會重新渲染', () => {
  const fakeOpen = document.createElement('div');
  fakeOpen.className = 'guide-drawer guide-help-drawer';
  document.body.appendChild(fakeOpen);
  try{
    expect(() => openGuideDrawer()).not.toThrow();
    expect(document.querySelectorAll('.guide-help-drawer')).toHaveLength(1);
  } finally {
    fakeOpen.remove();
  }
});
