import '../env-stub.mjs';
import { test, expect, afterAll, beforeEach } from 'vitest';
import { map } from '../../src/core/map.js';
import { runtime } from '../../src/runtime.js';

// 假 document.addEventListener：env-stub 的是空實作，這裡記下 visibilitychange
// 監聽器，測試才能模擬「螢幕鎖定後回到頁面」。必須在呼叫 initLocateButton() 之前設好。
const docListeners = {};
document.addEventListener = (ev, fn) => { (docListeners[ev] = docListeners[ev] || []).push(fn); };

import {
  initLocateButton,
  nextTrackState,
  describeAccuracy,
  getTrackState
} from '../../src/features/location.js';

/* ---------- 假 geolocation／wakeLock／地圖視角 ---------- */

let watchCalls = 0;
let clearedIds = [];
let fixCb, errCb, watchOptions;
navigator.geolocation = {
  watchPosition(success, error, options){
    watchCalls++;
    fixCb = success; errCb = error; watchOptions = options;
    return 42;
  },
  clearWatch(id){ clearedIds.push(id); },
  getCurrentPosition(){}
};

let lockRequests = [];
let lockReleases = 0;
let lockReleaseListener;
navigator.wakeLock = {
  async request(kind){
    lockRequests.push(kind);
    return {
      addEventListener(ev, fn){ if(ev === 'release') lockReleaseListener = fn; },
      async release(){ lockReleases++; }
    };
  }
};

// 假視角：animate() 不會自己結束，測試用 finishAnimations() 模擬「動畫跑完」
// （OpenLayers 在動畫結束或被打斷時都會呼叫 callback）。animating 由 animate()
// 設成 true、finishAnimations() 設回 false，測試也可以直接設定它來模擬
// 「別人發起的動畫正在跑」。
const animateCalls = [];
let animateCallbacks = [];
let animating = false;
let zoom = 12;
let viewCenter = [0, 0];
map.getView = () => ({
  animate: (opts, cb) => { animateCalls.push(opts); if(cb) animateCallbacks.push(cb); animating = true; },
  getAnimating: () => animating,
  getZoom: () => zoom,
  getCenter: () => viewCenter,
  getResolution: () => 1 // 1 地圖單位＝1 像素，方便直接用座標差算像素
});
function finishAnimations(){
  animating = false;
  const cbs = animateCallbacks;
  animateCallbacks = [];
  cbs.forEach(cb => cb(true));
}

initLocateButton();
const trackBtn = document.getElementById('trackBtn');
const popup = document.getElementById('locatePopup');
const popupBody = document.getElementById('locatePopupBody');
const toast = document.getElementById('locateToast');

const fix = (lat, lon, accuracy) => ({ coords: { latitude: lat, longitude: lon, accuracy } });
const flush = () => new Promise(r => setTimeout(r, 0)); // 讓 acquireWakeLock 的 await 跑完

function popupText(){
  const parts = [];
  (function walk(n){ if(n.textContent) parts.push(n.textContent); (n.children || []).forEach(walk); })(popupBody);
  return parts.join('|');
}

// 每個案例開頭把狀態機重設成 off（追蹤中就按一下停止），並清空所有記錄。
beforeEach(() => {
  if(getTrackState() === 'paused') trackBtn.click(); // paused → following
  if(getTrackState() === 'following') trackBtn.click(); // following → off
  watchCalls = 0; clearedIds = []; lockRequests = []; lockReleases = 0;
  animateCalls.length = 0; animateCallbacks = []; animating = false; zoom = 12; viewCenter = [0, 0];
  popup.hidden = true;
  toast.textContent = '';
});

// showLocateToast() 會留下一顆 4.5 秒的真實計時器，收尾時清掉，不讓 Node process 多等。
afterAll(() => {
  if(runtime.locateToastTimer) clearTimeout(runtime.locateToastTimer);
});

/* ---------- 純函式 ---------- */

test('nextTrackState：toggle 在 off／paused 進入 following、following 回到 off', () => {
  expect(nextTrackState('off', 'toggle')).toBe('following');
  expect(nextTrackState('paused', 'toggle')).toBe('following');
  expect(nextTrackState('following', 'toggle')).toBe('off');
});

