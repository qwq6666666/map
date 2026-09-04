/* ---------------------------------------------------------
   drawTool.js — 繪製工具：點／線／面標註、距離／面積量測、
   匯出 GeoJSON（給 QGIS／ArcGIS 等 GIS 軟體）與地圖截圖（PNG）
   ---------------------------------------------------------
   全部建立在 OpenLayers 內建的 interaction.Draw／Modify／Select
   之上，不用自己刻幾何運算或事件處理；距離／面積計算用 ol.sphere
   模組（球面距離，不是平面近似，長距離也準確）。

   繪製內容存在一個獨立的 ol.source.Vector，畫在所有底圖／歷史圖層
   之上（zIndex 較高），跟目前選了疊圖／比對／時間軸哪個模式無關，
   任何模式下都看得到、都能繼續畫。

   這是第一版：點／線／面的名稱都用瀏覽器原生 prompt() 輸入，不是
   自訂的輸入框 UI，功能上沒問題，但視覺風格跟網站其他部分不太一致，
   之後如果想做成跟搜尋框一樣風格的輸入介面，可以再調整。線／面留空
   不輸入名稱時，只顯示自動算出的長度／面積（跟原本行為一致）；輸入
   了名稱則顯示「名稱（長度／面積）」，兩者一起看得到。
--------------------------------------------------------- */
import { map } from './mapCore.js';
import { saveUserFeatures, loadUserFeatures, clearUserFeatures } from './features/storage.js';

let vectorSource = null;
let vectorLayer = null;
let modifyInteraction = null;
let selectInteraction = null;
let activeDrawInteraction = null;
let currentTool = null;
let toolbarEl = null;
let toggleBtn = null;
let toolbarOpen = false;

// 繪圖顏色選擇：工具列色票（6 色）+ 自訂色，畫下一個圖形時採用
// currentColor；既有圖形則各自把顏色寫進 SimpleStyle 屬性裡（見
// applyColorToFeature），不會因為之後切換 currentColor 而跟著變色。
export const PALETTE_COLORS = ['#C0392B', '#2980B9', '#27AE60', '#D35400', '#8E44AD', '#2C3E50'];
export const DEFAULT_COLOR = '#C0392B';
let currentColor = DEFAULT_COLOR;

const INK = '#17211D';
const PAPER = '#EAE3D3';

// 要素編輯彈窗（繪製後二次改色／改名／刪除）相關狀態
let editOverlay = null;
let editPopupEl, editPopupTitle, editPopupNameInput, editPopupPalette, editPopupCustomColor, editPopupDeleteBtn;
let editingFeature = null;

function formatLength(meters){
  if(meters >= 1000) return `${(meters / 1000).toFixed(2)} 公里`;
  return `${meters.toFixed(1)} 公尺`;
}

function formatArea(sqMeters){
  if(sqMeters >= 1000000) return `${(sqMeters / 1000000).toFixed(2)} 平方公里`;
  if(sqMeters >= 10000) return `${(sqMeters / 10000).toFixed(2)} 公頃`;
  return `${sqMeters.toFixed(1)} 平方公尺`;
}

