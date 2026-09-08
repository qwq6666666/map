/* ---------------------------------------------------------
   ui/mobileLayout.js — 手機版 (<=768px) 版面協調層
   ---------------------------------------------------------
   這支檔案不重新實作任何搜尋／模式切換／圖層邏輯，只做三件事：

   1. 監看 matchMedia('(max-width:768px)')，跨越 768px 門檻時把
      「真正的」DOM 節點（.address-search-row／#addressSuggest／
      .layer-search-row）搬進／搬出手機版頂部搜尋列 #mobileSearchBar
      ——是搬移不是複製，事件監聽器跟 features/search.js、
      features/layerSearch.js、ui/search.js、ui/layerSearch.js 完全沒有
      改變。地址搜尋列與圖資搜尋列會「同時」搬進 #mobileSearchBar，但
      靠 body class（mobile-search-mode-address／mobile-search-mode-layer，
      由 initMobileSearchModeToggle()／applyMobileSearchMode() 同步）
      同一時間只顯示其中一條，加上一顆合併切換鈕（#mobileSearchModeBtn，
      放在地址搜尋列裡），讓使用者視覺上只看到一個輸入框，實際上兩邊
      仍是各自獨立的真實 DOM 節點，互不接管對方的搜尋邏輯與狀態，切換
      模式不會清除任何一邊已經搜尋出來的結果。
   2. 讓 #sidebar 在手機版變成可拖曳／點擊循環二態的 Bottom Sheet
      （收合 peek／展開 75vh），沿用既有的 collapseSidebar()／
      expandSidebar()（ui/sidebarToggle.js）做「收合／展開」二態切換，
      幾何全部交給 style.css 的 Mobile Responsive Layout 區塊。
   3. 手機版「地圖工具」快速選單（#mobileModeBtn／#mobileModePopover）
      只是轉呼叫 #modeSwitch 裡對應按鈕的 .click()，核心模式切換邏輯
      仍在 core/modeManager.js；選單裡另外併了「說明」分類（🧭 新手導覽／
      ❔ 使用指南兩個選項），同理只轉呼叫側邊欄裡原本的 #tourStartBtn／
      #guideOpenBtn，取代被隱藏的 .tour-btn-row；
      「目前圖層」浮動列點擊展開/收合透明度拉桿；搜尋結果出現時自動
      把 Bottom Sheet 打開到展開態，方便直接看到。
   4. 即時量測 window.visualViewport.height 寫成 --vvh 供 style.css 算
      Sheet 高度（手機瀏覽器工具列會動態顯示/收起，純 vh 對不上實際
      可視高度），並同步 body class（mobile-sheet-open／
      mobile-mode-<mode>）讓 CSS 在 Sheet 打開／特定模式下藏起會互相
      重疊的浮動控制項，或依模式簡化畫面（例如時間軸模式隱藏頂部搜尋
      列／定位／繪圖）——這些都只是「暫時隱藏＋別處找得到同樣功能」，
      不是刪除功能。
   5. 「地圖工具」浮動按鈕可拖曳到螢幕任何位置並記住（localStorage），
      選單面板開啟時改成跟著按鈕目前位置浮出，純呈現層面的調整。
   6. 頂部搜尋列 15 秒閒置（無 focus／無輸入）自動摺疊成圓形圖示按鈕，
      點擊摺疊態立即展開並 focus 回輸入框；純 CSS transition 做動畫，
      這裡只管 class 的加減與計時器排程。

   >768px（平板／桌面）時，這裡所有動作都是 no-op，畫面與操作維持
   桌面版原樣。
--------------------------------------------------------- */
import { state as store, subscribe } from '../store.js';
import { collapseSidebar, expandSidebar } from './sidebarToggle.js';

const MOBILE_QUERY = '(max-width:768px)';
const MOBILE_PLACEHOLDER = '🔍 搜尋地址、地點……';
const MOBILE_LAYER_PLACEHOLDER = '🗺 搜尋圖層名稱、年份……';

const mq = window.matchMedia(MOBILE_QUERY);
let desktopPlaceholder = null;
let desktopLayerPlaceholder = null;

