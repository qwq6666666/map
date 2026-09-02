/* ---------------------------------------------------------
   mapCore.js — OpenLayers 地圖核心
   ---------------------------------------------------------
   負責：地圖／底圖初始化、目前位置定位（藍點）、透明疊圖／左右
   比對模式切換、比對模式的圖層選擇器與分隔線拖曳裁切、歷史圖層
   啟用／取消、透明度控制、側邊欄收合。

   對外只匯出其他模組需要用到的部分：
     - map：OL 地圖實例（sidebarUI 的 flyToSourceExtent 需要、
       但已內含在本模組，外部不需要直接碰 map，除非未來有需要）
     - showLocateToast：searchUI 的「定位搜尋」失敗時也會用到同一顆提示
     - flyToSourceExtent：sidebarUI 展開來源時要移動地圖視角
     - selectHistoryLayer / clearHistoryLayer / setMode：
       sidebarUI、searchUI 點選圖層或送出搜尋時都需要呼叫
     - initMapCore()：把所有需要 LAYER_SOURCES／REGION_EXTENTS
       已經載入完成才能正確運作的初始化動作包起來，由 main.js
       在 loadAppData() 完成後呼叫。
--------------------------------------------------------- */
import { state } from './state.js';
import { LAYER_SOURCES, REGION_EXTENTS, findLayerById, makeSourceForKey, titleForKey } from './data.js';
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
   自動將地圖移動、縮放到該來源大致涵蓋的地理範圍。
   僅套用在來源層級的展開動作，分類／子分類／圖層點擊不會再次移動地圖。
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
  if(state.locateToastTimer) clearTimeout(state.locateToastTimer);
  state.locateToastTimer = setTimeout(()=> locateToast.classList.remove('show'), 4500);
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
   底圖切換（疊圖模式用）
--------------------------------------------------------- */
function initBaseSwitch(){
  document.getElementById('baseSwitch').addEventListener('click', (e)=>{
    const btn = e.target.closest('button[data-base]');
    if(!btn) return;
    document.querySelectorAll('#baseSwitch button').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    const isSat = btn.dataset.base === 'sat';
    osmLayer.setVisible(!isSat);
    satLayer.setVisible(isSat);
  });
}

/* ---------------------------------------------------------
   模式切換：疊圖 vs 左右比對
--------------------------------------------------------- */
let overlayPanel, comparePanel, opacityBlockEl, swipeDividerEl, compareWrapA, compareWrapB;
const pickerValues = {
  A: 'hist:sinica:JM20K_1904:jpg',   // 預設左側：1904 堡圖
  B: 'base:osm'                       // 預設右側：現代地圖
};

export function setMode(mode){
  const previousMode = state.currentMode;
  state.currentMode = mode;
  document.getElementById('sidebar').classList.toggle('compact-mode', mode === 'compare');
  if(mode === 'overlay'){
    opacityBlockEl.style.display = 'block';
    overlayPanel.style.display = 'block';
    comparePanel.style.display = 'none';
    swipeDividerEl.classList.remove('show');
    compareWrapA.classList.remove('show');
    compareWrapB.classList.remove('show');
    if(state.swipeLayerA) map.removeLayer(state.swipeLayerA);
    if(state.swipeLayerB) map.removeLayer(state.swipeLayerB);
    if(previousMode === 'compare'){
      // 從左右比對切回來時，沿用左側目前選擇的圖層，不重置
      applyKeyToOverlay(pickerValues.A);
    } else {
      osmLayer.setVisible(document.querySelector('#baseSwitch button.active').dataset.base === 'osm');
      satLayer.setVisible(document.querySelector('#baseSwitch button.active').dataset.base === 'sat');
    }
    map.render();
  } else {
    opacityBlockEl.style.display = 'none';
    overlayPanel.style.display = 'none';
    comparePanel.style.display = 'block';
    swipeDividerEl.classList.add('show');
    compareWrapA.classList.add('show');
    compareWrapB.classList.add('show');
    // 保留目前選擇的底圖（現代地圖／衛星影像）做為共用底層，
    // 左右兩側各自的圖層改為疊加在底圖之上、僅裁切顯示自己該側，
    // 這樣歷史圖層沒有資料的地方仍會透出底圖，不會變成空白。
    // 左側初始值以「透明疊圖」目前選擇的圖層為準（沒選歷史圖層則用目前底圖）。
    const currentBaseKey = document.querySelector('#baseSwitch button.active').dataset.base === 'sat' ? 'base:sat' : 'base:osm';
    pickerValues.A = state.activeOverlayKey || currentBaseKey;
    document.getElementById('pickerLabelA').textContent = titleForKey(pickerValues.A);

    if(state.historyLayer){ map.removeLayer(state.historyLayer); state.historyLayer = null; }
    document.querySelectorAll('.layer-item.active').forEach(el=>el.classList.remove('active'));
    document.getElementById('stamp').classList.remove('show');
    rebuildSwipeLayer('A');
    rebuildSwipeLayer('B');
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
    document.querySelectorAll('#modeSwitch button').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
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
    item.addEventListener('click', ()=> onSelect(key, label));
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
      onSelect(`hist:${src.id}:${layer.id}:${layer.fmt}`, `${layer.year} ${layer.title}`), false);
    srcWrap.appendChild(srcHead);
    srcWrap.appendChild(srcBody);
    panelEl.appendChild(srcWrap);
  });
}

