/* ---------------------------------------------------------
   features/compareMode.js — 左右比對模式
   ---------------------------------------------------------
   從 mapCore.js 拆出來、只有進入左右比對模式才會用到的東西：
   圖層選擇器面板、左右裁切渲染、分隔線拖曳。這些函式外部完全
   不會單獨呼叫，彼此高度耦合，所以獨立成一個 feature 模組，
   而不是硬塞進 layerManager（歷史圖層生命週期）或 modeManager
   （模式切換本身）。

   對外只匯出 core/modeManager.js 需要用到的部分：
     - initCompareMode()：初始化 DOM 參照與事件，由
       mapCore.js 的 initMapCore() 呼叫一次。
     - enterCompareMode()／resetCompareVisuals()：進入／離開
       比對模式時的畫面套用，由 modeManager 的 applyModeTransition()
       呼叫。
     - applyCompareSide(side)：單一側圖層變更時套用，由
       modeManager 的 store 訂閱者 render() 呼叫。
     - positionDivider()：分隔線位置變更時套用，同樣由 render() 呼叫。
--------------------------------------------------------- */
import { state as store, setCompareSide, setSwipePercent } from '../store.js';
import { runtime } from '../runtime.js';
import { LAYER_SOURCES, makeSourceForKey, titleForKey } from '../data.js';
import { buildCategoryList } from '../uiTree.js';
import { map } from '../core/map.js';
import { collapseSidebar } from '../ui/sidebarToggle.js';
import { getOrCreateSource } from '../core/layerCache.js';
import { getProtectedKeys } from '../core/protectedKeys.js';
import { createCountryFilterBar } from '../ui/countryFilter.js';

let swipeDividerEl, compareWrapA, compareWrapB;

/* ---------------------------------------------------------
   離開比對模式（或任何一次模式切換的共用重置）：把分隔線／左右
   裁切圖層收起來。不管切去哪個模式都會先呼叫這個，避免殘留上一次
   比對模式的圖層跟畫面元素。
--------------------------------------------------------- */
export function resetCompareVisuals(){
  swipeDividerEl.classList.remove('show');
  compareWrapA.classList.remove('show');
  compareWrapB.classList.remove('show');
  if(runtime.swipeLayerA){ map.removeLayer(runtime.swipeLayerA); runtime.swipeLayerA = null; }
  if(runtime.swipeLayerB){ map.removeLayer(runtime.swipeLayerB); runtime.swipeLayerB = null; }
}

/* ---------------------------------------------------------
   進入比對模式：顯示分隔線與左右容器、決定左側預設圖層、
   建立左右裁切圖層。
--------------------------------------------------------- */
export function enterCompareMode(){
  swipeDividerEl.classList.add('show');
  compareWrapA.classList.add('show');
  compareWrapB.classList.add('show');

  // 左側初始值以「透明疊圖」目前選擇的圖層為準（沒選歷史圖層則用目前底圖）。
  // 這是進入比對模式當下算出來的預設值，透過既有的 setCompareSide()
  // 寫回 store，讓其他訂閱者也能收到這次狀態變更的廣播。
  const currentBaseKey = store.baseLayer === 'sat' ? 'base:sat' : 'base:osm';
  setCompareSide('A', store.activeOverlayKey || currentBaseKey);

  if(runtime.historyLayer){ map.removeLayer(runtime.historyLayer); runtime.historyLayer = null; }
  document.querySelectorAll('.layer-item.active').forEach(el=>el.classList.remove('active'));
  document.getElementById('stamp').classList.remove('show');

  applyCompareSide('A');
  applyCompareSide('B');
  positionDivider();
  map.render();
}

// 依 side（'A'/'B'）套用 store.compareA / store.compareB：更新按鈕標籤文字，
// 若目前在比對模式，同時重建對應側的裁切圖層。
export function applyCompareSide(side){
  const key = side === 'A' ? store.compareA : store.compareB;
  const labelEl = document.getElementById(side === 'A' ? 'pickerLabelA' : 'pickerLabelB');
  labelEl.textContent = titleForKey(key);
  if(store.mode !== 'compare') return; // 非比對模式時不用真的建立 swipe 圖層
  rebuildSwipeLayer(side, key);
}

