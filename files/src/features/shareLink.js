/* ---------------------------------------------------------
   features/shareLink.js — 分享連結功能
   ---------------------------------------------------------
   把目前畫面狀態（模式／底圖／疊圖圖層／比對模式左右圖層與分隔線／
   複合疊圖清單、地圖中心點與縮放）編碼進 URL query string，讓使用者
   複製連結分享給別人、對方打開連結時還原同一個畫面。

   只負責「編碼／解碼＋寫回 store／地圖視角」這件事本身，不碰任何
   DOM（複製成功/失敗的提示由呼叫端的按鈕自行決定要怎麼顯示）。
--------------------------------------------------------- */
import { state, setState } from '../store.js';
import { map } from '../core/map.js';
import { DATA, findLayerById } from '../data.js';

const DEFAULT_MODE = 'overlay';
const DEFAULT_BASE = 'osm';
const DEFAULT_SWIPE = 50;
const DEFAULT_CENTER_LONLAT = [120.9, 23.7]; // 對應 core/map.js 的初始 View 中心點
const DEFAULT_ZOOM = 8;
const COORD_DECIMALS = 5; // 約 1 公尺精度，足夠還原畫面又不會讓網址過長
const ZOOM_DECIMALS = 2;

const VALID_MODES = ['overlay', 'compare', 'timeline', 'multi'];

