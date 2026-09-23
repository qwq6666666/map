/* ---------------------------------------------------------
   ui/sourceStatusUI.js — 圖資來源狀態／快取抽屜
   ---------------------------------------------------------
   純介面渲染：真正的探測邏輯在 features/sourceStatus.js，這裡只負責
   畫抽屜、逐筆點亮結果。開合/覆蓋層架構直接比照 onboarding.js 的
   使用指南抽屜（buildGuideDrawer），共用同一組 .guide-drawer* CSS，
   只是內容換成主機清單，不是手風琴。

   原本「清除快取」是「⋯ 更多」選單裡跟這個抽屜平行的獨立按鈕，兩者都
   是網路／儲存相關的維護工具、使用頻率都低，合併成一個入口後選單少一
   項。清除動作本身（postMessage 給 sw.js）刻意不抽成獨立 feature 模組
   ——就是單純的瀏覽器 API 呼叫，比照這支檔案的其餘按鈕直接內聯處理。
   放在抽屜最上方、獨立於下面的主機探測（不等 runCheck() 跑完就能點），
   避免使用者「只是想清快取」卻要多等一輪 15 秒逾時等級的網路探測。
--------------------------------------------------------- */
import { checkAllSourceStatuses, buildSourceStatusTargets } from '../features/sourceStatus.js';
import { getRecentTileFailures, clearRecentTileFailures } from '../core/tileLoadGuard.js';
import { showLocateToast } from '../features/location.js';
import { removeDrawerAnimated } from './drawerClose.js';

// icon 存 sprite symbol id（見 public/assets/map-emoji-style-a-icons.svg），
// 消費端一律用 iconSvg() 組成 <svg><use> 字串，不能再用 textContent 賦值
// （會把子節點清空)。
const STATUS_LABEL = {
  ok: { icon: 'status-ok', text: '正常' },
  slow: { icon: 'status-slow', text: '緩慢' },
  down: { icon: 'status-down', text: '無回應（逾時）' }
};

const FAILURE_REASON_LABEL = {
  timeout: '⏱️ 逾時（伺服器過慢）',
  error: '<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#status-error"></use></svg> 明確錯誤（伺服器拒絕）'
};

function iconSvg(symbol){
  return `<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#${symbol}"></use></svg>`;
}

function formatRelativeTime(time){
  const diffMs = Date.now() - time;
  if(diffMs < 60000) return `${Math.max(1, Math.round(diffMs / 1000))} 秒前`;
  if(diffMs < 3600000) return `${Math.round(diffMs / 60000)} 分鐘前`;
  const d = new Date(time);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// label 可能來自使用者匯入的自訂 WMTS 服務名稱（見 data.js 的
// createGuardedTileLoadFunction({ label }) 呼叫端），不是本站固定的
// 圖層清單，不能當成信任內容用 innerHTML 組字串——這裡逐一用
// textContent 賦值，避免 XSS。
function renderFailureRow(f){
  const row = document.createElement('div');
  row.className = 'source-status-failure-row';

  const reason = document.createElement('span');
  reason.className = 'source-status-failure-reason';
  // FAILURE_REASON_LABEL 是本站固定字串（含內嵌 <svg> icon markup），
  // f.reason 只是查表用的 key，不是使用者輸入內容，可信任用 innerHTML；
  // 查無對應時退回 f.reason 原始字串，一樣用 textContent 賦值避免 XSS。
  const reasonLabel = FAILURE_REASON_LABEL[f.reason];
  if(reasonLabel) reason.innerHTML = reasonLabel;
  else reason.textContent = f.reason;

  const text = document.createElement('div');
  text.className = 'source-status-failure-text';
  const label = document.createElement('div');
  label.className = 'source-status-failure-label';
  label.textContent = f.label;
  const coord = document.createElement('div');
  coord.className = 'source-status-failure-coord';
  coord.textContent = `z${f.z}/${f.x}/${f.y}`;
  text.appendChild(label);
  text.appendChild(coord);

  const time = document.createElement('span');
  time.className = 'source-status-failure-time';
  time.textContent = formatRelativeTime(f.time);

  row.appendChild(reason);
  row.appendChild(text);
  row.appendChild(time);
  return row;
}

function renderFailuresList(listEl){
  const failures = getRecentTileFailures();
  listEl.innerHTML = '';
  if(failures.length === 0){
    const empty = document.createElement('p');
    empty.className = 'source-status-failures-empty';
    empty.textContent = '目前沒有紀錄';
    listEl.appendChild(empty);
    return;
  }
  failures.forEach(f => listEl.appendChild(renderFailureRow(f)));
}

// 主機底下的來源名稱可能有幾十筆（例如共用 gis.sinica.edu.tw 的縣市
// 們），全部列出來太長，只列前 5 筆＋剩餘數量。
function sourcesSummary(sources){
  const names = sources.map(s => s.name);
  if(names.length <= 5) return names.join('、');
  return `${names.slice(0, 5).join('、')} 等 ${names.length} 個來源`;
}

function renderPendingRow(target){
  const row = document.createElement('div');
  row.className = 'source-status-row';
  row.innerHTML = `
    <span class="source-status-badge pending">⋯</span>
    <div class="source-status-row-text">
      <div class="source-status-host">${target.host}</div>
      <div class="source-status-sources">${sourcesSummary(target.sources)}</div>
    </div>
    <span class="source-status-time">檢查中…</span>
  `;
  return row;
}

function applyResultToRow(row, result){
  const info = STATUS_LABEL[result.status];
  row.classList.add(`is-${result.status}`);
  const badge = row.querySelector('.source-status-badge');
  badge.innerHTML = iconSvg(info.icon);
  badge.classList.remove('pending');
  badge.classList.add(result.status);
  const timeEl = row.querySelector('.source-status-time');
  timeEl.textContent = result.status === 'down' ? info.text : `${info.text}．${result.ms}ms`;
}

// 透過 MessageChannel 請 sw.js 清掉三份 tile cache（見 public/sw.js 的
// message handler）。開發模式或瀏覽器不支援 Service Worker 時沒有
// controller，直接提示使用者無需清除。
async function clearTileCaches(){
  const controller = navigator.serviceWorker?.controller;
  if(!controller){
    showLocateToast('目前沒有離線圖磚快取，無需清除');
    return;
  }
  const result = await new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (e) => resolve(e.data);
    controller.postMessage({ type: 'CLEAR_TILE_CACHES' }, [channel.port2]);
  });
  showLocateToast(result?.ok ? '圖磚快取已清除' : '清除失敗，請稍後再試');
}

