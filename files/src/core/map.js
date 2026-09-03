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

const SAT_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

const osmLayer = new ol.layer.Tile({ source: new ol.source.OSM({ crossOrigin: 'anonymous' }), visible: true });
const satLayer = new ol.layer.Tile({
  source: new ol.source.XYZ({ url: SAT_URL, attributions: 'Esri, Maxar, Earthstar Geographics', crossOrigin: 'anonymous' }),
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
