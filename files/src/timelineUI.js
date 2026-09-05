/* ---------------------------------------------------------
   timelineUI.js — 時間軸模式（timelineMode.js）專用的時間軸內容渲染
   ---------------------------------------------------------
   把「目前地圖位置可套疊的歷史圖層」畫成一列刻度點＋橫向滑桿，跟
   features/customTimelineUI.js 的自訂時間軸浮動 dock 走同一套視覺／
   互動語彙（圓點刻度＋滑桿＋播放／加速播放），但完全獨立實作、不
   import、不共用容器或狀態——這裡唯一的呼叫端是 src/timelineMode.js
   （buildTimeline()），跟自訂時間軸 dock 純屬「風格一致」不是
   「共用元件」。

   每一筆候選圖層各自一個刻度點（同年份會連續出現好幾個點，不合併
   分組，跟 customTimelineUI.js 的 dock 行為一致），刻度點與底下的
   年份文字都可以直接點擊跳轉。播放進度用三態視覺表示：
     - 尚未經過：半透明白色外框（預設）
     - 已經經過：實心 brass 底色（.passed）
     - 目前所在：實心強調色，同時沿用跟其他檢視共用的
       .layer-item.active 高亮慣例（.active，帶 aria-current="step"），
       讓 core/layerManager.js 的 syncActiveLayerItemClasses() 不用
       另外改就能正確同步。

   資料需求：每筆候選圖層的 layer.yearNum 是數字或 null（見
   data.js 的 mapLayer）。沒有 yearNum 的圖層無法定位在時間軸上，
   另外收在時間軸下方的「年代不明」清單。

   排列方式：依年份「順序」排開（一顆一顆刻度點＋一條
   <input type=range>），不按實際年份比例定位——真實年代分布常常前後
   跳很多年，照實際比例畫，畫面會一段擠成一團、一段留一大片空白；
   等間距能讓畫面平均分布、乾淨好讀，兩個刻度點之間的距離不代表真實
   年數差距，但每個刻度點下方都會標示自己的年份。
--------------------------------------------------------- */

// 拖曳／播放時，畫面（刻度點顏色、滑桿數值）即時跟著手指走，完全不花
// 任何網路成本；但「真正套疊圖層」這個動作（會讓瀏覽器去抓圖磚）刻意
// 做了節流：
//   1. 只有滑到的刻度真的換了一筆，才會考慮觸發
//   2. 而且要等手指停下來 SCRUB_DEBOUNCE_MS 之後才真的觸發
// 這樣快速滑過中間好幾筆時，只有最後停下來的那一筆會真的載入，
// 而不是每移動一點點就發一次圖磚請求。放開滑桿（原生 range 的 change
// 事件，對應滑鼠/觸控放開或鍵盤放開方向鍵）時，不等 debounce，直接
// 立即套用目前指到的圖層。
const SCRUB_DEBOUNCE_MS = 150;

// 自動播放時，每一筆停留的時間（1x 速度）。故意比拖曳的 debounce 長很多，
// 讓每一張圖至少有機會開始把圖磚載入完，畫面才看得出東西。
const PLAY_INTERVAL_MS = 1800;

// 加速播放：可循環切換的倍率選項，1x 為預設、不影響既有行為。
const SPEED_LEVELS = [1, 2, 4];

/**
 * 畫出時間軸並掛進 container。
 * @param {Array<{src, layer}>} candidates 要畫上時間軸的候選圖層
 * @param {HTMLElement} container 掛載目標（會被清空後重新填入）
 * @param {(src, layer) => void} onSelect 點擊圖層時呼叫
 */
