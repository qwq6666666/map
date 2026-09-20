/* ---------------------------------------------------------
   ui/trackListUI.js — 「我的軌跡」列表抽屜
   ---------------------------------------------------------
   記錄下來的路線與匯入的軌跡都在這裡管理：顯示／隱藏在地圖上、飛到該軌跡、
   匯出 GPX／GeoJSON、存成繪圖圖形、改名、刪除；也從這裡匯入 GPX／GeoJSON。
   抽屜殼直接沿用使用指南／來源狀態的 .guide-drawer*（見 sourceStatusUI.js），
   內容是 .track-list-*／.track-item-*。
   軌跡名稱可能來自匯入的檔案（不可信內容），所以整個抽屜一律用
   createElement＋textContent 組 DOM，不經 innerHTML。
   記錄進行中每秒都有新點：列表不整個重畫（使用者手指底下的按鈕會被換掉），
   只原地更新「記錄中那一條」的統計文字；開始／結束記錄這種結構變化才重畫。
--------------------------------------------------------- */
import {
  listAllTracks, addImportedTracks, renameTrack, discardTrack, isRecordingTrack,
  onTrackChange, getTrackStatus
} from '../features/trackRecorder.js';
import { showTrack, hideTrack, isTrackShown, zoomToTrack, colorForTrack } from '../features/trackLayer.js';
import { parseTrackFile, TRACK_IMPORT_MAX_BYTES } from '../features/trackImport.js';
import {
  trackDistance, trackDurationMs, trackPointCount, formatDistance, formatDuration, formatTrackDate,
  trackToDrawingGeoJSON
} from '../features/trackMath.js';
import { importGeoJSON } from '../drawTool.js';
import { showLocateToast } from '../features/location.js';
import { showAlert, showConfirm, showPrompt } from './dialog.js';
import { exportTrackFile } from './trackExport.js';
import { removeDrawerAnimated } from './drawerClose.js';

function el(tag, className, text){
  const node = document.createElement(tag);
  if(className) node.className = className;
  if(text !== undefined) node.textContent = text;
  return node;
}

function iconSvg(symbol){
  // 固定字串（本站 sprite），不含任何使用者內容，可以用 innerHTML。
  const span = el('span');
  span.innerHTML = `<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#${symbol}"></use></svg>`;
  return span.firstChild ?? span;
}

function metaText(track){
  const parts = [formatTrackDate(track.startedAt), formatDistance(trackDistance(track))];
  const ms = trackDurationMs(track);
  if(ms > 0) parts.push(formatDuration(ms));
  return parts.join(' · ');
}

function actionButton(label, onClick, { className = '', title = '', disabled = false } = {}){
  const btn = el('button', `track-item-btn ${className}`.trim(), label);
  btn.type = 'button';
  if(title) btn.title = title;
  btn.disabled = disabled;
  btn.addEventListener('click', onClick);
  return btn;
}

async function readImportFiles(files){
  const imported = [];
  const problems = [];
  for(const file of files){
    if(file.size > TRACK_IMPORT_MAX_BYTES){
      problems.push(`「${file.name}」檔案太大（上限 ${Math.round(TRACK_IMPORT_MAX_BYTES / 1024 / 1024)} MB）。`);
      continue;
    }
    let text;
    try{
      text = await file.text();
    }catch{
      problems.push(`「${file.name}」讀取失敗。`);
      continue;
    }
    const { tracks, error } = parseTrackFile(file.name, text);
    if(error) problems.push(`「${file.name}」${error}`);
    else imported.push(...tracks);
  }
  return { imported, problems };
}

