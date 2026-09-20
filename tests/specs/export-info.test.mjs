import '../env-stub.mjs';
import { test, expect } from 'vitest';
import { loadAppData } from '../../src/data.js';
import {
  collectExportInfo,
  layoutInfoBand,
  wrapTextLines,
  formatExportTimestamp
} from '../../src/features/exportInfo.js';
import { setDisplayedPlaceNameCard, getDisplayedPlaceNameCard } from '../../src/features/placeNames.js';

await loadAppData();

const KEY_1904 = 'hist:sinica:JM20K_1904:jpg';
const NOW = new Date(2026, 8, 20, 7, 5); // 2026-09-20 07:05（本地時間）

const baseStore = (over = {}) => ({
  mode: 'overlay',
  baseLayer: 'osm',
  activeOverlayKey: null,
  compareA: KEY_1904,
  compareB: 'base:osm',
  multiOverlayLayers: [],
  overlayOpacity: 100,
  ...over
});

// 每個字元 8px 寬的假 context，同 env-stub 的 measureText 概估；額外記錄
// 畫了什麼，供驗證 draw() 的輸出。
function makeRecorderCtx(){
  const calls = { fillRect: [], fillText: [] };
  return {
    calls,
    font: '', fillStyle: '', textAlign: '', textBaseline: '',
    save(){}, restore(){},
    measureText: (t) => ({ width: String(t).length * 8 }),
    fillRect: (...a) => calls.fillRect.push(a),
    fillText: (...a) => calls.fillText.push(a)
  };
}

const place = {
  name: '大灣庄',
  aliases: ['大彎', '灣裡'],
  county: '臺南市',
  town: '永康區',
  description: '清代即有的聚落。',
  sourceType: 'settlement'
};

/* ---------- collectExportInfo ---------- */

test('疊圖模式：寫出「歷史圖層：年代＋名稱」與底圖，透明度 100% 不加註', () => {
  const info = collectExportInfo({ store: baseStore({ activeOverlayKey: KEY_1904 }), now: NOW });
  expect(info.layerLines[0].text).toBe('歷史圖層：1904 日治臺灣堡圖(明治版) 1:20,000');
  expect(info.layerLines[1].text).toBe('底圖：現代地圖');
  expect(info.layerLines.length).toBe(2);
});

test('疊圖模式：透明度低於 100% 時註明百分比', () => {
  const info = collectExportInfo({ store: baseStore({ activeOverlayKey: KEY_1904, overlayOpacity: 60 }), now: NOW });
  expect(info.layerLines[0].text).toContain('（透明度 60%）');
});

test('沒有歷史圖層時只寫底圖；衛星底圖名稱與來源正確', () => {
  const info = collectExportInfo({ store: baseStore({ baseLayer: 'sat' }), now: NOW });
  expect(info.layerLines.map(l => l.text)).toEqual(['底圖：衛星影像']);
  expect(info.sourceText).toBe('圖資來源：Esri, Maxar, Earthstar Geographics');
});

test('圖資來源：歷史圖層與底圖的來源都列出，重複的只列一次，以「；」分隔', () => {
  const info = collectExportInfo({ store: baseStore({ activeOverlayKey: KEY_1904 }), now: NOW });
  expect(info.sourceText.startsWith('圖資來源：中央研究院')).toBeTruthy();
  expect(info.sourceText).toContain('；© OpenStreetMap contributors');

  const twice = collectExportInfo({
    store: baseStore({ mode: 'compare', compareA: KEY_1904, compareB: KEY_1904 }),
    now: NOW
  });
  expect(twice.sourceText.split('中央研究院').length - 1, '相同來源只出現一次').toBe(1);
});

test('比對模式：分別寫出左側／右側圖層', () => {
  const info = collectExportInfo({ store: baseStore({ mode: 'compare' }), now: NOW });
  expect(info.layerLines[0].text).toBe('左側：1904 日治臺灣堡圖(明治版) 1:20,000');
  expect(info.layerLines[1].text).toBe('右側：現代地圖');
});

test('複合疊圖模式：列出各層與透明度，超過 5 張只列前 5 張並註明其餘張數', () => {
  const layers = Array.from({ length: 7 }, (_, i) => ({ key: KEY_1904, opacity: 50 + i }));
  const info = collectExportInfo({ store: baseStore({ mode: 'multi', multiOverlayLayers: layers }), now: NOW });
  const texts = info.layerLines.map(l => l.text);
  expect(texts.filter(t => t.startsWith('疊加圖層：')).length).toBe(5);
  expect(texts[0]).toContain('（透明度 50%）');
  expect(texts).toContain('…另有 2 張疊加圖層');
  expect(texts.at(-1)).toBe('底圖：現代地圖');
});

test('時間軸模式與疊圖模式寫法相同（同樣讀 activeOverlayKey）', () => {
  const info = collectExportInfo({ store: baseStore({ mode: 'timeline', activeOverlayKey: KEY_1904 }), now: NOW });
  expect(info.layerLines[0].text.startsWith('歷史圖層：1904')).toBeTruthy();
});

test('沒有地名卡時 placeLines 是空的；有的話依序是現名、別名、位置、說明、資料來源', () => {
  expect(collectExportInfo({ store: baseStore(), now: NOW }).placeLines).toEqual([]);
  const lines = collectExportInfo({ store: baseStore(), place, now: NOW }).placeLines.map(l => l.text);
  expect(lines).toEqual([
    '地名：大灣庄',
    '別名／舊稱：大彎、灣裡',
    '現代位置：臺南市永康區',
    '清代即有的聚落。',
    '地名資料：臺灣地區地名資料（聚落類）'
  ]);
});

