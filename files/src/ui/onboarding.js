// src/ui/onboarding.js
// 新手導覽（Welcome Modal + 5 步聚光燈導覽）與使用指南抽屜。
// 純 DOM 疊加層，只讀取既有元素的 getBoundingClientRect() 做定位，
// 不呼叫地圖／模式切換／搜尋等模組的內部邏輯，只靠 localStorage 記錄已讀旗標。

import { expandSidebar } from './sidebarToggle.js';

const STORAGE_KEY = 'has_seen_map_tour';

/** 5 步聚光燈導覽腳本。selector 找不到時該步驟會被跳過。 */
const TOUR_STEPS = [
  {
    selector: '#addressInput',
    fallbackSelector: '.search-block',
    title: '📍 找一個地方',
    desc: '輸入現在的地址或地標，系統會帶您定焦至該地點。',
  },
  {
    selector: '#layerSearchInput',
    fallbackSelector: '.layer-search-block',
    title: '🗺️ 找歷史地圖',
    desc: '想看特定歷史圖資？在這裡搜尋年代、圖層名稱或來源（與上方地址搜尋不同）。',
  },
  {
    selector: '#modeSwitch button[data-mode="overlay"]',
    title: '🪟 透明疊圖',
    desc: '將歷史地圖疊加在現代圖資上，滑動透明度拉桿透視百年變遷。',
  },
  {
    selector: '#modeSwitch button[data-mode="compare"]',
    title: '↔️ 左右比對',
    desc: '左右拖曳滑動分割線，直接比對兩張地圖的地景差異。',
  },
  {
    selector: '#modeSwitch button[data-mode="timeline"]',
    title: '🕰️ 時空時間軸',
    desc: '依年代順序穿梭歷史地圖。',
    extra: '現在輸入一個您熟悉的地點開始探索吧！',
    finalStep: true,
  },
];

/** 使用指南手風琴內容。 */
const GUIDE_SECTIONS = [
  {
    icon: '🔍',
    title: '搜尋定位',
    body: '「地址／位置搜尋」用來輸入現在的地名或地標，快速定焦到該座標；「圖資搜尋」則是用圖層名稱、年份、來源或分類找歷史地圖本身。兩者是獨立的搜尋通道，找不到地點時可以改試圖資搜尋看看有沒有對應年代的圖層。',
  },
  {
    icon: '🗺️',
    title: '基礎比對',
    body: '「透明疊圖」會把歷史地圖蓋在現代底圖上，用透明度拉桿慢慢滑動即可看出地景變化。「左右比對」則是用一條可拖曳的分割線，左右兩側各顯示一張地圖，適合並排觀察差異較大的區域。',
  },
  {
    icon: '🕰️',
    title: '時間軸切換指南',
    body: '切換到「時間軸」模式後，畫面下方會出現年代刻度，拖曳滑桿即可依年代順序切換同一地點的歷史圖層。若該地點有自訂時間軸（浮動小面板），可另外用刻度點或滑桿切換自選的圖層清單，兩者互不影響。',
  },
  {
    icon: '⚙️',
    title: '進階功能說明',
    body: '「複合疊圖」可一次勾選多張圖層疊加比較。繪圖標記工具能在地圖上加註記、量測或畫記重點區域。若中研院以外的圖資來源提供 WMTS／XYZ 服務，也可以自行輸入連線設定加入圖層清單。',
  },
  {
    icon: '📚',
    title: '資料來源與坐標系統',
    body: '圖資主要來自中央研究院人文社會科學研究中心 GIS 專題中心與各地方文史單位的 WMTS 服務，地圖座標統一採用 EPSG:3857（Web Mercator）顯示。若做學術引用，請以各圖層詳細資訊中標示的原始來源與版權聲明為準。',
  },
];

let tourEls = null; // { overlay, highlight, tooltip }
let tourIndex = 0;
let resizeBound = false;

function hasSeenTour() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return true; // localStorage 不可用時，不要一直打擾使用者
  }
}

function markSeenTour() {
  try {
    window.localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    /* ignore：無痕模式或被封鎖時忽略即可 */
  }
}

function ensureSidebarExpanded() {
  // 改呼叫 sidebarToggle.js 共用的 expandSidebar()，一併同步收合按鈕
  // 圖示／title／aria-label 與浮動透明度控制的顯示狀態，避免這裡自己
  // 手動改 classList／aria-expanded 卻遺漏其他跟著收合狀態連動的畫面。
  expandSidebar();
}

/* ---------------- Welcome Modal ---------------- */

