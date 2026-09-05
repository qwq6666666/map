/* ---------------------------------------------------------
   features/customTimelineUI.js — 自訂時間軸浮動 dock
   ---------------------------------------------------------
   完全獨立於全站時間軸模式（src/timelineUI.js／src/timelineMode.js）
   的一個浮動控制面板：刻度點＋滑桿＋透明度拉桿＋關閉鈕。不 import、
   不呼叫既有時間軸的任何函式，也不共用容器或 store 狀態，class
   前綴一律 custom-timeline-*，避免跟既有樣式互相污染。

   對外只匯出兩個函式：
     openCustomTimelineDock(candidates, callbacks)
     closeCustomTimelineDock()
   呼叫端（features/customTimeline.js）負責準備已排序好的候選圖層
   陣列，並在 onSelectIndex/onOpacityChange/onClose 三個 callback 裡
   接手實際的地圖操作（本檔案完全不碰地圖、不 import core/ 任何東西）。
--------------------------------------------------------- */

let dockEl = null;      // 目前開啟中的 dock 根節點，未開啟時是 null
let currentCallbacks = null;
let currentIndex = 0;
let dotEls = [];        // 依 candidates 順序排列的刻度點節點
let titleEl = null;
let metaEl = null;
let sliderEl = null;

// ---- 自動播放：跟 src/timelineUI.js 的播放邏輯精神一致，但完全獨立
//      重新實作，不 import、不共用任何狀態或 timer。 ----
const PLAY_INTERVAL_MS = 1800; // 自動播放時每一筆停留的時間（1x 速度）
// 加速播放：可循環切換的倍率選項，1x 為預設、不影響既有行為，只改變
// 自動播放的步進間隔，不影響刻度點點擊／滑桿拖曳「立即套用」的互動。
const SPEED_LEVELS = [1, 2, 0.5];
let playTimer = null;
let playing = false;
let playBtn = null;
let speedBtn = null;
let speedIndex = 0;

function currentInterval(){
  return PLAY_INTERVAL_MS / SPEED_LEVELS[speedIndex];
}

function yearLabelOf(layer){
  if(layer && layer.year) return String(layer.year);
  if(layer && typeof layer.yearNum === 'number') return String(layer.yearNum);
  return '年代不明';
}

function shortYearLabelOf(layer){
  if(layer && typeof layer.yearNum === 'number') return String(layer.yearNum);
  if(layer && layer.year) return String(layer.year);
  return '?';
}

// 更新標題／年份／來源文字與刻度點高亮，不觸發任何 callback。
function paint(idx, candidates){
  const item = candidates[idx];
  if(titleEl) titleEl.textContent = item.layer.title || '（未命名圖層）';
  if(metaEl) metaEl.textContent = `${yearLabelOf(item.layer)} · ${item.src.name}`;
  dotEls.forEach((dot, i) => {
    dot.classList.toggle('active', i === idx);
    if(i === idx) dot.setAttribute('aria-current', 'step');
    else dot.removeAttribute('aria-current');
  });
}

// 滑桿拖曳與刻度點點擊共用的「切換到第 idx 筆」邏輯：更新畫面、同步
// 滑桿數值、呼叫 onSelectIndex callback。
function selectIndex(idx, candidates){
  idx = Math.max(0, Math.min(candidates.length - 1, idx));
  currentIndex = idx;
  paint(idx, candidates);
  if(sliderEl) sliderEl.value = String(idx);
  currentCallbacks && currentCallbacks.onSelectIndex && currentCallbacks.onSelectIndex(idx, candidates[idx]);
}

// 停止自動播放：清掉 timer、還原播放鈕文字與樣式。重複呼叫或本來就
// 沒在播放時都必須是安全的 no-op。
function stopPlaying(){
  if(!playing) return;
  playing = false;
  if(playTimer){ clearTimeout(playTimer); playTimer = null; }
  if(playBtn){
    playBtn.textContent = '▶ 播放';
    playBtn.classList.remove('playing');
  }
}

// 播放下一筆；播到最後一筆時自動停止（不循環回開頭）。
function stepPlay(candidates){
  const nextIdx = currentIndex + 1;
  if(nextIdx >= candidates.length){ stopPlaying(); return; }
  selectIndex(nextIdx, candidates);
  if(nextIdx >= candidates.length - 1) stopPlaying();
  else playTimer = setTimeout(() => stepPlay(candidates), currentInterval());
}

