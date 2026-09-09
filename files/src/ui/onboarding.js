// src/ui/onboarding.js
// 新手導覽（Welcome Modal + 聚光燈導覽，桌面版 8 步／手機版 4 步）與使用指南抽屜。
// 純 DOM 疊加層，只讀取既有元素的 getBoundingClientRect() 做定位，
// 不呼叫地圖／模式切換／搜尋等模組的內部邏輯，只靠 localStorage 記錄已讀旗標。

import { expandSidebar } from './sidebarToggle.js';
import { copyShareLink } from '../features/shareLink.js';
import { showLocateToast } from '../features/location.js';

const STORAGE_KEY = 'has_seen_map_tour';

/** 聚光燈導覽腳本。selector 找不到（或存在但目前不可見）時該步驟會被跳過。
 *
 *  桌面版（8 步）：地址搜尋→圖資搜尋→四種模式（透明疊圖／左右比對／
 *  時空時間軸／複合疊圖，各自點名一顆 #modeSwitch 按鈕）→落點探針
 *  （點地圖任意處，selector 直接用 #map，因為 #identifyPin 在還沒
 *  點過地圖前是 display:none，沒東西可以 highlight）→分享連結按鈕。
 *
 *  手機版（4 步）：手機版的「地圖模式」側邊欄手風琴（#modeSwitch）
 *  已經隱藏、改由常駐浮動按鈕 #mobileModeBtn 負責（見 style.css 的
 *  Mobile Responsive Layout／src/ui/mobileLayout.js），所以不逐一點名
 *  四種模式，改成一步介紹浮動按鈕本身（選單裡同時有模式切換／繪圖
 *  工具／說明分類，desc 文字一併帶到）。另外原本共用的「圖資搜尋」
 *  那一步在手機版預設（地址模式）下 #layerSearchInput／.layer-search-block
 *  都是 display:none（見 style.css 的
 *  body.mobile-search-mode-address .layer-search-block），選不到目標
 *  會被自動跳過，所以手機版改成介紹合併搜尋框的模式切換鈕
 *  #mobileSearchModeBtn，並多加一步介紹 Bottom Sheet 拖曳把手
 *  #sheetHandle。buildTourSteps() 在 startTour() 當下判斷一次即可，
 *  不需要跟著視窗縮放即時切換腳本內容。 */
function buildTourSteps() {
  const isMobile = window.matchMedia('(max-width:768px)').matches;
  if (isMobile) {
    return [
      {
        selector: '#sheetHandle',
        title: '🤚 面板拖曳把手',
        desc: '下方面板預設只露出一小角，往上拖曳（或直接點一下）即可展開看到完整功能；再點一下或往下拖曳即可收合，把畫面還給地圖。',
      },
      {
        selector: '#addressInput',
        fallbackSelector: '.mobile-search-bar',
        title: '📍 找一個地方',
        desc: '在頂部欄位輸入現在的地址或地標，系統會帶您定焦至該地點。',
      },
      {
        selector: '#mobileSearchModeBtn',
        fallbackSelector: '.address-search-row',
        title: '🗺️ 切換成圖資搜尋',
        desc: '點這顆切換鈕會變成搜尋歷史地圖圖層（年代、圖層名稱、來源或分類），跟地址搜尋是各自獨立的搜尋通道，切換不會清掉任何一邊已經搜出來的結果。',
      },
      {
        selector: '#mobileModeBtn',
        title: '🗺️ 地圖工具',
        desc: '點這顆浮動按鈕開啟選單：切換「歷史疊圖／左右比對／時間軸／複合疊圖」四種瀏覽模式，開關繪圖工具，或找到新手導覽、使用指南、分享連結。按鈕本身也能拖曳到您喜歡的位置。',
        extra: '現在輸入一個您熟悉的地點開始探索吧！',
        finalStep: true,
      },
    ];
  }
  return [
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
      desc: '依年代順序穿梭同一地點的歷史地圖，拖曳滑桿或點年份圓點切換。',
    },
    {
      selector: '#modeSwitch button[data-mode="multi"]',
      title: '🧩 複合疊圖',
      desc: '一次勾選多張歷史圖層疊在一起比較，可各自調整透明度、疊放順序或移除。',
    },
    {
      selector: '#map',
      title: '📌 點地圖看座標',
      desc: '一般瀏覽模式下，直接點地圖任意處會釘上一枚標記，顯示座標、反查地址，還能一鍵搜尋涵蓋這個點的歷史圖層。',
    },
    {
      selector: '#shareLinkBtn',
      title: '🔗 分享連結',
      desc: '把目前的模式、圖層、地圖位置打包成一個網址，複製後傳給朋友，對方打開就能還原跟您一樣的畫面。',
      extra: '現在輸入一個您熟悉的地點開始探索吧！',
      finalStep: true,
    },
  ];
}

