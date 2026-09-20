/* ---------------------------------------------------------
   features/trackLayer.js — 軌跡在地圖上的折線圖層
   ---------------------------------------------------------
   一個向量圖層（zIndex 49，繪圖圖層 50 之下、歷史圖層之上）放所有「顯示中」的軌跡，
   每條軌跡一個 MultiLineString feature，顏色依軌跡 id 固定挑選（同一條軌跡每次
   顏色一樣，列表上的色塊才對得上地圖）。記錄器每收到一個點就用
   setTrackCoords() 更新（座標已投影、不重複投影整條）；列表面板顯示／隱藏其他
   軌跡用 showTrack()／hideTrack()。單點的段畫不成線，一律略過。
--------------------------------------------------------- */
import { map } from '../core/map.js';

const TRACK_Z_INDEX = 49;
export const TRACK_COLORS = ['#d9480f', '#1971c2', '#2f9e44', '#9c36b5', '#e67700', '#0c8599', '#c2255c'];

const LINE_CASING = '#ffffff';

let layer = null;
let source = null;
const features = new Map(); // trackId → ol.Feature
const styleCache = new Map();

// 依 id 雜湊挑色：不用「第幾條」，刪掉中間一條後其餘軌跡的顏色才不會跟著變。
export function colorForTrack(id){
  let h = 0;
  for(const ch of String(id)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return TRACK_COLORS[h % TRACK_COLORS.length];
}

function styleFor(color){
  if(!styleCache.has(color)){
    styleCache.set(color, [
      new ol.style.Style({ stroke: new ol.style.Stroke({ color: LINE_CASING, width: 7, lineCap: 'round', lineJoin: 'round' }) }),
      new ol.style.Style({ stroke: new ol.style.Stroke({ color, width: 4, lineCap: 'round', lineJoin: 'round' }) })
    ]);
  }
  return styleCache.get(color);
}

function ensureLayer(){
  if(layer) return;
  source = new ol.source.Vector();
  layer = new ol.layer.Vector({
    source,
    zIndex: TRACK_Z_INDEX,
    style: (feature) => styleFor(feature.get('color'))
  });
  map.addLayer(layer);
}

const drawable = (projectedSegs) => projectedSegs.filter((seg) => seg.length > 1);

// 座標必須已是地圖投影（EPSG:3857）。沒有這條軌跡的 feature 就新建。
export function setTrackCoords(id, projectedSegs){
  ensureLayer();
  let feature = features.get(id);
  if(!feature){
    feature = new ol.Feature(new ol.geom.MultiLineString(drawable(projectedSegs)));
    feature.set('color', colorForTrack(id));
    features.set(id, feature);
    source.addFeature(feature);
    return;
  }
  feature.getGeometry().setCoordinates(drawable(projectedSegs));
}

export const projectSegments = (track) => track.segments.map((seg) => seg.map(([lon, lat]) => ol.proj.fromLonLat([lon, lat])));

export function showTrack(track){
  setTrackCoords(track.id, projectSegments(track));
}

export function hideTrack(id){
  const feature = features.get(id);
  if(!feature) return;
  source.removeFeature(feature);
  features.delete(id);
}

export function isTrackShown(id){
  return features.has(id);
}

// 桌面版展開的側邊欄會蓋住地圖左側，軌跡不能飛到它底下：左邊界推到側邊欄右緣再多留一點
// （最多佔地圖寬度一半，避免視窗很窄時反而沒地方放）。手機版的側邊欄是底部的 Bottom Sheet，
// 由下方 padding 的底部處理；沒有側邊欄／已收合就用一般邊界。
const PADDING_TOP = 80;
const PADDING_SIDE = 60;
const PADDING_BOTTOM = 120;

function leftPadding(){
  const sidebar = document.getElementById('sidebar');
  const mobile = globalThis.matchMedia?.('(max-width: 768px)')?.matches;
  if(!sidebar || mobile || sidebar.classList?.contains('collapsed')) return PADDING_SIDE;
  const right = sidebar.getBoundingClientRect?.().right;
  if(!Number.isFinite(right) || right <= 0) return PADDING_SIDE;
  const width = map.getSize?.()?.[0];
  const wanted = Math.round(right) + 40;
  return Number.isFinite(width) ? Math.min(wanted, Math.round(width / 2)) : wanted;
}

// 讓地圖飛到整條軌跡。
export function zoomToTrack(track){
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for(const seg of projectSegments(track)){
    for(const [x, y] of seg){
      if(x < minX) minX = x;
      if(x > maxX) maxX = x;
      if(y < minY) minY = y;
      if(y > maxY) maxY = y;
    }
  }
  if(!Number.isFinite(minX)) return false;
  map.getView().fit([minX, minY, maxX, maxY], {
    padding: [PADDING_TOP, PADDING_SIDE, PADDING_BOTTOM, leftPadding()], maxZoom: 18, duration: 600
  });
  return true;
}

// 測試用：清空所有 feature（不移除圖層本身）。
export function _resetTrackLayerForTests(){
  features.clear();
  source?.clear?.();
}