/* ---------------------------------------------------------
   實機測試（見專案回報）發現手機瀏覽器的網址列／工具列會動態
   顯示/收起，若直接用 CSS `vh` 算 Bottom Sheet 高度，`vh` 是以「工具列
   收起後」的最大視窗換算，跟當下實際看得到的可視高度對不上，導致
   Sheet 實際佔用的高度比算出來的短一截、露出底下地圖與浮動控制項
   （左右比對／時間軸的浮動列因此「跑出來」蓋住畫面，即回報中的
   「展開下欄會跑上去遮擋畫面」）。這裡改用
   `window.visualViewport.height`（沒有就退回 innerHeight）即時量測，
   寫成 CSS 變數 --vvh 讓 style.css 的 --mobile-sheet-full
   用 px 精確計算，取代原本純 vh 的算法。
--------------------------------------------------------- */
function updateViewportMetrics(){
  const h = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
  document.documentElement.style.setProperty('--vvh', `${h}px`);
}

/* ---------------------------------------------------------
   1. 搜尋列搬移：只搬「搜尋列本體」與「建議清單」這兩個節點，
   .field-label／#locationResult（含座標資訊、可用圖層清單）留在
   側邊欄 Bottom Sheet 裡——地址搜尋結果依然是 Bottom Sheet 的一部分，
   只是輸入框獨立浮在地圖最上方，符合「搜尋比桌面更好找、但結果
   不塞進窄欄」的手機版需求，同時完全不用複製任何一段搜尋邏輯。
--------------------------------------------------------- */
function relocateSearchBar(isMobile){
  const searchBlock = document.querySelector('.search-block');
  const searchRow = searchBlock?.querySelector('.search-row');
  const suggestEl = document.getElementById('addressSuggest');
  const locationResultEl = document.getElementById('locationResult');
  const mobileBar = document.getElementById('mobileSearchBar');
  const addressInput = document.getElementById('addressInput');
  if(!searchBlock || !searchRow || !suggestEl || !locationResultEl || !mobileBar) return;

  if(isMobile){
    if(searchRow.parentElement !== mobileBar) mobileBar.appendChild(searchRow);
    if(suggestEl.parentElement !== mobileBar) mobileBar.appendChild(suggestEl);
    if(addressInput){
      if(desktopPlaceholder === null) desktopPlaceholder = addressInput.placeholder;
      addressInput.placeholder = MOBILE_PLACEHOLDER;
    }
  } else {
    if(searchRow.parentElement !== searchBlock) searchBlock.insertBefore(searchRow, locationResultEl);
    if(suggestEl.parentElement !== searchBlock) searchBlock.insertBefore(suggestEl, locationResultEl);
    if(addressInput && desktopPlaceholder !== null) addressInput.placeholder = desktopPlaceholder;
  }
}

/* ---------------------------------------------------------
   1a. 圖資搜尋列搬移：跟 relocateSearchBar() 對稱，只搬「搜尋列本體」
   （.layer-search-row，含 #layerSearchInput／#layerSearchClearBtn）這一個
   節點，#layerSearchPanel（搜尋結果）留在側邊欄 Bottom Sheet 裡不動。
   跟地址搜尋的 .search-row 搬進同一個 #mobileSearchBar，是否顯示由
   applyMobileSearchMode() 同步的 body class 決定（見 style.css），這裡
   完全不碰 ui/layerSearch.js 的比對邏輯與事件監聽器。
--------------------------------------------------------- */
function relocateLayerSearchRow(isMobile){
  const layerBlock = document.querySelector('.layer-search-block');
  const layerRow = layerBlock?.querySelector('.layer-search-row');
  const layerPanelEl = document.getElementById('layerSearchPanel');
  const mobileBar = document.getElementById('mobileSearchBar');
  const layerInput = document.getElementById('layerSearchInput');
  if(!layerBlock || !layerRow || !layerPanelEl || !mobileBar) return;

  if(isMobile){
    if(layerRow.parentElement !== mobileBar) mobileBar.appendChild(layerRow);
    if(layerInput){
      if(desktopLayerPlaceholder === null) desktopLayerPlaceholder = layerInput.placeholder;
      layerInput.placeholder = MOBILE_LAYER_PLACEHOLDER;
    }
  } else {
    if(layerRow.parentElement !== layerBlock) layerBlock.insertBefore(layerRow, layerPanelEl);
    if(layerInput && desktopLayerPlaceholder !== null) layerInput.placeholder = desktopLayerPlaceholder;
  }
}

