import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import { loadAppData, DATA } from '../../src/data.js';
import { initMapCore } from '../../src/mapCore.js';
import { initSidebar } from '../../src/sidebarUI.js';
import { initSearchUI } from '../../src/searchUI.js';
import { state as store, setState } from '../../src/store.js';
import { map } from '../../src/core/map.js';
import { buildShareURL, copyShareLink, applyShareStateFromURL } from '../../src/features/shareLink.js';

await loadAppData();
initMapCore();
initSidebar();
initSearchUI();

const sinica = DATA.LAYER_SOURCES.find(s => s.id === 'sinica');
const layerA = sinica.categories[0].layers[0];
const layerB = sinica.categories[0].layers[1];
const keyA = `hist:sinica:${layerA.id}:${layerA.fmt}`;
const keyB = `hist:sinica:${layerB.id}:${layerB.fmt}`;

// 每個測試開始前重設成乾淨的預設狀態，避免測試互相汙染。
function resetToDefault(){
  setState({
    mode: 'overlay',
    baseLayer: 'osm',
    activeOverlayKey: null,
    compareA: 'hist:sinica:JM20K_1904:jpg',
    compareB: 'base:osm',
    swipePercent: 50,
    multiOverlayLayers: [],
  });
  map.getView().setCenter([120.9, 23.7]);
  map.getView().setZoom(8);
  location.search = '';
}

/* ---------------------------------------------------------
   buildShareURL()
--------------------------------------------------------- */

test('預設狀態下網址只帶 cmpA/cmpB（compareA/compareB 本身有非 null 預設值，不比對預設；其他欄位都是預設值不寫入）', () => {
  resetToDefault();
  const url = buildShareURL();
  const qs = url.split('?')[1] || '';
  const params = new URLSearchParams(qs);
  assertEqual(params.get('mode'), null, '預設 mode 不寫入');
  assertEqual(params.get('base'), null, '預設 base 不寫入');
  assertEqual(params.get('overlay'), null, 'activeOverlayKey 預設是 null，不寫入');
  assertEqual(params.get('swipe'), null, '預設 swipe 不寫入');
  assertEqual(params.get('multi'), null, '空陣列不寫入');
  assertEqual(params.get('lon'), null, '中心點沒變不寫入');
  assertEqual(params.get('lat'), null, '中心點沒變不寫入');
  assertEqual(params.get('zoom'), null, '縮放沒變不寫入');
  assertEqual(params.get('cmpA'), 'hist:sinica:JM20K_1904:jpg', 'cmpA 有值就一定寫');
  assertEqual(params.get('cmpB'), 'base:osm', 'cmpB 有值就一定寫');
});

test('改變 mode／baseLayer／swipePercent 後網址正確帶上對應參數', () => {
  resetToDefault();
  setState({ mode: 'compare', baseLayer: 'sat', swipePercent: 30 });
  const params = new URLSearchParams(buildShareURL().split('?')[1]);
  assertEqual(params.get('mode'), 'compare', 'mode 應該出現');
  assertEqual(params.get('base'), 'sat', 'base 應該出現');
  assertEqual(params.get('swipe'), '30', 'swipe 應該出現');
});

test('activeOverlayKey 有值時 overlay 參數會出現', () => {
  resetToDefault();
  setState({ activeOverlayKey: keyA });
  const params = new URLSearchParams(buildShareURL().split('?')[1]);
  assertEqual(params.get('overlay'), keyA, 'overlay 應該出現');
});

test('multiOverlayLayers 會編碼成 key,opacity 用分號串接的 multi 參數', () => {
  resetToDefault();
  setState({ multiOverlayLayers: [{ key: keyA, opacity: 100 }, { key: keyB, opacity: 40 }] });
  const params = new URLSearchParams(buildShareURL().split('?')[1]);
  assertEqual(params.get('multi'), `${keyA},100;${keyB},40`, 'multi 應該正確編碼');
});

test('地圖中心點/縮放沒變時不出現 lon/lat/zoom，變了才出現', () => {
  resetToDefault();
  let params = new URLSearchParams(buildShareURL().split('?')[1]);
  assertEqual(params.get('lon'), null, '沒變不該出現 lon');

  map.getView().setCenter([121.5, 25.05]);
  map.getView().setZoom(12);
  params = new URLSearchParams(buildShareURL().split('?')[1]);
  assertEqual(params.get('lon'), '121.5', 'lon 應該出現');
  assertEqual(params.get('lat'), '25.05', 'lat 應該出現');
  assertEqual(params.get('zoom'), '12', 'zoom 應該出現');
});

/* ---------------------------------------------------------
   applyShareStateFromURL()
--------------------------------------------------------- */

test('完全沒有相關參數時回傳 false，不覆蓋現有狀態', () => {
  resetToDefault();
  setState({ mode: 'compare' }); // 先弄成非預設，確認函式沒亂動它
  location.search = '?unrelated=1';
  const result = applyShareStateFromURL();
  assertEqual(result, false, '沒有相關參數應該回傳 false');
  assertEqual(store.mode, 'compare', '不該覆蓋現有 mode');
  setState({ mode: 'overlay' });
});

test('合法的 overlay/cmpA/cmpB 能正確還原', () => {
  resetToDefault();
  location.search = `?overlay=${encodeURIComponent(keyA)}&cmpA=${encodeURIComponent(keyB)}&cmpB=base:sat`;
  const result = applyShareStateFromURL();
  assertTrue(result, '應該回傳 true');
  assertEqual(store.activeOverlayKey, keyA, 'overlay 正確還原');
  assertEqual(store.compareA, keyB, 'cmpA 正確還原');
  assertEqual(store.compareB, 'base:sat', 'cmpB 正確還原');
});