function setupPicker(side, btnEl, labelEl, panelEl){
  buildPickerPanel(panelEl, (key, label)=>{
    labelEl.textContent = label;
    panelEl.classList.remove('open');
    pickerValues[side] = key;
    rebuildSwipeLayer(side);
  });
  btnEl.addEventListener('click', (e)=>{
    e.stopPropagation();
    const willOpen = !panelEl.classList.contains('open');
    document.querySelectorAll('.layer-picker-panel.open').forEach(p=>p.classList.remove('open'));
    if(willOpen) panelEl.classList.add('open');
  });
}

function rebuildSwipeLayer(side){
  const key = pickerValues[side];
  const newLayer = new ol.layer.Tile({ source: makeSourceForKey(key) });
  if(side === 'A'){
    if(state.swipeLayerA) map.removeLayer(state.swipeLayerA);
    state.swipeLayerA = newLayer;
    clipLeftLayer(state.swipeLayerA);
    map.addLayer(state.swipeLayerA); // 疊加在底圖之上，僅裁切顯示左側
  } else {
    if(state.swipeLayerB) map.removeLayer(state.swipeLayerB);
    state.swipeLayerB = newLayer;
    clipRightLayer(state.swipeLayerB);
    map.addLayer(state.swipeLayerB); // 疊加在底圖之上，僅裁切顯示右側
  }
  map.render();
}

