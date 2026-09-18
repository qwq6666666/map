/* ---------------------------------------------------------
   tools/check-upstream-health.js
   ---------------------------------------------------------
   上游圖資服務健康檢查：網站幾乎完全依賴中研院 gis.sinica.edu.tw，
   上游改網址、下架來源或某個圖層被拿掉時，前端只會安靜地出現空白
   圖層、沒有任何錯誤訊息。這支腳本用來定期主動偵測：

   對 data/layers/<id>.json 裡 provider.tileTemplate 指向
   gis.sinica.edu.tw 的每個來源：
     1. 下載該來源的 WMTS Capabilities（失敗會重試，避免一次網路
        抖動就誤報），確認回應像是真的 Capabilities 文件。
     2. 比對「本地圖層 id」與「Capabilities 內的 Layer id」：
        - 本地有、上游沒有 → 失敗（該圖層在前端會變成空白/破圖）。
        - 上游有、本地沒有 → 只提示（上游新增了圖層，不算故障）。

   來源清單直接從 data/layers/*.json 推導，新增來源不用改這支腳本。
   不在 sinica 上的來源（udd／nlsc）沒有統一的 Capabilities 端點，
   不在這支腳本的檢查範圍內。

   用法：
       node tools/check-upstream-health.js [--report <輸出 markdown 路徑>]

   結束碼：0 = 全部正常（含只有「上游新增」提示）；1 = 有來源無法
   連線、或有本地圖層在上游找不到。
   在 GitHub Actions 裡會自動把結果附加到 $GITHUB_STEP_SUMMARY。
--------------------------------------------------------- */
const fs = require('node:fs');
const path = require('node:path');
const { forEachLayer } = require('./lib/layerWalk');

const LAYERS_DIR = path.join(__dirname, '..', 'data', 'layers');
const SINICA_TEMPLATE_RE = /^https:\/\/gis\.sinica\.edu\.tw\/([^/]+)\/file-exists\.php/;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;
const CONCURRENCY = 4;

function sleep(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 從 data/layers/*.json 推導出所有 sinica 來源與其 Capabilities 端點
function discoverSources(){
  const sources = [];
  for(const file of fs.readdirSync(LAYERS_DIR).sort()){
    if(!file.endsWith('.json') || file === 'index.json') continue;
    const src = JSON.parse(fs.readFileSync(path.join(LAYERS_DIR, file), 'utf-8'));
    const match = SINICA_TEMPLATE_RE.exec(src.provider?.tileTemplate || '');
    if(!match) continue;
    const localIds = [];
    forEachLayer(src, layer => localIds.push(layer.id));
    sources.push({
      name: file.replace(/\.json$/, ''),
      capabilitiesUrl: `https://gis.sinica.edu.tw/${match[1]}/wmts/1.0.0/WMTSCapabilities.xml`,
      localIds
    });
  }
  return sources;
}

// 抓 Capabilities 裡每個 <Layer> 的第一個 <ows:Identifier>
// （Style 底下的 "default" 排在後面，不會被誤抓——同 fetch-wmts-bbox.js）
function parseLayerIds(xml){
  const ids = new Set();
  const layerBlockRe = /<Layer>([\s\S]*?)<\/Layer>/g;
  let block;
  while((block = layerBlockRe.exec(xml)) !== null){
    const idMatch = /<ows:Identifier>([^<]+)<\/ows:Identifier>/.exec(block[1]);
    if(idMatch) ids.add(idMatch[1].trim());
  }
  return ids;
}

async function fetchCapabilities(url){
  let lastError;
  for(let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++){
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if(!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const xml = await res.text();
      if(!xml.includes('<Capabilities')) throw new Error('回應內容不是 WMTS Capabilities 文件');
      return xml;
    } catch (err) {
      lastError = err;
      if(attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError;
}

async function checkSource(source){
  const result = { name: source.name, url: source.capabilitiesUrl, error: null, missingUpstream: [], newUpstream: [], upstreamCount: 0, localCount: source.localIds.length };
  try {
    const upstreamIds = parseLayerIds(await fetchCapabilities(source.capabilitiesUrl));
    result.upstreamCount = upstreamIds.size;
    const localSet = new Set(source.localIds);
    result.missingUpstream = source.localIds.filter(id => !upstreamIds.has(id));
    result.newUpstream = [...upstreamIds].filter(id => !localSet.has(id));
  } catch (err) {
    result.error = err.message;
  }
  return result;
}

// 簡單的固定併發：避免 37 個請求一次全打到同一台上游主機
async function runPool(items, worker, concurrency){
  const results = new Array(items.length);
  let next = 0;
  async function loop(){
    while(next < items.length){
      const i = next++;
      results[i] = await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, loop));
  return results;
}

function buildReport(results){
  const failed = results.filter(r => r.error || r.missingUpstream.length > 0);
  const lines = [];
  lines.push('## 上游圖資服務健康檢查', '');
  lines.push(`檢查來源 ${results.length} 個，異常 ${failed.length} 個。`, '');
  if(failed.length > 0){
    lines.push('### 異常', '');
    for(const r of failed){
      lines.push(`- **${r.name}**（${r.url}）`);
      if(r.error) lines.push(`  - 無法取得 Capabilities：${r.error}`);
      if(r.missingUpstream.length > 0){
        lines.push(`  - 本地有、上游找不到的圖層 ${r.missingUpstream.length} 筆：\`${r.missingUpstream.join('`, `')}\``);
      }
    }
    lines.push('');
  }
  const withNew = results.filter(r => !r.error && r.newUpstream.length > 0);
  if(withNew.length > 0){
    lines.push('### 提示：上游有、本地尚未收錄的圖層（不算故障）', '');
    for(const r of withNew){
      lines.push(`- ${r.name}：${r.newUpstream.length} 筆（\`${r.newUpstream.join('`, `')}\`）`);
    }
    lines.push('');
  }
  if(failed.length === 0) lines.push('全部來源正常。', '');
  return { text: lines.join('\n'), failedCount: failed.length };
}

async function main(){
  const reportFlagIndex = process.argv.indexOf('--report');
  const reportPath = reportFlagIndex >= 0 ? process.argv[reportFlagIndex + 1] : null;

  const sources = discoverSources();
  console.log(`共 ${sources.length} 個 sinica 來源，開始檢查……`);
  const results = await runPool(sources, checkSource, CONCURRENCY);

  results.forEach(r => {
    const status = r.error ? `失敗：${r.error}`
      : r.missingUpstream.length > 0 ? `上游缺 ${r.missingUpstream.length} 筆圖層`
      : 'OK';
    console.log(`${r.name.padEnd(16)} 本地 ${String(r.localCount).padStart(3)} / 上游 ${String(r.upstreamCount).padStart(3)}  ${status}`);
  });

  const { text, failedCount } = buildReport(results);
  console.log('\n' + text);
  if(reportPath) fs.writeFileSync(reportPath, text);
  if(process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
  process.exit(failedCount > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(2);
});