function buildWelcomeModal() {
  const overlay = document.createElement('div');
  overlay.className = 'onboarding-modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `
    <div class="onboarding-modal-card">
      <h2 class="onboarding-modal-title">🗺️ 歡迎來到百年歷史地圖</h2>
      <ul class="onboarding-modal-list">
        <li>搜尋現代地點，快速定焦至您感興趣的地區</li>
        <li>尋找該地區的百年歷史地圖圖資</li>
        <li>疊加比對現代與歷史地圖，並依年代切換觀察變遷</li>
      </ul>
      <div class="onboarding-modal-actions">
        <button type="button" class="onboarding-modal-btn primary" data-action="tour">30 秒快速導覽</button>
        <button type="button" class="onboarding-modal-btn secondary" data-action="explore">開始探索</button>
        <button type="button" class="onboarding-modal-btn text" data-action="dismiss">不再顯示</button>
      </div>
    </div>
  `;

  const close = (startTourAfter) => {
    markSeenTour();
    overlay.remove();
    document.removeEventListener('keydown', onKeydown);
    if (startTourAfter) startTour();
  };

  const onKeydown = (e) => {
    if (e.key === 'Escape') close(false);
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close(false);
  });
  overlay.querySelector('[data-action="tour"]').addEventListener('click', () => close(true));
  overlay.querySelector('[data-action="explore"]').addEventListener('click', () => close(false));
  overlay.querySelector('[data-action="dismiss"]').addEventListener('click', () => close(false));

  document.addEventListener('keydown', onKeydown);
  return overlay;
}

function openWelcomeModal() {
  const overlay = buildWelcomeModal();
  document.body.appendChild(overlay);
}

/* ---------------- 5 步聚光燈導覽 ---------------- */

// 手機版某些元素會依目前模式用 CSS display:none 隱藏（例如頂部搜尋列
// 只在透明疊圖模式顯示，見 style.css 的 Mobile Responsive Layout／
// src/ui/mobileLayout.js 的 initModeClassSync()）。selector 找得到節點
// 不代表它现在真的顯示在畫面上，這裡額外用 getClientRects() 判斷是否
// 真的有算圖，隱藏的話當成「找不到」處理，交給呼叫端跳過這一步，
// 不會去 highlight 一個看不到的空白區域。
function isRendered(el) {
  return !!el && el.getClientRects().length > 0;
}

function resolveStepTarget(step) {
  const primary = document.querySelector(step.selector);
  if (isRendered(primary)) return primary;
  const fallback = step.fallbackSelector ? document.querySelector(step.fallbackSelector) : null;
  return isRendered(fallback) ? fallback : null;
}

function positionTourStep() {
  if (!tourEls) return;
  const step = TOUR_STEPS[tourIndex];
  const target = resolveStepTarget(step);
  if (!target) {
    // 找不到目標元素就跳到下一步，避免導覽卡住
    goToStep(tourIndex + 1, 1);
    return;
  }

  const rect = target.getBoundingClientRect();
  const pad = 6;
  const highlight = tourEls.highlight;
  highlight.style.top = `${Math.max(rect.top - pad, 0)}px`;
  highlight.style.left = `${Math.max(rect.left - pad, 0)}px`;
  highlight.style.width = `${rect.width + pad * 2}px`;
  highlight.style.height = `${rect.height + pad * 2}px`;

  const tooltip = tourEls.tooltip;
  // 先量測 tooltip 尺寸（暫時放在螢幕外避免閃爍）
  tooltip.style.top = '-9999px';
  tooltip.style.left = '-9999px';
  const tw = tooltip.offsetWidth || 280;
  const th = tooltip.offsetHeight || 140;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let top = rect.bottom + pad + 10;
  if (top + th > vh - 10) {
    top = Math.max(rect.top - pad - th - 10, 10);
  }
  let left = rect.left;
  if (left + tw > vw - 10) left = vw - tw - 10;
  if (left < 10) left = 10;
  if (top < 10) top = 10;

  tooltip.style.top = `${top}px`;
  tooltip.style.left = `${left}px`;
}

function renderTourStep() {
  if (!tourEls) return;
  const step = TOUR_STEPS[tourIndex];
  const isFirst = tourIndex === 0;
  const isLast = tourIndex === TOUR_STEPS.length - 1;
  const nextLabel = step.finalStep ? '完成並開始探索' : '下一步';
  tourEls.tooltip.innerHTML = `
    <div class="tour-tooltip-step">第 ${tourIndex + 1} / ${TOUR_STEPS.length} 步</div>
    <h3 class="tour-tooltip-title">${step.title}</h3>
    <p class="tour-tooltip-desc">${step.desc}</p>
    ${step.extra ? `<p class="tour-tooltip-extra">${step.extra}</p>` : ''}
    <div class="tour-tooltip-actions">
      <button type="button" class="tour-btn-skip" data-tour-action="skip">跳過導覽</button>
      <div class="tour-tooltip-actions-right">
        ${isFirst ? '' : '<button type="button" class="tour-btn-prev" data-tour-action="prev">上一步</button>'}
        <button type="button" class="tour-btn-next" data-tour-action="next">${nextLabel}</button>
      </div>
    </div>
  `;

  tourEls.tooltip.querySelector('[data-tour-action="skip"]').addEventListener('click', endTour);
  const prevBtn = tourEls.tooltip.querySelector('[data-tour-action="prev"]');
  if (prevBtn) prevBtn.addEventListener('click', () => goToStep(tourIndex - 1, -1));
  tourEls.tooltip.querySelector('[data-tour-action="next"]').addEventListener('click', () => {
    if (isLast) endTour();
    else goToStep(tourIndex + 1, 1);
  });

  positionTourStep();
}

function goToStep(index, direction) {
  if (index < 0) return endTour();
  if (index >= TOUR_STEPS.length) return endTour();
  tourIndex = index;
  renderTourStep();
}

function onTourKeydown(e) {
  if (e.key === 'Escape') endTour();
}

function onTourReposition() {
  positionTourStep();
}

function bindReposition() {
  if (resizeBound) return;
  window.addEventListener('resize', onTourReposition);
  const sidebarBody = document.querySelector('.sidebar-body');
  if (sidebarBody) sidebarBody.addEventListener('scroll', onTourReposition, { passive: true });
  resizeBound = true;
}

function unbindReposition() {
  window.removeEventListener('resize', onTourReposition);
  const sidebarBody = document.querySelector('.sidebar-body');
  if (sidebarBody) sidebarBody.removeEventListener('scroll', onTourReposition);
  resizeBound = false;
}

export function startTour() {
  if (tourEls) endTour();
  ensureSidebarExpanded();

  const highlight = document.createElement('div');
  highlight.className = 'tour-highlight';
  const tooltip = document.createElement('div');
  tooltip.className = 'tour-tooltip';

  document.body.appendChild(highlight);
  document.body.appendChild(tooltip);

  tourEls = { highlight, tooltip };
  tourIndex = 0;
  document.addEventListener('keydown', onTourKeydown);
  bindReposition();
  renderTourStep();
}

function endTour() {
  if (!tourEls) return;
  tourEls.highlight.remove();
  tourEls.tooltip.remove();
  tourEls = null;
  document.removeEventListener('keydown', onTourKeydown);
  unbindReposition();
}

/* ---------------- 使用指南抽屜 ---------------- */

function buildGuideDrawer() {
  const overlay = document.createElement('div');
  overlay.className = 'guide-drawer-overlay';

  const drawer = document.createElement('div');
  drawer.className = 'guide-drawer';
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-modal', 'true');

  const itemsHtml = GUIDE_SECTIONS.map((section, i) => `
    <div class="guide-acc-item${i === 0 ? ' open' : ''}">
      <button type="button" class="guide-acc-head" data-acc-index="${i}">
        <span>${section.icon} ${section.title}</span>
      </button>
      <div class="guide-acc-body">${section.body}</div>
    </div>
  `).join('');

  drawer.innerHTML = `
    <div class="guide-drawer-header">
      <h2 class="guide-drawer-title">❔ 使用指南</h2>
      <button type="button" class="guide-drawer-close" title="關閉" aria-label="關閉">✕</button>
    </div>
    <div class="guide-drawer-body">${itemsHtml}</div>
  `;

  const close = () => {
    overlay.remove();
    drawer.remove();
    document.removeEventListener('keydown', onKeydown);
  };
  const onKeydown = (e) => {
    if (e.key === 'Escape') close();
  };

  overlay.addEventListener('click', close);
  drawer.querySelector('.guide-drawer-close').addEventListener('click', close);
  drawer.querySelectorAll('.guide-acc-head').forEach((head) => {
    head.addEventListener('click', () => {
      head.closest('.guide-acc-item').classList.toggle('open');
    });
  });
  document.addEventListener('keydown', onKeydown);

  return { overlay, drawer };
}

export function openGuideDrawer() {
  const { overlay, drawer } = buildGuideDrawer();
  document.body.appendChild(overlay);
  document.body.appendChild(drawer);
}

/* ---------------- 進入點 ---------------- */

export function initOnboarding() {
  const tourStartBtn = document.getElementById('tourStartBtn');
  const guideOpenBtn = document.getElementById('guideOpenBtn');

  if (tourStartBtn) tourStartBtn.addEventListener('click', () => startTour());
  if (guideOpenBtn) guideOpenBtn.addEventListener('click', () => openGuideDrawer());

  if (!hasSeenTour()) {
    openWelcomeModal();
  }
}