// 歷史圖層 key（"hist:..."）透過共用的 WMTS Layer Cache 取得 Source——
// 這樣切到「時間軸模式已經看過」的同一張歷史圖時，Source（也就是真正
// 持有圖磚快取、花網路成本的東西）直接沿用，不會重新對 WMTS 服務發送
// 請求。底圖 key（"base:osm"/"base:sat"）不算歷史圖資，不經過快取，
// 沿用原本的 makeSourceForKey()。
//
// 注意：TileLayer 包裝物件本身這裡還是每次重新 new——因為左右比對的
// 裁切效果是用 layer.on('prerender'/'postrender', ...) 直接掛在這個
// TileLayer 實例上的，沒辦法跟疊圖／時間軸模式共用同一個 Layer 物件
// （共用會導致該圖層之後被拿去別的地方顯示時，也被誤裁切一半畫面）。
// 這個包裝物件不含任何網路成本，重新建立很便宜，不會造成重複請求。
function resolveSourceForCompareKey(key){
  if(typeof key === 'string' && key.startsWith('hist:')){
    return getOrCreateSource(key, getCompareProtectedKeys());
  }
  return makeSourceForKey(key);
}

function getCompareProtectedKeys(){
  // 統一改用 core/protectedKeys.js 的 getProtectedKeys()，避免自己維護一份
  // 子集漏掉 store.multiOverlayLayers／runtime.historyLayerKey，導致複合疊圖
  // 選好的圖層在比對模式底下被 layerCache 的 LRU 誤淘汰。
  return getProtectedKeys();
}

function rebuildSwipeLayer(side, key){
  const newLayer = new ol.layer.Tile({ source: resolveSourceForCompareKey(key) });
  if(side === 'A'){
    if(runtime.swipeLayerA) map.removeLayer(runtime.swipeLayerA);
    runtime.swipeLayerA = newLayer;
    clipLeftLayer(newLayer);
    map.addLayer(newLayer); // 疊加在底圖之上，僅裁切顯示左側
  } else {
    if(runtime.swipeLayerB) map.removeLayer(runtime.swipeLayerB);
    runtime.swipeLayerB = newLayer;
    clipRightLayer(newLayer);
    map.addLayer(newLayer); // 疊加在底圖之上，僅裁切顯示右側
  }
  map.render();
}

/* ---------------------------------------------------------
   比對模式：左右圖層裁切渲染（各自只顯示分隔線的一側，
   底下共用底圖維持可見，避免歷史圖層無資料處變空白）
   prerender 每次都讀 store.swipePercent 的即時值，所以拖曳分隔線時
   不需要重建圖層，只要重新 map.render() 讓下一輪 prerender 拿到新值。
--------------------------------------------------------- */
function clipLeftLayer(layer){
  layer.on('prerender', (event)=>{
    const ctx = event.context;
    const mapSize = map.getSize();
    if(!mapSize) return;
    const ratio = ctx.canvas.width / mapSize[0];
    const clipX = mapSize[0] * (store.swipePercent/100) * ratio;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, clipX, ctx.canvas.height);
    ctx.clip();
  });
  layer.on('postrender', (event)=>{
    event.context.restore();
  });
}

function clipRightLayer(layer){
  layer.on('prerender', (event)=>{
    const ctx = event.context;
    const mapSize = map.getSize();
    if(!mapSize) return;
    const ratio = ctx.canvas.width / mapSize[0];
    const clipX = mapSize[0] * (store.swipePercent/100) * ratio;
    ctx.save();
    ctx.beginPath();
    ctx.rect(clipX, 0, ctx.canvas.width - clipX, ctx.canvas.height);
    ctx.clip();
  });
  layer.on('postrender', (event)=>{
    event.context.restore();
  });
}

/* ---------------------------------------------------------
   比對模式：分隔線拖曳
--------------------------------------------------------- */
export function positionDivider(){
  const mapEl = document.getElementById('map');
  const w = mapEl.clientWidth;
  swipeDividerEl.style.left = (w * store.swipePercent/100) + 'px';
}

function initSwipeDivider(){
  document.getElementById('swipeHandle').addEventListener('pointerdown', (e)=>{
    runtime.dragging = true;
    e.preventDefault();
  });
  window.addEventListener('pointerup', ()=> runtime.dragging = false);
  window.addEventListener('pointercancel', ()=> runtime.dragging = false);
  window.addEventListener('pointermove', (e)=>{
    if(!runtime.dragging || store.mode !== 'compare') return;
    const mapEl = document.getElementById('map');
    const rect = mapEl.getBoundingClientRect();
    let x = e.clientX - rect.left;
    x = Math.max(0, Math.min(rect.width, x));
    setSwipePercent((x / rect.width) * 100);
  });
  window.addEventListener('resize', ()=>{ if(store.mode==='compare') positionDivider(); });
}