export function buildTimeline(candidates, container, onSelect){
  container.innerHTML = '';

  const dated = candidates.filter(c => typeof c.layer.yearNum === 'number');
  const undated = candidates.filter(c => typeof c.layer.yearNum !== 'number');

  if(dated.length > 0){
    // 依年份排序（年份相同時維持原本清單順序），決定刻度點從左到右的排列。
    const items = [...dated].sort((a, b) => a.layer.yearNum - b.layer.yearNum);

    const dotList = []; // { el, layer, src }，依左到右順序，供播放／拖曳／鍵盤操作使用
    let sliderEl = null;
    let playBtn = null;
    let speedBtn = null;

    // ---------------------------------------------------------
    // 播放進度上色：目前所在的刻度標記 active（沿用跟其他檢視共用的
    // 高亮慣例），已經播過的刻度標記 passed（實心底色），還沒播到的
    // 維持預設的半透明外框。
    // ---------------------------------------------------------
    let currentIndex = -1; // 還沒選過任何一筆之前是 -1，全部維持預設外觀
    let pendingTimer = null;
    let lastFiredLayerId = null;

    function paintProgress(idx){
      dotList.forEach((item, i) => {
        item.el.classList.toggle('passed', i < idx);
        item.el.classList.toggle('active', i === idx);
        if(i === idx) item.el.setAttribute('aria-current', 'step');
        else item.el.removeAttribute('aria-current');
      });
      if(sliderEl) sliderEl.value = String(Math.max(0, idx));
    }

    function selectIndex(idx, immediate){
      idx = Math.max(0, Math.min(dotList.length - 1, idx));
      currentIndex = idx;
      paintProgress(idx);
      const item = dotList[idx];
      if(item.layer.id === lastFiredLayerId) return; // 還是同一筆，不用重新觸發

      if(pendingTimer) clearTimeout(pendingTimer);
      const fire = () => {
        pendingTimer = null;
        lastFiredLayerId = item.layer.id;
        onSelect(item.src, item.layer);
      };
      if(immediate) fire();
      else pendingTimer = setTimeout(fire, SCRUB_DEBOUNCE_MS);
    }

    // ---------------------------------------------------------
    // 自動播放：依序播放到下一筆。每一步都是使用者明確要求「請依序
    // 播放」的一部分，所以直接套用（不像手動拖曳快速滑過要 debounce
    // 掉中間路過的）。
    // ---------------------------------------------------------
    let playTimer = null;
    let playing = false;
    let speedIndex = 0; // SPEED_LEVELS 的索引，只影響自動播放的間隔，不影響拖曳/點擊挑選

    function currentInterval(){
      return PLAY_INTERVAL_MS / SPEED_LEVELS[speedIndex];
    }

    function stopPlaying(){
      if(!playing) return;
      playing = false;
      if(playTimer){ clearTimeout(playTimer); playTimer = null; }
      if(playBtn){
        playBtn.textContent = '▶ 播放';
        playBtn.classList.remove('playing');
      }
    }

    function stepPlay(){
      const nextIdx = currentIndex + 1;
      if(nextIdx >= dotList.length){
        stopPlaying();
        return;
      }
      selectIndex(nextIdx, true);
      if(nextIdx >= dotList.length - 1){
        stopPlaying(); // 這一步剛好到最後一筆，直接停止，不用再空等一輪才停
      } else {
        playTimer = setTimeout(stepPlay, currentInterval());
      }
    }

    function startPlaying(){
      if(dotList.length < 2) return; // 只有一筆沒什麼好播放的
      playing = true;
      if(playBtn){
        playBtn.textContent = '❚❚ 暫停';
        playBtn.classList.add('playing');
      }
      const startIdx = currentIndex >= dotList.length - 1 ? 0 : Math.max(0, currentIndex);
      selectIndex(startIdx, true); // 確保目前這一筆有真的套用過（一開始還沒選過任何東西時）
      playTimer = setTimeout(stepPlay, currentInterval());
    }

    // ---------------------------------------------------------
    // 刻度點列：每一筆候選圖層各自一個圓點按鈕＋底下年份文字，兩者都能
    // 點擊直接跳轉。圓點沿用 layer-item + data-layer-id，讓
    // syncActiveLayerItemClasses() 能正確同步「目前實際套疊中」的高亮。
    // ---------------------------------------------------------
    const dotsRow = document.createElement('div');
    dotsRow.className = 'timeline-dots';
    // role="group" 讓 aria-label 對純 div 也生效。
    dotsRow.setAttribute('role', 'group');
    dotsRow.setAttribute('aria-label', '依年代排列的時間軸');

    items.forEach((c, i) => {
      const dotWrap = document.createElement('div');
      dotWrap.className = 'timeline-dot-wrap';

      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'layer-item timeline-dot'; // 沿用 layer-item，跟其他檢視共用 active 高亮機制
      dot.dataset.layerId = c.layer.id;
      const desc = `${c.layer.year} ${c.layer.title}（${c.src.name}）`;
      dot.setAttribute('aria-label', desc);
      dot.title = desc;

      const label = document.createElement('div');
      label.className = 'timeline-dot-label';
      label.textContent = String(c.layer.yearNum);

      const handleActivate = () => { stopPlaying(); selectIndex(i, true); };
      dot.addEventListener('click', handleActivate);
      label.addEventListener('click', handleActivate);
      dot.addEventListener('keydown', (e) => {
        if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); handleActivate(); }
      });

      dotWrap.appendChild(dot);
      dotWrap.appendChild(label);
      dotsRow.appendChild(dotWrap);
      dotList.push({ el: dot, layer: c.layer, src: c.src });
    });

    container.appendChild(dotsRow);

    // ---------------------------------------------------------
    // 播放列：播放/暫停鈕＋加速播放鈕＋橫向滑桿，只有一筆以上才需要
    // （只有一筆沒什麼好播放/拖曳的）。滑桿的 input 事件跟原本拖曳
    // pointermove 一樣密集，一樣要走 SCRUB_DEBOUNCE_MS 節流；change
    // 事件（放開滑桿，涵蓋滑鼠/觸控放開與鍵盤放開方向鍵）等同原本
    // pointerup，立即套用不等 debounce。
    // ---------------------------------------------------------
    if(dotList.length > 1){
      const sliderRow = document.createElement('div');
      sliderRow.className = 'timeline-slider-row';

      playBtn = document.createElement('button');
      playBtn.type = 'button';
      playBtn.className = 'timeline-play-btn';
      playBtn.textContent = '▶ 播放';
      playBtn.addEventListener('click', () => { playing ? stopPlaying() : startPlaying(); });

      sliderEl = document.createElement('input');
      sliderEl.type = 'range';
      sliderEl.className = 'timeline-slider';
      sliderEl.min = '0';
      sliderEl.max = String(dotList.length - 1);
      sliderEl.step = '1';
      sliderEl.value = '0';
      sliderEl.setAttribute('aria-label', '年代進度');
      sliderEl.addEventListener('input', () => {
        stopPlaying(); // 使用者自己動手拖，代表想自己控制，先停掉自動播放
        selectIndex(parseInt(sliderEl.value, 10) || 0, false);
      });
      sliderEl.addEventListener('change', () => {
        if(pendingTimer){ clearTimeout(pendingTimer); pendingTimer = null; }
        selectIndex(parseInt(sliderEl.value, 10) || 0, true); // 放開時不等 debounce，立刻套用
      });

      // 加速播放：1x/2x/4x 循環切換，只改變自動播放的步進間隔，
      // 對「拖曳/點擊挑選某一筆立即套用」的互動完全沒有影響。
      speedBtn = document.createElement('button');
      speedBtn.type = 'button';
      speedBtn.className = 'timeline-speed-btn';
      speedBtn.textContent = `${SPEED_LEVELS[speedIndex]}x`;
      speedBtn.setAttribute('aria-label', '切換自動播放速度');
      speedBtn.addEventListener('click', () => {
        speedIndex = (speedIndex + 1) % SPEED_LEVELS.length;
        speedBtn.textContent = `${SPEED_LEVELS[speedIndex]}x`;
        if(playing){ // 播放中立即套用新速度，不用等目前這一步走完
          if(playTimer){ clearTimeout(playTimer); }
          playTimer = setTimeout(stepPlay, currentInterval());
        }
      });

      sliderRow.appendChild(playBtn);
      sliderRow.appendChild(sliderEl);
      sliderRow.appendChild(speedBtn);
      container.appendChild(sliderRow);
    }
  }

  if(undated.length > 0){
    const wrap = document.createElement('div');
    wrap.className = 'timeline-undated';
    const label = document.createElement('div');
    label.className = 'timeline-undated-label';
    label.textContent = `年代不明（${undated.length} 筆）`;
    wrap.appendChild(label);

    const chipList = document.createElement('div');
    chipList.className = 'timeline-undated-list';
    undated.forEach(c => {
      const chip = document.createElement('div');
      chip.className = 'layer-item timeline-undated-chip';
      chip.dataset.layerId = c.layer.id;
      chip.textContent = c.layer.title;
      chip.addEventListener('click', () => onSelect(c.src, c.layer));
      chipList.appendChild(chip);
    });
    wrap.appendChild(chipList);
    container.appendChild(wrap);
  }

  if(dated.length === 0 && undated.length === 0){
    const empty = document.createElement('p');
    empty.className = 'avail-empty';
    empty.textContent = '沒有可顯示的圖層。';
    container.appendChild(empty);
  }
}
