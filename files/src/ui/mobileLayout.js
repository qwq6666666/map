/* ---------------------------------------------------------
   ui/mobileLayout.js — 手機版 (<=768px) 版面協調層
   ---------------------------------------------------------
   這支檔案不重新實作任何搜尋／模式切換／圖層邏輯，只做三件事：

   1. 監看 matchMedia('(max-width:768px)')，跨越 768px 門檻時把
      「真正的」DOM 節點（.search-row／#addressSuggest）搬進／搬出
      手機版頂部搜尋列 #mobileSearchBar——是搬移不是複製，事件監聽器
      跟 features/search.js／ui/search.js 完全沒有改變，兩邊只會有
      一份輸入框存在於畫面上。
   2. 讓 #sidebar 在手機版變成可拖曳／點擊循環三態的 Bottom Sheet
      （收合 peek／半開 45vh／展開 75vh），沿用既有的
      collapseSidebar()／expandSidebar()（ui/sidebarToggle.js）做
      「收合／半開」二態切換，額外疊加 .sheet-expanded class 做第三態，
      幾何全部交給 style.css 的 Mobile Responsive Layout 區塊。
   3. 手機版「地圖工具」快速選單（#mobileModeBtn／#mobileModePopover）
      只是轉呼叫 #modeSwitch 裡對應按鈕的 .click()，核心模式切換邏輯
      仍在 core/modeManager.js；「目前圖層」浮動列點擊展開/收合透明度
      拉桿；搜尋結果出現時自動把 Bottom Sheet 打開到半開，方便直接看到。

   >768px（平板／桌面）時，這裡所有動作都是 no-op，畫面與操作維持
   桌面版原樣。
--------------------------------------------------------- */
import { subscribe } from '../store.js';
import { collapseSidebar, expandSidebar } from './sidebarToggle.js';

const MOBILE_QUERY = '(max-width:768px)';
const MOBILE_PLACEHOLDER = '🔍 搜尋地址、地點……';

const mq = window.matchMedia(MOBILE_QUERY);
let desktopPlaceholder = null;

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
   2. Bottom Sheet：拖曳把手 #sheetHandle。
   三態對應：
     collapsed 態      → #sidebar.collapsed（peek，沿用桌面既有 class）
     半開態（預設展開） → 無 .collapsed、無 .sheet-expanded
     展開態（75vh）    → 無 .collapsed、有 .sheet-expanded
