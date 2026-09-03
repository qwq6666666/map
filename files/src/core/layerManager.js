/* ---------------------------------------------------------
   core/layerManager.js — 歷史圖層生命週期管理（疊圖／時間軸）
   ---------------------------------------------------------
   從 mapCore.js 拆出來的「疊圖模式」歷史圖層管理：淡入淡出交叉
   溶接切換、透明度控制，以及套用 store.activeOverlayKey 到地圖上。
   這支模組只管「透明疊圖模式目前這一張歷史圖層」，不管模式切換
   本身（core/modeManager.js）、不管左右比對模式
   （features/compareMode.js）。

   實際的「圖層要不要重新建立」，全部委派給 core/layerCache.js
   （WMTS Layer Cache）：同一個 key 只會建立一次 TileLayer／Source，
   之後不管是疊圖模式手動點選、還是時間軸播放來回切換，都直接沿用
   快取好的物件，只調整 opacity，不會重新對 WMTS 服務發送請求。
--------------------------------------------------------- */
import { state as store, clearOverlayLayer } from '../store.js';
import { runtime } from '../runtime.js';
import { resolveOverlayKey } from '../data.js';
import { map } from './map.js';
import { getOrCreateLayer, hasCachedLayer, clearCache, getCacheStats } from './layerCache.js';
import { getProtectedKeys } from './protectedKeys.js';

/* ---------------------------------------------------------
   淡入淡出交叉溶接：切換歷史圖層時，不要「先整個移除舊的，才開始
   顯示新的」（中間會有一段空白畫面），改成新圖層先在背景悄悄開始
   載入圖磚（opacity 先設 0，見 layerCache.js），給它一小段「暖機
   時間」（FADE_GRACE_MS）讓圖磚有機會先抓一些下來，接著才讓新舊
   圖層同時交叉淡出／淡入（FADE_MS）。

   淡出完畢的舊圖層不會被移除或丟棄——它本來就活在 layerCache 裡，
   淡出只是把 opacity 調回 0，圖層物件跟它已經下載好的圖磚繼續留在
   原地，之後又選回同一張時可以直接沿用，不用重新對 WMTS 服務發送
   任何請求，也不會再看到一次空白／讀取中的畫面。
--------------------------------------------------------- */
const FADE_GRACE_MS = 250; // 新圖層先背景載入、還沒開始淡入淡出的暖機時間
const FADE_MS = 350;       // 交叉淡出／淡入本身的時長

function fadeLayerTo(layer, targetOpacity, durationMs, onDone){
  const startOpacity = layer.getOpacity ? layer.getOpacity() : 1;
  const start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  function step(){
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const t = Math.min(1, (now - start) / durationMs);
    layer.setOpacity(startOpacity + (targetOpacity - startOpacity) * t);
    map.render();
    if(t < 1){
      setTimeout(step, 16);
    } else if(onDone){
      onDone();
    }
  }
  step();
}

function crossfadeToLayer(newLayer, previousLayer, targetOpacity, alreadyWarm){
  const startFade = () => {
    fadeLayerTo(newLayer, targetOpacity, FADE_MS);
    if(previousLayer && previousLayer !== newLayer){
      fadeLayerTo(previousLayer, 0, FADE_MS); // 淡出到 0 就好，圖層本身留在 layerCache，不用另外處理
    }
  };
  // 如果是快取裡本來就有的圖層，圖磚早就開始下載了，不用再等暖機時間，
  // 直接開始交叉淡出／淡入。
  if(alreadyWarm) startFade();
  else setTimeout(startFade, FADE_GRACE_MS);
}

/* ---------------------------------------------------------
   圖層預先載入：像時間軸模式這種「已經知道接下來會依序用到哪些
   圖層」的情境，提前跟 layerCache 要一次（沒有就建立、opacity 0，
   有就直接沿用），讓圖磚提早開始背景下載；真正切換過去時，
   applyActiveOverlayKey() 會直接拿到同一個已經在暖機的圖層物件。
--------------------------------------------------------- */
export function preloadOverlayKeys(keys){
  (keys || []).forEach(key => {
    if(!key || key === store.activeOverlayKey) return; // 目前正顯示的不用重複預載
    if(!resolveOverlayKey(key)) return;
    getOrCreateLayer(key, getProtectedKeys());
  });
}

// 保留舊名稱以維持相容（modeManager.js 用這個名字），改成呼叫
// layerCache 的 clearCache()：離開時間軸模式時，把整個歷史圖層
// 快取清空、真正從地圖上移除，避免長期累積佔用記憶體；重新進入
// 時間軸模式會依當下畫面重新建立。
export function clearLayerPool(){
  clearCache();
  runtime.historyLayer = null;
  runtime.historyLayerKey = null;
}