/* ---------------------------------------------------------
   1a-2. 手機版「地址／位置搜尋」與「圖資搜尋」合併成同一個輸入框：
   兩條 .search-row 都常駐在 #mobileSearchBar 裡（見上方兩個
   relocate 函式），這裡只負責切換鈕的點擊與一個 body class
   （mobile-search-mode-address／mobile-search-mode-layer），實際的
   顯示/隱藏交給 style.css，兩邊各自的輸入邏輯（geocodeAddress() debounce
   ／searchLayers() 立即比對）完全不受影響，也不互相接管對方的輸入框。
--------------------------------------------------------- */
let mobileSearchMode = 'address'; // 'address' | 'layer'，只在手機版有意義

/* 切換鈕（#mobileSearchModeBtn）本身沒有專屬容器，必須跟著「目前顯示
   中」的那條 .search-row 走，否則另一條 row 被 display:none 隱藏時，
   放在裡面的切換鈕會被連帶隱藏、使用者卡在圖資模式切不回地址模式。
   這裡用純 DOM 搬移（跟 relocateSearchBar()／relocateLayerSearchRow()
   同一種手法）把按鈕塞進目前可見的那條 row，不改變按鈕的事件監聽器。
   mode 參數預設吃目前 mobileSearchMode，desktop 收尾時會明確傳
   'address' 把按鈕搬回原始位置（見 applyBreakpoint()）。 */
function relocateModeToggleBtn(mode = mobileSearchMode){
  const btn = document.getElementById('mobileSearchModeBtn');
  if(!btn) return;
  const targetRow = mode === 'layer'
    ? document.querySelector('.layer-search-row')
    : document.querySelector('.address-search-row');
  const anchor = mode === 'layer'
    ? document.getElementById('layerSearchClearBtn')
    : document.getElementById('locateSearchBtn');
  if(targetRow && btn.parentElement !== targetRow){
    targetRow.insertBefore(btn, anchor || null);
  }
}

function applyMobileSearchMode(){
  document.body.classList.toggle('mobile-search-mode-address', mobileSearchMode === 'address');
  document.body.classList.toggle('mobile-search-mode-layer', mobileSearchMode === 'layer');
  relocateModeToggleBtn();
  const btn = document.getElementById('mobileSearchModeBtn');
  const icon = btn?.querySelector('.mobile-search-mode-icon');
  if(icon) icon.textContent = mobileSearchMode === 'address' ? '📍' : '🗺';
  if(btn) btn.title = mobileSearchMode === 'address' ? '切換成圖資搜尋' : '切換成地址／位置搜尋';
}

function initMobileSearchModeToggle(){
  const btn = document.getElementById('mobileSearchModeBtn');
  if(!btn) return;
  btn.addEventListener('click', ()=>{
    if(!mq.matches) return; // 桌面版沒有這顆按鈕（見 style.css），這裡多一層保險
    mobileSearchMode = mobileSearchMode === 'address' ? 'layer' : 'address';
    applyMobileSearchMode();
    // 切換模式當下代表使用者正要打字，展開頂部搜尋列並重新起算閒置倒數，
    // 並把 focus 交給切過去之後對應的那個輸入框。
    expandSearchBar();
    scheduleSearchBarCollapse();
    const nextInputId = mobileSearchMode === 'address' ? 'addressInput' : 'layerSearchInput';
    document.getElementById(nextInputId)?.focus();
  });
}

/* ---------------------------------------------------------
   1b. 頂部搜尋列 15 秒閒置自動摺疊成圖示：手機螢幕寸土寸金，搜尋列
   常駐展開會一直佔掉地圖上方一整條，但使用者大多數時間並非在搜尋。
   閒置 15 秒沒有互動（沒 focus／沒打字）就摺疊成只剩放大鏡圓鈕，
   點一下立刻展開並 focus 回輸入框，同時重新排程倒數——計時器只用
   setTimeout 手動管理，摺疊/展開純靠 CSS class + transition 做動畫，
   不需要 JS 動畫函式庫。
--------------------------------------------------------- */
const SEARCH_BAR_IDLE_MS = 15000;
const SEARCH_BAR_COLLAPSED_CLASS = 'mobile-search-collapsed';
let searchBarCollapseTimer = null;

function clearSearchBarCollapseTimer(){
  if(searchBarCollapseTimer){ clearTimeout(searchBarCollapseTimer); searchBarCollapseTimer = null; }
}
function scheduleSearchBarCollapse(){
  clearSearchBarCollapseTimer();
  if(!mq.matches) return; // 桌面版沒有這條浮動列，不排程也不用清 class
  searchBarCollapseTimer = setTimeout(()=>{
    document.getElementById('mobileSearchBar')?.classList.add(SEARCH_BAR_COLLAPSED_CLASS);
  }, SEARCH_BAR_IDLE_MS);
}
function expandSearchBar(){
  document.getElementById('mobileSearchBar')?.classList.remove(SEARCH_BAR_COLLAPSED_CLASS);
}