// 顯示「實際快取的圖磚張數」而非 navigator.storage.estimate() 的用量：
// estimate() 涵蓋整個網站（含程式與資料快取，清圖磚也降不到零）、跨網域
// 圖磚（opaque）又會被灌水計算，而且 caches.delete() 完成後仍會回傳舊數字，
// 要等數秒才更新（實測清除前 30 MB → 剛清完仍 30 MB → 約 8 秒後 0.9 MB），
// 使用者看到數字沒降就以為沒清掉。直接數 cache 裡的圖磚才是即時、準確的。
// 只算跨網域請求：LRU 索引（tile-lru.local）與本站圖示 svg 也會被存進
// tile cache（sw.js 以 destination === 'image' 判定），不是使用者要清的圖磚。
const TILE_CACHE_NAME_PREFIX = 'tile-cache-';

// 逐張讀 Content-Length 累加體積，不做 estimate()（理由同上）；圖磚快取現在只存
// res.ok 的回應（見 public/sw.js），opaque 已排除，所以 Content-Length 一般都讀得到，
// 缺標頭（極少數）才退回讀整個 body 的 blob().size。
// 三份快取名稱見 public/sw.js：tile-cache-<ver>（歷史）、tile-cache-osm-<ver>、tile-cache-sat-<ver>。
function cacheGroupLabel(name){
  if(name.startsWith('tile-cache-osm-')) return '現代地圖';
  if(name.startsWith('tile-cache-sat-')) return '衛星影像';
  return '歷史地圖';
}

async function countCachedTiles(){
  if(typeof caches === 'undefined') return null;
  try{
    const names = (await caches.keys()).filter(n => n.startsWith(TILE_CACHE_NAME_PREFIX));
    const groups = new Map([['歷史地圖', { count: 0, bytes: 0 }], ['現代地圖', { count: 0, bytes: 0 }], ['衛星影像', { count: 0, bytes: 0 }]]);
    for(const name of names){
      const group = groups.get(cacheGroupLabel(name));
      const cache = await caches.open(name);
      const requests = await cache.keys();
      for(const req of requests){
        const { origin, hostname } = new URL(req.url);
        if(origin === location.origin || hostname === 'tile-lru.local') continue;
        group.count++;
        const res = await cache.match(req);
        const len = Number(res?.headers.get('content-length'));
        group.bytes += len > 0 ? len : (await res.blob()).size;
      }
    }
    const list = [...groups].map(([label, g]) => ({ label, ...g }));
    return {
      count: list.reduce((n, g) => n + g.count, 0),
      bytes: list.reduce((n, g) => n + g.bytes, 0),
      groups: list.filter(g => g.count > 0)
    };
  }catch{
    return null;
  }
}