// 開始自動播放：只有一筆時沒什麼好播放的，不啟動。若目前已經在最後
// 一筆，從頭開始播；否則從目前這筆繼續往後播。
function startPlaying(candidates){
  if(candidates.length < 2) return;
  playing = true;
  if(playBtn){
    playBtn.textContent = '❚❚ 暫停';
    playBtn.classList.add('playing');
  }
  const startIdx = currentIndex >= candidates.length - 1 ? 0 : Math.max(0, currentIndex);
  selectIndex(startIdx, candidates);
  playTimer = setTimeout(() => stepPlay(candidates), currentInterval());
}

/**
 * 開啟（或取代既有的）自訂時間軸 dock。
 * @param {Array<{src, layer}>} candidates 已經依年代排序好的自訂圖層序列（至少 1 筆）
 * @param {{
 *   onSelectIndex: (idx: number, item: {src, layer}) => void,
 *   onOpacityChange: (percent: number) => void,
 *   onClose: () => void
 * }} callbacks
 */
export function openCustomTimelineDock(candidates, callbacks){
  teardown(); // 只是「取代」既有 dock，不算使用者主動關閉，不觸發舊的 onClose

  currentCallbacks = callbacks || {};
  currentIndex = 0;
  dotEls = [];
  speedIndex = 0; // 每次開啟 dock 都從 1x 重新開始

  const dock = document.createElement('div');
  dock.id = 'custom-timeline-dock';
  dock.className = 'custom-timeline-dock';

  // ---- 標題列：關閉鈕 + 抬頭文字 ----
  const head = document.createElement('div');
  head.className = 'custom-timeline-head';

  const headText = document.createElement('div');
  headText.className = 'custom-timeline-head-text';
  titleEl = document.createElement('div');
  titleEl.className = 'custom-timeline-title';
  metaEl = document.createElement('div');
  metaEl.className = 'custom-timeline-meta';
  headText.appendChild(titleEl);
  headText.appendChild(metaEl);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'custom-timeline-close';
  closeBtn.setAttribute('aria-label', '關閉自訂時間軸');
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', closeCustomTimelineDock);

  head.appendChild(headText);
  head.appendChild(closeBtn);
  dock.appendChild(head);

  // ---- 刻度點列 ----
  const dotsRow = document.createElement('div');
  dotsRow.className = 'custom-timeline-dots';
  candidates.forEach((c, i) => {
    const dotWrap = document.createElement('div');
    dotWrap.className = 'custom-timeline-dot-wrap';

    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'custom-timeline-dot';
    dot.setAttribute('aria-label', `切換到第 ${i + 1} 筆`);
    dot.addEventListener('click', () => { stopPlaying(); selectIndex(i, candidates); });

    const label = document.createElement('div');
    label.className = 'custom-timeline-dot-label';
    label.textContent = shortYearLabelOf(c.layer);
    label.addEventListener('click', () => { stopPlaying(); selectIndex(i, candidates); });

    dotWrap.appendChild(dot);
    dotWrap.appendChild(label);
    dotsRow.appendChild(dotWrap);
    dotEls.push(dot);
  });
  dock.appendChild(dotsRow);

  // ---- 滑動軌道：只有一筆時不用顯示可拖曳滑桿 ----
  sliderEl = null;
  playBtn = null;
  speedBtn = null;
  if(candidates.length > 1){
    const sliderRow = document.createElement('div');
    sliderRow.className = 'custom-timeline-slider-row';

    playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'custom-timeline-play-btn';
    playBtn.textContent = '▶ 播放';
    playBtn.addEventListener('click', () => { playing ? stopPlaying() : startPlaying(candidates); });

    // 加速播放：1x/2x/0.5x 循環切換，只改變自動播放的步進間隔，
    // 對刻度點點擊／滑桿拖曳「立即套用」的互動完全沒有影響。
    speedBtn = document.createElement('button');
    speedBtn.type = 'button';
    speedBtn.className = 'custom-timeline-speed-btn';
    speedBtn.textContent = `${SPEED_LEVELS[speedIndex]}x`;
    speedBtn.setAttribute('aria-label', '切換自動播放速度');
    speedBtn.addEventListener('click', () => {
      speedIndex = (speedIndex + 1) % SPEED_LEVELS.length;
      speedBtn.textContent = `${SPEED_LEVELS[speedIndex]}x`;
      if(playing){ // 播放中立即套用新速度，不用等目前這一步走完
        if(playTimer){ clearTimeout(playTimer); }
        playTimer = setTimeout(() => stepPlay(candidates), currentInterval());
      }
    });

    sliderEl = document.createElement('input');
    sliderEl.type = 'range';
    sliderEl.className = 'custom-timeline-slider';
    sliderEl.min = '0';
    sliderEl.max = String(candidates.length - 1);
    sliderEl.step = '1';
    sliderEl.value = '0';
    sliderEl.setAttribute('aria-label', '年代進度');
    sliderEl.addEventListener('input', () => {
      stopPlaying();
      selectIndex(parseInt(sliderEl.value, 10) || 0, candidates);
    });
    sliderRow.appendChild(playBtn);
    sliderRow.appendChild(sliderEl);
    sliderRow.appendChild(speedBtn);
    dock.appendChild(sliderRow);
  }

  // ---- 透明度拉桿 ----
  const opacityRow = document.createElement('div');
  opacityRow.className = 'custom-timeline-opacity-row';
  const opacityLabel = document.createElement('span');
  opacityLabel.className = 'custom-timeline-opacity-label';
  opacityLabel.textContent = '透明度';
  const opacitySlider = document.createElement('input');
  opacitySlider.type = 'range';
  opacitySlider.className = 'custom-timeline-opacity-slider';
  opacitySlider.min = '0';
  opacitySlider.max = '100';
  opacitySlider.value = '100';
  opacitySlider.setAttribute('aria-label', '透明度');
  const opacityValue = document.createElement('span');
  opacityValue.className = 'custom-timeline-opacity-value';
  opacityValue.textContent = '100%';
  opacitySlider.addEventListener('input', () => {
    const percent = parseInt(opacitySlider.value, 10) || 0;
    opacityValue.textContent = `${percent}%`;
    currentCallbacks && currentCallbacks.onOpacityChange && currentCallbacks.onOpacityChange(percent);
  });
  opacityRow.appendChild(opacityLabel);
  opacityRow.appendChild(opacitySlider);
  opacityRow.appendChild(opacityValue);
  dock.appendChild(opacityRow);

  document.body.appendChild(dock);
  dockEl = dock;

  // 初始畫面狀態：顯示第一筆，不呼叫 onSelectIndex（避免重複觸發，
  // 由呼叫端自己在 openCustomTimelineDock() 之後另外處理）。
  paint(0, candidates);

  // 進場動畫：先以隱藏狀態插入 DOM，下一個 tick 再加 .show 觸發 CSS
  // transition；用 setTimeout(fn,0) 而不是 requestAnimationFrame，
  // 因為測試環境的假 DOM 沒有 requestAnimationFrame。
  setTimeout(() => { dock.classList.add('show'); }, 0);

  return dock;
}

// 關閉時共用的收尾：從 DOM 移除、清掉所有模組層級的參照，確保重複
// 呼叫或本來就沒開啟時都是安全的 no-op。
function teardown(){
  if(playTimer){ clearTimeout(playTimer); playTimer = null; }
  playing = false;
  playBtn = null;
  speedBtn = null;
  speedIndex = 0;
  if(dockEl && dockEl.parentElement) dockEl.parentElement.removeChild(dockEl);
  else if(dockEl && dockEl.remove) dockEl.remove();
  dockEl = null;
  currentCallbacks = null;
  currentIndex = 0;
  dotEls = [];
  titleEl = null;
  metaEl = null;
  sliderEl = null;
}

/** 供外部（測試／其他程式碼）需要時可以直接呼叫關閉，等同使用者按了
 *  關閉鈕（會呼叫 onClose callback）；重複呼叫、或本來就沒開啟時必須
 *  安全地什麼都不做（不能報錯）。 */
export function closeCustomTimelineDock(){
  if(!dockEl){ return; } // 本來就沒開啟，安全地什麼都不做
  const cb = currentCallbacks;
  teardown();
  cb && cb.onClose && cb.onClose();
}
