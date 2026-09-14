/* ---------------------------------------------------------
   core/protectedKeys.js — 統一計算「目前使用中，不能被 layerCache
   LRU 淘汰」的 key 集合
   ---------------------------------------------------------
   在新增「複合疊圖模式」之前，這份邏輯是寫死在 core/layerManager.js
   裡的 getProtectedKeys()，只涵蓋疊圖模式的 activeOverlayKey 跟比對
   模式的 compareA/B。獨立成這支模組，是因為現在又多了一個會同時
   用到好幾個 key 的模式（複合疊圖，store.multiOverlayLayers 可能
   同時有好幾筆），如果繼續讓每個模式各自維護一份「保護名單」，
   很容易漏掉「保護到其他模式正在用的 key」，導致切換模式時明明
   還在用的圖層被 LRU 誤淘汰、下次切回去要重新對 WMTS 發送請求。

   所有需要呼叫 layerCache.js 的 getOrCreateLayer／getOrCreateSource
   的模組，都應該 import 這支函式取得保護名單，不要各自寫一份子集。
--------------------------------------------------------- */
import { state as store } from '../store.js';
import { runtime } from '../runtime.js';

export function getProtectedKeys(){
  const keys = new Set();
  if(store.activeOverlayKey) keys.add(store.activeOverlayKey);
  if(runtime.historyLayerKey) keys.add(runtime.historyLayerKey);
  // 這裡刻意不判斷字首（例如只保護 'hist:' 開頭）：layerCache 的保護名單只是
  // 「跳過淘汰」，對沒有對應 cache entry 的 key 完全無害（evictIfNeeded 只會
  // 過濾實際存在於 cache 裡的項目）。若在這裡比照 compareMode.js 目前只對
  // hist: 呼叫 getOrCreateSource() 的假設去加字首過濾，會變成兩個檔案分別
  // 維護同一份「目前使用中」子集邏輯的其中一半，違反本檔案目的；一旦
  // compareMode.js 之後改成連 custom: 圖層也走 getOrCreateSource()，這裡若忘記
  // 同步就會讓比對模式正在用的圖層被 LRU 誤淘汰。無條件加入才是真正解耦。
  if(typeof store.compareA === 'string') keys.add(store.compareA);
  if(typeof store.compareB === 'string') keys.add(store.compareB);
  store.multiOverlayLayers.forEach(entry => keys.add(entry.key));
  return keys;
}
