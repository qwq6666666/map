import '../env-stub.mjs';
import { test, expect } from 'vitest';
import { sleep } from '../helpers.mjs';
import { loadAppData } from '../../src/data.js';
import { initMapCore } from '../../src/mapCore.js';
import { initSidebar } from '../../src/sidebarUI.js';
import { initSearchUI, showLocationAndFindLayers } from '../../src/ui/search.js';

/* ---------------------------------------------------------
   tests/specs/search-token-race.test.mjs
   ---------------------------------------------------------
   地址搜尋 A 的圖層探測還在跑時，使用者開始了新搜尋 B：
   - A 不可以在探測結束後再 bumpSearchToken()，否則會把 B 的 token 蓋掉，
     B 的結果被當成過期丟棄（面板永遠停在進度文字）；
   - A 的「附近歷史地名」清單也不可以插進 B 的結果面板。
--------------------------------------------------------- */

const GEO_LON = 120.9123;
const GEO_LAT = 23.8567;
const NEAR_PLACE = {
  name: '化番社舊址', aliases: [], county: '南投縣', town: '魚池鄉',
  description: '', sourceType: 'settlement', longitude: GEO_LON + 0.0005, latitude: GEO_LAT
};

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const urlStr = String(url);
  if(urlStr.includes('data/place-names.json')){
    return { ok: true, json: async () => ({ places: [NEAR_PLACE] }) };
  }
  if(urlStr.includes('nominatim.openstreetmap.org/search')){
    return {
      ok: true,
      json: async () => ([{ display_name: '南投縣魚池鄉測試地址', lon: String(GEO_LON), lat: String(GEO_LAT), address: {} }])
    };
  }
  return originalFetch(url, options);
};

await loadAppData();
initMapCore();
initSidebar();
initSearchUI();

const addressInput = document.getElementById('addressInput');
const addressSearchBtn = document.getElementById('addressSearchBtn');
const locationResultEl = document.getElementById('locationResult');
const layerAvailPanelEl = document.getElementById('layerAvailPanel');

test('A 的探測期間開始新搜尋 B：B 的結果照常顯示，A 的附近歷史地名不會插進來', async () => {
  addressInput.value = '測試地址A';
  const searchA = addressSearchBtn._listeners.click[0](); // 不 await：讓 A 停在圖層探測中

  // 等到 A 進入 showLocationAndFindLayers（座標資訊已出現）才開始 B
  for(let i = 0; i < 200 && !locationResultEl.querySelector('.coord-info'); i++) await sleep(0);
  expect(locationResultEl.querySelector('.coord-info'), '前置條件：A 應已進入圖層探測').toBeTruthy();

  const searchB = showLocationAndFindLayers(GEO_LON + 0.3, GEO_LAT + 0.3, '搜尋B', {});
  await Promise.all([searchA, searchB]);

  expect(layerAvailPanelEl.querySelector('.avail-progress'), 'B 的結果不該被丟棄而停在進度文字').toBeFalsy();
  expect(layerAvailPanelEl.children.length, 'B 的結果面板應該有內容').toBeGreaterThan(0);
  expect(locationResultEl.querySelector('.nearby-place-names'), 'A 的附近歷史地名不該出現在 B 的結果裡').toBeFalsy();
});

test('沒有新搜尋打斷時，一般地址搜尋照常顯示附近歷史地名', async () => {
  addressInput.value = '測試地址C';
  await addressSearchBtn._listeners.click[0]();
  expect(locationResultEl.querySelector('.nearby-place-names'), '不被打斷時應照常顯示').toBeTruthy();
});