// hex（#rrggbb 或 #rgb）轉成帶透明度的 rgba(...) 字串，給 ol.style.Fill
// 的面填色使用（SimpleStyle 的 fill-opacity 只是個 0~1 數字，OpenLayers
// 沒有對應屬性可以直接吃，要自己併進顏色字串裡）。
function hexToRgba(hex, alpha){
  const h = String(hex || DEFAULT_COLOR).replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const num = parseInt(full, 16) || 0;
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// 依圖形種類（點／線／面）決定畫在地圖上的樣式，點跟線／面都會把
// feature.get('label') 的文字（點的說明、或線／面自動算出的長度／
// 面積）顯示在圖形旁邊。顏色一律優先讀 feature 自己的 SimpleStyle
// 屬性（marker-color / stroke / fill 等，見 applyColorToFeature），
// 沒有才 fallback 回 DEFAULT_COLOR，這樣同一張圖上不同顏色的圖形
// 各自獨立，不受目前色票選色（currentColor）影響。
export function featureStyleFn(feature){
  const kind = feature.get('kind');
  const label = feature.get('label') || '';
  const textStyle = label ? new ol.style.Text({
    text: label,
    font: '12px "Public Sans", sans-serif',
    fill: new ol.style.Fill({ color: INK }),
    stroke: new ol.style.Stroke({ color: PAPER, width: 3 }),
    offsetY: kind === 'point' ? -16 : 0
  }) : undefined;

  if(kind === 'point'){
    const color = feature.get('marker-color') || DEFAULT_COLOR;
    return new ol.style.Style({
      image: new ol.style.Circle({
        radius: 7,
        fill: new ol.style.Fill({ color }),
        stroke: new ol.style.Stroke({ color: PAPER, width: 2 })
      }),
      text: textStyle
    });
  }

  const strokeColor = feature.get('stroke') || DEFAULT_COLOR;
  const strokeWidth = feature.get('stroke-width') || 3;
  const fillColor = kind === 'polygon' ? (feature.get('fill') || strokeColor) : strokeColor;
  const fillOpacity = kind === 'polygon' ? (feature.get('fill-opacity') || 0.35) : 0.15;
  return new ol.style.Style({
    stroke: new ol.style.Stroke({ color: strokeColor, width: strokeWidth }),
    fill: new ol.style.Fill({ color: hexToRgba(fillColor, fillOpacity) }),
    image: new ol.style.Circle({ radius: 5, fill: new ol.style.Fill({ color: strokeColor }) }), // 線的端點／面的頂點
    text: textStyle
  });
}

// 把顏色寫進 feature 的 SimpleStyle 屬性（https://github.com/mapbox/simplestyle-spec），
// 匯出 GeoJSON 時這些屬性會原封不動一起匯出，QGIS／ArcGIS／geojson.io
// 等常見 GIS 軟體都看得懂、會照著上色；反過來匯入別處做的 GeoJSON，
// 只要照這個規格寫顏色，這裡也讀得到（見 importGeoJSON）。
export function applyColorToFeature(feature, color){
  const kind = feature.get('kind');
  if(kind === 'point'){
    feature.set('marker-color', color);
  } else if(kind === 'line'){
    feature.set('stroke', color);
    feature.set('stroke-width', 3);
    feature.set('stroke-opacity', 0.8);
  } else if(kind === 'polygon'){
    feature.set('stroke', color);
    feature.set('fill', color);
    feature.set('fill-opacity', 0.35);
  }
  // 假 feature（例如測試用的 makeFakeFeature()）不一定有 .changed()，
  // 只有真的 ol.Feature 才需要主動通知圖層重繪。
  if(typeof feature.changed === 'function') feature.changed();
}

// 要素編輯彈窗開著時，切換工具／清空全部繪製內容都應該順便關掉，
// 不然彈窗會繼續指著一個可能已經不存在、或不再是「選取中」狀態的
// 舊 feature。editPopupEl 可能因為 initFeatureEditPopup() 找不到
// #drawFeatureEditPopup 而提早 return、始終是 undefined，這裡要防呆。
function closeFeatureEditPopup(){
  if(!editPopupEl) return;
  editPopupEl.hidden = true;
  editingFeature = null;
  if(editOverlay) editOverlay.setPosition(undefined);
}

function clearActiveDrawInteraction(){
  if(activeDrawInteraction){ map.removeInteraction(activeDrawInteraction); activeDrawInteraction = null; }
  map.removeInteraction(selectInteraction);
  map.removeInteraction(modifyInteraction);
}

function updateToolbarActiveState(){
  toolbarEl.querySelectorAll('.draw-tool-btn[data-tool]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === currentTool);
  });
}

// 收合工具列時，把目前選取中的工具一併取消。理由：工具列收合後畫面上
// 看不到「現在是哪個工具」，如果還讓某個畫圖工具保持啟用，使用者點地圖
// 可能會不小心畫出預期外的圖形，不如收合的同時直接回到單純瀏覽狀態。
function setToolbarOpen(open){
  toolbarOpen = open;
  toolbarEl.classList.toggle('show', open);
  toggleBtn.classList.toggle('active', open);
  if(!open && currentTool){
    clearActiveDrawInteraction();
    currentTool = null;
    updateToolbarActiveState();
  }
}

