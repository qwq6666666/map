/* ---------------------------------------------------------
   core/map.js — 地圖本體
   ---------------------------------------------------------
   從 mapCore.js 拆出來的「地圖本體」部分：OpenLayers Map／View
   實例、兩顆底圖（現代地圖／衛星影像）、底圖切換，以及跟「移動
   視角」有關但不算「目前應該顯示什麼」狀態的 flyToSourceExtent。

   這支模組不知道疊圖／比對／時間軸模式、不知道歷史圖層，只管
   「這是一張地圖，現在用哪張底圖」。
--------------------------------------------------------- */
import { state as store, setBaseLayer } from '../store.js';
import { REGION_EXTENTS } from '../data.js';
import { getBaseLayerConfig } from '../config/baseLayers.js';

const osmConfig = getBaseLayerConfig('osm');
const satConfig = getBaseLayerConfig('sat');

const osmLayer = new ol.layer.Tile({
  source: new ol.source.OSM({
    crossOrigin: 'anonymous',
    minZoom: osmConfig.minZoom,
    maxZoom: osmConfig.maxZoom
  }),
  visible: true
});
const satLayer = new ol.layer.Tile({
  source: new ol.source.XYZ({
    url: satConfig.urlTemplate,
    attributions: satConfig.attribution,
    crossOrigin: 'anonymous',
    minZoom: satConfig.minZoom,
    maxZoom: satConfig.maxZoom
  }),
  visible: false
});

export const map = new ol.Map({
  target: 'map',
  layers: [osmLayer, satLayer],
  view: new ol.View({
    center: ol.proj.fromLonLat([120.9, 23.7]),
    zoom: 8,
    // View 的縮放範圍取兩個底圖設定的聯集，確保切換底圖時都能用滿
    // 各自允許的縮放級距（實際圖磚可用範圍仍由各 Source 的
    // minZoom/maxZoom 限制，超出範圍時 OL 會 overzoom 既有圖磚）。
    minZoom: Math.min(osmConfig.minZoom, satConfig.minZoom),
    maxZoom: Math.max(osmConfig.maxZoom, satConfig.maxZoom)
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
   點擊展開「分類」時，把地圖移動到該分類涵蓋的地理範圍——目前只給
   日本／韓國／東南亞這幾個橫跨多個城市的來源用（分類＝城市，例如
   「函館」「釜山」「曼谷」，跟其他來源「分類＝地圖系列」不同，展開
   分類時飛到對應城市才有意義，見 sidebarUI.js 呼叫端的白名單）。
   分類本身沒有預先算好的 bbox，直接從底下每張圖層的 region.bbox
   （沿用 tools/fetch-wmts-bbox.js 寫入的資料）取聯集算出來，沒有任何
   圖層帶 bbox 時就不動作。
--------------------------------------------------------- */
export function flyToCategoryExtent(cat){
  if(!cat) return;
  const layers = cat.groups ? cat.groups.flatMap(g => g.layers) : cat.layers;
  const bboxes = (layers || []).map(l => l.region && l.region.bbox).filter(Boolean);
  if(bboxes.length === 0) return;
  const ext = bboxes.reduce((acc, b) => [
    Math.min(acc[0], b[0]), Math.min(acc[1], b[1]),
    Math.max(acc[2], b[2]), Math.max(acc[3], b[3])
  ], [...bboxes[0]]);
  const extent3857 = ol.proj.transformExtent(ext, 'EPSG:4326', 'EPSG:3857');
  map.getView().fit(extent3857, { duration:700, padding:[40,40,40,40], maxZoom:14 });
}

/* ---------------------------------------------------------
   底圖切換（疊圖／比對／時間軸模式共用）：click handler 只呼叫
   setBaseLayer()，真正切換 osmLayer/satLayer 可見度、同步按鈕
   高亮，統一由 store 訂閱者（core/modeManager.js 的 render()）
   呼叫 applyBaseLayer() 處理。
--------------------------------------------------------- */
export function initBaseSwitch(){
  document.getElementById('baseSwitch').addEventListener('click', (e)=>{
    const btn = e.target.closest('button[data-base]');
    if(!btn) return;
    setBaseLayer(btn.dataset.base);
  });
}

export function applyBaseLayer(){
  osmLayer.setVisible(store.baseLayer === 'osm');
  satLayer.setVisible(store.baseLayer === 'sat');
  document.querySelectorAll('#baseSwitch button').forEach(b=>
    b.classList.toggle('active', b.dataset.base === store.baseLayer));
}