function initSearchBarAutoCollapse(){
  const mobileBar = document.getElementById('mobileSearchBar');
  const addressInput = document.getElementById('addressInput');
  const layerSearchInput = document.getElementById('layerSearchInput');
  if(!mobileBar) return;

  // 點擊已摺疊狀態的整條 bar（此時內容只剩下一顆圓鈕）立刻展開＋focus
  // 回目前模式對應的輸入框（地址／圖資合併後，focus 目標要看
  // mobileSearchMode，不能寫死 addressInput，否則圖資模式下點開會
  // focus 錯輸入框）；展開中或未摺疊時點擊交給輸入框/按鈕自己的既有
  // 行為，不攔截。
  mobileBar.addEventListener('click', ()=>{
    if(!mq.matches) return;
    if(!mobileBar.classList.contains(SEARCH_BAR_COLLAPSED_CLASS)) return;
    expandSearchBar();
    document.getElementById(mobileSearchMode === 'layer' ? 'layerSearchInput' : 'addressInput')?.focus();
    scheduleSearchBarCollapse();
  });

  // focus 中代表正在互動，先取消倒數；blur／打字（input）都算「有事發生」，
  // 重新起算 15 秒，不是「維持已經過去的時間」。地址／圖資兩個輸入框都要
  // 各自綁定，因為合併後兩者都常駐在 #mobileSearchBar 裡（只是同一時間
  // 只顯示一個），不論使用者在哪個模式打字都要重新起算倒數。
  addressInput?.addEventListener('focus', ()=>{ if(mq.matches) clearSearchBarCollapseTimer(); });
  addressInput?.addEventListener('blur', ()=>{ if(mq.matches) scheduleSearchBarCollapse(); });
  addressInput?.addEventListener('input', ()=>{ if(mq.matches) scheduleSearchBarCollapse(); });
  layerSearchInput?.addEventListener('focus', ()=>{ if(mq.matches) clearSearchBarCollapseTimer(); });
  layerSearchInput?.addEventListener('blur', ()=>{ if(mq.matches) scheduleSearchBarCollapse(); });
  layerSearchInput?.addEventListener('input', ()=>{ if(mq.matches) scheduleSearchBarCollapse(); });

  // 手機版某些模式（比對／時間軸／多重疊圖）會把整條 #mobileSearchBar
  // 用 body class 隱藏（見 style.css），切走時計時器留著沒意義（使用者
  // 根本看不到這條 bar），切回歷史疊圖模式才需要展開＋重新倒數。
  subscribe((state, prev, changedKeys)=>{
    if(!changedKeys.includes('mode') || !mq.matches) return;
    if(state.mode === 'overlay'){ expandSearchBar(); scheduleSearchBarCollapse(); }
    else clearSearchBarCollapseTimer();
  });
}