function buildDrawer(){
  const overlay = el('div', 'guide-drawer-overlay');
  const drawer = el('div', 'guide-drawer track-list-drawer');
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-modal', 'true');

  const header = el('div', 'guide-drawer-header');
  const title = el('h2', 'guide-drawer-title');
  title.appendChild(iconSvg('pin'));
  title.appendChild(el('span', '', ' 我的軌跡'));
  const closeBtn = el('button', 'guide-drawer-close');
  closeBtn.type = 'button';
  closeBtn.title = '關閉';
  closeBtn.setAttribute('aria-label', '關閉');
  closeBtn.appendChild(iconSvg('close'));
  header.appendChild(title);
  header.appendChild(closeBtn);

  const body = el('div', 'guide-drawer-body');
  body.appendChild(el('p', 'track-list-intro',
    '記錄下來的路線與匯入的軌跡都在這裡。按「顯示」就會畫在地圖上，可以疊在歷史地圖上比對；資料只存在這台裝置的瀏覽器裡。'));

  const importRow = el('div', 'track-list-import-row');
  const importBtn = el('button', 'track-list-import', '匯入 GPX／GeoJSON…');
  importBtn.type = 'button';
  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.accept = '.gpx,.geojson,.json,.xml,application/gpx+xml,application/geo+json,application/json,text/xml,application/xml';
  fileInput.multiple = true;
  fileInput.hidden = true;
  importRow.appendChild(importBtn);
  importRow.appendChild(fileInput);
  body.appendChild(importRow);

  const listEl = el('div', 'track-list');
  body.appendChild(listEl);
  drawer.appendChild(header);
  drawer.appendChild(body);

  let renderToken = 0;
  let lastRecording = getTrackStatus().recording;

  function close(){
    unsubscribe();
    document.removeEventListener('keydown', onKeydown);
    removeDrawerAnimated(overlay, drawer);
  }
  function onKeydown(e){ if(e.key === 'Escape') close(); }

  function buildItem(track){
    const recording = isRecordingTrack(track.id);
    const item = el('div', 'track-item');
    item.dataset.id = track.id;
    if(recording) item.dataset.recording = 'true';

    const head = el('div', 'track-item-head');
    const swatch = el('span', 'track-item-swatch');
    swatch.style.background = colorForTrack(track.id);
    const name = el('span', 'track-item-name', track.name);
    head.appendChild(swatch);
    head.appendChild(name);
    if(recording) head.appendChild(el('span', 'track-item-badge recording', '記錄中'));
    else if(track.imported) head.appendChild(el('span', 'track-item-badge', '匯入'));
    item.appendChild(head);
    item.appendChild(el('div', 'track-item-meta', metaText(track)));

    const canDraw = trackPointCount(track) > 1;
    const shown = recording || isTrackShown(track.id);
    const toggle = actionButton(shown ? '隱藏' : '顯示', () => {
      if(isTrackShown(track.id)) hideTrack(track.id);
      else showTrack(track);
      const nowShown = isTrackShown(track.id);
      toggle.textContent = nowShown ? '隱藏' : '顯示';
      toggle.setAttribute('aria-pressed', nowShown ? 'true' : 'false');
    }, { className: 'primary', disabled: recording, title: recording ? '記錄中的軌跡一律顯示在地圖上' : '' });
    toggle.setAttribute('aria-pressed', shown ? 'true' : 'false');

    const actions = el('div', 'track-item-actions');
    actions.appendChild(toggle);
    actions.appendChild(actionButton('定位', () => {
      if(!isTrackShown(track.id)) showTrack(track);
      if(zoomToTrack(track)) close();
      else showLocateToast('這條軌跡還沒有可以定位的點');
    }, { disabled: !canDraw, title: '地圖飛到這條軌跡' }));
    actions.appendChild(actionButton('GPX', () => exportTrackFile(track, 'gpx'), { disabled: !canDraw, title: '存成 GPX 檔' }));
    actions.appendChild(actionButton('GeoJSON', () => exportTrackFile(track, 'geojson'), { disabled: !canDraw, title: '存成 GeoJSON 檔' }));
    actions.appendChild(actionButton('存成繪圖', () => {
      const count = importGeoJSON(trackToDrawingGeoJSON(track, colorForTrack(track.id)));
      showLocateToast(count > 0
        ? `已存成 ${count} 條繪圖線條，可以在繪圖工具中編輯、改色、匯出`
        : '這條軌跡沒有可以轉換的線段');
    }, { disabled: !canDraw, title: '轉成繪圖工具的線條，之後可以編輯、改色，並隨繪圖一起匯出' }));
    actions.appendChild(actionButton('改名', async () => {
      const next = await showPrompt('軌跡名稱', { title: '重新命名', defaultValue: track.name, maxLength: 60 });
      if(next !== null && await renameTrack(track.id, next)) render();
    }));
    actions.appendChild(actionButton('刪除', async () => {
      const ok = await showConfirm(`確定刪除「${track.name}」？刪除後無法復原。`, { title: '刪除軌跡', confirmText: '刪除', danger: true });
      if(ok && await discardTrack(track.id)) render();
    }, { className: 'danger', disabled: recording, title: recording ? '請先結束記錄再刪除' : '' }));
    item.appendChild(actions);
    return item;
  }

  async function render(){
    const token = ++renderToken;
    const tracks = await listAllTracks();
    if(token !== renderToken) return; // 期間又重畫過，這次結果作廢
    while(listEl.children?.length) listEl.removeChild(listEl.children[0]);
    if(!tracks.length){
      listEl.appendChild(el('p', 'track-list-empty', '還沒有軌跡。到「⋯ 更多」→「記錄軌跡」開始記錄，或用上面的按鈕匯入 GPX／GeoJSON。'));
      return;
    }
    tracks.forEach((t) => listEl.appendChild(buildItem(t)));
  }

  importBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const files = [...(fileInput.files || [])];
    fileInput.value = ''; // 之後選同一個檔案也要能再觸發 change
    if(!files.length) return;
    const { imported, problems } = await readImportFiles(files);
    if(imported.length){
      await addImportedTracks(imported);
      showLocateToast(`已匯入 ${imported.length} 條軌跡並顯示在地圖上`);
      render();
    }
    if(problems.length) await showAlert(`有檔案沒有匯入：\n${problems.join('\n')}`, { title: '匯入失敗' });
  });

  // 記錄進行中：只原地更新那一條的統計文字；開始／結束記錄才整個重畫。
  const unsubscribe = onTrackChange((status) => {
    if(status.recording !== lastRecording){
      lastRecording = status.recording;
      render();
      return;
    }
    if(!status.recording) return;
    const liveMeta = listEl.querySelector?.('.track-item[data-recording] .track-item-meta');
    if(liveMeta) liveMeta.textContent = `${formatDistance(status.distanceMeters)} · ${formatDuration(status.durationMs)}`;
  });

  overlay.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', onKeydown);
  render();
  return { overlay, drawer };
}

export function openTrackListDrawer(){
  if(document.querySelector('.track-list-drawer')) return; // 已經開著（連點）
  const { overlay, drawer } = buildDrawer();
  document.body.appendChild(overlay);
  document.body.appendChild(drawer);
}

/** main.js 啟動流程呼叫一次。入口是「⋯ 更多」選單的 #trackListBtn（手機浮動選單轉發 click 過來）。 */
export function initTrackListUI(){
  document.getElementById('trackListBtn')?.addEventListener('click', openTrackListDrawer);
}
