/* ---------------------------------------------------------
   features/trackRecorder.js — 軌跡記錄控制器
   ---------------------------------------------------------
   疊在既有「持續追蹤」（features/location.js）上：追蹤每收到一筆定位，
   這裡決定要不要記進軌跡。記錄跟追蹤三態（following／paused）互相獨立——
   拖曳地圖只是暫停「跟隨」，記錄照常進行；追蹤停止（含定位權限被拒）
   則記錄一併結束。記錄是獨立開關、預設關：位置是隱私資料，不能因為按了追蹤
   就默默存下來。

   濾點／分段規則在 trackMath.js（純函式）；這裡只管狀態、地圖上的折線、
   分批寫入 IndexedDB（每 FLUSH_EVERY_POINTS 點或 FLUSH_EVERY_MS，加上頁面
   被隱藏／關閉時），手機分頁被系統殺掉也不會整段消失。
   折線畫在獨立圖層（zIndex 49，繪圖圖層 50 之下），不混進繪圖圖層，才不會被
   「清除繪圖」誤刪。
--------------------------------------------------------- */
import { map } from '../core/map.js';
import { addTrackListener, ensureTracking } from './location.js';
import { classifyFix, defaultTrackName, trackDistance, trackDurationMs, trackPointCount } from './trackMath.js';
import { saveTrack, loadLatestTrack, deleteTrack } from './trackStore.js';

// 寫入不能等太久：重新整理/關閉分頁時 pagehide 裡才開始的 IndexedDB 寫入不保證來得及完成（實測 location.reload() 會丟），
// 所以最多只能丟掉最近這幾個點；切到背景（visibilitychange）那次寫入則很可靠。
const FLUSH_EVERY_POINTS = 10;
const FLUSH_EVERY_MS = 10000;
// 連續這麼多筆都被判成「跳點」，就當成是「上一個採用點才是離群值」，改從目前位置重新起一段，
// 否則第一個採用的點如果剛好是錯的，之後每個正確的點都會被當成跳點永遠丟掉。
const MAX_JUMP_STREAK = 3;
// 連續這麼多筆精度都不合格，就對使用者說明「這裡的定位不夠準、沒有記到東西」，而不是讓他以為在記錄。
const WEAK_SIGNAL_STREAK = 3;
const TRACK_Z_INDEX = 49;

let track = null;            // 最新的一條軌跡（記錄中、剛結束、或啟動時從儲存讀回來的）
let recording = false;
let lastGoodT = NaN;
let forceNewSegment = false; // 接續舊軌跡時，第一筆定位一定要另起一段
let jumpStreak = 0;
let inaccurateStreak = 0;   // 連續被判精度太差的筆數（電腦／室內會一路精度不足）
let dirty = 0;
let lastFlushAt = 0;
let hooksInstalled = false;

let layer = null;
let feature = null;
let segsXY = [];             // 已投影成地圖座標的各段，跟 track.segments 一一對應

const listeners = new Set();

