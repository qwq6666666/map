import '../env-stub.mjs';
import { test, expect, beforeAll } from 'vitest';
import { loadAppData } from '../../src/data.js';
import { initMapCore } from '../../src/mapCore.js';
import { initSidebar } from '../../src/sidebarUI.js';
import { initSearchUI, showLocationAndFindLayers } from '../../src/ui/search.js';

/* ---------------------------------------------------------
   tests/specs/locate-accuracy-ui.test.mjs
   ---------------------------------------------------------
   showLocationAndFindLayers() 的第五個參數 accuracy（公尺）只有瀏覽器
   定位會傳：桌面沒有 GPS、Wi-Fi／IP 定位常差數百公尺，圖釘看起來精準
   卻可能離很遠，所以搜尋結果面板要顯示 `.locate-accuracy`。地址搜尋／
   地名比對不傳 accuracy，就不該出現這一行。

   env-stub 的假 DOM insertBefore 在參考節點不是子節點時會插到索引 0，
   所以這裡只斷言「存在／文字／不重複」，不斷言相對於座標資訊的位置。
--------------------------------------------------------- */

let locationResultEl;

beforeAll(async () => {
  await loadAppData();
  initMapCore();
  initSidebar();
  initSearchUI();
  locationResultEl = document.getElementById('locationResult');
});

const LON = 120.9123;
const LAT = 23.8567;

function accuracyEls(){
  return locationResultEl.querySelectorAll('.locate-accuracy');
}

test('傳入精度時顯示「精度 ±N 公尺」', async () => {
  await showLocationAndFindLayers(LON, LAT, '定位測試', {}, 12.4);
  const els = accuracyEls();
  expect(els.length, '應該只有一個 .locate-accuracy').toBe(1);
  expect(els[0].textContent).toBe('精度 ±12 公尺');
});

test('精度超過 100 公尺會加註「訊號較弱」', async () => {
  await showLocationAndFindLayers(LON, LAT, '定位測試', {}, 350);
  expect(accuracyEls()[0].textContent).toBe('精度 ±350 公尺（訊號較弱）');
});

test('沒傳精度（地址搜尋／地名比對）不建立 .locate-accuracy', async () => {
  await showLocationAndFindLayers(LON, LAT, '地址搜尋', {});
  expect(accuracyEls().length).toBe(0);
});

test('精度不是有限數字（NaN／null）不建立 .locate-accuracy', async () => {
  await showLocationAndFindLayers(LON, LAT, '定位測試', {}, Number.NaN);
  expect(accuracyEls().length, 'NaN').toBe(0);
  await showLocationAndFindLayers(LON, LAT, '定位測試', {}, null);
  expect(accuracyEls().length, 'null').toBe(0);
});

test('連續重新定位不會累積多個 .locate-accuracy，且上一輪的精度會被清掉', async () => {
  await showLocationAndFindLayers(LON, LAT, '第一次', {}, 20);
  await showLocationAndFindLayers(LON, LAT, '第二次', {}, 30);
  expect(accuracyEls().length, '重複定位後仍只有一個').toBe(1);
  expect(accuracyEls()[0].textContent).toBe('精度 ±30 公尺');

  await showLocationAndFindLayers(LON, LAT, '第三次（地址搜尋）', {});
  expect(accuracyEls().length, '改用地址搜尋後不應殘留上一輪的定位精度').toBe(0);
});
