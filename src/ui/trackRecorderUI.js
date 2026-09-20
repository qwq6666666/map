/* ---------------------------------------------------------
   ui/trackRecorderUI.js — 「記錄軌跡」「匯出軌跡」按鈕與狀態條
   ---------------------------------------------------------
   同一功能有兩組入口：「⋯ 更多」選單（#trackRecordBtn／#trackExport*Btn，
   真正綁事件的只有這組）與手機版「地圖工具」浮動選單（由
   ui/mobileLayout.js 轉發 click 給前者）。兩組都用 data-track-record／
   data-track-record-label／data-track-export 標記，文字、active、顯示與否
   在這裡一次同步。地圖上另有一條狀態條（#trackRecordStatus），記錄中隨時
   看得到「正在記錄」——位置是隱私資料，不能讓使用者忘了自己開著。
--------------------------------------------------------- */
import {
  initTrackRecorder, startRecording, stopRecording, resumeRecording, finishSavedTrack,
  discardTrack, onTrackChange, getTrackStatus, getCurrentTrack
} from '../features/trackRecorder.js';
import {
  trackToGpx, trackToGeoJSON, trackFileStamp, trackPointCount, trackDistance, trackDurationMs,
  formatDistance, formatDuration
} from '../features/trackMath.js';
import { shareFileNative } from '../features/nativeShare.js';
import { showLocateToast } from '../features/location.js';
import { downloadBlob } from '../drawTool.js';
import { showConfirm } from './dialog.js';

const FORMATS = {
  gpx: { ext: 'gpx', type: 'application/gpx+xml', build: (t) => trackToGpx(t) },
  geojson: { ext: 'geojson', type: 'application/geo+json', build: (t) => JSON.stringify(trackToGeoJSON(t)) }
};

function summarize(status){
  return `${formatDistance(status.distanceMeters)} · ${formatDuration(status.durationMs)}`;
}

let weakToastShown = false;

function render(status){
  document.querySelectorAll('[data-track-record-label]').forEach((el) => {
    el.textContent = status.recording ? '結束記錄軌跡' : '記錄軌跡';
  });
  document.querySelectorAll('[data-track-record]').forEach((el) => {
    el.classList.toggle('active', status.recording);
    el.setAttribute('aria-pressed', status.recording ? 'true' : 'false');
  });
  document.querySelectorAll('[data-track-export]').forEach((el) => { el.hidden = !status.canExport; });

  const bar = document.getElementById('trackRecordStatus');
  const text = document.getElementById('trackRecordStatusText');
  if(bar && text){
    bar.hidden = !status.recording;
    text.textContent = status.weakSignal
      ? '記錄中（定位不夠準，暫時沒有記到點）'
      : `記錄中 · ${summarize(status)}`;
    bar.classList.toggle('weak', status.weakSignal);
  }

  // 電腦與室內常常一路精度不足：整段都不會記到東西，要明講，別讓使用者以為在記。
  if(status.weakSignal && !weakToastShown){
    weakToastShown = true;
    showLocateToast('目前定位精度不足（電腦或室內常見），這些點不會被記錄。到戶外有 GPS 訊號的地方會比較準。');
  }
  if(!status.recording) weakToastShown = false;
}

async function exportTrack(format){
  const track = getCurrentTrack();
  const spec = FORMATS[format];
  if(!track || trackPointCount(track) < 2 || !spec){
    showLocateToast('還沒有可以匯出的軌跡（至少要記到兩個點）');
    return;
  }
  const filename = `軌跡_${trackFileStamp(track.startedAt)}.${spec.ext}`;
  const text = spec.build(track);

  // 手機優先叫出系統分享面板（iOS 下載檔案很不順）；分享不成、環境不支援就退回下載。
  if(globalThis.matchMedia?.('(max-width: 768px)')?.matches && typeof File !== 'undefined'){
    const result = await shareFileNative(new File([text], filename, { type: spec.type }), { title: track.name });
    if(result === 'shared' || result === 'cancelled') return;
  }
  downloadBlob(new Blob([text], { type: spec.type }), filename);
  showLocateToast(`已下載 ${filename}`);
}

async function onRecordClick(){
  if(getTrackStatus().recording){
    await stopRecording();
    const s = getTrackStatus();
    showLocateToast(s.canExport
      ? `已結束記錄（${summarize(s)}），可到「⋯ 更多」匯出軌跡`
      : '已結束記錄（沒有記到足夠的點）');
    return;
  }
  if(!navigator.geolocation?.watchPosition){
    showLocateToast('您的瀏覽器不支援定位功能。');
    return;
  }
  startRecording();
  showLocateToast('開始記錄軌跡。請保持這個頁面在前景，螢幕鎖定或切到別的 App 時瀏覽器會暫停定位。');
}

// 上次記錄到一半就被關掉（沒按結束）：問要不要接續，不接續也會保留下來，不默默丟掉使用者的資料。
async function offerResume(saved){
  if(getTrackStatus().recording) return; // 載入儲存的那幾毫秒內使用者已經自己開始新的記錄
  if(trackPointCount(saved) === 0){
    await discardTrack(saved.id);
    return;
  }
  const info = `${formatDistance(trackDistance(saved))} · ${formatDuration(trackDurationMs(saved))}`;
  const resume = await showConfirm(
    `上次記錄的軌跡（${info}）沒有正常結束。\n要接續記錄嗎？選「結束並保留」會把它存起來，之後可以匯出。`,
    { title: '接續上次的軌跡？', confirmText: '接續記錄', cancelText: '結束並保留' }
  );
  if(resume) resumeRecording(saved);
  else await finishSavedTrack(saved);
}

/** main.js 啟動流程呼叫一次（不需要 await：接續詢問的對話框會自己排隊顯示）。 */
export function initTrackRecorderUI(){
  document.getElementById('trackRecordBtn')?.addEventListener('click', onRecordClick);
  // 真正綁事件的只有「⋯ 更多」選單那組（手機浮動選單由 mobileLayout.js 轉發 click 過來）。
  document.getElementById('trackExportGpxBtn')?.addEventListener('click', () => exportTrack('gpx'));
  document.getElementById('trackExportGeoJsonBtn')?.addEventListener('click', () => exportTrack('geojson'));
  onTrackChange(render);
  render(getTrackStatus());

  return initTrackRecorder().then((latest) => {
    if(latest && !latest.done) return offerResume(latest);
    return undefined;
  });
}