test('mode=compare 跟 cmpA/cmpB 一起還原時，compareA 不會被 enterCompareMode() 的預設值蓋掉', () => {
  // 這是原本會踩到的坑：modeManager.js 的 render() 一旦看到 changedKeys
  // 有 'mode' 就只呼叫 applyModeTransition() 後 return，切進比對模式的
  // enterCompareMode() 又會把 compareA 重設成目前疊圖模式的圖層/底圖，
  // 如果 shareLink.js 把 mode 跟 compareA/compareB 塞進同一次 setState()，
  // enterCompareMode() 的預設值就會蓋掉分享連結原本要還原的左側圖層。
  resetToDefault();
  location.search = `?mode=compare&cmpA=${encodeURIComponent(keyA)}&cmpB=${encodeURIComponent(keyB)}`;
  const result = applyShareStateFromURL();
  assertTrue(result, '應該回傳 true');
  assertEqual(store.mode, 'compare', 'mode 正確還原');
  assertEqual(store.compareA, keyA, 'compareA 應該是分享連結指定的圖層，不是 enterCompareMode() 的預設值');
  assertEqual(store.compareB, keyB, 'compareB 正確還原');
});

test('不存在的 hist 圖層 key、custom: 開頭 key 都會被忽略，但同批其他合法欄位仍正常還原', () => {
  // 刻意不帶 mode=compare：切到 compare 模式會觸發 features/compareMode.js
  // 的 enterCompareMode() 額外把 compareA 重設成目前的 activeOverlayKey／
  // 底圖（見該檔案「左側初始值以透明疊圖目前選擇的圖層為準」的設計），
  // 混進來會誤把這個測試要驗證的「compareA 該不該被 shareLink 自己的
  // 驗證邏輯覆蓋」跟「compare 模式本身進場的側效應」搞混，改用 base
  // 當作陪同驗證的合法欄位，只單純測 shareLink.js 自己的驗證邏輯。
  resetToDefault();
  location.search = `?overlay=hist:sinica:not-a-real-layer:jpg&cmpA=custom:my-layer&cmpB=${encodeURIComponent(keyA)}&base=sat`;
  const before = { activeOverlayKey: store.activeOverlayKey, compareA: store.compareA };
  const result = applyShareStateFromURL();
  assertTrue(result, '至少有 cmpB/base 合法，應該回傳 true');
  assertEqual(store.activeOverlayKey, before.activeOverlayKey, '不存在的 hist key 應該被忽略，不覆蓋');
  assertEqual(store.compareA, before.compareA, 'custom: 開頭 key 應該被忽略，不覆蓋');
  assertEqual(store.compareB, keyA, 'cmpB 是合法 key，應該正常還原');
  assertEqual(store.baseLayer, 'sat', 'base 是合法值，應該正常還原');
});

test('multi 參數單筆壞掉只跳過那一筆，opacity 超出範圍會被 clamp', () => {
  resetToDefault();
  location.search = `?multi=${encodeURIComponent(`${keyA},150;hist:sinica:not-real:jpg,50;${keyB},-20`)}`;
  const result = applyShareStateFromURL();
  assertTrue(result, '至少一筆合法應該回傳 true');
  assertEqual(store.multiOverlayLayers.length, 2, '壞掉那一筆應該被跳過');
  const a = store.multiOverlayLayers.find(e => e.key === keyA);
  const b = store.multiOverlayLayers.find(e => e.key === keyB);
  assertEqual(a.opacity, 100, 'opacity 超過 100 應該被 clamp 成 100');
  assertEqual(b.opacity, 0, 'opacity 小於 0 應該被 clamp 成 0');
});

test('zoom/lon/lat 不是合法數字時會被忽略，不呼叫 setCenter/setZoom', () => {
  resetToDefault();
  const beforeCenter = map.getView().getCenter();
  const beforeZoom = map.getView().getZoom();
  location.search = '?lon=abc&lat=xyz&zoom=notanumber';
  const result = applyShareStateFromURL();
  assertEqual(result, false, '全部都不合法，applied 應該維持 false');
  assertEqual(map.getView().getCenter(), beforeCenter, '不該呼叫 setCenter');
  assertEqual(map.getView().getZoom(), beforeZoom, '不該呼叫 setZoom');
});

test('合法的 lon/lat/zoom 能正確還原地圖視角', () => {
  resetToDefault();
  location.search = '?lon=121.5&lat=25.05&zoom=12';
  const result = applyShareStateFromURL();
  assertTrue(result, '應該回傳 true');
  assertEqual(map.getView().getCenter()[0], 121.5, 'lon 正確還原');
  assertEqual(map.getView().getCenter()[1], 25.05, 'lat 正確還原');
  assertEqual(map.getView().getZoom(), 12, 'zoom 正確還原');
});

/* ---------------------------------------------------------
   copyShareLink()
--------------------------------------------------------- */

test('navigator.clipboard.writeText 成功時回傳 true', async () => {
  resetToDefault();
  navigator.clipboard = { writeText: async () => {} };
  const result = await copyShareLink();
  assertEqual(result, true, '應該回傳 true');
  delete navigator.clipboard;
});

test('navigator.clipboard 不存在時退回 execCommand fallback', async () => {
  resetToDefault();
  delete navigator.clipboard;
  const result = await copyShareLink();
  assertTrue(typeof result === 'boolean', '應該回傳 boolean，不噴例外');
});

test('navigator.clipboard.writeText 失敗時退回 execCommand fallback，不噴例外', async () => {
  resetToDefault();
  navigator.clipboard = { writeText: async () => { throw new Error('模擬複製失敗'); } };
  const result = await copyShareLink();
  assertTrue(typeof result === 'boolean', '應該回傳 boolean，不噴例外');
  delete navigator.clipboard;
});

await run();
