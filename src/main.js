/* ---------------------------------------------------------
   main.js — 應用程式進入點
   ---------------------------------------------------------
   先載入 data/ 底下的 JSON 資料，成功後才依序初始化地圖核心、
   側邊欄圖層清單、地址／定位搜尋。任何一個模組的初始化都需要
   LAYER_SOURCES／REGION_EXTENTS 等資料已經就緒，所以必須等
   loadAppData() 完成後才開始。
--------------------------------------------------------- */
import { loadAppData } from './data.js';
import { initMapCore } from './mapCore.js';
import { initSidebar } from './sidebarUI.js';
import { initSearchUI } from './searchUI.js';
import { initLayerSearchUI } from './ui/layerSearch.js';
import { initDrawTool } from './drawTool.js';
import { initIdentifyPin } from './features/identifyPin.js';
import { showLocationAndFindLayers, focusPlaceNameCard } from './ui/search.js';
import { getActivePlaceNameMatchAt } from './features/placeNames.js';
import { initOnboarding } from './ui/onboarding.js';
import { initSourceStatusUI } from './ui/sourceStatusUI.js';
import { initMobileLayout } from './ui/mobileLayout.js';
import { applyShareStateFromURL, initLiveShareURL } from './features/shareLink.js';
import { showAlert } from './ui/dialog.js';
import { initNativeShareUI } from './ui/nativeShareUI.js';
import { initTrackRecorderUI } from './ui/trackRecorderUI.js';
import { initTrackListUI } from './ui/trackListUI.js';

// 用頂層 await 取代原本包一層 async function main(){...} 再呼叫的寫法
// （SonarQube javascript:S7785）；index.html 是 `<script type="module">`，
// 瀏覽器原生支援 ESM 頂層 await，不需要額外包裝。
let dataLoaded = true;
try{
  await loadAppData();
}catch(err){
  console.error('資料載入失敗', err);
  showAlert('圖層資料載入失敗，請重新整理頁面再試一次。');
  dataLoaded = false;
}

if(dataLoaded){
  initMapCore();   // 地圖、底圖切換、疊圖／比對模式、透明度、定位藍點
  initSidebar();   // 左側 WMTS 來源／分類手風琴（需要 LAYER_SOURCES 已載入）
  initSearchUI();  // 地址搜尋、定位搜尋、自動完成、逐筆圖磚驗證
  initLayerSearchUI(); // 圖資搜尋（metadata 比對，跟地址搜尋完全獨立）
  initDrawTool();  // 點／線／面繪製標註、量測、匯出 GeoJSON／截圖
  initIdentifyPin({
    onSearchLayers: showLocationAndFindLayers,
    getPlaceNameMatch: getActivePlaceNameMatchAt,
    onViewPlaceNameCard: focusPlaceNameCard
  }); // 免開關地圖自由落點探針，含地名今昔對照卡的「查看地名沿革」連動
  initOnboarding(); // 新手導覽／使用指南（獨立疊加層，不依賴地圖或側欄初始化狀態）
  initNativeShareUI(); // 「傳送連結／截圖」原生分享面板按鈕（環境不支援就維持隱藏）
  initTrackRecorderUI(); // 「記錄軌跡／匯出軌跡」按鈕與狀態條；啟動時若上次記錄到一半被關掉會詢問接續
  initTrackListUI(); // 「我的軌跡」列表抽屜（顯示／匯出／存成繪圖／改名／刪除／匯入 GPX、GeoJSON）
  initSourceStatusUI(); // 圖資來源狀態抽屜（一鍵探測各主機是否正常，跟 initOnboarding 一樣是獨立疊加層）
  initMobileLayout(); // 手機版 (<=768px) Bottom Sheet／頂部搜尋列協調，>768px 為 no-op

  // 分享連結：所有 UI 都掛好訂閱後才還原網址帶入的狀態，確保 setState()
  // 廣播時每個模組都已經在聽，畫面才會真的照分享連結還原。
  applyShareStateFromURL();
  initLiveShareURL(); // 還原完才開始把後續變動即時寫回網址列（避免還原過程本身被當成使用者操作）
}

// 只在正式建置（vite build）且瀏覽器支援時註冊 Service Worker，
// 開發模式（vite dev）故意不註冊，避免快取干擾即時開發。
// 這裡執行到的時間點已經在 await loadAppData() 之後，不需要再刻意等
// window 的 load 事件才註冊——曾經包過 addEventListener('load', ...)，
// 但 loadAppData() 抓 layers.bundle.json 這種大檔案偶爾會比其他資源慢，
// 導致真正執行到這行時 load 事件早就已經觸發過，事後補掛的監聽器永遠
// 等不到，Service Worker 因此完全沒有機會自動註冊（已踩過的坑，實測
// 重現過兩次）。
if(import.meta.env?.PROD && 'serviceWorker' in navigator){
  navigator.serviceWorker.register('./sw.js').catch(err => {
    console.error('Service Worker 註冊失敗', err);
  });
}