/* ---------------------------------------------------------
   2. Bottom Sheet：拖曳把手 #sheetHandle。
   二態對應：
     collapsed 態 → #sidebar.collapsed（peek，沿用桌面既有 class）
     展開態（75vh） → 無 .collapsed
--------------------------------------------------------- */
function initSheetHandle(){
  const handle = document.getElementById('sheetHandle');
  const sidebar = document.getElementById('sidebar');
  if(!handle || !sidebar) return;

  const PEEK_PX = 60; // 需與 style.css 的 --mobile-sheet-peek 一致
  // 跟 style.css 的 --mobile-sheet-full 用同一份「實際可視高度」
  // （見 updateViewportMetrics()），不要各自用不同基準算，否則拖曳中
  // 的即時位置會跟放開後 CSS 對不齊、放開瞬間跳一下。
  const viewportH = () => (window.visualViewport && window.visualViewport.height) || window.innerHeight;
  const fullPx = () => viewportH() * 0.75;

  function currentTranslate(){
    if(sidebar.classList.contains('collapsed')) return fullPx() - PEEK_PX;
    return 0;
  }

  function snapTo(target){
    sidebar.classList.remove('dragging');
    sidebar.style.transform = '';
    if(target === 'collapsed'){
      collapseSidebar();
    } else { // expanded
      expandSidebar();
    }
  }

  let dragging = false, moved = false, startY = 0, startTranslate = 0;

  function onPointerDown(e){
    if(!mq.matches) return;
    dragging = true; moved = false;
    startY = e.clientY;
    startTranslate = currentTranslate();
    sidebar.classList.add('dragging');
    try{ handle.setPointerCapture(e.pointerId); }catch{ /* 部分瀏覽器/測試環境不支援，忽略即可 */ }
  }
  function onPointerMove(e){
    if(!dragging) return;
    const dy = e.clientY - startY;
    if(Math.abs(dy) > 6) moved = true;
    const next = Math.max(0, Math.min(fullPx() - PEEK_PX, startTranslate + dy));
    sidebar.style.transform = `translateY(${next}px)`;
  }
  function onPointerUp(e){
    if(!dragging) return;
    dragging = false;
    if(!moved){
      // 純點擊（沒有明顯拖曳位移）：兩態互相切換。
      if(sidebar.classList.contains('collapsed')) snapTo('expanded');
      else snapTo('collapsed');
      return;
    }
    const dy = e.clientY - startY;
    const finalTranslate = Math.max(0, Math.min(fullPx() - PEEK_PX, startTranslate + dy));
    const candidates = [
      { state:'expanded', pos:0 },
      { state:'collapsed', pos: fullPx() - PEEK_PX },
    ];
    candidates.sort((a,b)=> Math.abs(finalTranslate - a.pos) - Math.abs(finalTranslate - b.pos));
    snapTo(candidates[0].state);
  }

  handle.addEventListener('pointerdown', onPointerDown);
  handle.addEventListener('pointermove', onPointerMove);
  handle.addEventListener('pointerup', onPointerUp);
  handle.addEventListener('pointercancel', onPointerUp);
}

/* ---------------------------------------------------------
   3a. 「地圖工具」快速模式選單：純轉發點擊到 #modeSwitch 既有按鈕、
   繪圖工具開關純轉發點擊到 #drawToggleBtn，高亮／開關狀態分別訂閱
   store 與觀察 #drawToggleBtn 的 class，跟真正的按鈕狀態保持一致。
   按鈕本身可拖曳（見下方 initDraggableModeButton()），拖曳中放開不
   應該再觸發開合選單，兩者用 dragJustHappened 這個共用旗標互相協調。
--------------------------------------------------------- */
const MODE_BTN_POS_KEY = 'mobile_mode_btn_pos';
let dragJustHappened = false;

function initModePopover(){
  const btn = document.getElementById('mobileModeBtn');
  const popover = document.getElementById('mobileModePopover');
  const drawToggleOption = document.getElementById('mobileDrawToggle');
  const realDrawToggleBtn = document.getElementById('drawToggleBtn');
  if(!btn || !popover) return;

  function closePopover(){
    popover.classList.remove('open');
    btn.classList.remove('active');
    btn.setAttribute('aria-expanded', 'false');
  }
  // 選單面板改成跟著按鈕目前位置（可能已被拖到別處）浮出，優先貼在
  // 按鈕上方，上方放不下才貼下方；水平方向夾在螢幕範圍內，不超出。
  function positionPopover(){
    const rect = btn.getBoundingClientRect();
    const margin = 8;
    const popW = popover.offsetWidth || 220;
    const popH = popover.offsetHeight || 200;

    let left = rect.left;
    if(left + popW > window.innerWidth - margin) left = window.innerWidth - popW - margin;
    if(left < margin) left = margin;

    let top = rect.top - popH - 8;
    if(top < margin) top = Math.min(rect.bottom + 8, window.innerHeight - popH - margin);

    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
    popover.style.right = 'auto';
    popover.style.bottom = 'auto';
  }
  function openPopover(){
    popover.classList.add('open');
    positionPopover();
    btn.classList.add('active');
    btn.setAttribute('aria-expanded', 'true');
  }
  function syncActiveOption(){
    popover.querySelectorAll('.mobile-mode-option[data-mode]').forEach(optBtn=>{
      const realBtn = document.querySelector(`#modeSwitch button[data-mode="${optBtn.dataset.mode}"]`);
      optBtn.classList.toggle('active', !!realBtn?.classList.contains('active'));
    });
    if(drawToggleOption && realDrawToggleBtn){
      drawToggleOption.classList.toggle('active', realDrawToggleBtn.classList.contains('active'));
    }
  }

  btn.addEventListener('click', (e)=>{
    e.stopPropagation();
    if(dragJustHappened){ dragJustHappened = false; return; } // 剛拖完放開，這次點擊不算數
    if(popover.classList.contains('open')) closePopover();
    else { syncActiveOption(); openPopover(); }
  });
  document.addEventListener('click', (e)=>{
    if(popover.classList.contains('open') && !popover.contains(e.target) && e.target !== btn) closePopover();
  });
  popover.querySelectorAll('.mobile-mode-option[data-mode]').forEach(optBtn=>{
    optBtn.addEventListener('click', ()=>{
      document.querySelector(`#modeSwitch button[data-mode="${optBtn.dataset.mode}"]`)?.click();
      closePopover();
    });
  });
  drawToggleOption?.addEventListener('click', ()=>{
    realDrawToggleBtn?.click();
    closePopover();
  });
  popover.querySelectorAll('.mobile-mode-option[data-help-action]').forEach(optBtn=>{
    optBtn.addEventListener('click', ()=>{
      const action = optBtn.dataset.helpAction;
      if(action === 'tour') document.getElementById('tourStartBtn')?.click();
      else if(action === 'guide') document.getElementById('guideOpenBtn')?.click();
      closePopover();
    });
  });

  subscribe((state, prev, changedKeys)=>{ if(changedKeys.includes('mode')) syncActiveOption(); });
  // 繪圖工具開關不是走 store（見 src/drawTool.js 自己管理 .active class），
  // 用 MutationObserver 盯 #drawToggleBtn 的 class，涵蓋所有讓它開關的
  // 途徑（不只是這個選單本身點擊），保持兩邊顯示一致。
  if(realDrawToggleBtn){
    new MutationObserver(syncActiveOption).observe(realDrawToggleBtn, { attributes:true, attributeFilter:['class'] });
  }
  syncActiveOption();
}