function round(n, decimals){
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

// 判斷一個圖層 key 是否「現在真的能用」：底圖一律合法；'hist:' 開頭要
// 查 DATA.LAYER_SOURCES 確認來源與圖層都還存在；'custom:' 開頭一律視為
// 不合法（使用者自訂圖層只存在對方自己的 localStorage，別人的分享連結
// 打不開），其餘格式一律不合法。
function isValidLayerKey(key){
  if(!key) return false;
  if(key === 'base:osm' || key === 'base:sat') return true;
  if(key.startsWith('custom:')) return false;
  if(key.startsWith('hist:')){
    const parts = key.split(':'); // ["hist", sourceId, id, fmt]
    if(parts.length < 3) return false;
    const src = DATA.LAYER_SOURCES.find(s => s.id === parts[1]);
    if(!src) return false;
    return !!findLayerById(src, parts[2]);
  }
  return false;
}

function clampInt(n, min, max){
  if(!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// 解析 "key1,opacity1;key2,opacity2" 格式；每一筆各自驗證 key、
// opacity 一律 clamp 到 0~100 的整數，單筆壞掉只跳過那一筆，不影響其他筆。
function parseMultiParam(raw){
  if(!raw) return [];
  return raw.split(';').map(entry => {
    const [key, opacityStr] = entry.split(',');
    if(!isValidLayerKey(key)) return null;
    const opacityNum = Number(opacityStr);
    const opacity = Number.isFinite(opacityNum) ? clampInt(opacityNum, 0, 100) : 100;
    return { key, opacity };
  }).filter(Boolean);
}

/* ---------------------------------------------------------
   buildShareURL() — 把目前狀態編碼成完整分享網址
--------------------------------------------------------- */
export function buildShareURL(){
  const params = new URLSearchParams();

  if(state.mode !== DEFAULT_MODE) params.set('mode', state.mode);
  if(state.baseLayer !== DEFAULT_BASE) params.set('base', state.baseLayer);
  // overlay/cmpA/cmpB 只要有值就寫，不跟預設值比較（compareA/compareB
  // 在 store 一律有預設 key，若比對預設會讓比對模式分享出去的連結漏帶資訊）。
  if(state.activeOverlayKey) params.set('overlay', state.activeOverlayKey);
  if(state.compareA) params.set('cmpA', state.compareA);
  if(state.compareB) params.set('cmpB', state.compareB);
  if(state.swipePercent !== DEFAULT_SWIPE) params.set('swipe', String(state.swipePercent));
  if(state.multiOverlayLayers.length > 0){
    params.set('multi', state.multiOverlayLayers.map(e => `${e.key},${e.opacity}`).join(';'));
  }

  const view = map.getView();
  const center = view.getCenter();
  if(center){
    const [lon, lat] = ol.proj.toLonLat(center);
    const lonR = round(lon, COORD_DECIMALS);
    const latR = round(lat, COORD_DECIMALS);
    if(lonR !== DEFAULT_CENTER_LONLAT[0] || latR !== DEFAULT_CENTER_LONLAT[1]){
      params.set('lon', String(lonR));
      params.set('lat', String(latR));
    }
  }
  const zoom = view.getZoom();
  if(Number.isFinite(zoom)){
    const zoomR = round(zoom, ZOOM_DECIMALS);
    if(zoomR !== DEFAULT_ZOOM) params.set('zoom', String(zoomR));
  }

  const base = location.origin + location.pathname;
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/* ---------------------------------------------------------
   copyShareLink() — 產生分享網址並寫入剪貼簿
   navigator.clipboard 優先，失敗（或非安全上下文不存在）時退回
   document.execCommand('copy')。純粹回傳 boolean，不碰任何 DOM
   class，提示訊息交給呼叫端（按鈕）自己決定。
--------------------------------------------------------- */
export async function copyShareLink(){
  const text = buildShareURL();
  if(navigator.clipboard?.writeText){
    try{
      await navigator.clipboard.writeText(text);
      return true;
    }catch(err){
      console.warn('複製分享連結失敗，改用退回方案', err);
    }
  }
  try{
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }catch(err){
    console.warn('複製分享連結失敗', err);
    return false;
  }
}

/* ---------------------------------------------------------
   applyShareStateFromURL() — 解析 location.search 還原狀態
   完全沒有相關參數時直接 return false，不覆蓋使用者原本的預設狀態
   或 localStorage 還原的收藏/最近使用等其他欄位。每個欄位各自驗證，
   壞掉的欄位只跳過自己，不擋掉其他合法欄位的還原；要寫回 store 的
   欄位收集齊後只呼叫一次 setState()。
--------------------------------------------------------- */
export function applyShareStateFromURL(){
  const params = new URLSearchParams(location.search);
  const relevantKeys = ['mode', 'base', 'overlay', 'cmpA', 'cmpB', 'swipe', 'multi', 'lon', 'lat', 'zoom'];
  if(!relevantKeys.some(k => params.has(k))) return false;

  const patch = {};
  let applied = false;

  const mode = params.get('mode');
  if(mode && VALID_MODES.includes(mode)){ patch.mode = mode; applied = true; }

  const base = params.get('base');
  if(base === 'osm' || base === 'sat'){ patch.baseLayer = base; applied = true; }

  const overlay = params.get('overlay');
  if(isValidLayerKey(overlay)){ patch.activeOverlayKey = overlay; applied = true; }

  const swipeRaw = params.get('swipe');
  if(swipeRaw !== null){
    const n = Number(swipeRaw);
    if(Number.isFinite(n)){ patch.swipePercent = clampInt(n, 0, 100); applied = true; }
  }

  const multiRaw = params.get('multi');
  if(multiRaw !== null){
    const parsed = parseMultiParam(multiRaw);
    if(parsed.length > 0){ patch.multiOverlayLayers = parsed; applied = true; }
  }

  if(Object.keys(patch).length > 0) setState(patch);

  // compareA/compareB 刻意跟上面那批 patch 分開、晚一步用第二次 setState()
  // 寫入：modeManager.js 的 render() 一旦看到 changedKeys 有 'mode' 就只呼叫
  // applyModeTransition() 然後 return，不會在同一批裡處理 compareA/compareB；
  // 而切進比對模式的 enterCompareMode() 又會把 compareA 重設成目前疊圖模式
  // 的圖層，蓋掉分享連結原本要還原的左側圖層。分兩次呼叫，讓這次不含
  // 'mode' 的 setState 走個別欄位分支（applyCompareSide），才能真正蓋回
  // 分享連結指定的左右圖層。
  const comparePatch = {};
  const cmpA = params.get('cmpA');
  if(isValidLayerKey(cmpA)) comparePatch.compareA = cmpA;
  const cmpB = params.get('cmpB');
  if(isValidLayerKey(cmpB)) comparePatch.compareB = cmpB;
  if(Object.keys(comparePatch).length > 0){
    setState(comparePatch);
    applied = true;
  }

  if(params.has('lon') && params.has('lat')){
    const lon = Number(params.get('lon'));
    const lat = Number(params.get('lat'));
    if(Number.isFinite(lon) && Number.isFinite(lat)){
      map.getView().setCenter(ol.proj.fromLonLat([lon, lat]));
      applied = true;
    }
  }
  if(params.has('zoom')){
    const zoom = Number(params.get('zoom'));
    if(Number.isFinite(zoom)){
      map.getView().setZoom(zoom);
      applied = true;
    }
  }

  return applied;
}
