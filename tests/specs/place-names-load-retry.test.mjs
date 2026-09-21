import '../env-stub.mjs';
import { test, expect, vi, beforeEach, afterEach } from 'vitest';

/* ---------------------------------------------------------
   tests/specs/place-names-load-retry.test.mjs
   ---------------------------------------------------------
   地名今昔對照資料（10MB）第一次搜尋時才載入。載入失敗（斷網、HTTP
   錯誤）不能被永久快取，否則手機第一次搜尋剛好沒網路，整個 session
   之後都查無地名。失敗後有一段冷卻時間（避免每打一個字就重打一次 10MB
   的請求），冷卻過後自動重試；成功之後才吃記憶體快取。

   placeNames.js 的載入快取是模組層級狀態，每個測試都用
   vi.resetModules() 取得乾淨的模組實例。
--------------------------------------------------------- */

const PLACE = {
  name: '德化社', aliases: [], county: '南投縣', town: '魚池鄉',
  description: '', sourceType: 'settlement', longitude: 120.9, latitude: 23.8
};

const originalFetch = globalThis.fetch;
let fetchCalls;
let fetchBehavior; // 'fail' | 'http500' | 'ok'

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  fetchCalls = 0;
  fetchBehavior = 'fail';
  globalThis.fetch = async () => {
    fetchCalls++;
    if(fetchBehavior === 'fail') throw new Error('network down');
    if(fetchBehavior === 'http500') return { ok: false, status: 500 };
    return { ok: true, status: 200, json: async () => ({ places: [PLACE] }) };
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function loadModule(){
  return import('../../src/features/placeNames.js');
}

test('載入失敗時回傳空陣列，不丟例外', async () => {
  const { findPlaceNameCandidates } = await loadModule();
  expect(await findPlaceNameCandidates('德化社')).toEqual([]);
  expect(fetchCalls).toBe(1);
});

test('失敗後的冷卻時間內不重打請求（避免每打一個字就重載 10MB）', async () => {
  const { findPlaceNameCandidates } = await loadModule();
  await findPlaceNameCandidates('德化社');
  fetchBehavior = 'ok'; // 就算網路已經恢復，冷卻內也不重打
  await findPlaceNameCandidates('德化社');
  await findPlaceNameCandidates('德化社');
  expect(fetchCalls, '冷卻期間只有第一次真的 fetch').toBe(1);
});

test('冷卻過後自動重試，成功就能查到地名（不會整個 session 都查無）', async () => {
  const { findPlaceNameCandidates, PLACE_NAMES_RETRY_COOLDOWN_MS } = await loadModule();
  expect(await findPlaceNameCandidates('德化社')).toEqual([]);

  fetchBehavior = 'ok';
  vi.setSystemTime(Date.now() + PLACE_NAMES_RETRY_COOLDOWN_MS + 1);
  const result = await findPlaceNameCandidates('德化社');
  expect(result.length, '重試成功後應查到地名').toBe(1);
  expect(result[0].name).toBe('德化社');
  expect(fetchCalls).toBe(2);
});

test('HTTP 錯誤（非 2xx）同樣不永久快取', async () => {
  fetchBehavior = 'http500';
  const { findPlaceNameCandidates, PLACE_NAMES_RETRY_COOLDOWN_MS } = await loadModule();
  expect(await findPlaceNameCandidates('德化社')).toEqual([]);

  fetchBehavior = 'ok';
  vi.setSystemTime(Date.now() + PLACE_NAMES_RETRY_COOLDOWN_MS + 1);
  expect((await findPlaceNameCandidates('德化社')).length).toBe(1);
});

test('成功載入後吃記憶體快取，不會再打第二次', async () => {
  fetchBehavior = 'ok';
  const { findPlaceNameCandidates } = await loadModule();
  await findPlaceNameCandidates('德化社');
  await findPlaceNameCandidates('德化社');
  expect(fetchCalls).toBe(1);
});