function formatCacheSize(bytes){
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

async function updateCacheUsageText(el, breakdownEl){
  if(!el) return;
  el.textContent = '已快取圖磚：計算中…';
  if(breakdownEl) breakdownEl.textContent = '';
  const result = await countCachedTiles();
  el.textContent = result === null ? '' : `已快取圖磚：${result.count.toLocaleString('zh-TW')} 張（${formatCacheSize(result.bytes)}）`;
  if(breakdownEl && result){
    breakdownEl.textContent = result.groups
      .map(g => `${g.label} ${g.count.toLocaleString('zh-TW')} 張（${formatCacheSize(g.bytes)}）`)
      .join('　');
  }
}

function buildDrawer(){
  const overlay = document.createElement('div');
  overlay.className = 'guide-drawer-overlay';

  const drawer = document.createElement('div');
  drawer.className = 'guide-drawer source-status-drawer';
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-modal', 'true');

  drawer.innerHTML = `
    <div class="guide-drawer-header">
      <h2 class="guide-drawer-title"><svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#source-status"></use></svg> 圖資來源狀態</h2>
      <button type="button" class="guide-drawer-close" title="關閉" aria-label="關閉"><svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#close"></use></svg></button>
    </div>
    <div class="guide-drawer-body">
      <div class="source-status-cache-section">
        <div class="source-status-cache-row">
          <button type="button" class="source-status-clear-cache"><svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#clear-cache"></use></svg> 清除圖磚快取</button>
          <span class="source-status-cache-usage" aria-live="polite"></span>
        </div>
        <p class="source-status-cache-breakdown"></p>
        <p class="source-status-cache-intro">清除已下載的地圖圖磚（歷史地圖／現代地圖／衛星影像），釋放裝置儲存空間；圖層資料本身不受影響，下次瀏覽同區域會重新下載圖磚。</p>
      </div>
      <p class="source-status-intro">對每個資料來源主機各發一次探測請求，確認目前讀取狀態——平常瀏覽時某個縣市的圖層「點了沒反應」，通常就是這裡顯示異常的主機。逾時／緩慢代表資料提供方那邊的問題，不是這個網站本身故障。</p>
      <button type="button" class="source-status-recheck"><svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#refresh"></use></svg> 重新檢查</button>
      <div class="source-status-list"></div>
      <div class="source-status-failures-section">
        <div class="source-status-failures-header">
          <h3 class="source-status-failures-title">🗺️ 最近圖磚載入失敗</h3>
          <button type="button" class="source-status-failures-clear">清除紀錄</button>
        </div>
        <p class="source-status-failures-intro">上面的主機探測只測「伺服器有沒有回應」，測不出「特定圖層/座標讀不出來」；這裡記錄的才是實際瀏覽時真正發生的載入失敗（逾時或伺服器明確錯誤），主機探測正常不代表這裡不會有紀錄。</p>
        <div class="source-status-failures-list"></div>
      </div>
    </div>
  `;

  const close = () => {
    removeDrawerAnimated(overlay, drawer);
    document.removeEventListener('keydown', onKeydown);
  };
  const onKeydown = (e) => { if(e.key === 'Escape') close(); };
  overlay.addEventListener('click', close);
  drawer.querySelector('.guide-drawer-close').addEventListener('click', close);
  document.addEventListener('keydown', onKeydown);

  const listEl = drawer.querySelector('.source-status-list');
  const recheckBtn = drawer.querySelector('.source-status-recheck');
  const failuresListEl = drawer.querySelector('.source-status-failures-list');
  const failuresClearBtn = drawer.querySelector('.source-status-failures-clear');
  const clearCacheBtn = drawer.querySelector('.source-status-clear-cache');
  const cacheUsageEl = drawer.querySelector('.source-status-cache-usage');
  const cacheBreakdownEl = drawer.querySelector('.source-status-cache-breakdown');

  async function runCheck(){
    recheckBtn.disabled = true;
    listEl.innerHTML = '';
    const rows = new Map();
    buildSourceStatusTargets().forEach((target) => {
      const row = renderPendingRow(target);
      listEl.appendChild(row);
      rows.set(target.host, row);
    });
    await checkAllSourceStatuses((result) => {
      const row = rows.get(result.host);
      if(row) applyResultToRow(row, result);
    });
    recheckBtn.disabled = false;
  }

  recheckBtn.addEventListener('click', () => {
    runCheck();
    renderFailuresList(failuresListEl); // 順便刷新失敗紀錄，不用另外開關抽屜
  });
  failuresClearBtn.addEventListener('click', () => {
    clearRecentTileFailures();
    renderFailuresList(failuresListEl);
  });
  clearCacheBtn.addEventListener('click', async () => {
    clearCacheBtn.disabled = true;
    await clearTileCaches();
    await updateCacheUsageText(cacheUsageEl, cacheBreakdownEl);
    clearCacheBtn.disabled = false;
  });
  runCheck();
  renderFailuresList(failuresListEl);
  updateCacheUsageText(cacheUsageEl, cacheBreakdownEl);

  return { overlay, drawer };
}

export function openSourceStatusDrawer(){
  const { overlay, drawer } = buildDrawer();
  document.body.appendChild(overlay);
  document.body.appendChild(drawer);
}

export function initSourceStatusUI(){
  const btn = document.getElementById('sourceStatusBtn');
  if(btn) btn.addEventListener('click', openSourceStatusDrawer);
}
