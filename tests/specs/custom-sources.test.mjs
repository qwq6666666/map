import '../env-stub.mjs';
import { test, beforeEach, run, assertEqual, assertTrue } from '../assert.mjs';
import {
  state as store,
  addCustomSource, removeCustomSource, clearCustomSources,
  toggleMultiOverlayLayer, clearMultiOverlayLayers
} from '../../src/store.js';
import { titleForKey, attributionForKey, makeSourceForKey, setCustomSourcesProvider, DATA } from '../../src/data.js';

// 跟 features/multiOverlay.js 的 initMultiOverlayUI() 做的事一樣：
// 註冊「怎麼拿到目前自訂來源清單」給 data.js。
setCustomSourcesProvider(() => store.customSources);

// 每個測試開始前重設乾淨狀態，改用 beforeEach 掛上去，
// 不用在下面每個 test() 開頭都手動呼叫一次。
beforeEach(() => {
  clearCustomSources();
  clearMultiOverlayLayers();
  localStorage.clear();
});

test('addCustomSource 會產生唯一 id，並自動存進 localStorage', () => {
  const entry = addCustomSource({ name: '測試圖層', urlTemplate: 'https://example.com/{z}/{x}/{y}.png' });
  assertTrue(!!entry.id, '應該有自動產生的 id');
  assertEqual(store.customSources.length, 1, 'customSources 應該有 1 筆');
  const raw = localStorage.getItem('hundredYearMap:customSources');
  assertTrue(!!raw, '應該已經寫入 localStorage');
  const parsed = JSON.parse(raw);
  assertEqual(parsed[0].id, entry.id, 'localStorage 存的內容要跟 store 一致');
});

test('沒填名稱時預設用「未命名圖層」，不會是空字串', () => {
  const entry = addCustomSource({ urlTemplate: 'https://example.com/{z}/{x}/{y}.png' });
  assertEqual(entry.name, '未命名圖層', '應該有預設名稱');
});

test('titleForKey／makeSourceForKey 對 custom: 開頭的 key 能正確查到自訂來源', () => {
  const entry = addCustomSource({ name: '日本 GSI 地形圖', urlTemplate: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', attribution: '地理院タイル' });
  const key = `custom:${entry.id}`;
  assertEqual(titleForKey(key), '日本 GSI 地形圖', 'titleForKey 應該回傳自訂來源的名稱');
  const source = makeSourceForKey(key);
  assertTrue(!!source, 'makeSourceForKey 應該回傳一個 OL source（沒有拋例外）');
});

test('titleForKey 對已刪除／不存在的 custom key 會退回顯示 key 本身，不拋例外', () => {
  assertEqual(titleForKey('custom:not-exist'), 'custom:not-exist', '找不到時應該退回 key 字串');
});

test('attributionForKey：底圖／custom 兩種 key 都能查到對應的版權標示', () => {
  assertEqual(attributionForKey('base:osm'), '© OpenStreetMap contributors', '現代地圖底圖應回傳 OSM 版權標示');
  assertEqual(attributionForKey('base:sat'), 'Esri, Maxar, Earthstar Geographics', '衛星底圖應回傳 Esri 版權標示');

  const entry = addCustomSource({ name: '日本 GSI 地形圖', urlTemplate: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', attribution: '地理院タイル' });
  assertEqual(attributionForKey(`custom:${entry.id}`), '地理院タイル', '自訂來源應回傳使用者填寫的版權標示');
});

test('attributionForKey：hist 圖層回傳所屬來源的版權標示（來源共用，不需要真的存在這個 layer id）', () => {
  // 不依賴真實 bundle 資料（DATA.LAYER_SOURCES 要不要在這個測試檔的執行
  // 時機點被填充，取決於其他測試檔有沒有先呼叫過 loadAppData()，不可靠），
  // 直接塞一筆假來源、測完立刻復原，做法比照本檔案其餘測試用
  // addCustomSource() 建立獨立假資料的精神。
  const fakeSrc = { id: 'attribution-test-src', attribution: '測試來源版權標示', categories: [] };
  DATA.LAYER_SOURCES.push(fakeSrc);
  try{
    assertEqual(attributionForKey('hist:attribution-test-src:not-a-real-layer:jpg'), '測試來源版權標示', 'hist 圖層應回傳所屬來源的版權標示');
  } finally {
    DATA.LAYER_SOURCES.pop();
  }
});

test('attributionForKey：查不到時回傳空字串，不拋例外', () => {
  assertEqual(attributionForKey('custom:not-exist'), '', '找不到自訂來源時應回傳空字串');
  assertEqual(attributionForKey('hist:not-a-real-source:x:jpg'), '', '找不到來源時應回傳空字串');
});

test('removeCustomSource 會一併把它從 multiOverlayLayers 移除', () => {
  const entry = addCustomSource({ name: 'A', urlTemplate: 'https://example.com/{z}/{x}/{y}.png' });
  const key = `custom:${entry.id}`;
  toggleMultiOverlayLayer(key); // 勾選加入複合疊圖
  assertEqual(store.multiOverlayLayers.length, 1, '應該已經加入疊圖組合');

  removeCustomSource(entry.id);
  assertEqual(store.customSources.length, 0, 'customSources 應該清空');
  assertEqual(store.multiOverlayLayers.length, 0, '同一個 key 也應該從 multiOverlayLayers 移除，避免殘留失效的 key');
});

test('clearCustomSources 會清空所有自訂來源，並移除疊圖組合裡對應的項目，保留其他 hist: 圖層', () => {
  const a = addCustomSource({ name: 'A', urlTemplate: 'https://example.com/a/{z}/{x}/{y}.png' });
  const b = addCustomSource({ name: 'B', urlTemplate: 'https://example.com/b/{z}/{x}/{y}.png' });
  toggleMultiOverlayLayer(`custom:${a.id}`);
  toggleMultiOverlayLayer(`custom:${b.id}`);
  toggleMultiOverlayLayer('hist:sinica:JM25K_1921:jpg'); // 混一筆內建圖層，確認不會被誤刪

  clearCustomSources();
  assertEqual(store.customSources.length, 0, '自訂來源應該清空');
  assertEqual(store.multiOverlayLayers.length, 1, '應該只剩下那筆內建圖層');
  assertEqual(store.multiOverlayLayers[0].key, 'hist:sinica:JM25K_1921:jpg', '剩下的應該是內建圖層，不是自訂圖層');
});

test('重新從 localStorage 讀取：模擬重新整理頁面後清單還在', () => {
  addCustomSource({ name: '重開機也要在', urlTemplate: 'https://example.com/{z}/{x}/{y}.png' });
  const raw = localStorage.getItem('hundredYearMap:customSources');
  const parsed = JSON.parse(raw);
  assertEqual(parsed.length, 1, 'localStorage 應該保留這筆資料，供下次載入頁面時還原');
});

await run();
