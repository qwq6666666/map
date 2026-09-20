/* ---------------------------------------------------------
   ui/trackRecorderUI.js — 「記錄軌跡」按鈕與狀態條
   ---------------------------------------------------------
   同一功能有兩組入口：「⋯ 更多」選單（#trackRecordBtn，真正綁事件的只有這顆）
   與手機版「地圖工具」浮動選單（由 ui/mobileLayout.js 轉發 click 給前者）。
   兩組都用 data-track-record／data-track-record-label 標記，文字與 active
   在這裡一次同步。匯出、改名、刪除等管理動作在「我的軌跡」列表
   （ui/trackListUI.js），不在這裡。地圖上另有一條狀態條（#trackRecordStatus），
   記錄中隨時看得到「正在記錄」——位置是隱私資料，不能讓使用者忘了自己開著；
   條上有「結束」鈕（#trackRecordStopBtn），不用開選單就能停。
--------------------------------------------------------- */
import {
  initTrackRecorder, startRecording, stopRecording, resumeRecording, finishSavedTrack,
  discardTrack, onTrackChange, getTrackStatus
} from '../features/trackRecorder.js';
import { trackPointCount, trackDistance, trackDurationMs, formatDistance, formatDuration } from '../features/trackMath.js';
import { showLocateToast } from '../features/location.js';
import { showConfirm } from './dialog.js';

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

async function onRecordClick(){
  if(getTrackStatus().recording){
    await stopRecording();
    const s = getTrackStatus();
    showLocateToast(s.pointCount > 1
      ? `已結束記錄（${summarize(s)}），可到「我的軌跡」匯出或存成繪圖圖形`
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
    `上次記錄的軌跡（${info}）沒有正常結束。\n要接續記錄嗎？選「結束並保留」會把它存起來，之後可以在「我的軌跡」找到。`,
    { title: '接續上次的軌跡？', confirmText: '接續記錄', cancelText: '結束並保留' }
  );
  if(resume) resumeRecording(saved);
  else await finishSavedTrack(saved);
}

/** main.js 啟動流程呼叫一次（不需要 await：接續詢問的對話框會自己排隊顯示）。 */
export function initTrackRecorderUI(){
  document.getElementById('trackRecordBtn')?.addEventListener('click', onRecordClick);
  // 狀態條上的「結束」：記錄中隨手就能停，不必開選單。狀態條只在記錄中才顯示，
  // 所以這裡點到一定是「結束」；仍走同一個函式，提示與行為跟選單那顆完全一致。
  document.getElementById('trackRecordStopBtn')?.addEventListener('click', onRecordClick);
  onTrackChange(render);
  render(getTrackStatus());

  return initTrackRecorder().then((unfinished) => (unfinished ? offerResume(unfinished) : undefined));
}