--------------------------------------------------------- */
function initSheetHandle(){
  const handle = document.getElementById('sheetHandle');
  const sidebar = document.getElementById('sidebar');
  if(!handle || !sidebar) return;

  const PEEK_PX = 60; // 需與 style.css 的 --mobile-sheet-peek 一致
  const fullPx = () => window.innerHeight * 0.75;   // 對應 --mobile-sheet-full: 75vh
  const halfPx = () => window.innerHeight * 0.45;   // 對應 --mobile-sheet-half: 45vh

  function currentTranslate(){
    if(sidebar.classList.contains('collapsed')) return fullPx() - PEEK_PX;
    if(sidebar.classList.contains('sheet-expanded')) return 0;
    return fullPx() - halfPx();
  }

  function snapTo(target){
    sidebar.classList.remove('dragging');
    sidebar.style.transform = '';
    if(target === 'collapsed'){
      collapseSidebar(); // 一併移除 .sheet-expanded，見 sidebarToggle.js
    } else if(target === 'expanded'){
      expandSidebar();
      sidebar.classList.add('sheet-expanded');
    } else { // half
      expandSidebar();
      sidebar.classList.remove('sheet-expanded');
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
      // 純點擊（沒有明顯拖曳位移）：三態依序循環，讓使用者不用拖曳
      // 也能到達「展開 75vh」這個既有 collapseSidebar()/expandSidebar()
      // 二元切換到不了的第三態。
      if(sidebar.classList.contains('collapsed')) snapTo('half');
      else if(!sidebar.classList.contains('sheet-expanded')) snapTo('expanded');
      else snapTo('collapsed');
      return;
    }
    const dy = e.clientY - startY;
    const finalTranslate = Math.max(0, Math.min(fullPx() - PEEK_PX, startTranslate + dy));
    const candidates = [
      { state:'expanded', pos:0 },
      { state:'half', pos: fullPx() - halfPx() },
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
   3a. 「地圖工具」快速模式選單：純轉發點擊到 #modeSwitch 既有按鈕，
   高亮狀態訂閱 store 跟真正的按鈕 .active class 保持一致。
--------------------------------------------------------- */
function initModePopover(){
  const btn = document.getElementById('mobileModeBtn');
  const popover = document.getElementById('mobileModePopover');
  if(!btn || !popover) return;

  function closePopover(){
    popover.classList.remove('open');
    btn.classList.remove('active');
    btn.setAttribute('aria-expanded', 'false');
  }
  function openPopover(){
    popover.classList.add('open');
    btn.classList.add('active');
    btn.setAttribute('aria-expanded', 'true');
  }
  function syncActiveOption(){
    popover.querySelectorAll('.mobile-mode-option').forEach(optBtn=>{
      const realBtn = document.querySelector(`#modeSwitch button[data-mode="${optBtn.dataset.mode}"]`);
      optBtn.classList.toggle('active', !!realBtn?.classList.contains('active'));
    });
  }

  btn.addEventListener('click', (e)=>{
    e.stopPropagation();
    if(popover.classList.contains('open')) closePopover();
    else { syncActiveOption(); openPopover(); }
  });
  document.addEventListener('click', (e)=>{
    if(popover.classList.contains('open') && !popover.contains(e.target) && e.target !== btn) closePopover();
  });
  popover.querySelectorAll('.mobile-mode-option').forEach(optBtn=>{
    optBtn.addEventListener('click', ()=>{
      document.querySelector(`#modeSwitch button[data-mode="${optBtn.dataset.mode}"]`)?.click();
      closePopover();
    });
  });

  subscribe((state, prev, changedKeys)=>{ if(changedKeys.includes('mode')) syncActiveOption(); });
  syncActiveOption();
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
   3c. 地址搜尋結果出現時，自動把 Bottom Sheet 從收合(peek)打開到半開，
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
      sidebar.classList.remove('sheet-expanded');
      autoOpened = true;
    } else if(!visible && autoOpened){
      collapseSidebar();
      autoOpened = false;
    }
  });
  observer.observe(locationResultEl, { attributes:true, attributeFilter:['style'] });
}

let everEnteredMobile = false;

/* ---------------------------------------------------------
   #mobileModeBtn／#mobileModePopover／.floating-opacity 的 z-index
   刻意比 #sidebar 高（半開狀態時仍要能點擊），但展開至 75vh 時 Bottom
   Sheet 幾乎佔滿螢幕，這幾顆浮動控制項反而會蓋在展開後的面板內容
   上面。這裡監看 #sidebar 的 class 變化，同步一個 body class，讓
   style.css 在「完全展開」時把這幾顆暫時藏起來——功能本來就能在展開
   後的面板裡找到（「地圖模式」「目前圖層」），不算移除功能。
--------------------------------------------------------- */
function initExpandedStateSync(){
  const sidebar = document.getElementById('sidebar');
  if(!sidebar) return;
  const sync = () => {
    document.body.classList.toggle('mobile-sheet-expanded', sidebar.classList.contains('sheet-expanded'));
  };
  new MutationObserver(sync).observe(sidebar, { attributes:true, attributeFilter:['class'] });
  sync();
}

function applyBreakpoint(isMobile){
  relocateSearchBar(isMobile);
  // 手機初始狀態要「地圖接近全螢幕」（見任務規格四），第一次跨進手機
  // 尺寸時強制收合成 peek 態；之後在手機尺寸內縮放視窗（例如轉橫向）
  // 不會再重複強制收合，避免打斷使用者當下手動展開的操作。
  if(isMobile && !everEnteredMobile){
    everEnteredMobile = true;
    const sidebar = document.getElementById('sidebar');
    if(sidebar && !sidebar.classList.contains('collapsed')) collapseSidebar();
  }
}

export function initMobileLayout(){
  applyBreakpoint(mq.matches);
  if(mq.addEventListener) mq.addEventListener('change', (e)=> applyBreakpoint(e.matches));
  else mq.addListener((e)=> applyBreakpoint(e.matches)); // 舊版 Safari 相容

  initSheetHandle();
  initModePopover();
  initFloatingOpacityExpand();
  initSearchResultAutoExpand();
  initExpandedStateSync();
}
