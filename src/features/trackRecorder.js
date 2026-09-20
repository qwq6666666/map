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
import { addTrackListener, ensureTracking } from './location.js';
import { classifyFix, defaultTrackName, trackDistance, trackDurationMs, trackPointCount } from './trackMath.js';
import { saveTrack, listTracks, deleteTrack } from './trackStore.js';
import { setTrackCoords, showTrack, hideTrack, projectSegments } from './trackLayer.js';

// 寫入不能等太久：重新整理/關閉分頁時 pagehide 裡才開始的 IndexedDB 寫入不保證來得及完成（實測 location.reload() 會丟），
// 所以最多只能丟掉最近這幾個點；切到背景（visibilitychange）那次寫入則很可靠。
const FLUSH_EVERY_POINTS = 10;
const FLUSH_EVERY_MS = 10000;
// 連續這麼多筆都被判成「跳點」，就當成是「上一個採用點才是離群值」，改從目前位置重新起一段，
// 否則第一個採用的點如果剛好是錯的，之後每個正確的點都會被當成跳點永遠丟掉。
const MAX_JUMP_STREAK = 3;
// 連續這麼多筆精度都不合格，就對使用者說明「這裡的定位不夠準、沒有記到東西」，而不是讓他以為在記錄。
const WEAK_SIGNAL_STREAK = 3;

let track = null;            // 正在記錄（或剛記錄完）的那一條；列表上其他軌跡不在這裡，直接讀儲存
let recording = false;
let lastGoodT = NaN;
let forceNewSegment = false; // 接續舊軌跡時，第一筆定位一定要另起一段
let jumpStreak = 0;
let inaccurateStreak = 0;   // 連續被判精度太差的筆數（電腦／室內會一路精度不足）
let dirty = 0;
let lastFlushAt = 0;
let hooksInstalled = false;

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
    distanceMeters: track ? trackDistance(track) : 0,
    durationMs: track ? trackDurationMs(track) : 0,
    pointCount: track ? trackPointCount(track) : 0
  };
}

export function getCurrentTrack(){ return track; }

/* ---------- 地圖上的折線（共用 trackLayer，記錄中的軌跡一律顯示） ---------- */

function redrawLine(){
  setTrackCoords(track.id, segsXY);
}

function rebuildProjection(){
  segsXY = projectSegments(track);
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

// 啟動時發現的未結束軌跡，使用者選「結束並保留」：直接標成完成。
export async function finishSavedTrack(saved){
  const segs = saved.segments;
  const lastSeg = segs[segs.length - 1];
  await saveTrack({ ...saved, done: true, endedAt: lastSeg?.length ? lastSeg[lastSeg.length - 1][2] : saved.startedAt });
  emit();
}

/* ---------- 軌跡庫（「我的軌跡」列表用；記錄中的那條以記憶體版本為準） ---------- */

export const isRecordingTrack = (id) => recording && track?.id === id;

// 全部軌跡，新的在前。記錄中的那條還有沒寫入儲存的點，用記憶體版本取代儲存裡的舊快照。
export async function listAllTracks(){
  const saved = await listTracks();
  const merged = track && !saved.some((t) => t.id === track.id) ? [track, ...saved] : saved;
  return merged
    .map((t) => (track && t.id === track.id ? track : t))
    .sort((a, b) => b.startedAt - a.startedAt);
}

// 匯入的軌跡直接存進儲存並顯示在地圖上（使用者剛匯入就是要看）。
export async function addImportedTracks(tracks){
  for(const t of tracks){
    await saveTrack(t);
    showTrack(t);
  }
  emit();
}

export async function renameTrack(id, name){
  const trimmed = String(name ?? '').trim();
  if(!trimmed) return false;
  if(track?.id === id){
    track.name = trimmed; // 記錄器之後的 flush 會寫整個 track，只改儲存的話下一次 flush 會把舊名字蓋回去
    await flush();
  } else {
    const saved = (await listTracks()).find((t) => t.id === id);
    if(!saved) return false;
    await saveTrack({ ...saved, name: trimmed });
  }
  emit();
  return true;
}

// 刪除一條軌跡（含地圖上的折線）。正在記錄的那條不能刪，要先結束記錄。
export async function discardTrack(id){
  if(isRecordingTrack(id)) return false;
  await deleteTrack(id);
  hideTrack(id);
  if(track?.id === id){
    track = null;
    segsXY = [];
  }
  emit();
  return true;
}

/**
 * main.js 啟動流程呼叫一次。回傳啟動時儲存裡「沒有正常結束」的那一條（沒有＝null），
 * 由 UI 詢問接續或結束並保留。已結束的軌跡一律不自動畫在地圖上（重新整理就是乾淨
 * 的地圖），要看再從「我的軌跡」打開。
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

  if(recording) return null; // 載入儲存的那幾毫秒內使用者已經自己開始新記錄
  return (await listTracks()).find((t) => !t.done) ?? null;
}

// 測試用：重置模組內部狀態（不動已建立的圖層）。
export function _resetTrackRecorderForTests(){
  track = null; recording = false; lastGoodT = NaN; forceNewSegment = false;
  jumpStreak = 0; inaccurateStreak = 0; dirty = 0; lastFlushAt = 0; segsXY = []; listeners.clear();
}
