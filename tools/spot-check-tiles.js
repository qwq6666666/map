/* ---------------------------------------------------------
   tools/spot-check-tiles.js
   ---------------------------------------------------------
   季度手動抽測：對 udd（臺北市都發局歷史圖資）與 nlsc（國土測繪中心）
   每個圖層各請求一顆圖磚，確認服務還活著。這兩個來源不在每週自動的
   upstream-health 範圍內（見 CLAUDE.md），所以靠人定期跑這支。

   用法：
       npm run check:spot                # 預設抽測台北市中心
       node tools/spot-check-tiles.js <經度> <緯度> [縮放層級]

   結果分三類：
     有圖   HTTP 200 且圖磚 > 500 bytes
     空白   HTTP 200 但圖磚很小（多半是該地點沒有資料，例如只涵蓋部分
            地區的分析成果圖），只提示、不算故障——想確認可換個地點再測
     異常   非 200、逾時或網路錯誤 → 結束碼 1

   圖磚座標重用 src/core/tileGeo.js 的 lonLatToTileXY()，不要在這裡另外
   手算（手算出錯會把「座標錯」誤判成「服務壞了」）。
--------------------------------------------------------- */
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const BLANK_MAX_BYTES = 500;
const TIMEOUT_MS = 15000;
const CONCURRENCY = 4;

function collectJobs(z, x, y){
  const fill = tpl => tpl.replace('{z}', z).replace('{y}', y).replace('{x}', x);
  const jobs = [];

  const udd = require(path.join(ROOT, 'data/layers/udd.json'));
  for(const cat of udd.categories){
    for(const l of cat.layers || []){
      if(l.url) jobs.push({ src: 'udd', id: l.id, url: fill(l.url) });
    }
  }

  const nlsc = require(path.join(ROOT, 'data/layers/nlsc.json'));
  for(const cat of nlsc.categories){
    for(const l of cat.layers || []){
      jobs.push({ src: 'nlsc', id: l.id, url: fill(nlsc.provider.tileTemplate.replace('{id}', l.id)) });
    }
  }
  return jobs;
}

async function probe(job){
  const t0 = Date.now();
  try {
    const res = await fetch(job.url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const bytes = (await res.arrayBuffer()).byteLength;
    const ms = Date.now() - t0;
    if(res.status !== 200) return { ...job, kind: 'bad', detail: `HTTP ${res.status}`, ms };
    return { ...job, kind: bytes > BLANK_MAX_BYTES ? 'ok' : 'blank', detail: `${bytes} bytes`, ms };
  } catch(err){
    return { ...job, kind: 'bad', detail: String(err.cause?.code || err.message), ms: Date.now() - t0 };
  }
}

async function main(){
  const { lonLatToTileXY } = await import(pathToFileURL(path.join(ROOT, 'src/core/tileGeo.js')).href);
  const [lonArg, latArg, zArg] = process.argv.slice(2);
  const lon = lonArg === undefined ? 121.5654 : Number(lonArg);
  const lat = latArg === undefined ? 25.033 : Number(latArg);
  const z = zArg === undefined ? 15 : Number(zArg);
  if(![lon, lat, z].every(Number.isFinite)){
    console.error('參數必須是數字：node tools/spot-check-tiles.js <經度> <緯度> [縮放層級]');
    process.exit(2);
  }
  const { x, y } = lonLatToTileXY(lon, lat, z);
  console.log(`抽測地點 (${lon}, ${lat})，圖磚 z=${z} x=${x} y=${y}\n`);

  const jobs = collectJobs(z, x, y);
  const results = [];
  let next = 0;
  async function worker(){
    while(next < jobs.length) results.push(await probe(jobs[next++]));
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  let bad = 0;
  for(const src of ['udd', 'nlsc']){
    const rows = results.filter(r => r.src === src);
    const count = kind => rows.filter(r => r.kind === kind).length;
    console.log(`${src}: 共 ${rows.length}，有圖 ${count('ok')}，空白 ${count('blank')}，異常 ${count('bad')}`);
    for(const r of rows.filter(r => r.kind === 'blank')) console.log(`  ○ ${r.id}（空白：${r.detail}，該地點可能沒有資料）`);
    for(const r of rows.filter(r => r.kind === 'bad')) console.log(`  ✗ ${r.id}（${r.detail}，${r.ms}ms）`);
    bad += count('bad');
  }
  console.log(bad === 0 ? '\n全部正常。' : `\n有 ${bad} 個圖層異常。`);
  process.exit(bad === 0 ? 0 : 1);
}

main();
