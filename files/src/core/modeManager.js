/* ---------------------------------------------------------
   core/modeManager.js — 模式控制
   ---------------------------------------------------------
   從 mapCore.js 拆出來的「模式切換」協調中心：訂閱 store，把
   目前狀態（mode／baseLayer／activeOverlayKey／compareA／
   compareB／swipePercent／multiOverlayLayers）實際套用到地圖與
   面板 DOM 上。

   這支模組不自己碰歷史圖層或比對模式的細節，只負責「決定現在
   該顯示哪個面板、該呼叫誰」，實際動作委派給：
     - core/map.js：applyBaseLayer()
     - core/layerManager.js：applyActiveOverlayKey()／clearLayerPool()／
       suspendActiveOverlayVisual()
     - core/multiOverlayManager.js：applyMultiOverlayLayers()／
       hideMultiOverlayLayers()
     - features/compareMode.js：enterCompareMode()／resetCompareVisuals()／
       applyCompareSide()／positionDivider()
     - features/multiOverlay.js：syncMultiLayerCheckedClasses()／
       renderMultiOverlayBar()
     - ui/sidebarToggle.js：collapseSidebar()／updateFloatingOpacityVisibility()
     - timelineMode.js（既有模組，不重複建立第二套時間軸邏輯）：
       activateTimelineMode()
--------------------------------------------------------- */
import { state as store, subscribe, setMode } from '../store.js';
import { map, applyBaseLayer } from './map.js';
import { applyActiveOverlayKey, clearLayerPool, suspendActiveOverlayVisual } from './layerManager.js';
import { applyMultiOverlayLayers, hideMultiOverlayLayers } from './multiOverlayManager.js';
import { enterCompareMode, resetCompareVisuals, applyCompareSide, positionDivider } from '../features/compareMode.js';
import { syncMultiLayerCheckedClasses, renderMultiOverlayBar, renderCustomSourcesPanel } from '../features/multiOverlay.js';
import { collapseSidebar, updateFloatingOpacityVisibility } from '../ui/sidebarToggle.js';
import { activateTimelineMode } from '../timelineMode.js';

let overlayPanel, comparePanel, timelinePanel, multiPanel, opacityBlockEl, mapTimelineBarEl, multiOverlayBarEl;

function applyModeTransition(){
  document.getElementById('sidebar').classList.toggle('compact-mode', store.mode === 'compare');
  document.querySelectorAll('#modeSwitch button').forEach(b=>
    b.classList.toggle('active', b.dataset.mode === store.mode));

  // 三種模式共用的地圖疊加元素，先統一收起來，各自的分支再打開自己需要的，
  // 避免每個分支都要重複寫一次「關掉其他模式的東西」。
  resetCompareVisuals();
  mapTimelineBarEl.classList.remove('show');
  multiOverlayBarEl.classList.remove('show');
  // 離開時間軸模式時，把還沒用到的預先載入圖層清掉，避免留一堆背景
  // 圖層佔用記憶體／持續耗費瀏覽器資源；重新進入時間軸模式會再重新預載。
  if(store.mode !== 'timeline') clearLayerPool();
  // 離開複合疊圖模式時，只隱藏目前顯示中的圖層，store.multiOverlayLayers
  // 本身不清空——使用者組好的疊圖組合應該要記得住，下次切回來還在，
  // 這點刻意跟上面時間軸模式的 clearLayerPool() 不同（見
  // core/multiOverlayManager.js 檔頭說明）。
  if(store.mode !== 'multi') hideMultiOverlayLayers();

  if(store.mode === 'overlay'){
    opacityBlockEl.style.display = 'block';
    overlayPanel.style.display = 'block';
    comparePanel.style.display = 'none';
    timelinePanel.style.display = 'none';
    multiPanel.style.display = 'none';
    // activeOverlayKey 在切到比對／時間軸／複合疊圖模式時不會被清掉
    // （見下方），所以這裡直接沿用目前的值套用即可，等同原本「切回
    // 疊圖模式時，沿用之前選擇的圖層」的行為。
    applyBaseLayer();
    applyActiveOverlayKey();
    map.render();
  } else if(store.mode === 'timeline'){
    opacityBlockEl.style.display = 'block'; // 時間軸模式一樣可以調整目前套疊圖層的透明度
    overlayPanel.style.display = 'none';
    comparePanel.style.display = 'none';
    timelinePanel.style.display = 'block';
    multiPanel.style.display = 'none';
    mapTimelineBarEl.classList.add('show');
    collapseSidebar(); // 時間軸主要畫面在地圖下方，側邊欄自動收合讓出空間
    applyBaseLayer();
    applyActiveOverlayKey(); // 沿用目前選擇的圖層（可能是疊圖模式選的），不強制清空
    activateTimelineMode();  // 立即依目前地圖畫面中心點，探測 sinica 有哪些年份的圖層
    map.render();
  } else if(store.mode === 'multi'){
    opacityBlockEl.style.display = 'none'; // 每張圖層各自有自己的透明度滑桿（浮動清單面板），不用側邊欄那組單一滑桿
    overlayPanel.style.display = 'none';
    comparePanel.style.display = 'none';
    timelinePanel.style.display = 'none';
    multiPanel.style.display = 'block';
    multiOverlayBarEl.classList.add('show');
    suspendActiveOverlayVisual(); // 疊圖模式選的那張先隱藏，避免跟複合疊圖的圖層混在一起、順序打架
    applyBaseLayer();
    applyMultiOverlayLayers();
    syncMultiLayerCheckedClasses();
    renderMultiOverlayBar();
    renderCustomSourcesPanel(); // 進場時重新整理一次，涵蓋「不在這個模式時新增/刪除過自訂圖層」的情況
    map.render();
  } else { // compare
    opacityBlockEl.style.display = 'none';
    overlayPanel.style.display = 'none';
    comparePanel.style.display = 'block';
    timelinePanel.style.display = 'none';
    multiPanel.style.display = 'none';
    enterCompareMode();
  }
  updateFloatingOpacityVisibility();
  // 透明度區塊／國家篩選列的顯示與否會隨模式改變（見上面各分支），
  // 兩者疊出來的總高度也跟著變，觸發一次 resize 事件重新量測
  // --sticky-offset（sidebarUI.js 的監聽器），避免切換模式後吸附列
  // 底下留一截跟舊高度對不齊的空隙。測試環境用的假 window 沒有
  // dispatchEvent／Event，這裡只在真的瀏覽器環境執行。
  if(typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof Event === 'function'){
    window.dispatchEvent(new Event('resize'));
  }
}