test('nextTrackState：只有 following 會因為使用者動地圖而變 paused；denied／stop 一律 off', () => {
  expect(nextTrackState('following', 'userMoved')).toBe('paused');
  expect(nextTrackState('off', 'userMoved')).toBe('off');
  expect(nextTrackState('paused', 'userMoved')).toBe('paused');
  ['off', 'following', 'paused'].forEach(s => {
    expect(nextTrackState(s, 'denied')).toBe('off');
    expect(nextTrackState(s, 'stop')).toBe('off');
  });
  expect(nextTrackState('following', 'unknown-event')).toBe('following');
});

test('describeAccuracy：四捨五入、超過 100 公尺標示訊號較弱、沒有數值回傳空字串', () => {
  expect(describeAccuracy(12.4)).toBe('精度 ±12 公尺');
  expect(describeAccuracy(100)).toBe('精度 ±100 公尺');
  expect(describeAccuracy(150)).toBe('精度 ±150 公尺（訊號較弱）');
  expect(describeAccuracy(undefined)).toBe('');
  expect(describeAccuracy(Number.NaN)).toBe('');
});

/* ---------- 開始／停止 ---------- */

test('按追蹤鈕：開始 watchPosition（高精度）、進入 following、要螢幕常亮、按鈕變成追蹤中', async () => {
  trackBtn.click();
  await flush();
  expect(watchCalls).toBe(1);
  expect(watchOptions.enableHighAccuracy).toBe(true);
  expect(getTrackState()).toBe('following');
  expect(trackBtn.classList.contains('tracking')).toBe(true);
  expect(trackBtn.getAttribute('aria-pressed')).toBe('true');
  expect(trackBtn.classList.contains('acquiring'), '等第一筆定位期間').toBe(true);
  expect(lockRequests).toEqual(['screen']);
  expect(toast.textContent).toContain('持續追蹤中');
});

test('再按一次：停止追蹤（clearWatch、釋放螢幕常亮、按鈕回到一般狀態）', async () => {
  trackBtn.click();
  await flush();
  trackBtn.click();
  expect(clearedIds).toEqual([42]);
  expect(lockReleases).toBe(1);
  expect(getTrackState()).toBe('off');
  expect(trackBtn.classList.contains('tracking')).toBe(false);
  expect(trackBtn.classList.contains('acquiring')).toBe(false);
  expect(trackBtn.getAttribute('aria-pressed')).toBe('false');
  expect(toast.textContent).toBe('已停止追蹤位置');
});

test('瀏覽器不支援 watchPosition：提示不支援、維持 off，不會開始追蹤', () => {
  const original = navigator.geolocation;
  navigator.geolocation = null;
  try{
    trackBtn.click();
    expect(getTrackState()).toBe('off');
    expect(toast.textContent).toContain('不支援');
  } finally { navigator.geolocation = original; }
});

/* ---------- 收到定位 ---------- */

test('第一筆定位：打開座標彈窗（含精度）、地圖飛過去並放大到至少 16 級；藍點外圈開始脈動', async () => {
  trackBtn.click();
  await flush();
  fixCb(fix(25.03, 121.56, 8));
  expect(popup.hidden).toBe(false);
  expect(popupText()).toContain('精度 ±8 公尺');
  expect(animateCalls.length).toBe(1);
  expect(animateCalls[0].center).toEqual([121.56, 25.03]);
  expect(animateCalls[0].zoom).toBe(16);
  expect(trackBtn.classList.contains('acquiring'), '收到定位後不再是等待狀態').toBe(false);
  expect(document.getElementById('locateMarker').classList.contains('tracking')).toBe(true);
});

test('已經比 16 級更近就保持原縮放，不會被拉遠', async () => {
  zoom = 18;
  trackBtn.click();
  await flush();
  fixCb(fix(25.03, 121.56, 8));
  expect(animateCalls[0].zoom).toBe(18);
});

test('後續定位：只移動地圖、不再指定縮放；使用者關掉彈窗後不會再跳出來，內容仍即時更新', async () => {
  trackBtn.click();
  await flush();
  fixCb(fix(25.03, 121.56, 8));
  popup.hidden = true; // 使用者關掉彈窗
  animateCalls.length = 0;
  fixCb(fix(25.031, 121.561, 150));
  expect(popup.hidden, '不該自己重新打開').toBe(true);
  expect(animateCalls.length).toBe(1);
  expect('zoom' in animateCalls[0]).toBe(false);
  expect(popupText()).toContain('訊號較弱');
});