let activeTourSteps = buildTourSteps();

/** 使用指南手風琴內容。 */
const GUIDE_SECTIONS = [
  {
    icon: '🔍',
    title: '搜尋定位',
    body: '「地址／位置搜尋」輸入現在的地名或地標，打字時下方會出現建議清單，點一下即可定焦；旁邊的定位圖示（使用目前位置尋找圖層）能直接用您目前的座標找可用圖資，不用自己打地址。定焦後側邊欄會列出「此地點可用圖層」，可切換「全部／依類型／依年代」三種排序方式檢視。「圖資搜尋」則是完全獨立的另一個搜尋框，用圖層名稱、年份、來源或分類找歷史地圖本身，不會做地理定位，找不到地點時可以改試這裡看看有沒有對應年代的圖層。兩者互不影響，各自保留自己的搜尋結果。',
  },
  {
    icon: '🗺️',
    title: '基礎比對',
    body: '「透明疊圖」會把歷史地圖蓋在現代底圖（或衛星影像）上，用「目前圖層」欄的透明度拉桿慢慢滑動即可看出地景變化，喜歡的圖層可以按☆收藏起來。「左右比對」則是用一條可拖曳的分割線，左右兩側各顯示一張地圖（左右圖層各自用浮動的圖層選單挑選，任何底圖或歷史圖層都能自由搭配），適合並排觀察差異較大的區域。',
  },
  {
    icon: '🕰️',
    title: '時間軸切換指南',
    body: '切到「時間軸」模式後，畫面下方會出現年代刻度（可切換 1:25,000／1:50,000／混合兩種比例尺），依目前地圖畫面中心點列出可用年份：拖曳滑桿、點選年份圓點，或按「播放」自動依序播放；地圖移動後不會自動重新整理，要按浮動列上的「重新整理」才會依新的位置重新列年份。\n\n另外還有一種完全獨立的「自訂時間軸」：在地址搜尋出來的「可用圖層」清單裡按「＋ 自訂時間軸 (多選)」進入多選模式，勾選想比較的圖層後按「確認建立自訂時間軸」，就會依年代排序打開一個獨立的浮動小面板，用自己的刻度點／滑桿／透明度拉桿切換自選的圖層清單。這跟上面的全站時間軸模式是兩套互不影響的東西，可以同時各自操作。',
  },
  {
    icon: '🧩',
    title: '進階功能說明',
    body: '「複合疊圖」模式可一次勾選多張歷史圖層疊在一起，清單在地圖下方，能各自調整透明度、拖曳調整疊放順序或移除；也能在這個模式加入自訂 WMTS／XYZ 圖層（見下方說明）。\n\n繪圖標記工具（點畫筆圖示開關）可以：標「點」（能附加文字說明）、畫「線」（自動算出長度）、畫「面」（自動算出面積），六種色票或自訂顏色可選；畫好的圖形可以用「選取」工具點開重新改名／改色／刪除。整批操作還有「刪除」（刪目前選取的）、「清空」（全部清掉）、「匯出 GeoJSON」（下載成檔案，可匯入 QGIS／ArcGIS 等 GIS 軟體）、「匯入 GeoJSON」（讀回之前匯出的檔案，顏色樣式會保留）、「地圖截圖」（把目前畫面含底圖與繪製內容存成 PNG 圖片）。繪製內容不受目前模式影響，切換疊圖／比對／時間軸／複合疊圖都還在。\n\n若中研院以外的圖資來源也有提供圖磚服務，可以在複合疊圖模式的「自訂 WMTS／XYZ 圖層」區塊加入：「手動貼網址」適合已知圖磚網址樣板（需含 {z}/{x}/{y}）的單張圖層；「從 WMTS 服務匯入」則貼上該服務的 GetCapabilities 網址，讀取後可一次勾選多張圖層加入（只會列出跟本站座標系統 EPSG:3857 相容的圖層），如果該服務沒開放跨網域讀取會顯示錯誤，改用「手動貼網址」通常還是能顯示圖磚。',
  },
  {
    icon: '📌',
    title: '落點探針',
    body: '在「歷史疊圖」這個一般瀏覽模式下（其他模式不會觸發），直接點地圖上任意一處即可釘上一枚標記並跳出資訊視窗，顯示該點的座標（WGS84／TWD97）與反查出來的地址；視窗裡還有一顆「搜尋涵蓋此點之歷史圖層」按鈕，點下去會直接切換成地址搜尋、列出涵蓋這個座標的歷史圖資，不用再手動輸入地址。標記放好後，點空白處只會關掉資訊視窗、標記不會消失，要重看資訊點標記本身即可重開；真的要換點或清除，用視窗裡的「清除點位」按鈕（桌面版也可以在標記上按右鍵：視窗開著先關視窗，視窗已經關著的第二次右鍵才會真的清除）。',
  },
  {
    icon: '🔗',
    title: '分享連結',
    body: '側邊欄 header 的「🔗 分享連結」按鈕會把目前畫面狀態（瀏覽模式、底圖、目前疊圖／左右比對的左右圖層與分割線位置、複合疊圖清單，以及地圖中心點與縮放層級）打包編碼進網址，並自動複製到剪貼簿，直接貼給朋友即可。對方打開連結會自動還原成同一個畫面；請留意複合疊圖清單裡的自訂 WMTS／XYZ 圖層只存在您自己瀏覽器的紀錄裡，分享連結不會帶到對方那邊，對方看到的複合疊圖清單會略過這些自訂圖層。',
  },
  {
    icon: '⭐',
    title: '收藏與最近使用圖層',
    body: '側邊欄「目前圖層」欄位旁的☆按鈕可以收藏正在檢視的歷史圖層，收藏後的清單會另外顯示在側邊欄的「⭐ 收藏」手風琴裡，點清單項目可以直接套用該圖層，不用重新搜尋一次；再按一次☆（或清單裡的★取消收藏）即可移除。「🕘 最近使用」則會自動記錄最近選過的圖層，不用手動操作，旁邊有「清除紀錄」按鈕可以一次清空。兩份清單都存在瀏覽器的 localStorage，換裝置或清瀏覽器資料不會保留。',
  },
  {
    icon: '📱',
    title: '手機版操作方式',
    body: '手機（寬度 768px 以下）畫面以地圖為主，側邊欄變成可拖曳的下方面板（Bottom Sheet）：面板頂端的把手可以點一下或上下拖曳，在「收合（只露出一小角）」與「展開（約螢幕 3/4 高）」兩態間切換。搜尋框移到畫面最上方一條合併輸入框，預設是地址搜尋，按旁邊的📍/🗺切換鈕可改成圖資搜尋，兩邊搜尋結果各自保留互不影響；閒置 15 秒沒有互動會自動收成一個圓形按鈕，點一下就會展開回來。畫面右下角的浮動按鈕「地圖工具」點下去會彈出選單，可以切換四種瀏覽模式、開關繪圖工具，或找到新手導覽、使用指南、分享連結（取代電腦版側邊欄裡對應的那排按鈕），這顆按鈕本身也能拖到您喜歡的位置。國家篩選列選到「台灣」或「中國」分頁時，圖層清單會改成手機專屬的三段式瀏覽：先選大區域（例如台灣的北部／中部／南部／東部／離島），再選地區（同縣市的來源會合併，例如台北的兩個來源算同一個地區），最後展開該地區的來源手風琴挑選實際圖層；選「其他」分頁則維持跟電腦版一樣的「來源→分類→次分類→圖層」手風琴。',
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
  const step = activeTourSteps[tourIndex];
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
  const step = activeTourSteps[tourIndex];
  const isFirst = tourIndex === 0;
  const isLast = tourIndex === activeTourSteps.length - 1;
  const nextLabel = step.finalStep ? '完成並開始探索' : '下一步';
  tourEls.tooltip.innerHTML = `
    <div class="tour-tooltip-step">第 ${tourIndex + 1} / ${activeTourSteps.length} 步</div>
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
  if (index >= activeTourSteps.length) return endTour();
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
  activeTourSteps = buildTourSteps(); // 依當下是否為手機尺寸決定腳本版本

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
  const shareLinkBtn = document.getElementById('shareLinkBtn');

  if (tourStartBtn) tourStartBtn.addEventListener('click', () => startTour());
  if (guideOpenBtn) guideOpenBtn.addEventListener('click', () => openGuideDrawer());
  if (shareLinkBtn) {
    shareLinkBtn.addEventListener('click', async () => {
      const ok = await copyShareLink();
      showLocateToast(ok ? '連結已複製' : '複製失敗，請手動複製網址列');
    });
  }

  if (!hasSeenTour()) {
    openWelcomeModal();
  }
}
