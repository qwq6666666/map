/* ---------------------------------------------------------
   ui/sourceStatusUI.js — 圖資來源狀態抽屜
   ---------------------------------------------------------
   純介面渲染：真正的探測邏輯在 features/sourceStatus.js，這裡只負責
   畫抽屜、逐筆點亮結果。開合/覆蓋層架構直接比照 onboarding.js 的
   使用指南抽屜（buildGuideDrawer），共用同一組 .guide-drawer* CSS，
   只是內容換成主機清單，不是手風琴。
--------------------------------------------------------- */
import { checkAllSourceStatuses, buildSourceStatusTargets } from '../features/sourceStatus.js';
import { getRecentTileFailures, clearRecentTileFailures } from '../core/tileLoadGuard.js';

const STATUS_LABEL = {
  ok: { icon: '✅', text: '正常' },
  slow: { icon: '⚠️', text: '緩慢' },
  down: { icon: '❌', text: '無回應（逾時）' }
};

const FAILURE_REASON_LABEL = {
  timeout: '⏱️ 逾時（伺服器過慢）',
  error: '🚫 明確錯誤（伺服器拒絕）'
};

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
  reason.textContent = FAILURE_REASON_LABEL[f.reason] || f.reason;

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
  badge.textContent = info.icon;
  badge.classList.remove('pending');
  badge.classList.add(result.status);
  const timeEl = row.querySelector('.source-status-time');
  timeEl.textContent = result.status === 'down' ? info.text : `${info.text}．${result.ms}ms`;
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
      <p class="source-status-intro">對每個資料來源主機各發一次探測請求，確認目前讀取狀態——平常瀏覽時某個縣市的圖層「點了沒反應」，通常就是這裡顯示異常的主機。逾時／緩慢代表資料提供方那邊的問題，不是這個網站本身故障。</p>
      <button type="button" class="source-status-recheck">🔄 重新檢查</button>
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
    overlay.remove();
    drawer.remove();
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
  runCheck();
  renderFailuresList(failuresListEl);

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
