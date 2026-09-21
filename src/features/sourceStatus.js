/* ---------------------------------------------------------
   features/sourceStatus.js — 圖資來源健康狀態檢查
   ---------------------------------------------------------
   背景：data/layers/*.json 裡幾十個「來源」實際上是共用少數幾台
   主機（例如絕大多數縣市歷史地圖都掛在 gis.sinica.edu.tw 底下），
   任何一台主機出狀況，就會讓一大批圖層同時「點了沒反應」，但畫面上
   完全看不出來是我們的問題還是資料提供方的問題。這支模組讓使用者
   自己一鍵檢查：對每個不重複的主機各發一次探測請求，回報回應時間，
   讓「是哪個來源掛了」一目了然，不用像除錯這次事件一樣手動一個個測。

   探測邏輯刻意不判斷「這個座標到底有沒有歷史圖資」（tileChecker.js
   的 checkOne() 在意的是這件事），只在意「伺服器有沒有在合理時間內
   回應」——不管 onload 或 onerror，只要 timeoutMs 內收到任何回應，就
   代表主機本身是活的；只有完全沒回應（timedOut）才代表主機真的掛了。
   這樣就不用煩惱「探測到的這顆圖磚剛好那個位置沒資料」污染判斷結果。
--------------------------------------------------------- */
import { DATA } from '../data.js';
import { lonLatToTileXY } from '../core/tileGeo.js';
import { probeImageOnce } from '../tileChecker.js';

// 探測用的縮放層級：夠粗，落在絕大多數來源的 minZoom~maxZoom 範圍內，
// 且圖磚較大張、bbox 中心點附近命中真實資料的機率也較高（純粹加分，
// 不影響判斷邏輯——見上方說明，沒資料一樣算「有回應」）。
const PROBE_ZOOM = 8;
// 健康檢查是使用者主動點開才會觸發的一次性檢查，不像背景探測要壓低
// 逾時時間搶救使用者體驗；這裡刻意抓寬（15 秒），才能真的把「非常慢
// 但沒有完全掛掉」跟「完全沒回應」分開，而不是全部提早判定成逾時。
export const SOURCE_STATUS_TIMEOUT_MS = 15000;
// 回應時間超過這個門檻但仍然有回應，歸類成「緩慢」而非「正常」。
export const SOURCE_STATUS_SLOW_THRESHOLD_MS = 5000;

// data.js 的 URL 樣板只有 {id}/{format} 被 resolveTileUrl() 換掉，
// {z}/{x}/{y} 是留給 OL 的 XYZ/WMTS source 自己代換，這裡手動補上。
function fillTileCoords(template, z, x, y){
  return template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

function firstLayerOf(src){
  for(const cat of src.categories || []){
    const layersArr = cat.groups ? cat.groups.flatMap(g => g.layers) : cat.layers;
    if(layersArr && layersArr.length) return layersArr[0];
  }
  return null;
}

// 從網址字串取 host：只需要 host，用正規表示式就夠，不必為此建立 URL 物件。
export function hostOf(url){
  const m = /^https?:\/\/([^/]+)/.exec(url);
  return m ? m[1] : url;
}

// 幫一個來源算出一個可以拿去探測的圖磚網址；缺 bbox、缺圖層、或樣板
// 解不出來時回傳 null，呼叫端據此略過這個來源（沒有網址可測）。
// bbox 查 DATA.REGION_EXTENTS 而不是 src.region——loadAppData() 組
// DATA.LAYER_SOURCES 時沒有把原始 provider/region 帶到每個來源物件
// 上（只留下 tileUrl() 這個已經綁好 provider 的 closure，見 data.js），
// bbox 另外整理進 DATA.REGION_EXTENTS 這張表。
export function buildProbeUrl(src){
  const layer = firstLayerOf(src);
  const bbox = DATA.REGION_EXTENTS[src.id];
  if(!layer || !bbox) return null;
  const template = src.tileUrl(layer);
  if(!template) return null;
  const lon = (bbox[0] + bbox[2]) / 2;
  const lat = (bbox[1] + bbox[3]) / 2;
  const { x, y } = lonLatToTileXY(lon, lat, PROBE_ZOOM);
  return fillTileCoords(template, PROBE_ZOOM, x, y);
}

// 把 DATA.LAYER_SOURCES 依實際主機（host）分組：同一台主機底下不管
// 掛了幾個來源，健康狀態只會是同一份（今天的 sinica 事件就是整台主機
// 一起掛，不是個別來源各自出狀況），分組後只需要探測一次就能代表
// 這台主機底下所有來源目前的狀態，不用每個來源各發一次請求。
export function buildSourceStatusTargets(){
  const byHost = new Map();
  for(const src of DATA.LAYER_SOURCES){
    const url = buildProbeUrl(src);
    if(!url) continue;
    const host = hostOf(url);
    if(!byHost.has(host)) byHost.set(host, { host, probeUrl: url, sources: [] });
    byHost.get(host).sources.push({ id: src.id, name: src.name });
  }
  return [...byHost.values()].sort((a, b) => b.sources.length - a.sources.length);
}

// 純函式版分類邏輯，跟實際計時脫鉤，方便測試直接餵假的 ms/timedOut
// 驗證三種分類的邊界，不用真的等 15 秒逾時或 5 秒門檻。
export function classifyProbeResult({ timedOut, ms }){
  if(timedOut) return 'down';
  if(ms > SOURCE_STATUS_SLOW_THRESHOLD_MS) return 'slow';
  return 'ok';
}

// 對單一主機發出一次探測，回傳附上 status（'ok'|'slow'|'down'）與
// ms（無條件進位到整數毫秒）的完整結果物件。
export async function checkSourceStatus(target){
  const { ok, timedOut, ms } = await probeImageOnce(target.probeUrl, SOURCE_STATUS_TIMEOUT_MS);
  return { ...target, status: classifyProbeResult({ timedOut, ms }), ok, ms: Math.round(ms) };
}

// 平行檢查所有主機；onResult(result) 每完成一筆就呼叫一次，讓 UI 可以
// 逐筆點亮結果，不用整批做完才一次顯示（主機一多、又剛好有主機真的
// 逾時 15 秒，整批等完才顯示會讓使用者以為面板卡住了）。
export async function checkAllSourceStatuses(onResult){
  const targets = buildSourceStatusTargets();
  return Promise.all(targets.map(async (target) => {
    const result = await checkSourceStatus(target);
    onResult?.(result);
    return result;
  }));
}