/* ---------------------------------------------------------
   比對模式：左右圖層裁切渲染（各自只顯示分隔線的一側，
   底下共用底圖維持可見，避免歷史圖層無資料處變空白）
--------------------------------------------------------- */
function clipLeftLayer(layer){
  layer.on('prerender', (event)=>{
    const ctx = event.context;
    const mapSize = map.getSize();
    if(!mapSize) return;
    const ratio = ctx.canvas.width / mapSize[0];
    const clipX = mapSize[0] * (state.swipePercent/100) * ratio;
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
    const clipX = mapSize[0] * (state.swipePercent/100) * ratio;
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
  swipeDividerEl.style.left = (w * state.swipePercent/100) + 'px';
}

function initSwipeDivider(){
  document.getElementById('swipeHandle').addEventListener('pointerdown', (e)=>{
    state.dragging = true;
    e.preventDefault();
  });
  window.addEventListener('pointerup', ()=> state.dragging = false);
  window.addEventListener('pointercancel', ()=> state.dragging = false);
  window.addEventListener('pointermove', (e)=>{
    if(!state.dragging || state.currentMode !== 'compare') return;
    const mapEl = document.getElementById('map');
    const rect = mapEl.getBoundingClientRect();
    let x = e.clientX - rect.left;
    x = Math.max(0, Math.min(rect.width, x));
    state.swipePercent = (x / rect.width) * 100;
    swipeDividerEl.style.left = x + 'px';
    map.render();
  });
  window.addEventListener('resize', ()=>{ if(state.currentMode==='compare') positionDivider(); });
}

/* ---------------------------------------------------------
   歷史圖層啟用／取消（透明疊圖模式）
--------------------------------------------------------- */
export function activateHistoryLayer(src, layer){
  if(state.historyLayer) map.removeLayer(state.historyLayer);
  state.historyLayer = new ol.layer.Tile({
    source: new ol.source.XYZ({
      url: src.tileUrl(layer),
      attributions: src.attribution
    }),
    opacity: parseInt(document.getElementById('opacitySlider').value,10)/100
  });
  map.addLayer(state.historyLayer);
  state.activeLayerId = layer.id;
  state.activeOverlayKey = `hist:${src.id}:${layer.id}:${layer.fmt}`;

  document.getElementById('stampYear').textContent = layer.year;
  document.getElementById('stampLabel').textContent = layer.title;
  document.getElementById('stamp').classList.add('show');
}

export function selectHistoryLayer(src, layer, itemEl){
  // 若點擊已啟用的圖層 -> 取消
  if(state.activeLayerId === layer.id){
    clearHistoryLayer();
    return;
  }
  document.querySelectorAll('.layer-item.active').forEach(el=>el.classList.remove('active'));
  itemEl.classList.add('active');
  activateHistoryLayer(src, layer);
}

export function clearHistoryLayer(){
  if(state.historyLayer){ map.removeLayer(state.historyLayer); state.historyLayer = null; }
  state.activeLayerId = null;
  state.activeOverlayKey = null;
  document.querySelectorAll('.layer-item.active').forEach(el=>el.classList.remove('active'));
  document.getElementById('stamp').classList.remove('show');
}

/* ---------------------------------------------------------
   從左右比對模式切回透明疊圖時，把指定的 key（左側目前選擇）
   還原成疊圖模式的狀態：底圖切換或啟用對應的歷史圖層
--------------------------------------------------------- */
function applyKeyToOverlay(key){
  if(key === 'base:osm' || key === 'base:sat'){
    clearHistoryLayer();
    const baseId = key === 'base:sat' ? 'sat' : 'osm';
    document.querySelectorAll('#baseSwitch button').forEach(b=>
      b.classList.toggle('active', b.dataset.base === baseId));
    osmLayer.setVisible(baseId === 'osm');
    satLayer.setVisible(baseId === 'sat');
    return;
  }
  const parts = key.split(':'); // ["hist", sourceId, id, fmt]
  const src = LAYER_SOURCES.find(s => s.id === parts[1]);
  if(!src) return;
  const foundLayer = findLayerById(src, parts[2]);
  if(!foundLayer) return;

  const itemEl = document.querySelector(`#categories .layer-item[data-layer-id="${foundLayer.id}"]`);
  if(itemEl){
    const subAncestor = itemEl.closest('.subcategory');
    if(subAncestor) subAncestor.classList.add('open');
    const catAncestor = itemEl.closest('.category');
    if(catAncestor) catAncestor.classList.add('open');
    const srcAncestor = itemEl.closest('.source-group');
    if(srcAncestor) srcAncestor.classList.add('open');
  }
  document.querySelectorAll('.layer-item.active').forEach(el=>el.classList.remove('active'));
  if(itemEl) itemEl.classList.add('active');
  activateHistoryLayer(src, foundLayer);
}

/* ---------------------------------------------------------
   透明度控制
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
    if(state.historyLayer) state.historyLayer.setOpacity(v/100);
  }
  opacitySlider.addEventListener('input', ()=> setOverlayOpacity(parseInt(opacitySlider.value,10)));
  floatingOpacitySlider.addEventListener('input', ()=> setOverlayOpacity(parseInt(floatingOpacitySlider.value,10)));

  document.getElementById('clearBtn').addEventListener('click', clearHistoryLayer);
}

/* ---------------------------------------------------------
   側邊欄收合：收合後（僅透明疊圖模式）改在左下角顯示浮動透明度控制，
   讓使用者不用展開整個面板也能調整
--------------------------------------------------------- */
let floatingOpacityEl;
function updateFloatingOpacityVisibility(){
  const collapsed = document.getElementById('sidebar').classList.contains('collapsed');
  floatingOpacityEl.classList.toggle('show', collapsed && state.currentMode === 'overlay');
}
function initSidebarToggle(){
  floatingOpacityEl = document.getElementById('floatingOpacity');
  document.getElementById('toggleSidebar').addEventListener('click', (e)=>{
    const sb = document.getElementById('sidebar');
    sb.classList.toggle('collapsed');
    e.target.textContent = sb.classList.contains('collapsed') ? '▸' : '◂';
    updateFloatingOpacityVisibility();
  });
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
  document.getElementById('pickerLabelA').textContent = titleForKey(pickerValues.A);
  document.getElementById('pickerLabelB').textContent = titleForKey(pickerValues.B);
  initSwipeDivider();
  initOpacityControls();
  initSidebarToggle();
}
