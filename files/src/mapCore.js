/* ---------------------------------------------------------
   mapCore.js — OpenLayers 地圖核心（訂閱 store，反應式重繪）
   ---------------------------------------------------------
   這支模組不再讓按鈕的 click handler 直接呼叫 map.addLayer()／
   map.removeLayer()。所有「使用者想切換什麼」都先透過 store.js
   的 setState()／action 函式（setMode／setBaseLayer／
   selectOverlayLayer…）寫進 store，這裡只訂閱 store 的變化，
   在 render() 裡集中把「目前狀態」實際套用到地圖圖層與 DOM 上。

   對外只匯出其他模組需要用到的部分：
     - map：OL 地圖實例
     - showLocateToast：searchUI 的「定位搜尋」失敗時也會用到同一顆提示
     - flyToSourceExtent：sidebarUI 展開來源時要移動地圖視角
       （純視角操作，不屬於「目前顯示什麼」的狀態，所以不透過 store）
     - initMapCore()：把所有初始化動作（含訂閱 store）包起來，
       由 main.js 在 loadAppData() 完成後呼叫。
--------------------------------------------------------- */
import { state as store, subscribe, setMode, setBaseLayer, setCompareSide, setSwipePercent, clearOverlayLayer } from './store.js';
import { runtime } from './runtime.js';
import { LAYER_SOURCES, REGION_EXTENTS, makeSourceForKey, titleForKey, resolveOverlayKey } from './data.js';
import { buildCategoryList } from './uiTree.js';

const SAT_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

/* ---------------------------------------------------------
   OpenLayers 地圖初始化
--------------------------------------------------------- */
const osmLayer = new ol.layer.Tile({ source: new ol.source.OSM(), visible: true });
const satLayer = new ol.layer.Tile({
  source: new ol.source.XYZ({ url: SAT_URL, attributions: 'Esri, Maxar, Earthstar Geographics' }),
  visible: false
});

export const map = new ol.Map({
  target: 'map',
  layers: [osmLayer, satLayer],
  view: new ol.View({
    center: ol.proj.fromLonLat([120.9, 23.7]),
    zoom: 8,
    minZoom: 3,
    maxZoom: 21
  })
});

/* ---------------------------------------------------------
   點擊展開圖資來源（最大階層，例如「宜蘭百年歷史地圖」）時，
   自動將地圖移動、縮放到該來源大致涵蓋的地理範圍。這是一次性的
   視角操作，不是「目前應該顯示什麼」的持續狀態，所以不透過 store。
--------------------------------------------------------- */
export function flyToSourceExtent(srcId){
  const ext = REGION_EXTENTS[srcId];
  if(!ext) return;
  const extent3857 = ol.proj.transformExtent(ext, 'EPSG:4326', 'EPSG:3857');
  map.getView().fit(extent3857, { duration:700, padding:[40,40,40,40], maxZoom:14 });
}

/* ---------------------------------------------------------
   定位功能：取得目前位置並移動地圖、標示藍點
--------------------------------------------------------- */
let locateMarkerEl, locateOverlay, locateBtn, locateToast;

export function showLocateToast(msg){
  locateToast.textContent = msg;
  locateToast.classList.add('show');
  if(runtime.locateToastTimer) clearTimeout(runtime.locateToastTimer);
  runtime.locateToastTimer = setTimeout(()=> locateToast.classList.remove('show'), 4500);
}

