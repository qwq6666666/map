/* ---------------------------------------------------------
   ui/sourceStatusUI.js — 圖資來源狀態抽屜
   ---------------------------------------------------------
   純介面渲染：真正的探測邏輯在 features/sourceStatus.js，這裡只負責
   畫抽屜、逐筆點亮結果。開合/覆蓋層架構直接比照 onboarding.js 的
   使用指南抽屜（buildGuideDrawer），共用同一組 .guide-drawer* CSS，
   只是內容換成主機清單，不是手風琴。
--------------------------------------------------------- */
import { checkAllSourceStatuses, buildSourceStatusTargets } from '../features/sourceStatus.js';

const STATUS_LABEL = {
  ok: { icon: '✅', text: '正常' },
  slow: { icon: '⚠️', text: '緩慢' },
  down: { icon: '❌', text: '無回應（逾時）' }
};

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
      <h2 class="guide-drawer-title">📡 圖資來源狀態</h2>
      <button type="button" class="guide-drawer-close" title="關閉" aria-label="關閉">✕</button>
    </div>
    <div class="guide-drawer-body">
      <p class="source-status-intro">對每個資料來源主機各發一次探測請求，確認目前讀取狀態——平常瀏覽時某個縣市的圖層「點了沒反應」，通常就是這裡顯示異常的主機。逾時／緩慢代表資料提供方那邊的問題，不是這個網站本身故障。</p>
      <button type="button" class="source-status-recheck">🔄 重新檢查</button>
      <div class="source-status-list"></div>
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

  recheckBtn.addEventListener('click', runCheck);
  runCheck();

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