function setTool(tool){
  clearActiveDrawInteraction();
  closeFeatureEditPopup();
  currentTool = (currentTool === tool) ? null : tool; // 再點一次同一個工具 -> 取消選取，回到單純瀏覽
  updateToolbarActiveState();
  if(!currentTool) return;

  if(currentTool === 'select'){
    map.addInteraction(selectInteraction);
    map.addInteraction(modifyInteraction);
    return;
  }

  const geometryType = currentTool === 'point' ? 'Point' : currentTool === 'line' ? 'LineString' : 'Polygon';
  activeDrawInteraction = new ol.interaction.Draw({ source: vectorSource, type: geometryType });
  activeDrawInteraction.on('drawend', (e) => {
    const feature = e.feature;
    feature.set('kind', currentTool);
    applyColorToFeature(feature, currentColor);
    if(currentTool === 'point'){
      const name = prompt('這個標記點的說明文字（可留空）：', '');
      feature.set('name', name || '');
      feature.set('label', name || '');
    } else if(currentTool === 'line'){
      const measure = formatLength(ol.sphere.getLength(feature.getGeometry()));
      const name = prompt('這條線的名稱（可留空，只顯示長度）：', '');
      feature.set('name', name || '');
      feature.set('measure', measure);
      feature.set('label', name ? `${name}（${measure}）` : measure);
    } else if(currentTool === 'polygon'){
      const measure = formatArea(ol.sphere.getArea(feature.getGeometry()));
      const name = prompt('這個區域的名稱（可留空，只顯示面積）：', '');
      feature.set('name', name || '');
      feature.set('measure', measure);
      feature.set('label', name ? `${name}（${measure}）` : measure);
    }
    persistFeatures();
  });
  map.addInteraction(activeDrawInteraction);
}

function deleteSelected(){
  if(!selectInteraction) return;
  const selected = selectInteraction.getFeatures();
  selected.forEach(f => vectorSource.removeFeature(f));
  selected.clear();
  persistFeatures();
}

function clearAll(){
  if(!confirm('確定要清除全部繪製內容嗎？這個動作無法復原。')) return;
  vectorSource.clear();
  closeFeatureEditPopup();
  clearUserFeatures();
  showStorageToast('已清空本機快取');
}