function initModeSwitch(){
  overlayPanel = document.getElementById('overlayPanel');
  comparePanel = document.getElementById('comparePanel');
  timelinePanel = document.getElementById('timelinePanel');
  multiPanel = document.getElementById('multiPanel');
  opacityBlockEl = document.getElementById('opacityBlock');
  mapTimelineBarEl = document.getElementById('mapTimelineBar');
  multiOverlayBarEl = document.getElementById('multiOverlayBar');

  document.getElementById('modeSwitch').addEventListener('click', (e)=>{
    const btn = e.target.closest('button[data-mode]');
    if(!btn) return;
    setMode(btn.dataset.mode);
  });
}

/* ---------------------------------------------------------
   store 訂閱：把「目前狀態」實際套用到地圖與 DOM。
   mode 一旦改變，涵蓋了 baseLayer／activeOverlayKey／compareA／
   compareB 的完整重繪，所以優先處理、直接 return，不用同一批再各自
   處理一次；沒有 mode 變動時，才依各自變動的欄位分開套用，
   避免每次拖曳分隔線都整個模式重繪一次。
--------------------------------------------------------- */
function render(state, prevState, changedKeys){
  if(changedKeys.includes('mode')){
    applyModeTransition();
    return;
  }
  if(changedKeys.includes('baseLayer')) applyBaseLayer();
  if(changedKeys.includes('activeOverlayKey')) applyActiveOverlayKey();
  if(changedKeys.includes('compareA')) applyCompareSide('A');
  if(changedKeys.includes('compareB')) applyCompareSide('B');
  if(changedKeys.includes('swipePercent')){ positionDivider(); map.render(); }
  // 複合疊圖模式下勾選/取消勾選/移除/調整順序：只在目前就是這個模式時
  // 才需要重新套用地圖圖層＋重繪浮動清單／checkbox 樣式；不是這個模式時
  // 改動只會存在 store 裡，等下次切進來再統一套用一次（進場已經會呼叫
  // applyModeTransition，不需要在這裡重複處理）。透明度拖曳中不會走到
  // 這裡（features/multiOverlay.js 的滑桿刻意不經過 store），所以這裡
  // 只會在增減／排序這種離散操作時被觸發，不會有拖曳中整份清單重繪、
  // 滑桿手感被打斷的問題。
  if(changedKeys.includes('multiOverlayLayers') && store.mode === 'multi'){
    applyMultiOverlayLayers();
    syncMultiLayerCheckedClasses();
    renderMultiOverlayBar();
    renderCustomSourcesPanel(); // 勾選狀態可能因為多選清單那邊的「移除」操作而變動，重繪一次同步 checkbox
  }
  // 新增／刪除自訂圖層本身（跟「有沒有勾選疊在地圖上」是兩件事）：
  // 只在複合疊圖面板可見時才需要重繪，理由跟上面 multiOverlayLayers 一樣。
  if(changedKeys.includes('customSources') && store.mode === 'multi'){
    renderCustomSourcesPanel();
  }
}

/* ---------------------------------------------------------
   進入點：設定模式面板 DOM 參照、訂閱 store，並套用一次目前狀態
   （初次進場：疊圖模式／現代地圖底圖等），走跟往後狀態變化完全
   相同的一套渲染路徑，不用另外重複寫一次初始化。
   由 mapCore.js 的 initMapCore() 呼叫，且必須晚於
   features/compareMode.js 的 initCompareMode()、
   features/multiOverlay.js 的 initMultiOverlayUI()、與
   ui/sidebarToggle.js 的 initSidebarToggle()（applyModeTransition
   會用到它們準備好的 DOM 參照）。
--------------------------------------------------------- */
export function initModeManager(){
  initModeSwitch();
  subscribe(render);
  applyModeTransition();
}
