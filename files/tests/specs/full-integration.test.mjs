import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue, sleep } from '../assert.mjs';
import { loadAppData, LAYER_SOURCES } from '../../src/data.js';
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
  await sleep(500);
  const inner = document.getElementById('mapTimelineBarInner');
  const dots = inner.querySelectorAll('.timeline-dot');
  assertEqual(dots.length, 15, '方案 A（1:25,000 系列）應該有 15 筆');
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

  scaleSwitch._listeners['click'][0]({ target: btn50k, preventDefault(){}, stopPropagation(){} });
  await sleep(400);
  const inner = document.getElementById('mapTimelineBarInner');
  const dots = inner.querySelectorAll('.timeline-dot');
  assertEqual(dots.length, 9, '1:50,000 系列應該有 9 筆');
});

test('三種模式可以依序切換回疊圖模式，不拋出例外', async () => {
  setMode('compare');
  setMode('overlay');
  assertTrue(true, '沒有拋出例外就算通過');
});

await run();
