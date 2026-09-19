import '../env-stub.mjs';
import { test, beforeEach, expect, vi } from 'vitest';
import { loadAppData, DATA } from '../../src/data.js';
import { initMapCore } from '../../src/mapCore.js';
import { initSidebar } from '../../src/sidebarUI.js';
import { initSearchUI } from '../../src/searchUI.js';
import { state as store, setState } from '../../src/store.js';
import { map } from '../../src/core/map.js';
import { buildShareURL, copyShareLink, applyShareStateFromURL, shareStateHasCustomLayers, buildLiveShareURL, initLiveShareURL } from '../../src/features/shareLink.js';

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
// 用 beforeEach 掛上去，不用在下面每個 test() 開頭都手動呼叫一次
// （原本的寫法、也是 DEVELOPMENT.md 提到的「寫測試時的陷阱」典型樣板）。
function resetToDefault(){
  setState({
    mode: 'overlay',
    baseLayer: 'osm',
    activeOverlayKey: null,
    compareA: 'hist:sinica:JM20K_1904:jpg',
    compareB: 'base:osm',
    swipePercent: 50,
    overlayOpacity: 100,
    multiOverlayLayers: [],
  });
  map.getView().setCenter([120.9, 23.7]);
  map.getView().setZoom(8);
  location.search = '';
}

beforeEach(resetToDefault);

/* ---------------------------------------------------------
   buildShareURL()
--------------------------------------------------------- */

test('預設狀態下網址只帶 cmpA/cmpB（compareA/compareB 本身有非 null 預設值，不比對預設；其他欄位都是預設值不寫入）', () => {
  const url = buildShareURL();
  const qs = url.split('?')[1] || '';
  const params = new URLSearchParams(qs);
  expect(params.get('mode'), '預設 mode 不寫入').toBe(null);
  expect(params.get('base'), '預設 base 不寫入').toBe(null);
  expect(params.get('overlay'), 'activeOverlayKey 預設是 null，不寫入').toBe(null);
  expect(params.get('swipe'), '預設 swipe 不寫入').toBe(null);
  expect(params.get('multi'), '空陣列不寫入').toBe(null);
  expect(params.get('lon'), '中心點沒變不寫入').toBe(null);
  expect(params.get('lat'), '中心點沒變不寫入').toBe(null);
  expect(params.get('zoom'), '縮放沒變不寫入').toBe(null);
  expect(params.get('cmpA'), 'cmpA 有值就一定寫').toBe('hist:sinica:JM20K_1904:jpg');
  expect(params.get('cmpB'), 'cmpB 有值就一定寫').toBe('base:osm');
});

test('改變 mode／baseLayer／swipePercent 後網址正確帶上對應參數', () => {
  setState({ mode: 'compare', baseLayer: 'sat', swipePercent: 30 });
  const params = new URLSearchParams(buildShareURL().split('?')[1]);
  expect(params.get('mode'), 'mode 應該出現').toBe('compare');
  expect(params.get('base'), 'base 應該出現').toBe('sat');
  expect(params.get('swipe'), 'swipe 應該出現').toBe('30');
});

test('activeOverlayKey 有值時 overlay 參數會出現', () => {
  setState({ activeOverlayKey: keyA });
  const params = new URLSearchParams(buildShareURL().split('?')[1]);
  expect(params.get('overlay'), 'overlay 應該出現').toBe(keyA);
});

test('overlay/timeline 模式下 overlayOpacity 非預設才寫入 opacity；比對／複合疊圖模式不寫', () => {
  expect(new URLSearchParams(buildShareURL().split('?')[1]).get('opacity'), '預設 100 不寫入').toBe(null);
  setState({ overlayOpacity: 40 });
  expect(new URLSearchParams(buildShareURL().split('?')[1]).get('opacity'), 'overlay 模式應該寫入').toBe('40');
  setState({ mode: 'timeline' });
  expect(new URLSearchParams(buildShareURL().split('?')[1]).get('opacity'), 'timeline 模式應該寫入').toBe('40');
  setState({ mode: 'compare' });
  expect(new URLSearchParams(buildShareURL().split('?')[1]).get('opacity'), 'compare 模式不寫').toBe(null);
  setState({ mode: 'overlay' });
});

