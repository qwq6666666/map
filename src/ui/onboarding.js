// src/ui/onboarding.js
// 新手導覽（Welcome Modal + 聚光燈導覽，桌面版 8 步／手機版 4 步）與使用指南抽屜。
// 純 DOM 疊加層，只讀取既有元素的 getBoundingClientRect() 做定位，
// 不呼叫地圖／模式切換／搜尋等模組的內部邏輯，只靠 localStorage 記錄已讀旗標。

import { expandSidebar } from './sidebarToggle.js';
import { removeDrawerAnimated } from './drawerClose.js';

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
        title: '<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#pin"></use></svg> 找一個地方',
        desc: '在頂部欄位輸入現在的地址或地標，系統會帶您定焦至該地點。',
      },
      {
        selector: '#mobileSearchModeBtn',
        fallbackSelector: '.address-search-row',
        title: '<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#map"></use></svg> 切換成圖資搜尋',
        desc: '點這顆切換鈕會變成搜尋歷史地圖圖層（年代、圖層名稱、來源或分類），跟地址搜尋是各自獨立的搜尋通道，切換不會清掉任何一邊已經搜出來的結果。',
      },
      {
        selector: '#mobileModeBtn',
        title: '<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#map"></use></svg> 地圖工具',
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
      title: '<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#pin"></use></svg> 找一個地方',
      desc: '輸入現在的地址或地標，系統會帶您定焦至該地點。',
    },
    {
      selector: '#layerSearchInput',
      fallbackSelector: '.layer-search-block',
      title: '<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#map"></use></svg> 找歷史地圖',
      desc: '想看特定歷史圖資？在這裡搜尋年代、圖層名稱或來源（與上方地址搜尋不同）。',
    },
    {
      selector: '#modeSwitch button[data-mode="overlay"]',
      title: '<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#overlay"></use></svg> 透明疊圖',
      desc: '將歷史地圖疊加在現代圖資上，滑動透明度拉桿透視百年變遷。',
    },
    {
      selector: '#modeSwitch button[data-mode="compare"]',
      title: '<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#compare"></use></svg> 左右比對',
      desc: '左右拖曳滑動分割線，直接比對兩張地圖的地景差異。',
    },
    {
      selector: '#modeSwitch button[data-mode="timeline"]',
      title: '<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#timeline"></use></svg> 時空時間軸',
      desc: '依年代順序穿梭同一地點的歷史地圖，拖曳滑桿或點年份圓點切換。',
    },
    {
      selector: '#modeSwitch button[data-mode="multi"]',
      title: '<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#layers"></use></svg> 複合疊圖',
      desc: '一次勾選多張歷史圖層疊在一起比較，可各自調整透明度、疊放順序或移除。',
    },
    {
      selector: '#map',
      title: '<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#pin"></use></svg> 點地圖看座標',
      desc: '一般瀏覽模式下，直接點地圖任意處會釘上一枚標記，顯示座標、反查地址，還能一鍵搜尋涵蓋這個點的歷史圖層。',
    },
    {
      // #shareLinkBtn 在預設隱藏的「⋯ 更多」選單裡，找不到可見目標會被整步跳過，
      // 導覽就永遠走不到最後一步，所以聚光燈打在選單入口 #tourMoreBtn 上。
      selector: '#tourMoreBtn',
      title: '<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#share"></use></svg> 分享連結',
      desc: '按「⋯ 更多」選「分享連結」，把目前的模式、圖層、地圖位置打包成一個網址，複製後傳給朋友，對方打開就能還原跟您一樣的畫面。',
      extra: '現在輸入一個您熟悉的地點開始探索吧！',
      finalStep: true,
    },
  ];
}

let activeTourSteps = buildTourSteps();