export function onTrackChange(fn){
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(){
  for(const fn of listeners){
    try{ fn(getTrackStatus()); }catch(err){ console.error('軌跡狀態監聽器失敗', err); }
  }
}

export function getTrackStatus(){
  return {
    recording,
    weakSignal: recording && inaccurateStreak >= WEAK_SIGNAL_STREAK,
    hasTrack: !!track && trackPointCount(track) > 0,
    canExport: !!track && trackPointCount(track) > 1,
    distanceMeters: track ? trackDistance(track) : 0,
    durationMs: track ? trackDurationMs(track) : 0,
    pointCount: track ? trackPointCount(track) : 0
  };
}

export function getCurrentTrack(){ return track; }

/* ---------- 地圖上的折線 ---------- */

function ensureLayer(){
  if(layer) return;
  feature = new ol.Feature(new ol.geom.MultiLineString([]));
  layer = new ol.layer.Vector({
    source: new ol.source.Vector({ features: [feature] }),
    zIndex: TRACK_Z_INDEX,
    style: [
      new ol.style.Style({ stroke: new ol.style.Stroke({ color: '#ffffff', width: 7, lineCap: 'round', lineJoin: 'round' }) }),
      new ol.style.Style({ stroke: new ol.style.Stroke({ color: '#d9480f', width: 4, lineCap: 'round', lineJoin: 'round' }) })
    ]
  });
  map.addLayer(layer);
}

function redrawLine(){
  ensureLayer();
  // 單點的段畫不成線，OpenLayers 對只有一個座標的 LineString 行為不定，直接略過。
  feature.getGeometry().setCoordinates(segsXY.filter((seg) => seg.length > 1));
}

function rebuildProjection(){
  segsXY = track.segments.map((seg) => seg.map(([lon, lat]) => ol.proj.fromLonLat([lon, lat])));
}

/* ---------- 寫入儲存 ---------- */

function flush(){
  dirty = 0;
  lastFlushAt = Date.now();
  return track ? saveTrack(track) : Promise.resolve(true);
}

/* ---------- 每筆追蹤定位 ---------- */

function handleFix(pos){
  if(!recording || !track) return;
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
  const t = Number.isFinite(pos.timestamp) ? pos.timestamp : Date.now();
  const segs = track.segments;
  const curSeg = forceNewSegment ? null : segs[segs.length - 1];
  const last = curSeg?.length ? curSeg[curSeg.length - 1] : null;

  let verdict = classifyFix(last, lastGoodT, { lon, lat, accuracy, t });
  if(verdict === 'inaccurate'){
    if(++inaccurateStreak === WEAK_SIGNAL_STREAK) emit();
    return;
  }
  const wasWeak = inaccurateStreak >= WEAK_SIGNAL_STREAK;
  inaccurateStreak = 0;
  if(wasWeak) emit();
  lastGoodT = t; // 精度合格就算「有訊號」，即使這點因為原地不動被略過，也不該被當成中斷
  if(verdict === 'jump'){
    if(++jumpStreak < MAX_JUMP_STREAK) return;
    verdict = 'newSegment';
  }
  jumpStreak = 0;
  if(verdict === 'still') return;

  if(verdict === 'newSegment'){
    segs.push([]);
    segsXY.push([]);
    forceNewSegment = false;
  }
  segs[segs.length - 1].push([lon, lat, t, Number.isFinite(accuracy) ? Math.round(accuracy) : null]);
  segsXY[segsXY.length - 1].push(ol.proj.fromLonLat([lon, lat]));
  redrawLine();

  if(++dirty >= FLUSH_EVERY_POINTS || Date.now() - lastFlushAt >= FLUSH_EVERY_MS) flush();
  emit();
}

// 追蹤被停止（使用者關掉、或定位權限被拒）：記錄跟著結束並存檔。
function handleTrackingStopped(){
  if(recording) stopRecording();
}

/* ---------- 對外操作 ---------- */

export function startRecording(){
  if(recording) return;
  const now = Date.now();
  track = { id: `t${now}`, name: defaultTrackName(now), startedAt: now, endedAt: null, done: false, segments: [] };
  segsXY = [];
  recording = true;
  lastGoodT = NaN;
  forceNewSegment = false;
  jumpStreak = 0;
  inaccurateStreak = 0;
  ensureLayer();
  redrawLine();
  ensureTracking();
  flush();
  emit();
}

// 接續啟動時發現的未結束軌跡（頁面被關掉或系統殺掉）。之後第一筆定位另起一段，
// 中間離線的那段時間不會被一條直線連起來。
export function resumeRecording(saved){
  if(recording) return;
  track = { ...saved, done: false, endedAt: null };
  rebuildProjection();
  recording = true;
  lastGoodT = NaN;
  forceNewSegment = true;
  jumpStreak = 0;
  inaccurateStreak = 0;
  redrawLine();
  ensureTracking();
  flush();
  emit();
}

export function stopRecording(){
  if(!recording || !track) return Promise.resolve();
  recording = false;
  const segs = track.segments;
  const lastSeg = segs[segs.length - 1];
  track.endedAt = lastSeg?.length ? lastSeg[lastSeg.length - 1][2] : Date.now();
  track.done = true;
  const saved = flush();
  emit();
  return saved;
}

// 啟動時發現的未結束軌跡，使用者選「儲存」：直接標成完成。
export async function finishSavedTrack(saved){
  const segs = saved.segments;
  const lastSeg = segs[segs.length - 1];
  track = { ...saved, done: true, endedAt: lastSeg?.length ? lastSeg[lastSeg.length - 1][2] : saved.startedAt };
  await saveTrack(track);
  emit();
}

export async function discardTrack(id){
  await deleteTrack(id);
  if(track?.id === id){
    if(recording) recording = false;
    track = null;
    segsXY = [];
    if(layer) redrawLine();
    emit();
  }
}

/**
 * main.js 啟動流程呼叫一次。回傳啟動時從儲存讀到的最新軌跡（沒有＝null）：
 * 沒結束的由 UI 詢問接續／儲存／捨棄；已結束的先不畫在地圖上（重新整理
 * 就是乾淨的地圖），但保留下來讓匯出鈕可以用。
 */
export async function initTrackRecorder(){
  if(!hooksInstalled){
    hooksInstalled = true;
    addTrackListener({ onFix: handleFix, onStop: handleTrackingStopped });
    // 頁面被隱藏／關閉前把還沒寫入的點寫進去（手機切換 App、鎖屏、分頁被回收前的最後機會）。
    document.addEventListener('visibilitychange', () => {
      if(document.visibilityState === 'hidden' && dirty > 0) flush();
    });
    globalThis.addEventListener?.('pagehide', () => { if(dirty > 0) flush(); });
  }

  const latest = await loadLatestTrack();
  if(latest && !recording){
    track = latest;
    emit();
  }
  return latest;
}

// 測試用：重置模組內部狀態（不動已建立的圖層）。
export function _resetTrackRecorderForTests(){
  track = null; recording = false; lastGoodT = NaN; forceNewSegment = false;
  jumpStreak = 0; inaccurateStreak = 0; dirty = 0; lastFlushAt = 0; segsXY = []; listeners.clear();
}