test('multiOverlayLayers 會編碼成 key,opacity 用分號串接的 multi 參數', () => {
  setState({ multiOverlayLayers: [{ key: keyA, opacity: 100 }, { key: keyB, opacity: 40 }] });
  const params = new URLSearchParams(buildShareURL().split('?')[1]);
  expect(params.get('multi'), 'multi 應該正確編碼').toBe(`${keyA},100;${keyB},40`);
});

test('地圖中心點/縮放沒變時不出現 lon/lat/zoom，變了才出現', () => {
  let params = new URLSearchParams(buildShareURL().split('?')[1]);
  expect(params.get('lon'), '沒變不該出現 lon').toBe(null);

  map.getView().setCenter([121.5, 25.05]);
  map.getView().setZoom(12);
  params = new URLSearchParams(buildShareURL().split('?')[1]);
  expect(params.get('lon'), 'lon 應該出現').toBe('121.5');
  expect(params.get('lat'), 'lat 應該出現').toBe('25.05');
  expect(params.get('zoom'), 'zoom 應該出現').toBe('12');
});

test('activeOverlayKey/compareA/compareB/multiOverlayLayers 是 custom: 開頭時，網址不會帶對應參數', () => {
  setState({
    activeOverlayKey: 'custom:my-source',
    compareA: 'custom:my-source',
    compareB: 'custom:my-source',
    multiOverlayLayers: [{ key: keyA, opacity: 100 }, { key: 'custom:my-source', opacity: 40 }]
  });
  const params = new URLSearchParams(buildShareURL().split('?')[1]);
  expect(params.get('overlay'), 'custom: overlay 不應該寫入網址').toBe(null);
  expect(params.get('cmpA'), 'custom: cmpA 不應該寫入網址').toBe(null);
  expect(params.get('cmpB'), 'custom: cmpB 不應該寫入網址').toBe(null);
  expect(params.get('multi'), 'multi 只保留非 custom: 的圖層').toBe(`${keyA},100`);
});

test('shareStateHasCustomLayers()：純函式偵測目前狀態是否含有分享連結不會帶到的自訂圖層', () => {
  expect(shareStateHasCustomLayers(), '預設狀態（compareA/compareB 都是內建 key）不應該偵測到 custom 圖層').toBe(false);

  setState({ activeOverlayKey: 'custom:my-source' });
  expect(shareStateHasCustomLayers(), 'activeOverlayKey 是 custom: 時應該偵測到').toBeTruthy();

  setState({ activeOverlayKey: null, multiOverlayLayers: [{ key: 'custom:my-source', opacity: 100 }] });
  expect(shareStateHasCustomLayers(), 'multiOverlayLayers 裡有 custom: 時應該偵測到').toBeTruthy();

  setState({ multiOverlayLayers: [{ key: keyA, opacity: 100 }] });
  expect(shareStateHasCustomLayers(), '全部都是 hist: 圖層時不應該偵測到').toBe(false);
});

/* ---------------------------------------------------------
   applyShareStateFromURL()
--------------------------------------------------------- */

test('完全沒有相關參數時回傳 false，不覆蓋現有狀態', () => {
  setState({ mode: 'compare' }); // 先弄成非預設，確認函式沒亂動它
  location.search = '?unrelated=1';
  const result = applyShareStateFromURL();
  expect(result, '沒有相關參數應該回傳 false').toBe(false);
  expect(store.mode, '不該覆蓋現有 mode').toBe('compare');
  setState({ mode: 'overlay' });
});

test('合法的 overlay/cmpA/cmpB 能正確還原', () => {
  location.search = `?overlay=${encodeURIComponent(keyA)}&cmpA=${encodeURIComponent(keyB)}&cmpB=base:sat`;
  const result = applyShareStateFromURL();
  expect(result, '應該回傳 true').toBeTruthy();
  expect(store.activeOverlayKey, 'overlay 正確還原').toBe(keyA);
  expect(store.compareA, 'cmpA 正確還原').toBe(keyB);
  expect(store.compareB, 'cmpB 正確還原').toBe('base:sat');
});