test('地名卡：沒有別名／說明就略過那幾行；說明過長會截斷成 120 字加「…」', () => {
  const minimal = collectExportInfo({
    store: baseStore(),
    place: { ...place, aliases: [], description: '' },
    now: NOW
  }).placeLines.map(l => l.text);
  expect(minimal.some(t => t.startsWith('別名'))).toBe(false);
  expect(minimal.length, '現名、位置、資料來源').toBe(3);

  const long = collectExportInfo({
    store: baseStore(),
    place: { ...place, description: '字'.repeat(300) },
    now: NOW
  }).placeLines.find(l => l.text.startsWith('字'));
  expect(Array.from(long.text).length).toBe(121);
  expect(long.text.endsWith('…')).toBe(true);
});

test('頁尾：匯出時間（補零）與網站網址；沒給網址就不寫', () => {
  expect(formatExportTimestamp(NOW)).toBe('2026-09-20 07:05');
  const withUrl = collectExportInfo({ store: baseStore(), now: NOW, pageUrl: 'https://example.com/map/' });
  expect(withUrl.footerText).toBe('匯出時間 2026-09-20 07:05　｜　百年歷史地圖 https://example.com/map/');
  expect(collectExportInfo({ store: baseStore(), now: NOW }).footerText).toBe('匯出時間 2026-09-20 07:05');
});

test('圖層 key 已失效（找不到對應圖層）時不會拋例外，退回 key 本身當名稱', () => {
  const info = collectExportInfo({ store: baseStore({ activeOverlayKey: 'hist:nosuch:x:png' }), now: NOW });
  expect(info.layerLines[0].text).toBe('歷史圖層：hist:nosuch:x:png');
});

/* ---------- wrapTextLines ---------- */

test('wrapTextLines：依寬度逐字折行', () => {
  const ctx = makeRecorderCtx();
  expect(wrapTextLines(ctx, 'a'.repeat(25), 80, 5)).toEqual(['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
});

test('wrapTextLines：超過最大行數時最後一行以「…」結尾且不超出寬度', () => {
  const ctx = makeRecorderCtx();
  const lines = wrapTextLines(ctx, 'a'.repeat(50), 80, 2);
  expect(lines.length).toBe(2);
  expect(lines[1].endsWith('…')).toBe(true);
  expect(ctx.measureText(lines[1]).width <= 80).toBe(true);
});

test('wrapTextLines：剛好放滿最大行數、沒有剩字時不加「…」；空字串回傳空陣列', () => {
  const ctx = makeRecorderCtx();
  expect(wrapTextLines(ctx, 'a'.repeat(20), 80, 2)).toEqual(['a'.repeat(10), 'a'.repeat(10)]);
  expect(wrapTextLines(ctx, '', 80, 2)).toEqual([]);
});

/* ---------- layoutInfoBand ---------- */

test('layoutInfoBand：有地名卡時比沒有的更高；scale 放大高度也等比放大', () => {
  const ctx = makeRecorderCtx();
  const without = layoutInfoBand(ctx, collectExportInfo({ store: baseStore(), now: NOW }), 800, 1);
  const withPlace = layoutInfoBand(ctx, collectExportInfo({ store: baseStore(), place, now: NOW }), 800, 1);
  const scaled = layoutInfoBand(ctx, collectExportInfo({ store: baseStore(), now: NOW }), 1600, 2);
  expect(withPlace.height > without.height).toBe(true);
  expect(scaled.height).toBeCloseTo(without.height * 2, 5);
});

test('layoutInfoBand.draw：底色蓋滿 top 起算的整段高度，且所有文字落在該範圍內', () => {
  const ctx = makeRecorderCtx();
  const info = collectExportInfo({ store: baseStore({ activeOverlayKey: KEY_1904 }), place, now: NOW, pageUrl: 'https://example.com/' });
  const band = layoutInfoBand(ctx, info, 800, 1);
  const out = makeRecorderCtx();
  band.draw(out, 600);
  const [x, y, w, h] = out.calls.fillRect[0];
  expect([x, y, w]).toEqual([0, 600, 800]);
  expect(h).toBeCloseTo(band.height, 5);
  expect(out.calls.fillText.length > 0).toBe(true);
  out.calls.fillText.forEach(([, , textY]) => {
    expect(textY > 600 && textY <= 600 + band.height, `文字 y=${textY} 應在資訊列範圍內`).toBe(true);
  });
  expect(out.calls.fillText.map(c => c[0]).join('')).toContain('匯出時間');
});

/* ---------- placeNames 的「顯示中卡片」狀態 ---------- */

test('setDisplayedPlaceNameCard／getDisplayedPlaceNameCard：可設定、可清除（null／undefined 都視為清除）', () => {
  setDisplayedPlaceNameCard(place);
  expect(getDisplayedPlaceNameCard()).toBe(place);
  setDisplayedPlaceNameCard(null);
  expect(getDisplayedPlaceNameCard()).toBeNull();
  setDisplayedPlaceNameCard(place);
  setDisplayedPlaceNameCard(undefined);
  expect(getDisplayedPlaceNameCard()).toBeNull();
});
