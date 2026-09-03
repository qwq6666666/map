/* ---------------------------------------------------------
   core/multiOverlayManager.js — 複合疊圖模式：多張歷史圖層同時疊加
   ---------------------------------------------------------
   跟 core/layerManager.js（疊圖模式，永遠只有一張、切換時交叉淡出
   淡入）不同，這裡管理的是 store.multiOverlayLayers 這個陣列，每筆
   { key, opacity } 對應地圖上一張 TileLayer，陣列順序＝疊放順序
   （index 越大＝疊在越上層）。不需要交叉淡出淡入——複合疊圖模式的
   圖層是使用者主動勾選/取消，不是「自動切到下一張」，直接顯示/
   隱藏即可，不用額外做動畫。

   沿用 core/layerCache.js 的 WMTS Layer Cache：同一個 key 不管是被
   疊圖模式、比對模式、時間軸模式、或這裡的複合疊圖模式用到，永遠
   只建立一次 TileLayer／Source，這裡拿到的都是同一個快取好的物件，
   只調整 opacity／zIndex，不會重複對 WMTS 服務發送請求。

   進出這個模式時不清空 store.multiOverlayLayers（使用者組好的疊圖
   組合應該要記得住，下次切回來還在），只是把圖層畫面上顯示/隱藏；
   這點跟離開時間軸模式會整個清空 layerPool 的行為刻意不同（見
   core/modeManager.js 呼叫 hideMultiOverlayLayers() 的地方）。

   zIndex 注意事項：因為圖層物件是跨模式共用的快取物件，這裡設定的
   zIndex 如果離開時不清掉，會殘留到下次這個 key 被疊圖／比對／時間
   軸模式用到時，干擾到那些模式原本依賴「加入地圖的先後順序」決定
   疊放順序的假設。所以隱藏圖層時一併把 zIndex 重設回 undefined
   （交還給預設的插入順序規則），不能只把 opacity 調回 0。
--------------------------------------------------------- */
import { state as store } from '../store.js';
import { getOrCreateLayer, hasCachedLayer, getCachedLayer, setLayerOpacity } from './layerCache.js';
import { getProtectedKeys } from './protectedKeys.js';
import { map } from './map.js';

const BASE_Z_INDEX = 1; // 疊在底圖（沒有明確 zIndex，等同 0）之上；陣列 index 依序往上疊加

let lastShownKeys = new Set(); // 上一輪實際顯示中的 key，用來判斷這一輪誰該被隱藏

function resetLayerVisual(key){
  if(!hasCachedLayer(key)) return;
  setLayerOpacity(key, 0);
  const layer = getCachedLayer(key);
  if(layer) layer.setZIndex(undefined); // 交還給預設疊放順序，避免殘留 zIndex 干擾其他模式
}

// 依 store.multiOverlayLayers 目前的內容，把對應圖層加到地圖上、
// 設定各自的 zIndex／opacity；已經不在清單裡但上一輪還顯示著的圖層，
// 隱藏並清掉 zIndex（見檔頭說明），不直接從地圖移除——圖層物件本身
// 留在 layerCache 裡繼續給 LRU 管理即可。
export function applyMultiOverlayLayers(){
  const currentKeys = new Set();

  store.multiOverlayLayers.forEach((entry, idx) => {
    const layer = getOrCreateLayer(entry.key, getProtectedKeys());
    layer.setZIndex(BASE_Z_INDEX + idx);
    layer.setOpacity(entry.opacity / 100);
    currentKeys.add(entry.key);
  });

  lastShownKeys.forEach(key => {
    if(!currentKeys.has(key)) resetLayerVisual(key);
  });

  lastShownKeys = currentKeys;
  map.render();
}

// 切到其他模式時呼叫：只隱藏目前顯示中的圖層，store.multiOverlayLayers
// 本身不清空，下次切回複合疊圖模式時 applyMultiOverlayLayers() 會依
// 記得的清單重新顯示。
export function hideMultiOverlayLayers(){
  lastShownKeys.forEach(resetLayerVisual);
  lastShownKeys = new Set();
  map.render();
}