test('mode=compare 跟 cmpA/cmpB 一起還原時，compareA 不會被 enterCompareMode() 的預設值蓋掉', () => {
  // 這是原本會踩到的坑：modeManager.js 的 render() 一旦看到 changedKeys
  // 有 'mode' 就只呼叫 applyModeTransition() 後 return，切進比對模式的
  // enterCompareMode() 又會把 compareA 重設成目前疊圖模式的圖層/底圖，
  // 如果 shareLink.js 把 mode 跟 compareA/compareB 塞進同一次 setState()，
  // enterCompareMode() 的預設值就會蓋掉分享連結原本要還原的左側圖層。
  location.search = `?mode=compare&cmpA=${encodeURIComponent(keyA)}&cmpB=${encodeURIComponent(keyB)}`;
  const result = applyShareStateFromURL();
  expect(result, '應該回傳 true').toBeTruthy();
  expect(store.mode, 'mode 正確還原').toBe('compare');
  expect(store.compareA, 'compareA 應該是分享連結指定的圖層，不是 enterCompareMode() 的預設值').toBe(keyA);
  expect(store.compareB, 'compareB 正確還原').toBe(keyB);
});

test('不存在的 hist 圖層 key、custom: 開頭 key 都會被忽略，但同批其他合法欄位仍正常還原', () => {
  // 刻意不帶 mode=compare：切到 compare 模式會觸發 features/compareMode.js
  // 的 enterCompareMode() 額外把 compareA 重設成目前的 activeOverlayKey／
  // 底圖（見該檔案「左側初始值以透明疊圖目前選擇的圖層為準」的設計），
  // 混進來會誤把這個測試要驗證的「compareA 該不該被 shareLink 自己的
  // 驗證邏輯覆蓋」跟「compare 模式本身進場的側效應」搞混，改用 base
  // 當作陪同驗證的合法欄位，只單純測 shareLink.js 自己的驗證邏輯。
  location.search = `?overlay=hist:sinica:not-a-real-layer:jpg&cmpA=custom:my-layer&cmpB=${encodeURIComponent(keyA)}&base=sat`;
  const before = { activeOverlayKey: store.activeOverlayKey, compareA: store.compareA };
  const result = applyShareStateFromURL();
  expect(result, '至少有 cmpB/base 合法，應該回傳 true').toBeTruthy();
  expect(store.activeOverlayKey, '不存在的 hist key 應該被忽略，不覆蓋').toBe(before.activeOverlayKey);
  expect(store.compareA, 'custom: 開頭 key 應該被忽略，不覆蓋').toBe(before.compareA);
  expect(store.compareB, 'cmpB 是合法 key，應該正常還原').toBe(keyA);
  expect(store.baseLayer, 'base 是合法值，應該正常還原').toBe('sat');
});

test('opacity 參數能還原到 store，超出範圍 clamp，不是數字則忽略', () => {
  location.search = `?overlay=${encodeURIComponent(keyA)}&opacity=35`;
  expect(applyShareStateFromURL(), '應該回傳 true').toBeTruthy();
  expect(store.overlayOpacity, 'opacity 正確還原').toBe(35);
  expect(store.activeOverlayKey, '同批 overlay 一起還原').toBe(keyA);
  location.search = '?opacity=250';
  applyShareStateFromURL();
  expect(store.overlayOpacity, '超過 100 應 clamp').toBe(100);
  location.search = '?opacity=-5';
  applyShareStateFromURL();
  expect(store.overlayOpacity, '負數應 clamp 成 0').toBe(0);
  setState({ overlayOpacity: 60 });
  location.search = '?opacity=abc';
  applyShareStateFromURL();
  expect(store.overlayOpacity, '非數字忽略，維持原值').toBe(60);
});

test('multi 參數單筆壞掉只跳過那一筆，opacity 超出範圍會被 clamp', () => {
  location.search = `?multi=${encodeURIComponent(`${keyA},150;hist:sinica:not-real:jpg,50;${keyB},-20`)}`;
  const result = applyShareStateFromURL();
  expect(result, '至少一筆合法應該回傳 true').toBeTruthy();
  expect(store.multiOverlayLayers.length, '壞掉那一筆應該被跳過').toBe(2);
  const a = store.multiOverlayLayers.find(e => e.key === keyA);
  const b = store.multiOverlayLayers.find(e => e.key === keyB);
  expect(a.opacity, 'opacity 超過 100 應該被 clamp 成 100').toBe(100);
  expect(b.opacity, 'opacity 小於 0 應該被 clamp 成 0').toBe(0);
});