/* ---------------------------------------------------------
   比對模式：圖層選擇器（按鈕 + 手風琴浮動面板，取代長串下拉選單）
--------------------------------------------------------- */
function buildPickerPanel(panelEl, onSelect){
  panelEl.innerHTML = '';

  // 底圖（現代地圖／衛星影像）
  const baseWrap = document.createElement('div');
  baseWrap.className = 'category open';
  const baseHead = document.createElement('div');
  baseHead.className = 'category-head';
  baseHead.style.cursor = 'default';
  baseHead.innerHTML = `<span>底圖</span>`;
  const baseBody = document.createElement('div');
  baseBody.className = 'category-body';
  baseBody.style.display = 'block';
  [['base:osm','現代地圖'], ['base:sat','衛星影像']].forEach(([key,label])=>{
    const item = document.createElement('div');
    item.className = 'layer-item';
    item.innerHTML = `<span class="layer-title">${label}</span>`;
    item.addEventListener('click', ()=> onSelect(key));
    baseBody.appendChild(item);
  });
  baseWrap.appendChild(baseHead);
  baseWrap.appendChild(baseBody);
  panelEl.appendChild(baseWrap);

  // WMTS 圖資來源 → 分類 → 圖層
  const sourceWraps = []; // [{ src, wrap }]，供下面篩選列使用
  const { bar: filterBar, refresh: refreshCountryFilter } = createCountryFilterBar(() => sourceWraps);
  panelEl.appendChild(filterBar);

  LAYER_SOURCES.forEach(src=>{
    const srcWrap = document.createElement('div');
    srcWrap.className = 'source-group';
    const srcHead = document.createElement('button');
    srcHead.type = 'button';
    srcHead.className = 'source-head';
    const total = src.categories.reduce((s,c)=> s + (c.groups ? c.groups.reduce((gs,g)=>gs+g.layers.length,0) : c.layers.length), 0);
    srcHead.innerHTML = `<span><span class="chevron">▸</span>${src.name}</span><span class="count">${total}</span>`;
    srcHead.addEventListener('click', ()=> srcWrap.classList.toggle('open'));
    const srcBody = document.createElement('div');
    srcBody.className = 'source-body';
    buildCategoryList(src.categories, srcBody, (layer)=>
      onSelect(`hist:${src.id}:${layer.id}:${layer.fmt}`), false);
    srcWrap.appendChild(srcHead);
    srcWrap.appendChild(srcBody);
    panelEl.appendChild(srcWrap);
    sourceWraps.push({ src, wrap: srcWrap });
  });

  refreshCountryFilter();
}

function setupPicker(side, btnEl, labelEl, panelEl){
  buildPickerPanel(panelEl, (key)=>{
    panelEl.classList.remove('open');
    setCompareSide(side, key);
  });
  btnEl.addEventListener('click', (e)=>{
    e.stopPropagation();
    const willOpen = !panelEl.classList.contains('open');
    document.querySelectorAll('.layer-picker-panel.open').forEach(p=>p.classList.remove('open'));
    if(willOpen) panelEl.classList.add('open');
    // 左下角（A 側）的圖層切換按鈕跟側邊欄展開時的位置會重疊，
    // 左右比對模式下點它就順手把側邊欄收合，選單才不會被擋住。
    if(willOpen && side === 'A' && store.mode === 'compare') collapseSidebar();
  });
}

export function initCompareMode(){
  swipeDividerEl = document.getElementById('swipeDivider');
  compareWrapA = document.getElementById('compareWrapA');
  compareWrapB = document.getElementById('compareWrapB');

  document.addEventListener('click', (e)=>{
    document.querySelectorAll('.layer-picker-panel.open').forEach(p=>{
      if(!p.parentElement.contains(e.target)) p.classList.remove('open');
    });
  });
  setupPicker('A', document.getElementById('pickerBtnA'), document.getElementById('pickerLabelA'), document.getElementById('pickerPanelA'));
  setupPicker('B', document.getElementById('pickerBtnB'), document.getElementById('pickerLabelB'), document.getElementById('pickerPanelB'));
  initSwipeDivider();
}