// 切到複合疊圖模式時呼叫：只是把疊圖模式目前這張圖層的畫面隱藏
// （opacity 0），不動 runtime.historyLayerKey／store.activeOverlayKey，
// 所以切回疊圖模式時 applyActiveOverlayKey() 還記得要淡入回同一張。
// 跟 features/compareMode.js 進入比對模式時直接 map.removeLayer() 整個
// 移除的做法不同——這裡刻意只隱藏不移除，因為這個 layer 物件是
// layerCache 共用的快取物件，直接從地圖移除會讓 layerCache 內部的
// Map 紀錄跟地圖上實際的圖層狀態對不起來。
export function suspendActiveOverlayVisual(){
  if(runtime.historyLayer) runtime.historyLayer.setOpacity(0);
}

export function applyActiveOverlayKey(){
  const resolved = resolveOverlayKey(store.activeOverlayKey);
  if(!resolved){
    if(runtime.historyLayer){
      fadeLayerTo(runtime.historyLayer, 0, FADE_MS);
      runtime.historyLayer = null;
      runtime.historyLayerKey = null;
    }
    document.getElementById('stamp').classList.remove('show');
  } else {
    const { layer } = resolved;
    const targetOpacity = parseInt(document.getElementById('opacitySlider').value,10)/100;
    const key = store.activeOverlayKey;

    const previousLayer = runtime.historyLayer;
    const alreadyWarm = hasCachedLayer(key); // 記錄「是不是快取裡本來就有」，決定要不要跳過暖機時間
    const newLayer = getOrCreateLayer(key, getProtectedKeys());

    runtime.historyLayer = newLayer;
    runtime.historyLayerKey = key;

    crossfadeToLayer(newLayer, previousLayer, targetOpacity, alreadyWarm);

    document.getElementById('stampYear').textContent = layer.year;
    document.getElementById('stampLabel').textContent = layer.title;
    document.getElementById('stamp').classList.add('show');
  }
  syncActiveLayerItemClasses();
  map.render();
}

// 側邊欄主清單與搜尋結果清單，兩個地方都有同一顆圖層的 .layer-item，
// 統一在這裡依 store.activeOverlayKey 同步 .active class 與展開對應的
// 分類／次分類／來源手風琴。
export function syncActiveLayerItemClasses(){
  document.querySelectorAll('.layer-item.active').forEach(el=>el.classList.remove('active'));
  const resolved = resolveOverlayKey(store.activeOverlayKey);
  if(!resolved) return;
  document.querySelectorAll(`.layer-item[data-layer-id="${resolved.layer.id}"]`).forEach(itemEl=>{
    itemEl.classList.add('active');
    // 時間軸模式底下側邊欄本來就是收合的，不需要（也不希望）在背景把
    // 對應的分類／來源手風琴強制展開；等使用者自己手動展開側邊欄時，
    // 才不會發現分類已經被時間軸切換過程悄悄展開到某個地方。
    if(store.mode === 'timeline') return;
    let p = itemEl.parentElement;
    while(p){
      if(p.classList && (p.classList.contains('category') || p.classList.contains('subcategory') || p.classList.contains('source-group'))) p.classList.add('open');
      p = p.parentElement;
    }
  });
}

/* ---------------------------------------------------------
   透明度控制（不影響「顯示哪個圖層」，只是既有圖層的顯示參數，
   所以不透過 store，直接對目前的 runtime.historyLayer 操作）
--------------------------------------------------------- */
export function initOpacityControls(){
  const opacitySlider = document.getElementById('opacitySlider');
  const opacityVal = document.getElementById('opacityVal');
  const floatingOpacitySlider = document.getElementById('floatingOpacitySlider');
  const floatingOpacityVal = document.getElementById('floatingOpacityVal');

  // 側邊欄內與側邊欄收合後的浮動控制，兩顆滑桿共用同一份數值，
  // 任一顆拖動都會同步另一顆並套用到目前的歷史圖層。
  function setOverlayOpacity(v){
    opacitySlider.value = v;
    opacityVal.textContent = v + '%';
    floatingOpacitySlider.value = v;
    floatingOpacityVal.textContent = v + '%';
    if(runtime.historyLayer) runtime.historyLayer.setOpacity(v/100);
  }
  opacitySlider.addEventListener('input', ()=> setOverlayOpacity(parseInt(opacitySlider.value,10)));
  floatingOpacitySlider.addEventListener('input', ()=> setOverlayOpacity(parseInt(floatingOpacitySlider.value,10)));

  document.getElementById('clearBtn').addEventListener('click', clearOverlayLayer);
}

// 方便未來在畫面上（或 console）顯示 Cache 現況用；目前沒有 UI 掛這個，
// 純粹把 layerCache 的 stats 轉手匯出，供除錯或未來擴充。
export { getCacheStats };
