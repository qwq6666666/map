/* ---------------------------------------------------------
   mapCore.js — 組合層（facade）
   ---------------------------------------------------------
   這支檔案不再自己實作地圖邏輯，改成把拆開後的子模組組合起來，
   並且對外維持跟拆分前完全相同的匯出名稱／使用方式：

     - map：OL 地圖實例（來自 core/map.js）
     - flyToSourceExtent：sidebarUI 展開來源時要移動地圖視角
       （來自 core/map.js）
     - showLocateToast：searchUI 的「定位搜尋」失敗時也會用到
       同一顆提示（來自 features/location.js）
     - syncActiveLayerItemClasses：側邊欄／搜尋結果清單同步高亮
       （來自 core/layerManager.js）
     - initMapCore()：把所有子模組的初始化動作組合起來，由
       main.js 在 loadAppData() 完成後呼叫。

   實際的地圖初始化／圖層管理／模式控制／定位／比對模式／複合疊圖，
   分別在：
     core/map.js、core/layerManager.js、core/modeManager.js、
     features/location.js、features/compareMode.js、
     features/multiOverlay.js、ui/sidebarToggle.js
--------------------------------------------------------- */
import { map, flyToSourceExtent, initBaseSwitch } from './core/map.js';
import { showLocateToast, initLocateButton } from './features/location.js';
import { preloadOverlayKeys, syncActiveLayerItemClasses, initOpacityControls } from './core/layerManager.js';
import { initCompareMode } from './features/compareMode.js';
import { initMultiOverlayUI } from './features/multiOverlay.js';
import { initSidebarToggle } from './ui/sidebarToggle.js';
import { initModeManager } from './core/modeManager.js';
import { initTimelineMode } from './timelineMode.js';

export { map, flyToSourceExtent, showLocateToast, syncActiveLayerItemClasses };

export function initMapCore(){
  initLocateButton();
  initBaseSwitch();
  initCompareMode();
  initMultiOverlayUI(); // 複合疊圖模式：側邊欄 checkbox 圖層樹初始化，須晚於 LAYER_SOURCES 就緒
  initOpacityControls();
  initSidebarToggle();
  initTimelineMode(map, preloadOverlayKeys);
  initModeManager(); // 須放最後：套用一次目前狀態時會用到上面幾個模組準備好的 DOM
}