/** 使用指南手風琴內容。每段盡量壓在 3~4 句以內，讓使用者能快速掃過抓到操作重點。 */
const GUIDE_SECTIONS = [
  {
    icon: '<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#search"></use></svg>',
    title: '搜尋定位',
    body: '輸入地名或地標，建議清單會即時列出；也可按輸入框旁的「使用目前位置」按鈕，改用目前所在位置定位，不用自己打地址。\n\n若輸入的是古地名（例如日治堡里名、清代舊稱），會直接開啟「地名今昔對照卡」顯示新舊名稱與沿革；一般地址命中後，若附近有記錄到的歷史地名，也會另外列出「附近歷史地名」供點選查看。\n\n定焦後側邊欄會列出「此地點可用圖層」，可切換「全部」「類型」「年代」三種排序。\n\n「圖資搜尋」是完全獨立的另一個搜尋框，直接用圖層名稱、年份、來源或分類找圖層，不做定位，兩邊搜尋結果互不影響。',
  },
  {
    icon: '<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#map"></use></svg>',
    title: '基礎比對',
    body: '「透明疊圖」把歷史地圖蓋在現代底圖（或衛星影像）上，拖曳透明度拉桿即可看出地景變化，喜歡的圖層可按「收藏」星號（☆）收藏。「左右比對」用可拖曳的分割線並排兩張地圖，左右圖層各自由浮動選單挑選、底圖與歷史圖層可任意搭配，適合觀察差異明顯的區域。',
  },
  {
    icon: '<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#timeline"></use></svg>',
    title: '時間軸切換指南',
    body: '「時間軸」模式依目前地圖中心點列出可用年份，下方刻度可切換比例尺（1:25,000／1:50,000／混合）：拖曳滑桿、點年份圓點，或按「播放」自動依序切換。<strong>地圖移動後要按「重新整理」，才會依新位置重新列出年份。</strong>\n\n另有獨立的「自訂時間軸」，跟「時間軸」模式互不影響、可以同時操作：<ol><li>在「此地點可用圖層」清單按「＋ 自訂時間軸 (多選)」</li><li>勾選想比較的圖層</li><li>按「確認建立」，即可依年代開啟專屬浮動面板瀏覽</li></ol>',
  },
  {
    icon: '<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#layers"></use></svg>',
    title: '複合疊圖',
    body: '「複合疊圖」可一次勾選多張歷史圖層疊加，各自調整透明度、拖曳排序或移除，也能在此加入自訂圖層（見「自訂圖層匯入」）。',
  },
  {
    icon: '<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#draw"></use></svg>',
    title: '繪圖工具',
    body: '按地圖右側的「繪圖工具」按鈕（畫筆圖示）開關工具列，手機版在「地圖工具」選單裡。可標點（能附加文字）、畫線（自動算長度）、畫面（自動算面積），六色票或自訂顏色可選；「選取」工具可改名／改色／刪除。\n\n另有「刪除」、「清空」、匯出／匯入 GeoJSON（可與 QGIS／ArcGIS 互通）、地圖截圖，繪製內容不受模式切換影響。\n\n「清空」會刪除全部繪製內容（按下後會先跳出確認視窗），<strong>這個動作無法復原</strong>。繪製內容只存在這台裝置的瀏覽器裡，<strong>換裝置或清瀏覽器資料就會消失，不是雲端同步保存</strong>。',
  },
  {
    icon: '<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#guide"></use></svg>',
    title: '自訂圖層匯入',
    body: '在「複合疊圖」模式的「自訂 WMTS／XYZ 圖層」區塊，可以加入中研院以外的圖資，有兩種方式：\n\n「手動貼網址」適合單張圖層，或不是標準 WMTS 服務的圖磚來源：<ol><li>填入「名稱」與含 {z}/{x}/{y} 的「網址樣板」（「格式」「版權標示」為選填）</li><li>按「加入」</li></ol>\n「從 WMTS 服務匯入」可一次加入多張圖層：<ol><li>貼上該服務的 GetCapabilities 網址</li><li>按「讀取圖層清單」（服務需開放跨網域讀取；若顯示錯誤，可改用「手動貼網址」）</li><li>勾選要加入的圖層，可用「全選／取消全選」（只列出跟本站座標系統 EPSG:3857 相容的圖層）</li><li>按「加入勾選的圖層」</li></ol>\n<strong>自訂圖層只存在您自己的瀏覽器裡，換裝置或清瀏覽器資料就會消失，也不會包含在分享連結內。</strong>',
  },
  {
    icon: '<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#pin"></use></svg>',
    title: '落點探針',
    body: '在「透明疊圖」模式下點地圖任意處會釘上標記，顯示座標（WGS84／TWD97）與反查地址，並有「搜尋涵蓋此點之歷史圖層」按鈕可直接找圖層；若座標剛好命中剛搜尋過的歷史地名，還會顯示「歷史地名」小卡與「查看地名沿革」按鈕。\n\n點空白處只會關閉資訊視窗，標記不會消失。要清除標記，可按視窗裡的「清除點位」；桌面版也可以對標記按右鍵：<ol><li>第一次按右鍵：先關閉資訊視窗</li><li>再按一次右鍵：才會真的清除標記</li></ol>',
  },
  {
    icon: '<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#share"></use></svg>',
    title: '分享連結',
    body: '在頂部「⋯ 更多」選單按「分享連結」（手機版在「地圖工具」選單裡），會把目前模式、底圖、圖層與地圖位置打包進網址並自動複製，貼給朋友、對方打開就能還原同一畫面。\n\n<strong>自訂 WMTS／XYZ 圖層只存在您自己的瀏覽器裡，不會包含在分享連結內。</strong>',
  },
  {
    icon: '<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#source-status"></use></svg>',
    title: '來源狀態／快取',
    body: '頂部「⋯ 更多」選單裡的「來源狀態／快取」可以檢查各圖資來源主機目前是否正常回應、查看最近讀取失敗的圖磚記錄，也能一鍵清除瀏覽器已下載的圖磚快取（圖層資料本身不受影響，下次瀏覽同一區域會重新下載圖磚）。圖層長時間空白、或懷疑資料沒更新時可以先來這裡看看。',
  },
  {
    icon: '<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#favorite"></use></svg>',
    title: '收藏與最近使用圖層',
    body: '「目前圖層」欄位旁的「收藏」星號（☆）可以收藏正在檢視的圖層，收藏清單顯示在側邊欄的「收藏」分頁，點項目可直接套用，不用重新搜尋。\n\n「最近使用」分頁會自動記錄近期選過的圖層，可按「清除紀錄」一次清空。\n\n<strong>兩份清單都只存在這台裝置的瀏覽器（localStorage），換裝置或清瀏覽器資料就會消失，不是雲端同步保存。</strong>',
  },
  {
    // sprite（map-emoji-style-a-icons.svg）裡沒有語意相近的手機圖示，刻意留空、只放文字標題，
    // 比繼續用 📱 emoji 跟其他段落的單色線條圖示更一致；新增圖示後再補上。
    icon: '',
    title: '手機版操作方式',
    body: '手機（寬度 768px 以下）以地圖為主，側邊欄變成可拖曳的下方面板。頂端把手可點一下或拖曳，在「收合」（只露出一小角）與「展開」（約螢幕 3/4 高）之間切換。\n\n畫面上方的合併搜尋列預設是地址搜尋，按搜尋列右側的切換鈕（提示文字為「切換成圖資搜尋」）可改成圖資搜尋，兩邊結果互不影響；閒置 15 秒沒互動會自動收成圓鈕。\n\n畫面左側預設有浮動的「地圖工具」按鈕，可切換瀏覽模式、開關「繪圖工具」、「定位」，也能找到「新手導覽」「使用指南」「分享連結」「來源狀態／快取」；按鈕本身可以拖到喜歡的位置。\n\n國家篩選選到「台灣」或「中國」時，圖層清單會改成三段式瀏覽（大區域→地區→來源）；選「其他」則是二段式（先選來源，再看該來源的分類與圖層）。',
  },
  {
    icon: '<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#library"></use></svg>',
    title: '資料來源與坐標系統',
    body: '圖資主要來自中央研究院人文社會科學研究中心 GIS 專題中心與各地方文史單位的 WMTS 服務，地圖座標統一採用 EPSG:3857（Web Mercator）顯示。學術引用請以各圖層詳細資訊中標示的原始來源與版權聲明為準。',
  },
  {
    icon: '<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#info"></use></svg>',
    title: '常見問題',
    body: '<strong>Q：為什麼這個地方完全沒有歷史地圖可以疊？</strong>\nA：老地圖的掃描／測繪範圍本來就有限，不是每個角落都收錄，純粹是資料沒涵蓋到，不是系統故障。\n\n<strong>Q：圖層一直讀取失敗或空白，是不是壞掉了？</strong>\nA：多半是來源主機暫時壅塞或逾時，可以到「⋯ 更多」→「來源狀態／快取」檢查主機是否正常回應，或清除快取後重新整理再試一次。\n\n<strong>Q：分享連結給朋友，為什麼他看到的複合疊圖組合少了幾張？</strong>\nA：自訂 WMTS／XYZ 圖層只存在您自己瀏覽器的紀錄裡，分享連結不會帶過去，對方需要自己重新加入。\n\n<strong>Q：搜尋不到某個舊地名或古地名，怎麼辦？</strong>\nA：地名今昔對照是精確比對資料庫既有收錄的地名，沒收錄就搜不到；可以改用一般地址搜尋定焦附近，再看看「附近歷史地名」清單有沒有相近的紀錄。\n\n<strong>Q：重新整理頁面後，我畫的圖形或加入的自訂圖層不見了？</strong>\nA：這些資料只存在瀏覽器本機（localStorage），沒清瀏覽器資料就會留著；換裝置、換瀏覽器或清除資料就會消失，不是雲端同步保存。\n\n<strong>Q：這些歷史地圖可以下載或引用嗎？授權為何？</strong>\nA：各圖層版權以其詳細資訊中標示的原始來源與版權聲明為準，學術引用請照該處標示的出處註記，不同來源授權條件可能不同。',
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

// 手機版導覽腳本（見 buildTourSteps()）點名的目標元素（#sheetHandle／
// #addressInput／#mobileSearchModeBtn／#mobileModeBtn）全部都在
// #sidebar（Bottom Sheet）之外，不需要展開面板才看得到；第一步文案
// 還特別在示範「往上拖曳把手即可展開」，若一開始就強制展開會直接
// 跟文案矛盾、也擋住示範情境。因此只在桌面版才強制展開側邊欄。
function ensureSidebarExpanded() {
  if (window.matchMedia('(max-width:768px)').matches) return;
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
      <h2 class="onboarding-modal-title"><svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#map"></use></svg> 歡迎來到百年歷史地圖</h2>
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
// 不代表它現在真的顯示在畫面上，這裡額外用 getClientRects() 判斷是否
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
    goToStep(tourIndex + 1);
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
  if (prevBtn) prevBtn.addEventListener('click', () => goToStep(tourIndex - 1));
  tourEls.tooltip.querySelector('[data-tour-action="next"]').addEventListener('click', () => {
    if (isLast) endTour();
    else goToStep(tourIndex + 1);
  });

  positionTourStep();
}

function goToStep(index) {
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

// 桌面版側邊欄展開有寬高轉場（styles/base.css 檔尾），導覽開始時才
// expandSidebar()，量到的目標位置是轉場中途的；轉場結束再補一次定位。
// transitionend 會從子元素（hover、箭頭轉動）冒泡上來，只認側邊欄自己。
function onSidebarTransitionEnd(e) {
  if (e.target === e.currentTarget) positionTourStep();
}

function bindReposition() {
  if (resizeBound) return;
  window.addEventListener('resize', onTourReposition);
  document.getElementById('sidebar')?.addEventListener('transitionend', onSidebarTransitionEnd);
  const sidebarBody = document.querySelector('.sidebar-body');
  if (sidebarBody) sidebarBody.addEventListener('scroll', onTourReposition, { passive: true });
  resizeBound = true;
}

function unbindReposition() {
  window.removeEventListener('resize', onTourReposition);
  document.getElementById('sidebar')?.removeEventListener('transitionend', onSidebarTransitionEnd);
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

// 每次建立抽屜遞增，讓 aria-controls 指向的 id 在同一頁面上永遠唯一
// （關閉動畫進行中若再次開啟，新舊兩份 DOM 會短暫並存）。
let guideDrawerSeq = 0;

function buildGuideDrawer() {
  const drawerId = ++guideDrawerSeq;
  const overlay = document.createElement('div');
  overlay.className = 'guide-drawer-overlay';

  const drawer = document.createElement('div');
  drawer.className = 'guide-drawer';
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-modal', 'true');

  // aria-expanded／aria-controls：展開狀態原本只靠 .open class 表達，螢幕閱讀器
  // 讀不到；渲染與 toggle 時都要同步維護（見下方 click handler）。
  // icon 為空字串（sprite 裡沒有語意相近的圖示，例如「手機版操作方式」）時只放標題，
  // 不留前導空白。
  const itemsHtml = GUIDE_SECTIONS.map((section, i) => {
    const bodyId = `guide-acc-body-${drawerId}-${i}`;
    const isOpen = i === 0;
    return `
    <div class="guide-acc-item${isOpen ? ' open' : ''}">
      <button type="button" class="guide-acc-head" data-acc-index="${i}" aria-expanded="${isOpen}" aria-controls="${bodyId}">
        <span>${section.icon ? `${section.icon} ` : ''}${section.title}</span>
      </button>
      <div class="guide-acc-body" id="${bodyId}">${section.body}</div>
    </div>
  `;
  }).join('');

  drawer.innerHTML = `
    <div class="guide-drawer-header">
      <h2 class="guide-drawer-title"><svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#guide"></use></svg> 使用指南</h2>
      <button type="button" class="guide-drawer-close" title="關閉" aria-label="關閉"><svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#close"></use></svg></button>
    </div>
    <div class="guide-drawer-body">${itemsHtml}</div>
  `;

  const close = () => {
    removeDrawerAnimated(overlay, drawer);
    document.removeEventListener('keydown', onKeydown);
  };
  const onKeydown = (e) => {
    if (e.key === 'Escape') close();
  };

  overlay.addEventListener('click', close);
  drawer.querySelector('.guide-drawer-close').addEventListener('click', close);
  drawer.querySelectorAll('.guide-acc-head').forEach((head) => {
    head.addEventListener('click', () => {
      const isOpen = head.closest('.guide-acc-item').classList.toggle('open');
      head.setAttribute('aria-expanded', String(isOpen));
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

// 工具列按鈕排「⋯ 更多」下拉選單：分享連結／清除快取／來源狀態三個
// 低頻功能收在裡面，展開只是單純切換 hidden，不影響裡面按鈕各自的
// click handler（見下方各自 addEventListener，選單開合跟功能觸發是
// 兩件互不相干的事）。
function initTourMoreMenu() {
  const wrap = document.querySelector('.tour-more-wrap');
  const moreBtn = document.getElementById('tourMoreBtn');
  const menu = document.getElementById('tourMoreMenu');
  if (!wrap || !moreBtn || !menu) return;

  const close = () => {
    menu.hidden = true;
    moreBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onOutsideClick);
    document.removeEventListener('keydown', onKeydown);
  };
  const onOutsideClick = (e) => { if (!wrap.contains(e.target)) close(); };
  const onKeydown = (e) => { if (e.key === 'Escape') close(); };

  moreBtn.addEventListener('click', () => {
    const willOpen = menu.hidden;
    if (willOpen) {
      menu.hidden = false;
      moreBtn.setAttribute('aria-expanded', 'true');
      document.addEventListener('click', onOutsideClick);
      document.addEventListener('keydown', onKeydown);
    } else {
      close();
    }
  });
  // 選單裡任何按鈕被點擊後（不論分享連結／清除快取／來源狀態），選單
  // 本身就該收起來，不用各自的 click handler 記得收合。
  menu.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', close);
  });
}

export function initOnboarding() {
  initTourMoreMenu();
  const tourStartBtn = document.getElementById('tourStartBtn');
  const guideOpenBtn = document.getElementById('guideOpenBtn');

  // 「分享連結」按鈕的行為（手機叫系統分享面板、桌面直接複製）在 ui/nativeShareUI.js。
  if (tourStartBtn) tourStartBtn.addEventListener('click', () => startTour());
  if (guideOpenBtn) guideOpenBtn.addEventListener('click', () => openGuideDrawer());

  if (!hasSeenTour()) {
    openWelcomeModal();
  }
}