function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function timestamp(){
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// 輕量提示 toast，給自動儲存／清空快取這類「背景動作」用一個小小的
// 文字回饋。UI 元素（#drawStorageToast）由 index.html 提供，可能還沒
// 被加上，找不到就靜默跳過，不影響儲存/還原本身的邏輯。
function showStorageToast(msg){
  const el = document.getElementById('drawStorageToast');
  if(!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

// 把目前 vectorSource 裡的圖形整批寫進 localStorage，供重新整理頁面
// 後自動還原（見 initDrawTool() 尾端的 loadUserFeatures()）。沒有任何
// 圖形時直接清空快取，避免刪光所有圖形後 localStorage 還殘留舊資料。
function persistFeatures(){
  const features = vectorSource.getFeatures();
  if(features.length === 0){
    clearUserFeatures();
    return;
  }
  const format = new ol.format.GeoJSON();
  const geojsonStr = format.writeFeatures(features, {
    featureProjection: 'EPSG:3857',
    dataProjection: 'EPSG:4326'
  });
  const ok = saveUserFeatures(JSON.parse(geojsonStr));
  if(ok) showStorageToast('已自動儲存');
}

/**
 * 匯出繪製內容成 GeoJSON（EPSG:4326 經緯度座標，GIS 軟體通用），
 * 可直接匯入 QGIS、ArcGIS 等軟體。
 */
export function exportGeoJSON(){
  const features = vectorSource.getFeatures();
  if(features.length === 0){ alert('目前沒有任何繪製內容可以匯出。'); return; }
  const format = new ol.format.GeoJSON();
  const geojsonStr = format.writeFeatures(features, {
    featureProjection: 'EPSG:3857', // 地圖內部使用的座標系
    dataProjection: 'EPSG:4326'     // 匯出成一般 GIS 軟體慣用的經緯度座標
  });
  const blob = new Blob([geojsonStr], { type: 'application/geo+json' });
  downloadBlob(blob, `繪製內容_${timestamp()}.geojson`);
}

/**
 * 匯入 GeoJSON（檔案內容字串，或已經 parse 好的物件），加進目前的
 * 繪製圖層。相容別處做的 GeoJSON：沒有 kind 屬性的話用幾何類型猜；
 * 沒有 SimpleStyle 顏色屬性的話補上 DEFAULT_COLOR，確保一定畫得出來。
 * @param {string|object} input GeoJSON 文字或物件
 * @returns {number} 成功匯入的圖形數量
 */
export function importGeoJSON(input){
  const text = (typeof input === 'string') ? input : JSON.stringify(input);
  let features;
  try{
    const format = new ol.format.GeoJSON();
    features = format.readFeatures(text, {
      featureProjection: 'EPSG:3857',
      dataProjection: 'EPSG:4326'
    });
  }catch(err){
    console.error('匯入 GeoJSON 失敗', err);
    alert('匯入失敗：檔案格式不是有效的 GeoJSON。');
    return 0;
  }
  features.forEach(feature => {
    if(!feature.get('kind')){
      const geomType = feature.getGeometry && feature.getGeometry() && feature.getGeometry().getType ? feature.getGeometry().getType() : null;
      feature.set('kind', geomType === 'Point' ? 'point' : geomType === 'LineString' ? 'line' : 'polygon');
    }
    const kind = feature.get('kind');
    const hasStyle = kind === 'point' ? !!feature.get('marker-color') : !!feature.get('stroke');
    if(!hasStyle) applyColorToFeature(feature, DEFAULT_COLOR);
    if(!feature.get('label')) feature.set('label', feature.get('name') || '');
    vectorSource.addFeature(feature);
  });
  persistFeatures();
  return features.length;
}

/**
 * 把目前地圖畫面（底圖／歷史圖層／繪製內容，當下看到什麼就存什麼）
 * 匯出成一張 PNG 圖片，等於地圖裁切截圖。
 * 做法：等地圖這一幀真的畫完後，把畫面上每一層的 canvas 依照各自
 * 的透明度、位移，合成畫到同一張新的 canvas 上再輸出，這是
 * OpenLayers 官方文件建議的匯出圖片做法。
 */
export function exportImage(){
  // map.once('rendercomplete', ...) 理論上會在下一次渲染完成時觸發，但如果
  // 地圖畫面跟上次比對完全沒有變化，OpenLayers 有時候會判斷「沒有新的東西
  // 要重繪」而完全不觸發這個事件，導致監聽器卡住、擷取變得像「只能按一次」
  //（第一次剛好還在渲染中才觸發成功，之後不動地圖再按就沒反應）。
  // 加一個逾時保險：如果事件真的沒有觸發，就直接用目前畫面擷取——反正
  // 按下擷取的當下，畫面本來就是使用者正在看的、已經渲染穩定的狀態。
  let done = false;
  const capture = () => {
    if(done) return;
    done = true;
    doCapture();
  };
  map.once('rendercomplete', capture);
  map.renderSync();
  setTimeout(capture, 400);
}

function doCapture(){
  // 瀏覽器內部（尤其是 Retina／高解析度螢幕）常常會用比 CSS 顯示尺寸
  // 更高的實際像素去畫圖磚，畫面才會看起來清晰銳利。如果輸出的 canvas
  // 只開到 CSS 尺寸（例如螢幕上看到 800×600），等於把這些多出來的細節
  // 硬生生砍掉，存出來的圖片畫質會明顯比螢幕上看到的還差。這裡改成
  // 依照 devicePixelRatio 把輸出尺寸放大，畫面實際多細緻，存出來的圖片
  // 就多細緻。
  const pixelRatio = window.devicePixelRatio || 1;
  const mapCanvas = document.createElement('canvas');
  const size = map.getSize();
  mapCanvas.width = size[0] * pixelRatio;
  mapCanvas.height = size[1] * pixelRatio;
  const mapContext = mapCanvas.getContext('2d');

  const canvases = map.getViewport().querySelectorAll('.ol-layer canvas, canvas.ol-layer');
  canvases.forEach((canvas) => {
    if(!canvas.width) return;
    const opacity = canvas.parentNode && canvas.parentNode.style.opacity;
    mapContext.globalAlpha = (opacity === '' || opacity === undefined) ? 1 : Number(opacity);
    // 不管來源 canvas 原本的實際像素尺寸是多少，直接等比例縮放畫滿到
    // 目前這張放大過的目標 canvas，畫面靜止（沒有正在拖曳／縮放動畫）
    // 時這樣最穩妥，不用另外解析 CSS transform 矩陣。
    mapContext.drawImage(canvas, 0, 0, mapCanvas.width, mapCanvas.height);
  });

  mapContext.globalAlpha = 1;
  mapContext.setTransform(1, 0, 0, 1, 0, 0);

  // 圖磚來自外部伺服器，如果該伺服器沒有明確允許跨網域讀取像素資料
  // （CORS），canvas 合成完的內容會被瀏覽器標記成「不能再讀出」，
  // toBlob() 這時候可能直接丟出例外，而不是單純回傳 null。這裡包一層
  // try/catch，讓使用者至少看得到「為什麼失敗」，不會什麼都沒發生。
  try{
    mapCanvas.toBlob((blob) => {
      if(blob) downloadBlob(blob, `地圖截圖_${timestamp()}.png`);
      else alert('圖片匯出失敗：圖層可能來自不允許跨網域讀取的伺服器（CORS 限制），請再試一次。');
    });
  }catch(err){
    console.error('地圖截圖失敗', err);
    alert('圖片匯出失敗：目前畫面上的圖層來自不允許跨網域讀取像素的伺服器（CORS 限制），瀏覽器基於安全考量擋下了這次匯出。');
  }
}

// 把某個色票容器（工具列 #drawColorPalette 或編輯彈窗
// #drawFeaturePopupPalette，兩者結構相同）裡跟目前顏色相符的那顆
// swatch 標成 active，其餘取消，兩處色票共用同一套邏輯。
function updateColorPaletteActiveState(paletteEl, color){
  if(!paletteEl) return;
  paletteEl.querySelectorAll('.draw-color-swatch').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.color === color);
  });
}

