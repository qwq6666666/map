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

async function main(){
  try{
    await loadAppData();
  }catch(err){
    console.error('資料載入失敗', err);
    alert('圖層資料載入失敗，請重新整理頁面再試一次。');
    return;
  }
  initMapCore();  // 地圖、底圖切換、疊圖／比對模式、透明度、定位藍點
  initSidebar();  // 左側 WMTS 來源／分類手風琴（需要 LAYER_SOURCES 已載入）
  initSearchUI(); // 地址搜尋、定位搜尋、自動完成、逐筆圖磚驗證
}

main();
