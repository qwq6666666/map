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

let vectorSource = null;
let vectorLayer = null;
let modifyInteraction = null;
let selectInteraction = null;
let activeDrawInteraction = null;
let currentTool = null;
let toolbarEl = null;
let toggleBtn = null;
let toolbarOpen = false;

const ACCENT = '#A63D2F';   // 沿用網站的印章紅（--stamp）
const ACCENT_FILL = 'rgba(166,61,47,0.15)';
const INK = '#17211D';
const PAPER = '#EAE3D3';

function formatLength(meters){
  if(meters >= 1000) return `${(meters / 1000).toFixed(2)} 公里`;
  return `${meters.toFixed(1)} 公尺`;
}

function formatArea(sqMeters){
  if(sqMeters >= 1000000) return `${(sqMeters / 1000000).toFixed(2)} 平方公里`;
  if(sqMeters >= 10000) return `${(sqMeters / 10000).toFixed(2)} 公頃`;
  return `${sqMeters.toFixed(1)} 平方公尺`;
}

// 依圖形種類（點／線／面）決定畫在地圖上的樣式，點跟線／面都會把
// feature.get('label') 的文字（點的說明、或線／面自動算出的長度／
// 面積）顯示在圖形旁邊。
function featureStyleFn(feature){
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
    return new ol.style.Style({
      image: new ol.style.Circle({
        radius: 7,
        fill: new ol.style.Fill({ color: ACCENT }),
        stroke: new ol.style.Stroke({ color: PAPER, width: 2 })
      }),
      text: textStyle
    });
  }
  return new ol.style.Style({
    stroke: new ol.style.Stroke({ color: ACCENT, width: 3 }),
    fill: new ol.style.Fill({ color: ACCENT_FILL }),
    image: new ol.style.Circle({ radius: 5, fill: new ol.style.Fill({ color: ACCENT }) }), // 線的端點／面的頂點
    text: textStyle
  });
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
  });
  map.addInteraction(activeDrawInteraction);
}

function deleteSelected(){
  if(!selectInteraction) return;
  const selected = selectInteraction.getFeatures();
  selected.forEach(f => vectorSource.removeFeature(f));
  selected.clear();
}

function clearAll(){
  if(!confirm('確定要清除全部繪製內容嗎？這個動作無法復原。')) return;
  vectorSource.clear();
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

/** main.js 啟動流程呼叫一次即可。 */
export function initDrawTool(){
  vectorSource = new ol.source.Vector();
  vectorLayer = new ol.layer.Vector({
    source: vectorSource,
    style: featureStyleFn,
    zIndex: 50 // 蓋在所有底圖／歷史圖層之上
  });
  map.addLayer(vectorLayer);

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

  toggleBtn = document.getElementById('drawToggleBtn');
  toggleBtn.addEventListener('click', () => setToolbarOpen(!toolbarOpen));
}