// 工具列色票：選色後只影響「接下來要畫的下一個圖形」（currentColor），
// 不影響地圖上已經畫好的圖形（那些顏色各自寫死在自己的 feature 屬性上，
// 見 applyColorToFeature／featureStyleFn）。
function initColorPalette(){
  const paletteEl = document.getElementById('drawColorPalette');
  paletteEl.querySelectorAll('.draw-color-swatch').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      currentColor = btn.dataset.color;
      updateColorPaletteActiveState(paletteEl, currentColor);
    });
  });
  const customInput = document.getElementById('drawColorCustom');
  customInput.addEventListener('click', (e) => e.stopPropagation());
  customInput.addEventListener('input', (e) => {
    e.stopPropagation();
    currentColor = customInput.value;
    updateColorPaletteActiveState(paletteEl, currentColor);
  });
  updateColorPaletteActiveState(paletteEl, currentColor);
}

// 要素編輯彈窗：畫完一個圖形之後，用「select」工具點它就能改名／改色／
// 刪除，改色當下 applyColorToFeature() 會呼叫 feature.changed()，圖層
// 用的是動態讀屬性的 featureStyleFn，畫面立刻更新，不用手動重繪圖層。
function initFeatureEditPopup(){
  editPopupEl = document.getElementById('drawFeatureEditPopup');
  if(!editPopupEl) return; // index.html 沒有這個容器時靜默跳過

  editPopupTitle = document.getElementById('drawFeaturePopupTitle');
  editPopupNameInput = document.getElementById('drawFeaturePopupName');
  editPopupPalette = document.getElementById('drawFeaturePopupPalette');
  editPopupCustomColor = document.getElementById('drawFeaturePopupCustomColor');
  editPopupDeleteBtn = document.getElementById('drawFeaturePopupDelete');
  const closeBtn = document.getElementById('drawFeaturePopupClose');

  editOverlay = new ol.Overlay({
    element: editPopupEl,
    positioning: 'bottom-center',
    stopEvent: true,
    offset: [0, -12]
  });
  map.addOverlay(editOverlay);

  editPopupEl.addEventListener('click', (e) => e.stopPropagation());

  editPopupNameInput.addEventListener('input', (e) => {
    e.stopPropagation();
    if(!editingFeature) return;
    const name = editPopupNameInput.value;
    editingFeature.set('name', name);
    const kind = editingFeature.get('kind');
    const measure = editingFeature.get('measure');
    editingFeature.set('label', (kind !== 'point' && measure) ? (name ? `${name}（${measure}）` : measure) : name);
  });

  const applyEditColor = (color) => {
    if(!editingFeature) return;
    applyColorToFeature(editingFeature, color);
    updateColorPaletteActiveState(editPopupPalette, color);
    editPopupCustomColor.value = color;
    persistFeatures();
  };
  editPopupPalette.querySelectorAll('.draw-color-swatch').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      applyEditColor(btn.dataset.color);
    });
  });
  editPopupCustomColor.addEventListener('click', (e) => e.stopPropagation());
  editPopupCustomColor.addEventListener('input', (e) => {
    e.stopPropagation();
    applyEditColor(editPopupCustomColor.value);
  });

  editPopupDeleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if(!editingFeature) return;
    vectorSource.removeFeature(editingFeature);
    closeFeatureEditPopup();
    persistFeatures();
  });

  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeFeatureEditPopup();
  });

  // 只有「select」工具啟用中才處理，避免跟正在畫圖的 Draw interaction
  // 搶點擊、也避免跟一般瀏覽模式下的 identifyPin.js 落點探針互相干擾。
  map.on('singleclick', (e) => {
    if(currentTool !== 'select') return;
    const feature = map.forEachFeatureAtPixel(e.pixel, (f, layer) => layer === vectorLayer ? f : undefined);
    if(!feature){ closeFeatureEditPopup(); return; }
    editingFeature = feature;
    const kind = feature.get('kind');
    editPopupTitle.textContent = kind === 'point' ? '點' : kind === 'line' ? '線' : '面';
    editPopupNameInput.value = feature.get('name') || '';
    const color = kind === 'point' ? (feature.get('marker-color') || DEFAULT_COLOR) : (feature.get('stroke') || DEFAULT_COLOR);
    updateColorPaletteActiveState(editPopupPalette, color);
    editPopupCustomColor.value = color;
    editOverlay.setPosition(e.coordinate);
    editPopupEl.hidden = false;
  });
}

