import { test, expect } from 'vitest';
import { waitFor } from '../helpers.mjs';
import '../env-stub.mjs';

import { loadAppData } from '../../src/data.js';
import { initMapCore } from '../../src/mapCore.js';
import { initSidebar } from '../../src/sidebarUI.js';
import { initSearchUI } from '../../src/searchUI.js';
import { initDrawTool } from '../../src/drawTool.js';
import { setMode, state as store } from '../../src/store.js';
import { startLocationTour } from '../../src/timelineMode.js';
import { map } from '../../src/core/map.js';

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

/* ---------------------------------------------------------
   「百年導覽」（timelineMode.js 的 startLocationTour()，供
   ui/placeNameCard.js「開始百年導覽」鈕呼叫）：目前是 overlay 模式
   （上一個測試結束時設定），startLocationTour() 應該同步把地圖定位到
   指定座標、切到時間軸模式，探測完成後不用使用者按任何東西就自動開始
   播放。這裡刻意選一個跟目前地圖中心明顯不同的座標，才能證明真的是
   startLocationTour() 移動了地圖，不是恰好本來就在那附近。
--------------------------------------------------------- */
test('百年導覽：從 overlay 模式呼叫，應該同步定位地圖、切到時間軸模式、探測完成後自動開始播放', async () => {
  expect(store.mode, '前置條件：目前應該是 overlay 模式').toBe('overlay');
  const targetLonLat = [120.6736, 24.1477]; // 台中市中心，明顯不同於預設地圖中心
  startLocationTour(targetLonLat[0], targetLonLat[1]);

  expect(store.mode, 'startLocationTour() 應該同步切到時間軸模式').toBe('timeline');
  const actualLonLat = globalThis.ol.proj.toLonLat(map.getView().getCenter());
  expect(actualLonLat[0], '地圖經度應該同步移到目標座標').toBeCloseTo(targetLonLat[0], 6);
  expect(actualLonLat[1], '地圖緯度應該同步移到目標座標').toBeCloseTo(targetLonLat[1], 6);

  const inner = document.getElementById('mapTimelineBarInner');
  await waitFor(() => inner.querySelectorAll('.timeline-dot.active').length > 0, {
    message: '百年導覽探測完成後，逾時仍未自動選取任何一筆（autoplay 可能沒有生效）'
  });
  const playBtn = inner.querySelector('.timeline-play-btn');
  expect(playBtn.innerHTML.includes('#pause'), '應該不用使用者按播放鈕，直接自動進入播放中狀態').toBeTruthy();
});

test('百年導覽：已經在時間軸模式時呼叫（setMode 是 no-op），也應該正確重新定位並重新探測', async () => {
  expect(store.mode, '前置條件：延續上一個測試，目前應該已經在時間軸模式').toBe('timeline');
  const targetLonLat = [121.5170, 25.0478]; // 台北市中心，再換一個明顯不同的座標
  startLocationTour(targetLonLat[0], targetLonLat[1]);

  const actualLonLat = globalThis.ol.proj.toLonLat(map.getView().getCenter());
  expect(actualLonLat[0], '已經在時間軸模式時，也應該同步移動地圖經度').toBeCloseTo(targetLonLat[0], 6);
  expect(actualLonLat[1], '已經在時間軸模式時，也應該同步移動地圖緯度').toBeCloseTo(targetLonLat[1], 6);

  const inner = document.getElementById('mapTimelineBarInner');
  await waitFor(() => inner.querySelectorAll('.timeline-dot.active').length > 0, {
    message: '已經在時間軸模式時再次呼叫，逾時仍未自動開始播放'
  });

  setMode('overlay'); // 收尾，避免播放中的計時器／狀態影響其他測試檔案
});