function initLocateButton(){
  locateMarkerEl = document.getElementById('locateMarker');
  locateOverlay = new ol.Overlay({
    element: locateMarkerEl,
    positioning: 'center-center',
    stopEvent: false
  });
  map.addOverlay(locateOverlay);

  locateBtn = document.getElementById('locateBtn');
  locateToast = document.getElementById('locateToast');

  locateBtn.addEventListener('click', ()=>{
    if(!navigator.geolocation){
      showLocateToast('您的瀏覽器不支援定位功能。');
      return;
    }
    locateBtn.classList.add('loading');
    navigator.geolocation.getCurrentPosition(
      (pos)=>{
        locateBtn.classList.remove('loading');
        const coord = ol.proj.fromLonLat([pos.coords.longitude, pos.coords.latitude]);
        locateOverlay.setPosition(coord);
        locateMarkerEl.classList.add('show');
        const view = map.getView();
        view.animate({ center: coord, zoom: Math.max(view.getZoom(), 15), duration: 600 });
      },
      (err)=>{
        locateBtn.classList.remove('loading');
        let msg = '無法取得目前位置，請稍後再試。';
        if(err.code === err.PERMISSION_DENIED) msg = '已拒絕位置權限，請至瀏覽器或系統設定允許此網站存取位置後再試一次。';
        else if(err.code === err.POSITION_UNAVAILABLE) msg = '目前無法判斷您的位置。';
        else if(err.code === err.TIMEOUT) msg = '定位逾時，請再試一次。';
        showLocateToast(msg);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });
}

/* ---------------------------------------------------------
   底圖切換（疊圖／比對模式共用）：click handler 只呼叫 setBaseLayer()，
   真正切換 osmLayer/satLayer 可見度、同步按鈕高亮，在 render() 統一處理。
--------------------------------------------------------- */
function initBaseSwitch(){
  document.getElementById('baseSwitch').addEventListener('click', (e)=>{
    const btn = e.target.closest('button[data-base]');
    if(!btn) return;
    setBaseLayer(btn.dataset.base);
  });
}

function applyBaseLayer(){
  osmLayer.setVisible(store.baseLayer === 'osm');
  satLayer.setVisible(store.baseLayer === 'sat');
  document.querySelectorAll('#baseSwitch button').forEach(b=>
    b.classList.toggle('active', b.dataset.base === store.baseLayer));
}

/* ---------------------------------------------------------
   透明疊圖模式：套用目前 store.activeOverlayKey 到地圖上
   （null 代表沒有套疊歷史圖層，只顯示底圖）
--------------------------------------------------------- */
function applyActiveOverlayKey(){
  const resolved = resolveOverlayKey(store.activeOverlayKey);
  if(!resolved){
    if(runtime.historyLayer){ map.removeLayer(runtime.historyLayer); runtime.historyLayer = null; }
    document.getElementById('stamp').classList.remove('show');
  } else {
    const { src, layer } = resolved;
    if(runtime.historyLayer) map.removeLayer(runtime.historyLayer);
    runtime.historyLayer = new ol.layer.Tile({
      source: new ol.source.XYZ({ url: src.tileUrl(layer), attributions: src.attribution }),
      opacity: parseInt(document.getElementById('opacitySlider').value,10)/100
    });
    map.addLayer(runtime.historyLayer);
    document.getElementById('stampYear').textContent = layer.year;
    document.getElementById('stampLabel').textContent = layer.title;
    document.getElementById('stamp').classList.add('show');
  }
  syncActiveLayerItemClasses();
  map.render();
}

// 側邊欄主清單與搜尋結果清單，兩個地方都有同一顆圖層的 .layer-item，
// 統一在這裡依 store.activeOverlayKey 同步 .active class 與展開對應的
// 分類／次分類／來源手風琴，取代原本分散在點擊當下、或還原模式時各自
// 處理高亮的做法。
export function syncActiveLayerItemClasses(){
  document.querySelectorAll('.layer-item.active').forEach(el=>el.classList.remove('active'));
  const resolved = resolveOverlayKey(store.activeOverlayKey);
  if(!resolved) return;
  document.querySelectorAll(`.layer-item[data-layer-id="${resolved.layer.id}"]`).forEach(itemEl=>{
    itemEl.classList.add('active');
    let p = itemEl.parentElement;
    while(p){
      if(p.classList && (p.classList.contains('category') || p.classList.contains('subcategory') || p.classList.contains('source-group'))) p.classList.add('open');
      p = p.parentElement;
    }
  });
}

/* ---------------------------------------------------------
   模式切換：疊圖 vs 左右比對
--------------------------------------------------------- */
let overlayPanel, comparePanel, opacityBlockEl, swipeDividerEl, compareWrapA, compareWrapB;

function applyModeTransition(){
  document.getElementById('sidebar').classList.toggle('compact-mode', store.mode === 'compare');
  document.querySelectorAll('#modeSwitch button').forEach(b=>
    b.classList.toggle('active', b.dataset.mode === store.mode));

  if(store.mode === 'overlay'){
    opacityBlockEl.style.display = 'block';
    overlayPanel.style.display = 'block';
    comparePanel.style.display = 'none';
    swipeDividerEl.classList.remove('show');
    compareWrapA.classList.remove('show');
    compareWrapB.classList.remove('show');
    if(runtime.swipeLayerA){ map.removeLayer(runtime.swipeLayerA); runtime.swipeLayerA = null; }
    if(runtime.swipeLayerB){ map.removeLayer(runtime.swipeLayerB); runtime.swipeLayerB = null; }
    // activeOverlayKey 在切到比對模式時不會被清掉（見下方），所以這裡
    // 直接沿用目前的值套用即可，等同原本「從左右比對切回來時，沿用左側
    // 目前選擇的圖層」的行為。
    applyBaseLayer();
    applyActiveOverlayKey();
    map.render();
  } else {
    opacityBlockEl.style.display = 'none';
    overlayPanel.style.display = 'none';
    comparePanel.style.display = 'block';
    swipeDividerEl.classList.add('show');
    compareWrapA.classList.add('show');
    compareWrapB.classList.add('show');

    // 左側初始值以「透明疊圖」目前選擇的圖層為準（沒選歷史圖層則用目前底圖）。
    // 這是進入比對模式當下算出來的預設值，直接寫回 store（跟原本
    // pickerValues.A = activeOverlayKey || currentBaseKey 是同一件事），
    // 不用另外呼叫 setState() 觸發第二次廣播。
    const currentBaseKey = store.baseLayer === 'sat' ? 'base:sat' : 'base:osm';
    store.compareA = store.activeOverlayKey || currentBaseKey;

    if(runtime.historyLayer){ map.removeLayer(runtime.historyLayer); runtime.historyLayer = null; }
    document.querySelectorAll('.layer-item.active').forEach(el=>el.classList.remove('active'));
    document.getElementById('stamp').classList.remove('show');

    applyCompareSide('A');
    applyCompareSide('B');
    positionDivider();
    map.render();
  }
  updateFloatingOpacityVisibility();
}

function initModeSwitch(){
  overlayPanel = document.getElementById('overlayPanel');
  comparePanel = document.getElementById('comparePanel');
  opacityBlockEl = document.getElementById('opacityBlock');
  swipeDividerEl = document.getElementById('swipeDivider');
  compareWrapA = document.getElementById('compareWrapA');
  compareWrapB = document.getElementById('compareWrapB');

  document.getElementById('modeSwitch').addEventListener('click', (e)=>{
    const btn = e.target.closest('button[data-mode]');
    if(!btn) return;
    setMode(btn.dataset.mode);
  });
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
  });
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

// 依 side（'A'/'B'）套用 store.compareA / store.compareB：更新按鈕標籤文字，
// 若目前在比對模式，同時重建對應側的裁切圖層。
function applyCompareSide(side){
  const key = side === 'A' ? store.compareA : store.compareB;
  const labelEl = document.getElementById(side === 'A' ? 'pickerLabelA' : 'pickerLabelB');
  labelEl.textContent = titleForKey(key);
  if(store.mode !== 'compare') return; // 非比對模式時不用真的建立 swipe 圖層
  rebuildSwipeLayer(side, key);
}

function rebuildSwipeLayer(side, key){
  const newLayer = new ol.layer.Tile({ source: makeSourceForKey(key) });
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
function positionDivider(){
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
   透明度控制（不影響「顯示哪個圖層」，只是既有圖層的顯示參數，
   所以不透過 store，直接對目前的 runtime.historyLayer 操作）
--------------------------------------------------------- */
function initOpacityControls(){
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

/* ---------------------------------------------------------
   側邊欄收合：收合後（僅透明疊圖模式）改在左下角顯示浮動透明度控制，
   讓使用者不用展開整個面板也能調整
--------------------------------------------------------- */
let floatingOpacityEl;
let toggleSidebarBtn;
function updateFloatingOpacityVisibility(){
  const collapsed = document.getElementById('sidebar').classList.contains('collapsed');
  floatingOpacityEl.classList.toggle('show', collapsed && store.mode === 'overlay');
}
// 共用的收合動作：手動點收合按鈕、跟左右比對模式點左下圖層切換按鈕時都會用到。
function collapseSidebar(){
  const sb = document.getElementById('sidebar');
  if(sb.classList.contains('collapsed')) return; // 已經是收合狀態就不用重複處理
  sb.classList.add('collapsed');
  if(toggleSidebarBtn) toggleSidebarBtn.textContent = '▸';
  updateFloatingOpacityVisibility();
}
function initSidebarToggle(){
  floatingOpacityEl = document.getElementById('floatingOpacity');
  toggleSidebarBtn = document.getElementById('toggleSidebar');
  toggleSidebarBtn.addEventListener('click', (e)=>{
    const sb = document.getElementById('sidebar');
    sb.classList.toggle('collapsed');
    e.target.textContent = sb.classList.contains('collapsed') ? '▸' : '◂';
    updateFloatingOpacityVisibility();
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
}

/* ---------------------------------------------------------
   進入點：所有依賴 LAYER_SOURCES 已載入完成的初始化動作，
   由 main.js 在 loadAppData() 完成後呼叫。
--------------------------------------------------------- */
export function initMapCore(){
  initLocateButton();
  initBaseSwitch();
  initModeSwitch();
  document.addEventListener('click', (e)=>{
    document.querySelectorAll('.layer-picker-panel.open').forEach(p=>{
      if(!p.parentElement.contains(e.target)) p.classList.remove('open');
    });
  });
  setupPicker('A', document.getElementById('pickerBtnA'), document.getElementById('pickerLabelA'), document.getElementById('pickerPanelA'));
  setupPicker('B', document.getElementById('pickerBtnB'), document.getElementById('pickerLabelB'), document.getElementById('pickerPanelB'));
  initSwipeDivider();
  initOpacityControls();
  initSidebarToggle();

  subscribe(render);
  // 初次進場：套用 store 的預設狀態（疊圖模式／現代地圖底圖等），
  // 走跟往後狀態變化完全相同的一套渲染路徑，不用另外重複寫一次初始化。
  applyModeTransition();
}