test('複製按鈕複製的是「最新一筆」座標，不是建立那一列當下的舊座標', async () => {
  trackBtn.click();
  await flush();
  fixCb(fix(25.03, 121.56, 8));
  fixCb(fix(23.5, 120.5, 8));
  const written = [];
  navigator.clipboard = { writeText: (t) => { written.push(t); return Promise.resolve(); } };
  const copyBtns = [];
  (function walk(n){ if(n.className === 'coord-copy-btn') copyBtns.push(n); (n.children || []).forEach(walk); })(popupBody);
  copyBtns[0].click();
  delete navigator.clipboard;
  expect(written[0]).toContain('23.5');
});

/* ---------- 暫停跟隨 ---------- */

const startFollowing = async () => {
  trackBtn.click();
  await flush();
  fixCb(fix(25.03, 121.56, 8));
  finishAnimations();
  viewCenter = [121.56, 25.03]; // 動畫跑完，畫面中心就是定位點
  animateCalls.length = 0;
};

test('拖曳地圖（pointerdrag）：跟隨中立刻暫停；沒在追蹤時不影響狀態', async () => {
  map._trigger('pointerdrag');
  expect(getTrackState()).toBe('off');

  await startFollowing();
  map._trigger('pointerdrag');
  expect(getTrackState()).toBe('paused');
  expect(trackBtn.classList.contains('paused')).toBe(true);
  expect(trackBtn.classList.contains('tracking')).toBe(false);
});

test('自己的置中動畫結束時（畫面中心就是定位點）不會被 moveend 誤判成使用者移開', async () => {
  await startFollowing();
  map._trigger('moveend');
  expect(getTrackState()).toBe('following');
});

test('moveend：畫面中心離定位點超過 40 像素（滾輪縮放、鍵盤等）就暫停；40 像素以內不算', async () => {
  await startFollowing();
  viewCenter = [121.56 + 40, 25.03]; // 剛好 40 像素
  map._trigger('moveend');
  expect(getTrackState(), '40 像素以內不算移開').toBe('following');

  viewCenter = [121.56 + 41, 25.03];
  map._trigger('moveend');
  expect(getTrackState()).toBe('paused');
});

test('moveend 時地圖還有動畫在跑：不判斷（等動畫結束再說）', async () => {
  await startFollowing();
  viewCenter = [500, 500];
  animating = true;
  map._trigger('moveend');
  expect(getTrackState()).toBe('following');
});

test('收到定位時，如果地圖正被別人發起的動畫移動（例如地址搜尋飛到別處）：暫停跟隨、不搶回來', async () => {
  trackBtn.click();
  await flush();
  animating = true; // 不是我們發起的（追蹤剛開始、還沒有自己的動畫）
  fixCb(fix(25.03, 121.56, 8));
  expect(getTrackState()).toBe('paused');
  expect(animateCalls.length, '不該用自己的動畫蓋掉對方的').toBe(0);
});

test('收到定位時，正在跑的是我們自己上一筆的動畫：照常繼續跟隨（新動畫接手）', async () => {
  trackBtn.click();
  await flush();
  fixCb(fix(25.03, 121.56, 8)); // 自己的動畫開始、還沒結束
  fixCb(fix(25.031, 121.561, 8)); // 動畫還在跑時又來一筆
  expect(getTrackState()).toBe('following');
  expect(animateCalls.length).toBe(2);
});

test('動畫計數不會卡住：沒有任何動畫在跑時，就算之前的 callback 沒被呼叫，也照常跟隨', async () => {
  trackBtn.click();
  await flush();
  fixCb(fix(25.03, 121.56, 8)); // 動畫開始，但測試刻意不呼叫 callback
  animating = false; // 畫面上其實已經沒有動畫了
  fixCb(fix(25.031, 121.561, 8));
  expect(getTrackState()).toBe('following');
  expect(animateCalls.length).toBe(2);
});

test('追蹤中按一次性定位：那支置中動畫算自己的，下一筆定位不會因此暫停', async () => {
  await startFollowing();
  let oneShotSuccess = null;
  navigator.geolocation.getCurrentPosition = (ok) => { oneShotSuccess = ok; };
  document.getElementById('locateBtn').click();
  oneShotSuccess(fix(25.03, 121.56, 8));
  expect(animateCalls.length, '一次性定位的置中動畫').toBe(1);
  expect(animating).toBe(true);

  fixCb(fix(25.031, 121.561, 8));
  expect(getTrackState()).toBe('following');
  expect(animateCalls.length).toBe(2);
  navigator.geolocation.getCurrentPosition = () => {};
});

