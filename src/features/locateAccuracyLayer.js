/* ---------------------------------------------------------
   features/locateAccuracyLayer.js — 定位精度圓圈
   ---------------------------------------------------------
   在藍點（locateMarker）底下畫一個半透明圓圈，半徑代表 GPS 回報的
   accuracy（公尺）：圓越大代表定位越不準，讓使用者一眼看出藍點的
   位置只是「大概在這個範圍內」，不是精確點位。跟 trackLayer.js
   一樣是獨立的向量圖層（同一份 map 單例，只建立一次）。

   半徑換算成地圖投影（EPSG:3857）座標交給呼叫端（location.js）用
   core/tileGeo.js 的 metersToMercatorRadius() 處理，這裡只管畫圖，
   不重複算一次緯度校正。
--------------------------------------------------------- */
import { map } from '../core/map.js';

// 比照 trackLayer.js（49）／drawTool 圖層（50）的慣例排在下方：精度圓圈
// 是背景輔助資訊，不該蓋過軌跡線或使用者正在畫的圖形。
const ACCURACY_Z_INDEX = 48;

const FILL_COLOR = 'rgba(47,111,237,0.15)';
const STROKE_COLOR = 'rgba(47,111,237,0.55)';

let layer = null;
let source = null;
let feature = null;
let style = null;

function ensureLayer(){
  if(layer) return;
  source = new ol.source.Vector();
  style = new ol.style.Style({
    fill: new ol.style.Fill({ color: FILL_COLOR }),
    stroke: new ol.style.Stroke({ color: STROKE_COLOR, width: 1.5 })
  });
  layer = new ol.layer.Vector({ source, zIndex: ACCURACY_Z_INDEX, style });
  map.addLayer(layer);
}

// coord 是已投影座標（EPSG:3857），radius 是投影座標系下的半徑（公尺）；
// radius <= 0（沒有精度資訊，或 metersToMercatorRadius() 判定不該畫）就
// 把圓圈藏起來，不留著上一筆定位的舊圓圈誤導使用者。
export function showAccuracyCircle(coord, radius){
  if(!(radius > 0)){
    hideAccuracyCircle();
    return;
  }
  ensureLayer();
  if(!feature){
    feature = new ol.Feature(new ol.geom.Circle(coord, radius));
    source.addFeature(feature);
  }else{
    const geometry = feature.getGeometry();
    geometry.setCenter(coord);
    geometry.setRadius(radius);
  }
}

export function hideAccuracyCircle(){
  if(!feature || !source) return;
  source.removeFeature(feature);
  feature = null;
}

// 測試用：清空狀態，不移除圖層本身（比照 trackLayer.js 的 _resetTrackLayerForTests()）。
export function _resetAccuracyCircleForTests(){
  hideAccuracyCircle();
}
