import { test, expect } from 'vitest';
import { waitFor } from '../assert.mjs';
import '../env-stub.mjs';

import { loadAppData } from '../../src/data.js';
import { initMapCore } from '../../src/mapCore.js';
import { initSidebar } from '../../src/sidebarUI.js';
import { initSearchUI } from '../../src/searchUI.js';
import { initDrawTool } from '../../src/drawTool.js';
import { setMode } from '../../src/store.js';

test('整個應用程式可以完整初始化，不拋出任何例外', async () => {
  await loadAppData();
  initMapCore();
  initSidebar();
  initSearchUI();
  initDrawTool();
});

test('時間軸模式：進入後會依方案 A 清單探測，得到 15 筆圖層', async () => {
  setMode('timeline');
  // setMode('timeline') 觸發的 activateTimelineMode()/refreshNow() 是
  // fire-and-forget（背景逐筆圖磚探測完成後才 buildTimeline()），呼叫端
  // 沒有回傳可以 await 的 Promise；改成輪詢「.timeline-dot 真的渲染出來」
  // 這個可觀察條件，取代原本賭一個經驗值夠不夠長的 sleep(500)。
  const inner = document.getElementById('mapTimelineBarInner');
  await waitFor(() => inner.querySelectorAll('.timeline-dot').length > 0, {
    message: '時間軸模式進入後，逾時仍未渲染出任何 .timeline-dot（背景圖磚探測流程可能卡住）'
  });
  const dots = inner.querySelectorAll('.timeline-dot');
  expect(dots.length, '方案 A（1:25,000 系列）應該有 15 筆').toBe(15);
});

test('時間軸模式：切換到 1:50,000 系列會重新探測，得到 9 筆', async () => {
  const scaleSwitch = document.getElementById('mapTimelineScaleSwitch');
  const btn50k = document.createElement('button');
  btn50k.dataset.scale = '50k';
  scaleSwitch.appendChild(btn50k);
  const btn25k = document.createElement('button');
  btn25k.dataset.scale = '25k';
  btn25k.classList.add('active');
  scaleSwitch.appendChild(btn25k);
  // 補上 closest()（測試環境的簡化版）讓事件代理找得到正確按鈕
  scaleSwitch.closest = function(){ return null; };
  btn50k.closest = function(sel){ return sel === 'button[data-scale]' ? btn50k : null; };

  const inner = document.getElementById('mapTimelineBarInner');
  scaleSwitch._listeners['click'][0]({ target: btn50k, preventDefault(){}, stopPropagation(){} });
  // 同上一個測試：改輪詢「重新探測完成、渲染出剛好 9 筆」取代固定 sleep(400)。
  await waitFor(() => inner.querySelectorAll('.timeline-dot').length === 9, {
    message: '切換到 1:50,000 系列後，逾時仍未渲染出 9 筆 .timeline-dot（背景圖磚探測流程可能卡住）'
  });
  const dots = inner.querySelectorAll('.timeline-dot');
  expect(dots.length, '1:50,000 系列應該有 9 筆').toBe(9);
});

test('三種模式可以依序切換回疊圖模式，不拋出例外', async () => {
  setMode('compare');
  setMode('overlay');
  expect(true, '沒有拋出例外就算通過').toBeTruthy();
});