test('zoom/lon/lat 不是合法數字時會被忽略，不呼叫 setCenter/setZoom', () => {
  const beforeCenter = map.getView().getCenter();
  const beforeZoom = map.getView().getZoom();
  location.search = '?lon=abc&lat=xyz&zoom=notanumber';
  const result = applyShareStateFromURL();
  expect(result, '全部都不合法，applied 應該維持 false').toBe(false);
  expect(map.getView().getCenter(), '不該呼叫 setCenter').toBe(beforeCenter);
  expect(map.getView().getZoom(), '不該呼叫 setZoom').toBe(beforeZoom);
});

test('合法的 lon/lat/zoom 能正確還原地圖視角', () => {
  location.search = '?lon=121.5&lat=25.05&zoom=12';
  const result = applyShareStateFromURL();
  expect(result, '應該回傳 true').toBeTruthy();
  expect(map.getView().getCenter()[0], 'lon 正確還原').toBe(121.5);
  expect(map.getView().getCenter()[1], 'lat 正確還原').toBe(25.05);
  expect(map.getView().getZoom(), 'zoom 正確還原').toBe(12);
});

/* ---------------------------------------------------------
   copyShareLink()
--------------------------------------------------------- */

test('navigator.clipboard.writeText 成功時回傳 true', async () => {
  navigator.clipboard = { writeText: async () => {} };
  const result = await copyShareLink();
  expect(result, '應該回傳 true').toBe(true);
  delete navigator.clipboard;
});

test('navigator.clipboard 不存在時退回 execCommand fallback', async () => {
  delete navigator.clipboard;
  const result = await copyShareLink();
  expect(typeof result === 'boolean', '應該回傳 boolean，不噴例外').toBeTruthy();
});

test('navigator.clipboard.writeText 失敗時退回 execCommand fallback，不噴例外', async () => {
  navigator.clipboard = { writeText: async () => { throw new Error('模擬複製失敗'); } };
  const result = await copyShareLink();
  expect(typeof result === 'boolean', '應該回傳 boolean，不噴例外').toBeTruthy();
  delete navigator.clipboard;
});

/* ---------------------------------------------------------
   即時同步網址列（buildLiveShareURL／initLiveShareURL）
--------------------------------------------------------- */

test('buildLiveShareURL：預設狀態網址列乾淨（不帶 cmpA/cmpB），非分享參數與 hash 原樣保留', () => {
  location.search = '?utm_source=x&zoom=3';
  location.hash = '#top';
  expect(buildLiveShareURL(), '分享參數被重算（預設值不寫入）、utm 與 hash 保留').toBe('/?utm_source=x#top');
  location.hash = '';
});

test('buildLiveShareURL：比對模式才帶 cmpA/cmpB，切回疊圖模式後不帶', () => {
  setState({ mode: 'compare' });
  setState({ compareA: keyA }); // 切進比對模式時 enterCompareMode() 會重設左側，所以要等切完再指定
  const inCompare = new URLSearchParams(buildLiveShareURL().split('?')[1]);
  expect(inCompare.get('mode'), '比對模式帶 mode').toBe('compare');
  expect(inCompare.get('cmpA'), '比對模式帶 cmpA').toBe(keyA);
  setState({ mode: 'overlay' });
  expect(buildLiveShareURL(), '疊圖模式預設狀態不帶任何參數').toBe('/');
});

test('initLiveShareURL：狀態變動或地圖 moveend 後 debounce 一次 replaceState，dispose 後不再更新', () => {
  vi.useFakeTimers();
  const replaceState = vi.fn();
  globalThis.history = { state: null, replaceState };
  const dispose = initLiveShareURL();
  try{
    setState({ activeOverlayKey: keyA });
    setState({ overlayOpacity: 55 });
    map._triggerMoveEnd();
    expect(replaceState, 'debounce 期間不應立刻寫入').not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    expect(replaceState, '連續變動只寫一次').toHaveBeenCalledTimes(1);
    const url = replaceState.mock.calls[0][2];
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('overlay'), '網址列帶目前圖層').toBe(keyA);
    expect(params.get('opacity'), '網址列帶透明度').toBe('55');

    dispose();
    setState({ overlayOpacity: 20 });
    vi.advanceTimersByTime(600);
    expect(replaceState, 'dispose 後不再寫入').toHaveBeenCalledTimes(1);
  }finally{
    dispose();
    vi.useRealTimers();
    delete globalThis.history;
  }
});
