import { describe, test, expect, afterEach, vi } from 'vitest';
import checkUpstreamHealth from '../../tools/check-upstream-health.js';

const { parseLayerIds, buildReport, checkSource } = checkUpstreamHealth;

/* ---------------------------------------------------------
   tests/specs/check-upstream-health.test.mjs
   ---------------------------------------------------------
   tools/check-upstream-health.js 是每週一次的上游服務健檢（見 CLAUDE.md
   「CI 與上游監控」），失守的話「上游改網址／下架圖層」會一路安靜到
   前端出現空白圖層才被發現。原本零測試覆蓋，比照 pre-push-check.js／
   tools/verify-docs-sync.js 的既有模式：main() 用 require.main===module
   擋住，只 export 純邏輯（parseLayerIds／buildReport／checkSource）；
   checkSource() 的網路請求用假 globalThis.fetch 頂替，不打真的網路。
--------------------------------------------------------- */

describe('parseLayerIds', () => {
  test('抓出每個 <Layer> 區塊裡第一個 <ows:Identifier>（Layer 自己的 id）', () => {
    const xml = `<Capabilities>
      <Contents>
        <Layer>
          <ows:Identifier>JM20K_1904</ows:Identifier>
          <Style><ows:Identifier>default</ows:Identifier></Style>
        </Layer>
        <Layer>
          <ows:Identifier>JM5K_1921</ows:Identifier>
          <Style><ows:Identifier>default</ows:Identifier></Style>
        </Layer>
      </Contents>
    </Capabilities>`;
    expect(parseLayerIds(xml)).toEqual(new Set(['JM20K_1904', 'JM5K_1921']));
  });

  test('不會誤抓 Style 底下的 "default"（真正的坑：Style 的 Identifier 排在 Layer 自己的後面）', () => {
    const xml = `<Layer><ows:Identifier>real-id</ows:Identifier><Style><ows:Identifier>default</ows:Identifier></Style></Layer>`;
    const ids = parseLayerIds(xml);
    expect(ids.has('real-id')).toBe(true);
    expect(ids.has('default')).toBe(false);
    expect(ids.size).toBe(1);
  });

  test('重複的 id 只算一筆（回傳 Set，天然去重）', () => {
    const xml = `<Layer><ows:Identifier>dup</ows:Identifier></Layer><Layer><ows:Identifier>dup</ows:Identifier></Layer>`;
    expect(parseLayerIds(xml)).toEqual(new Set(['dup']));
  });

  test('沒有任何 <Layer> 區塊（例如錯誤頁面或空 Capabilities）→ 空 Set，不噴例外', () => {
    expect(parseLayerIds('<html>Not Found</html>')).toEqual(new Set());
    expect(parseLayerIds('')).toEqual(new Set());
  });

  test('<Layer> 裡沒有 <ows:Identifier>（格式異常）→ 略過這個區塊，不當成空字串 id', () => {
    const xml = `<Layer><ows:Title>沒有 Identifier</ows:Title></Layer><Layer><ows:Identifier>ok</ows:Identifier></Layer>`;
    expect(parseLayerIds(xml)).toEqual(new Set(['ok']));
  });
});

describe('buildReport', () => {
  test('全部正常：不列異常區塊，failedCount 為 0', () => {
    const { text, failedCount } = buildReport([
      { name: 'sinica_a', url: 'https://x', error: null, missingUpstream: [], newUpstream: [] }
    ]);
    expect(failedCount).toBe(0);
    expect(text).toContain('全部來源正常');
    expect(text).not.toContain('### 異常');
  });

  test('連線失敗與「本地有、上游找不到」都算異常，各自在報告裡列出', () => {
    const { text, failedCount } = buildReport([
      { name: 'down-source', url: 'https://down', error: 'HTTP 500', missingUpstream: [], newUpstream: [] },
      { name: 'missing-source', url: 'https://ok', error: null, missingUpstream: ['a', 'b'], newUpstream: [] }
    ]);
    expect(failedCount).toBe(2);
    expect(text).toContain('down-source');
    expect(text).toContain('無法取得 Capabilities：HTTP 500');
    expect(text).toContain('missing-source');
    expect(text).toContain('`a`, `b`');
  });

  test('「上游新增、本地未收錄」只出現在提示區塊，不算故障（failedCount 不計入）', () => {
    const { text, failedCount } = buildReport([
      { name: 'has-new', url: 'https://x', error: null, missingUpstream: [], newUpstream: ['NEW_LAYER'] }
    ]);
    expect(failedCount).toBe(0);
    expect(text).toContain('提示：上游有、本地尚未收錄的圖層（不算故障）');
    expect(text).toContain('NEW_LAYER');
    expect(text).not.toContain('### 異常');
  });
});

describe('checkSource', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; vi.useRealTimers(); });

  function fakeCapabilitiesResponse(xml, { ok = true, status = 200 } = {}){
    return { ok, status, statusText: 'x', text: async () => xml };
  }

  test('成功取得 Capabilities：算出 missingUpstream／newUpstream，不重試', async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return fakeCapabilitiesResponse('<Capabilities><Layer><ows:Identifier>a</ows:Identifier></Layer><Layer><ows:Identifier>b</ows:Identifier></Layer></Capabilities>');
    };
    const result = await checkSource({ name: 'src', capabilitiesUrl: 'https://x', localIds: ['a', 'gone'] });
    expect(callCount).toBe(1);
    expect(result.error).toBeNull();
    expect(result.upstreamCount).toBe(2);
    expect(result.missingUpstream).toEqual(['gone']); // 本地有、上游沒有
    expect(result.newUpstream).toEqual(['b']); // 上游有、本地沒有
  });

  // fetchCapabilities() 失敗時會重試 3 次、每次間隔用真的 setTimeout（2 秒起跳），
  // 這裡用假計時器讓重試瞬間跑完，不用真的等 6 秒以上。
  test('HTTP 非 200：重試 3 次後記錄 error，不算 missingUpstream（連不上跟圖層真的消失是兩回事）', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    globalThis.fetch = async () => { callCount++; return fakeCapabilitiesResponse('', { ok: false, status: 503 }); };
    const resultPromise = checkSource({ name: 'src', capabilitiesUrl: 'https://x', localIds: ['a'] });
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(callCount).toBe(3); // MAX_ATTEMPTS
    expect(result.error).toContain('503');
    expect(result.missingUpstream).toEqual([]);
    expect(result.upstreamCount).toBe(0);
  });

  test('回應內容不像 Capabilities 文件（例如被導到錯誤頁）：重試後仍失敗，記錄 error', async () => {
    vi.useFakeTimers();
    globalThis.fetch = async () => fakeCapabilitiesResponse('<html>404 Not Found</html>');
    const resultPromise = checkSource({ name: 'src', capabilitiesUrl: 'https://x', localIds: [] });
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result.error).toContain('不是 WMTS Capabilities');
  });
});
