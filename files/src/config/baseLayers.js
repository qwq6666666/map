/* ---------------------------------------------------------
   config/baseLayers.js — 底圖來源設定
   ---------------------------------------------------------
   原本寫死在 core/map.js 的底圖（現代地圖／衛星影像）URL 樣板、
   縮放範圍與版權字串，集中放到這裡管理，方便之後新增其他底圖
   來源，也方便測試驗證設定結構。

   純資料設定檔，不依賴任何其他 src 模組。
--------------------------------------------------------- */

export const BASE_LAYERS = [
  {
    id: 'osm',
    name: '現代地圖',
    urlTemplate: null, // 使用 ol.source.OSM 內建圖磚來源，無自訂樣板
    minZoom: 0,
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors'
  },
  {
    id: 'sat',
    name: '衛星影像',
    urlTemplate: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    minZoom: 0,
    maxZoom: 21,
    attribution: 'Esri, Maxar, Earthstar Geographics'
  }
];

export function getBaseLayerConfig(id){
  return BASE_LAYERS.find(layer => layer.id === id);
}
