/* ---------------------------------------------------------
   tests/specs/source-status.test.mjs
   ---------------------------------------------------------
   features/sourceStatus.js：驗證探測網址組出來是正確的（sinica 樣板式
   ／udd literalUrl 式各一種）、依主機分組正確，以及 ok/slow/down 三種
   狀態分類的判斷邊界（用純函式 classifyProbeResult 測，不用真的等
   逾時／5 秒門檻）。checkAllSourceStatuses() 端到端流程另外用假 Image
   驗證一次。
--------------------------------------------------------- */
import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import { loadAppData, DATA } from '../../src/data.js';
import {
  buildProbeUrl, buildSourceStatusTargets, hostOf,
  classifyProbeResult, checkAllSourceStatuses
} from '../../src/features/sourceStatus.js';

await loadAppData();

test('hostOf：從完整網址正確取出 host', () => {
  assertEqual(hostOf('https://gis.sinica.edu.tw/beijing/file-exists.php?img=x'), 'gis.sinica.edu.tw', 'https 網址');
  assertEqual(hostOf('http://example.com/a/b'), 'example.com', 'http 網址');
});

test('buildProbeUrl：sinica 樣板式來源，{id}/{format}/{z}/{x}/{y} 都被正確代換', () => {
  const sinica = DATA.LAYER_SOURCES.find(s => s.id === 'sinica');
  const url = buildProbeUrl(sinica);
  assertTrue(!!url, '應該組得出網址');
  assertTrue(url.startsWith('https://gis.sinica.edu.tw/'), '應該是 sinica 的主機');
  assertTrue(!/\{.*\}/.test(url), '不應該殘留任何未代換的 {佔位符}');
});

test('buildProbeUrl：udd literalUrl 式來源，直接用該圖層自己的 url 樣板代換 z/y/x', () => {
  const udd = DATA.LAYER_SOURCES.find(s => s.id === 'udd');
  const url = buildProbeUrl(udd);
  assertTrue(!!url, '應該組得出網址');
  assertTrue(url.startsWith('https://'), '應該是完整網址');
  assertTrue(!/\{.*\}/.test(url), '不應該殘留任何未代換的 {佔位符}');
});

test('buildSourceStatusTargets：同一台主機（sinica）底下多個來源會合併成同一筆，且都在 sources 清單裡', () => {
  const targets = buildSourceStatusTargets();
  const sinicaHostTarget = targets.find(t => t.host === 'gis.sinica.edu.tw');
  assertTrue(!!sinicaHostTarget, '應該有 gis.sinica.edu.tw 這筆');
  assertTrue(sinicaHostTarget.sources.length > 5, 'sinica 主機底下應該有一大批來源共用（實際遠超過 5 個）');
  assertTrue(sinicaHostTarget.sources.some(s => s.id === 'sinica'), '應該包含 sinica 本身');
  assertTrue(sinicaHostTarget.sources.some(s => s.id === 'beijing'), '應該包含同樣掛在這台主機下的 beijing');
});

test('buildSourceStatusTargets：udd／nlsc 各自是獨立主機，不會被併進 sinica 那筆', () => {
  const targets = buildSourceStatusTargets();
  const hosts = targets.map(t => t.host);
  assertTrue(hosts.includes('www.historygis.udd.gov.taipei'), '應該有 udd 自己的主機');
  assertTrue(hosts.includes('wmts.nlsc.gov.tw'), '應該有 nlsc 自己的主機');
  const uddTarget = targets.find(t => t.host === 'www.historygis.udd.gov.taipei');
  assertTrue(uddTarget.sources.every(s => s.id === 'udd'), 'udd 主機底下不應該混進其他來源');
});

test('classifyProbeResult：逾時一律判定 down，不管 ms 多少', () => {
  assertEqual(classifyProbeResult({ timedOut: true, ms: 10 }), 'down', '逾時應該是 down');
  assertEqual(classifyProbeResult({ timedOut: true, ms: 99999 }), 'down', '逾時應該是 down（ms 不影響）');
});

test('classifyProbeResult：有回應但耗時超過門檻判定 slow，門檻以內判定 ok', () => {
  assertEqual(classifyProbeResult({ timedOut: false, ms: 100 }), 'ok', '快速回應應該是 ok');
  assertEqual(classifyProbeResult({ timedOut: false, ms: 5000 }), 'ok', '剛好等於門檻不算超過，應該是 ok');
  assertEqual(classifyProbeResult({ timedOut: false, ms: 5001 }), 'slow', '超過門檻應該是 slow');
});

// 端到端：用假 Image 覆蓋掉 env-stub 版本，模擬「這台主機快速回應」
// 與「這台主機完全沒回應（逾時）」兩種情境，驗證 checkAllSourceStatuses()
// 真的會把逾時的那台主機判定成 down、其餘判定成 ok。
test('checkAllSourceStatuses：逾時的主機被判定為 down，正常回應的主機判定為 ok', async () => {
  const originalImage = globalThis.Image;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => originalSetTimeout(fn, ms > 100 ? 5 : ms); // 把逾時計時器壓短，測試不用真的等 15 秒
  globalThis.Image = class {
    constructor(){
      const self = this;
      originalSetTimeout(() => {
        if(String(self._url).includes('sinica')) return; // 模擬 sinica 完全沒回應
        self.naturalWidth = 10;
        self.naturalHeight = 10;
        if(self.onload) self.onload();
      }, 1);
    }
    set src(v){ this._url = v; }
  };
  try{
    const results = await checkAllSourceStatuses();
    const sinicaResult = results.find(r => r.host === 'gis.sinica.edu.tw');
    const uddResult = results.find(r => r.host === 'www.historygis.udd.gov.taipei');
    assertEqual(sinicaResult.status, 'down', 'sinica 主機應該被判定為 down');
    assertEqual(uddResult.status, 'ok', 'udd 主機應該被判定為 ok');
  } finally {
    globalThis.Image = originalImage;
    globalThis.setTimeout = originalSetTimeout;
  }
});

await run();