/** 供其他模組（例如免開關落點探針 identifyPin.js）查詢目前是否有
 * 繪圖工具啟用中，避免兩者互相搶點擊事件。 */
export function isDrawToolActive(){ return !!currentTool; }

/** main.js 啟動流程呼叫一次即可。 */
export function initDrawTool(){
  vectorSource = new ol.source.Vector();
  vectorLayer = new ol.layer.Vector({
    source: vectorSource,
    style: featureStyleFn,
    zIndex: 50 // 蓋在所有底圖／歷史圖層之上
  });
  map.addLayer(vectorLayer);

  // 還原上次自動儲存的繪製內容（重新整理頁面／重新開網頁後接續使用），
  // 重用 importGeoJSON() 既有的防呆邏輯（沒有 kind／SimpleStyle 顏色屬性
  // 就自動補上），不需要另外寫一套還原用的解析程式碼。
  const savedFeatureCollection = loadUserFeatures();
  if(savedFeatureCollection) importGeoJSON(savedFeatureCollection);

  modifyInteraction = new ol.interaction.Modify({ source: vectorSource });
  selectInteraction = new ol.interaction.Select();

  toolbarEl = document.getElementById('drawToolbar');
  toolbarEl.querySelectorAll('.draw-tool-btn[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });
  document.getElementById('drawDeleteBtn').addEventListener('click', deleteSelected);
  document.getElementById('drawClearBtn').addEventListener('click', clearAll);
  document.getElementById('drawExportGeoJSONBtn').addEventListener('click', exportGeoJSON);
  document.getElementById('drawExportImageBtn').addEventListener('click', exportImage);

  document.getElementById('drawImportGeoJSONBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('drawImportFileInput').click();
  });
  document.getElementById('drawImportFileInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = () => importGeoJSON(reader.result);
    reader.readAsText(file);
    e.target.value = '';
  });

  initColorPalette();
  initFeatureEditPopup();

  toggleBtn = document.getElementById('drawToggleBtn');
  toggleBtn.addEventListener('click', () => setToolbarOpen(!toolbarOpen));
}
