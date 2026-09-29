/* ---------------------------------------------------------
   mobile-layout.test.mjs — src/ui/mobileLayout.js 基本回歸測試
   ---------------------------------------------------------
   mobileLayout.js 先前完全零測試覆蓋：模組頂層直接呼叫
   `window.matchMedia(...)`，但 tests/env-stub.mjs 的假 window 原本沒
   有提供 matchMedia，只要有測試 import 這支檔案就會在載入階段直接
   拋例外。env-stub.mjs 已補上假 matchMedia／MutationObserver，這裡
   不追求覆蓋全部 675 行的細節，只涵蓋：
     1. 模組能被正常 import、initMobileLayout() 呼叫不拋錯（含
        mq.matches 為 false／true 兩種情境，用 setStubViewportWidth()
        觸發 matchMedia 的 change 事件模擬跨越 768px 門檻）。
     2. Bottom Sheet 展開/收合二態切換（拖曳把手純點擊＝toggle）。
     3. 搜尋列模式切換（地址／圖資）按鈕行為。

   跟 main.js 的初始化順序一致：initSidebarToggle()（來自
   ui/sidebarToggle.js）要先於 initMobileLayout() 呼叫，因為
   mobileLayout.js 內部會呼叫 collapseSidebar()/expandSidebar()，
   這兩個函式依賴 initSidebarToggle() 準備好的 floatingOpacityEl／
   toggleSidebarBtn 模組內部狀態，沒先呼叫會噴例外。這支測試刻意不
   呼叫完整的 initMapCore()（需要 loadAppData() 等重量級初始化），
   只準備 mobileLayout.js 實際會用到的最小依賴。
--------------------------------------------------------- */
import { test, expect } from 'vitest';
import { setStubViewportWidth } from '../env-stub.mjs';
import { initSidebarToggle } from '../../src/ui/sidebarToggle.js';
import { initMobileLayout } from '../../src/ui/mobileLayout.js';

initSidebarToggle();

test('initMobileLayout() 在桌面寬度（mq.matches=false）下可以正常呼叫，不拋錯', () => {
  initMobileLayout();
});

test('setStubViewportWidth() 觸發 matchMedia change 跨進手機寬度後，body 套用手機搜尋模式 class', () => {
  setStubViewportWidth(500); // <=768px，跨過手機門檻
  expect(document.body.classList.contains('mobile-search-mode-address'), '進入手機版預設應該是地址搜尋模式').toBeTruthy();
});

test('第一次進入手機寬度時，Bottom Sheet 應強制收合成 peek 態', () => {
  const sidebar = document.getElementById('sidebar');
  expect(sidebar.classList.contains('collapsed'), '首次進入手機版應該自動收合成 peek').toBeTruthy();
});

test('Bottom Sheet 拖曳把手：純點擊（無明顯位移）可在收合/展開二態間切換', () => {
  const sheetHandle = document.getElementById('sheetHandle');
  const sidebar = document.getElementById('sidebar');
  expect(sidebar.classList.contains('collapsed'), '測試前應該處於收合狀態（延續上一個測試）').toBeTruthy();

  // 直接呼叫 addEventListener 註冊進去的 handler，模擬「按下、沒有明顯
  // 位移、放開」的純點擊手勢（onPointerUp 判斷 moved 為 false 時視為
  // 點擊，兩態互相切換）。
  sheetHandle._listeners['pointerdown'][0]({ clientY: 100, pointerId: 1 });
  sheetHandle._listeners['pointerup'][0]({ clientY: 100 });
  expect(!sidebar.classList.contains('collapsed'), '點擊把手後應該展開').toBeTruthy();

  sheetHandle._listeners['pointerdown'][0]({ clientY: 100, pointerId: 1 });
  sheetHandle._listeners['pointerup'][0]({ clientY: 100 });
  expect(sidebar.classList.contains('collapsed'), '再點擊一次應該收合回去').toBeTruthy();
});

test('Bottom Sheet 拖曳把手：拖曳中途第二指觸碰把手，不應重置已判定的拖曳狀態（回歸測試）', () => {
  // 延續上一個測試的結尾狀態（peek/collapsed），從展開態開始更容易驗證：
  // 先用純點擊展開一次。
  const sheetHandle = document.getElementById('sheetHandle');
  const sidebar = document.getElementById('sidebar');
  if(sidebar.classList.contains('collapsed')){
    sheetHandle._listeners['pointerdown'][0]({ clientY: 100, pointerId: 1 });
    sheetHandle._listeners['pointerup'][0]({ clientY: 100 });
  }
  expect(!sidebar.classList.contains('collapsed'), '測試前應先處於展開狀態').toBeTruthy();

  // 第一指按下、小幅位移（>6px 已判定為拖曳，moved=true）。
  sheetHandle._listeners['pointerdown'][0]({ clientY: 100, pointerId: 1 });
  sheetHandle._listeners['pointermove'][0]({ clientY: 120, pointerId: 1 });
  // 第二指中途觸碰同一顆把手（雙指誤觸／上一指未放開又來一指）：修正前
  // 沒有 `if(dragging) return;` 防呆，這裡會把 moved 重置為 false、
  // startY 換成第二指座標。
  sheetHandle._listeners['pointerdown'][0]({ clientY: 121, pointerId: 2 });
  // 放開（沿用同一段手勢的尾端座標，dy 僅 21px，遠小於收合門檻）。
  sheetHandle._listeners['pointerup'][0]({ clientY: 121 });

  // 修正後：moved 仍是 true，21px 的小幅拖曳離「展開(0px)」比「收合
  // (~540px)」近，應該落回展開態，維持沒有明顯變化；修正前的 bug 會讓
  // moved 被誤重置成 false，放開時走「純點擊」邏輯，直接把整個 Sheet
  // 切到收合態，即使實際位移量很小。
  expect(!sidebar.classList.contains('collapsed'), '小幅拖曳中途被第二指干擾，仍應維持展開態，不應被誤判為點擊而整個收合').toBeTruthy();
});

test('搜尋列模式切換按鈕：地址／圖資模式互相切換', () => {
  const modeBtn = document.getElementById('mobileSearchModeBtn');
  expect(document.body.classList.contains('mobile-search-mode-address'), '切換前應為地址模式').toBeTruthy();

  modeBtn.click();
  expect(document.body.classList.contains('mobile-search-mode-layer'), '切換後應為圖資搜尋模式').toBeTruthy();
  expect(!document.body.classList.contains('mobile-search-mode-address'), '切換後不應該還留著地址模式 class').toBeTruthy();

  modeBtn.click();
  expect(document.body.classList.contains('mobile-search-mode-address'), '再切一次應該切回地址搜尋模式').toBeTruthy();
});

test('回到桌面寬度後，手機搜尋模式 class 會被移除（同時清掉閒置摺疊計時器，避免測試流程被 15 秒計時器卡住）', () => {
  setStubViewportWidth(1000); // >768px，跨回桌面
  expect(!document.body.classList.contains('mobile-search-mode-address'), '回桌面版應移除手機搜尋 class').toBeTruthy();
  expect(!document.body.classList.contains('mobile-search-mode-layer'), '回桌面版應移除手機搜尋 class').toBeTruthy();
});
