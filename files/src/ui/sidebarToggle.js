/* ---------------------------------------------------------
   ui/sidebarToggle.js — 側邊欄收合
   ---------------------------------------------------------
   從 mapCore.js 拆出來的純 UI 邏輯：側邊欄收合／展開按鈕，以及
   收合後（僅疊圖／時間軸模式）改在左下角顯示浮動透明度控制。
   不碰地圖圖層，只操作 DOM classList，所以獨立成純 UI 模組。

   collapseSidebar／updateFloatingOpacityVisibility 額外匯出，
   因為 core/modeManager.js（切到時間軸模式時）與
   features/compareMode.js（左下角圖層切換按鈕跟收合按鈕位置
   重疊，點下去順手收合側邊欄）都需要共用同一份收合邏輯。
--------------------------------------------------------- */
import { state as store } from '../store.js';

let floatingOpacityEl;
let toggleSidebarBtn;

export function updateFloatingOpacityVisibility(){
  const collapsed = document.getElementById('sidebar').classList.contains('collapsed');
  // 疊圖／時間軸模式都會用到「目前套疊圖層」這個概念，側邊欄收合時
  // 都改用左下角浮動透明度控制；左右比對模式的透明度控制不適用。
  floatingOpacityEl.classList.toggle('show', collapsed && (store.mode === 'overlay' || store.mode === 'timeline'));
}

// 依目前收合狀態同步按鈕的 title／aria-label／aria-expanded，避免 hover
// 提示與螢幕報讀器念出跟實際點擊動作相反的文字（收合後應提示「展開」）。
function syncToggleBtnA11y(collapsed){
  if(!toggleSidebarBtn) return;
  const label = collapsed ? '展開面板' : '收合面板';
  toggleSidebarBtn.title = label;
  toggleSidebarBtn.setAttribute('aria-label', label);
  toggleSidebarBtn.setAttribute('aria-expanded', String(!collapsed));
}

// 共用的收合動作：手動點收合按鈕、跟左右比對模式點左下圖層切換按鈕時都會用到。
export function collapseSidebar(){
  const sb = document.getElementById('sidebar');
  if(sb.classList.contains('collapsed')) return; // 已經是收合狀態就不用重複處理
  sb.classList.add('collapsed');
  // .sheet-expanded 是手機版 Bottom Sheet 的「展開至 75vh」疊加狀態
  // （見 src/ui/mobileLayout.js），跟 .collapsed 同時存在沒有意義；
  // 桌面版沒有這個 class，remove 是沒有作用的 no-op，不影響桌面行為。
  sb.classList.remove('sheet-expanded');
  if(toggleSidebarBtn) toggleSidebarBtn.textContent = '▸';
  syncToggleBtnA11y(true);
  updateFloatingOpacityVisibility();
}

// 共用的展開動作：與 collapseSidebar() 對稱，供其他模組（例如
// ui/onboarding.js 開始導覽前強制展開側邊欄）呼叫，避免各自直接改
// classList／aria 屬性卻漏更新收合按鈕圖示或浮動透明度控制的顯示狀態。
export function expandSidebar(){
  const sb = document.getElementById('sidebar');
  if(!sb.classList.contains('collapsed')) return; // 已經是展開狀態就不用重複處理
  sb.classList.remove('collapsed');
  if(toggleSidebarBtn) toggleSidebarBtn.textContent = '◂';
  syncToggleBtnA11y(false);
  updateFloatingOpacityVisibility();
}

export function initSidebarToggle(){
  floatingOpacityEl = document.getElementById('floatingOpacity');
  toggleSidebarBtn = document.getElementById('toggleSidebar');
  syncToggleBtnA11y(document.getElementById('sidebar').classList.contains('collapsed'));
  toggleSidebarBtn.addEventListener('click', (e)=>{
    const sb = document.getElementById('sidebar');
    sb.classList.toggle('collapsed');
    const collapsed = sb.classList.contains('collapsed');
    if(collapsed) sb.classList.remove('sheet-expanded'); // 見 collapseSidebar() 同一段說明
    e.target.textContent = collapsed ? '▸' : '◂';
    syncToggleBtnA11y(collapsed);
    updateFloatingOpacityVisibility();
  });
}