test('paused 時新的定位只更新藍點、不再移動地圖；按追蹤鈕立刻回到最後位置並恢復跟隨', async () => {
  await startFollowing();
  map._trigger('pointerdrag');
  expect(getTrackState()).toBe('paused');

  fixCb(fix(25.04, 121.57, 8));
  expect(animateCalls.length, '暫停跟隨時不該動地圖').toBe(0);

  trackBtn.click();
  expect(getTrackState()).toBe('following');
  expect(animateCalls.length).toBe(1);
  expect(animateCalls[0].center, '回到最後一次收到的位置').toEqual([121.57, 25.04]);
  expect(clearedIds, '恢復跟隨不是重新開始追蹤，不該 clearWatch').toEqual([]);
  expect(watchCalls, '也不該重新 watchPosition').toBe(1);
});

test('使用者主動按「回到目前位置」時，就算地圖正在跑別人的動畫也照樣回去（不會被自己的防搶判斷擋掉）', async () => {
  await startFollowing();
  map._trigger('pointerdrag');
  fixCb(fix(25.04, 121.57, 8));
  animating = true; // 別人的動畫正在跑
  trackBtn.click();
  expect(getTrackState()).toBe('following');
  expect(animateCalls.length).toBe(1);
});

test('重新開始追蹤時，上一次留下的位置不會拿來判斷這次是否被移開', async () => {
  await startFollowing();
  trackBtn.click(); // 停止
  expect(getTrackState()).toBe('off');
  trackBtn.click(); // 重新開始，還沒收到任何定位
  await flush();
  viewCenter = [9999, 9999];
  map._trigger('moveend');
  expect(getTrackState(), '還沒有這次的定位點，不判斷').toBe('following');
});

/* ---------- 錯誤 ---------- */

test('權限被拒絕：自動停止追蹤（釋放螢幕常亮），並提示如何開啟權限', async () => {
  trackBtn.click();
  await flush();
  errCb({ code: 1, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
  expect(getTrackState()).toBe('off');
  expect(clearedIds).toEqual([42]);
  expect(lockReleases).toBe(1);
  expect(toast.textContent).toContain('拒絕位置權限');
});

test('訊號暫時不穩：追蹤繼續、同一段連續失敗只提示一次，收到定位後才重新計算', async () => {
  trackBtn.click();
  await flush();
  const timeoutErr = { code: 3, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 };
  errCb(timeoutErr);
  expect(getTrackState(), '追蹤不該因此停止').toBe('following');
  expect(toast.textContent).toContain('訊號不穩');

  toast.textContent = '';
  errCb(timeoutErr);
  expect(toast.textContent, '第二次失敗不重複提示').toBe('');

  fixCb(fix(25.03, 121.56, 8)); // 恢復
  errCb(timeoutErr);
  expect(toast.textContent, '恢復後再次失敗才再提示').toContain('訊號不穩');
});

/* ---------- 螢幕常亮 ---------- */

test('回到頁面（visibilitychange → visible）且仍在追蹤：重新要螢幕常亮；沒在追蹤就不要', async () => {
  const fireVisible = () => {
    document.visibilityState = 'visible';
    (docListeners.visibilitychange || []).forEach(fn => fn());
  };
  try{
    fireVisible();
    await flush();
    expect(lockRequests, '沒在追蹤時不該要').toEqual([]);

    trackBtn.click();
    await flush();
    expect(lockRequests.length).toBe(1);
    lockReleaseListener(); // 瀏覽器在螢幕鎖定時自動釋放
    fireVisible();
    await flush();
    expect(lockRequests.length, '回到頁面後重新要').toBe(2);
  } finally { delete document.visibilityState; }
});

test('螢幕常亮被拒絕（例如省電模式）不影響追蹤本身', async () => {
  const original = navigator.wakeLock.request;
  navigator.wakeLock.request = async () => { throw new Error('NotAllowedError'); };
  try{
    trackBtn.click();
    await flush();
    expect(getTrackState()).toBe('following');
    fixCb(fix(25.03, 121.56, 8));
    expect(animateCalls.length).toBe(1);
  } finally { navigator.wakeLock.request = original; }
});
