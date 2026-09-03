import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import {
  state as store,
  addCustomSource, removeCustomSource, clearCustomSources,
  toggleMultiOverlayLayer, clearMultiOverlayLayers
} from '../../src/store.js';
import { titleForKey, makeSourceForKey, setCustomSourcesProvider } from '../../src/data.js';

// 跟 features/multiOverlay.js 的 initMultiOverlayUI() 做的事一樣：
// 註冊「怎麼拿到目前自訂來源清單」給 data.js。
setCustomSourcesProvider(() => store.customSources);

function reset(){
  clearCustomSources();
  clearMultiOverlayLayers();
  localStorage.clear();
}

test('addCustomSource 會產生唯一 id，並自動存進 localStorage', () => {
  reset();
  const entry = addCustomSource({ name: '測試圖層', urlTemplate: 'https://example.com/{z}/{x}/{y}.png' });
  assertTrue(!!entry.id, '應該有自動產生的 id');
  assertEqual(store.customSources.length, 1, 'customSources 應該有 1 筆');
  const raw = localStorage.getItem('hundredYearMap:customSources');
  assertTrue(!!raw, '應該已經寫入 localStorage');
  const parsed = JSON.parse(raw);
  assertEqual(parsed[0].id, entry.id, 'localStorage 存的內容要跟 store 一致');
});

test('沒填名稱時預設用「未命名圖層」，不會是空字串', () => {
  reset();
  const entry = addCustomSource({ urlTemplate: 'https://example.com/{z}/{x}/{y}.png' });
  assertEqual(entry.name, '未命名圖層', '應該有預設名稱');
});

test('titleForKey／makeSourceForKey 對 custom: 開頭的 key 能正確查到自訂來源', () => {
  reset();
  const entry = addCustomSource({ name: '日本 GSI 地形圖', urlTemplate: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', attribution: '地理院タイル' });
  const key = `custom:${entry.id}`;
  assertEqual(titleForKey(key), '日本 GSI 地形圖', 'titleForKey 應該回傳自訂來源的名稱');
  const source = makeSourceForKey(key);
  assertTrue(!!source, 'makeSourceForKey 應該回傳一個 OL source（沒有拋例外）');
});

test('titleForKey 對已刪除／不存在的 custom key 會退回顯示 key 本身，不拋例外', () => {
  reset();
  assertEqual(titleForKey('custom:not-exist'), 'custom:not-exist', '找不到時應該退回 key 字串');
});

test('removeCustomSource 會一併把它從 multiOverlayLayers 移除', () => {
  reset();
  const entry = addCustomSource({ name: 'A', urlTemplate: 'https://example.com/{z}/{x}/{y}.png' });
  const key = `custom:${entry.id}`;
  toggleMultiOverlayLayer(key); // 勾選加入複合疊圖
  assertEqual(store.multiOverlayLayers.length, 1, '應該已經加入疊圖組合');

  removeCustomSource(entry.id);
  assertEqual(store.customSources.length, 0, 'customSources 應該清空');
  assertEqual(store.multiOverlayLayers.length, 0, '同一個 key 也應該從 multiOverlayLayers 移除，避免殘留失效的 key');
});

test('clearCustomSources 會清空所有自訂來源，並移除疊圖組合裡對應的項目，保留其他 hist: 圖層', () => {
  reset();
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
  reset();
  addCustomSource({ name: '重開機也要在', urlTemplate: 'https://example.com/{z}/{x}/{y}.png' });
  const raw = localStorage.getItem('hundredYearMap:customSources');
  const parsed = JSON.parse(raw);
  assertEqual(parsed.length, 1, 'localStorage 應該保留這筆資料，供下次載入頁面時還原');
});

await run();