/* ---------------------------------------------------------
   3a-2. 讓「地圖工具」浮動按鈕可以拖到螢幕任何地方，並記住位置
   （localStorage），下次載入沿用；用 pointerdown/move/up 判斷位移量，
   超過門檻才算拖曳（否則視為單純點擊，交給 initModePopover() 的
   click 事件開合選單），彼此不衝突。
--------------------------------------------------------- */
function initDraggableModeButton(){
  const btn = document.getElementById('mobileModeBtn');
  if(!btn) return;

  function clampPos(pos){
    const margin = 6;
    const w = btn.offsetWidth || 48, h = btn.offsetHeight || 48;
    const maxLeft = Math.max(margin, window.innerWidth - w - margin);
    const maxTop = Math.max(margin, window.innerHeight - h - margin);
    return {
      left: Math.min(Math.max(pos.left, margin), maxLeft),
      top: Math.min(Math.max(pos.top, margin), maxTop),
    };
  }
  function applyPos(pos){
    btn.style.left = `${pos.left}px`;
    btn.style.top = `${pos.top}px`;
    btn.style.right = 'auto';
    btn.style.bottom = 'auto';
  }
  function loadSavedPos(){
    try{
      const raw = window.localStorage.getItem(MODE_BTN_POS_KEY);
      if(!raw) return null;
      const pos = JSON.parse(raw);
      if(typeof pos?.left === 'number' && typeof pos?.top === 'number') return pos;
    }catch{ /* localStorage 不可用時忽略，維持 CSS 預設位置即可 */ }
    return null;
  }
  function savePos(pos){
    try{ window.localStorage.setItem(MODE_BTN_POS_KEY, JSON.stringify(pos)); }
    catch{ /* 無痕模式或被封鎖時忽略 */ }
  }

  const saved = loadSavedPos();
  if(saved) applyPos(clampPos(saved));

  let dragging = false, moved = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;

  btn.addEventListener('pointerdown', (e)=>{
    if(!mq.matches) return;
    dragging = true; moved = false;
    const rect = btn.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY;
    startLeft = rect.left; startTop = rect.top;
    try{ btn.setPointerCapture(e.pointerId); }catch{ /* 部分瀏覽器/測試環境不支援，忽略即可 */ }
  });
  btn.addEventListener('pointermove', (e)=>{
    if(!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if(!moved && Math.hypot(dx, dy) < 6) return; // 位移太小先當作還沒開始拖曳
    moved = true;
    applyPos(clampPos({ left: startLeft + dx, top: startTop + dy }));
  });
  function onPointerUp(){
    if(!dragging) return;
    dragging = false;
    if(moved){
      dragJustHappened = true; // 告訴 initModePopover() 的 click handler 這次放開不要開選單
      const rect = btn.getBoundingClientRect();
      savePos({ left: rect.left, top: rect.top });
    }
  }
  btn.addEventListener('pointerup', onPointerUp);
  btn.addEventListener('pointercancel', onPointerUp);

  // 螢幕旋轉／尺寸改變時，確保按鈕還在可視範圍內（不會被夾到看不到的地方）。
  window.addEventListener('resize', ()=>{
    const rect = btn.getBoundingClientRect();
    const clamped = clampPos({ left: rect.left, top: rect.top });
    if(clamped.left !== rect.left || clamped.top !== rect.top) applyPos(clamped);
  });
}

/* ---------------------------------------------------------
   3b. 「目前圖層」浮動列：點一下（非拉桿本身）展開/收合透明度拉桿，
   拉桿與 store/layer opacity 的連動沿用 core/layerManager.js 既有邏輯，
   這裡完全不碰。
--------------------------------------------------------- */
function initFloatingOpacityExpand(){
  const el = document.getElementById('floatingOpacity');
  if(!el) return;
  el.addEventListener('click', (e)=>{
    if(!mq.matches) return;
    if(e.target.tagName === 'INPUT') return; // 拖動拉桿本身不切換展開狀態
    el.classList.toggle('expanded');
  });
}

/* ---------------------------------------------------------
   3c. 地址搜尋結果出現時，自動把 Bottom Sheet 從收合(peek)打開到展開，
   讓使用者不用自己再手動拉開；只在「是這次自動打開的」情況下，清除
   搜尋時才自動收回去，避免蓋掉使用者自己手動展開到的狀態。只監看
   #locationResult 的 style（ui/search.js 既有的顯示/隱藏開關），不碰
   任何搜尋邏輯本身。
--------------------------------------------------------- */
function initSearchResultAutoExpand(){
  const locationResultEl = document.getElementById('locationResult');
  const sidebar = document.getElementById('sidebar');
  if(!locationResultEl || !sidebar) return;

  let autoOpened = false;
  const observer = new MutationObserver(()=>{
    if(!mq.matches) return;
    const visible = locationResultEl.style.display !== 'none';
    if(visible && sidebar.classList.contains('collapsed')){
      expandSidebar();
      autoOpened = true;
    } else if(!visible && autoOpened){
      collapseSidebar();
      autoOpened = false;
    }
  });
  observer.observe(locationResultEl, { attributes:true, attributeFilter:['style'] });
}

/* ---------------------------------------------------------
   3c-2. 跟上面對稱：圖資搜尋出現結果時也自動把 Bottom Sheet 打開到
   展開態，因為合併輸入框搬到頂部後 #layerSearchPanel 仍留在 Bottom Sheet
   裡（見 relocateLayerSearchRow()），收合(peek)狀態下使用者看不到搜尋
   結果。只監看 #layerSearchPanel 的 hidden 屬性（ui/layerSearch.js 既有
   的顯示/隱藏開關），不碰任何搜尋比對邏輯本身。
--------------------------------------------------------- */
function initLayerSearchResultAutoExpand(){
  const layerPanelEl = document.getElementById('layerSearchPanel');
  const sidebar = document.getElementById('sidebar');
  if(!layerPanelEl || !sidebar) return;

  let autoOpened = false;
  const observer = new MutationObserver(()=>{
    if(!mq.matches) return;
    const visible = !layerPanelEl.hidden;
    if(visible && sidebar.classList.contains('collapsed')){
      expandSidebar();
      autoOpened = true;
    } else if(!visible && autoOpened){
      collapseSidebar();
      autoOpened = false;
    }
  });
  observer.observe(layerPanelEl, { attributes:true, attributeFilter:['hidden'] });
}

let everEnteredMobile = false;

/* ---------------------------------------------------------
   #mobileModeBtn／#mobileModePopover／.floating-opacity 的 z-index
   刻意比 #sidebar 高，只有 Sheet 收合成 peek 時才需要靠它們補位——
   Sheet 只要一打開（展開態），面板裡本來就看得到「地圖模式」
   「目前圖層」，這幾顆浮動捷徑反而會蓋住剛打開的面板內容（實機回報
   「浮動功能會影響拉起選單」）。這裡監看 #sidebar 的 class 變化，同步
   一個 body class，只要不是收合狀態就統一藏起來，不算移除功能。
--------------------------------------------------------- */
function initSheetOpenStateSync(){
  const sidebar = document.getElementById('sidebar');
  if(!sidebar) return;
  const sync = () => {
    document.body.classList.toggle('mobile-sheet-open', !sidebar.classList.contains('collapsed'));
  };
  new MutationObserver(sync).observe(sidebar, { attributes:true, attributeFilter:['class'] });
  sync();
}

/* ---------------------------------------------------------
   依目前模式同步一個 body class（mobile-mode-overlay/compare/timeline/
   multi）。時間軸／複合疊圖模式的浮動列（#mapTimelineBar／
   #multiOverlayBar）在手機上會拉到接近全寬，跟右下角的日期印章
   （#stamp）搶同一塊位置（實機回報「圖資名稱遮擋時間軸」），這裡只
   用來讓 style.css 在這兩個模式下暫時藏起印章——印章是純裝飾用途，
   不是操作入口，藏起來不影響任何功能。
--------------------------------------------------------- */
function initModeClassSync(){
  const sync = () => {
    document.body.classList.remove('mobile-mode-overlay', 'mobile-mode-compare', 'mobile-mode-timeline', 'mobile-mode-multi');
    document.body.classList.add(`mobile-mode-${store.mode}`);
  };
  subscribe((state, prev, changedKeys)=>{ if(changedKeys.includes('mode')) sync(); });
  sync();
}

function applyBreakpoint(isMobile){
  relocateSearchBar(isMobile);
  relocateLayerSearchRow(isMobile);
  // 同步「地址／圖資搜尋合併」的 body class：只在手機版有意義，離開
  // 手機版時兩個 class 都拿掉，避免殘留（>768px 底下 style.css 對應規則
  // 都包在 @media (max-width:768px) 裡，就算殘留 class 也不會有效果，
  // 這裡拿掉純粹是保持乾淨）。不重設 mobileSearchMode 本身，維持使用者
  // 上次選的模式。
  if(isMobile) applyMobileSearchMode();
  else{
    document.body.classList.remove('mobile-search-mode-address', 'mobile-search-mode-layer');
    // 離開手機版時把切換鈕搬回地址搜尋列原始位置，避免（曾切到圖資
    // 模式後跨回桌面版時）按鈕留在 .layer-search-row 裡；桌面版本來就
    // 靠 .mobile-search-mode-btn{display:none} 隱藏這顆鈕，這裡純粹是
    // 保持 DOM 結構乾淨，不影響任何顯示邏輯。
    relocateModeToggleBtn('address');
  }
  // 手機初始狀態要「地圖接近全螢幕」（見任務規格四），第一次跨進手機
  // 尺寸時強制收合成 peek 態；之後在手機尺寸內縮放視窗（例如轉橫向）
  // 不會再重複強制收合，避免打斷使用者當下手動展開的操作。
  if(isMobile && !everEnteredMobile){
    everEnteredMobile = true;
    const sidebar = document.getElementById('sidebar');
    if(sidebar && !sidebar.classList.contains('collapsed')) collapseSidebar();
  }
  // 跨越 768px 門檻：進入手機版重新起算 15 秒摺疊倒數；跳回桌面版要
  // 清掉計時器並拿掉摺疊 class，避免桌面版（此時 #mobileSearchBar 本來
  // 就是空殼）殘留一顆用不到的計時器或 class。
  if(isMobile) scheduleSearchBarCollapse();
  else{
    clearSearchBarCollapseTimer();
    expandSearchBar();
  }
}

export function initMobileLayout(){
  updateViewportMetrics();
  window.addEventListener('resize', updateViewportMetrics);
  window.addEventListener('orientationchange', updateViewportMetrics);
  if(window.visualViewport) window.visualViewport.addEventListener('resize', updateViewportMetrics);

  applyBreakpoint(mq.matches);
  if(mq.addEventListener) mq.addEventListener('change', (e)=> applyBreakpoint(e.matches));
  else mq.addListener((e)=> applyBreakpoint(e.matches)); // 舊版 Safari 相容

  initSearchBarAutoCollapse();
  initMobileSearchModeToggle();
  initSheetHandle();
  initModePopover();
  initDraggableModeButton();
  initFloatingOpacityExpand();
  initSearchResultAutoExpand();
  initLayerSearchResultAutoExpand();
  initSheetOpenStateSync();
  initModeClassSync();
}
