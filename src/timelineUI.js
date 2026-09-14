/* ---------------------------------------------------------
   timelineUI.js — 時間軸模式（timelineMode.js）專用的時間軸內容渲染
   ---------------------------------------------------------
   把「目前地圖位置可套疊的歷史圖層」畫成一列可點擊／可拖曳 scrub 的
   刻度點，搭配播放／加速播放鈕，跟 features/customTimelineUI.js 的
   自訂時間軸浮動 dock 走同一套視覺語彙（圓點刻度＋播放／加速播放），
   但完全獨立實作、不 import、不共用容器或狀態——這裡唯一的呼叫端是
   src/timelineMode.js（buildTimeline()），跟自訂時間軸 dock 純屬
   「風格一致」不是「共用元件」。

   播放鈕／刻度點／加速鈕合併成同一列（.timeline-row），不像
   customTimelineUI.js 的 dock 分成「刻度點一列＋播放/滑桿一列」兩層：
   原本額外有一條 <input type=range> 滑桿負責拖曳，但滑桿做的事其實
   跟刻度點列本身「選某個索引」完全重複，只是多佔一整列版面，因此改
   成直接在刻度點列（.timeline-ticks）上用 pointerdown/pointermove
   支援按住拖曳 scrub，拿掉滑桿後省下一整列高度。

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

// 加速播放：可循環切換的倍率選項。跟 features/customTimelineUI.js
// 共用同一組級距與循環順序（兩顆「切換速度」按鈕在使用者心智模型裡
// 是同一種操作，級距不一致容易誤解），0.5x 為新增的減速選項、其餘
// 維持原本的 1x/2x/4x 不變。DEFAULT_SPEED_INDEX 指向 1x，確保開啟時
// 預設速度、既有的播放/暫停邏輯都不受影響。
const SPEED_LEVELS = [0.5, 1, 2, 4];
const DEFAULT_SPEED_INDEX = SPEED_LEVELS.indexOf(1);

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
    let speedIndex = DEFAULT_SPEED_INDEX; // SPEED_LEVELS 的索引，只影響自動播放的間隔，不影響拖曳/點擊挑選

    function currentInterval(){
      return PLAY_INTERVAL_MS / SPEED_LEVELS[speedIndex];
    }

    function stopPlaying(){
      if(!playing) return;
      playing = false;
      if(playTimer){ clearTimeout(playTimer); playTimer = null; }
      if(playBtn){
        playBtn.textContent = '▶';
        playBtn.title = '播放';
        playBtn.setAttribute('aria-label', '播放');
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
        playBtn.textContent = '❚❚';
        playBtn.title = '暫停';
        playBtn.setAttribute('aria-label', '暫停');
        playBtn.classList.add('playing');
      }
      const startIdx = currentIndex >= dotList.length - 1 ? 0 : Math.max(0, currentIndex);
      selectIndex(startIdx, true); // 確保目前這一筆有真的套用過（一開始還沒選過任何東西時）
      playTimer = setTimeout(stepPlay, currentInterval());
    }

    // ---------------------------------------------------------
    // 單一列（.timeline-row）：播放鈕＋刻度點列（.timeline-ticks）＋
    // 加速鈕。刻度點沿用 layer-item + data-layer-id，讓
    // syncActiveLayerItemClasses() 能正確同步「目前實際套疊中」的高亮；
    // 每個圓點下方的年份文字一樣可以直接點擊跳轉。
    // ---------------------------------------------------------
    const ticks = document.createElement('div');
    ticks.className = 'timeline-ticks';
    // role="group" 讓 aria-label 對純 div 也生效。
    ticks.setAttribute('role', 'group');
    ticks.setAttribute('aria-label', '依年代排列的時間軸');

    function focusDot(idx){
      const item = dotList[idx];
      if(item && item.el.focus) item.el.focus();
    }

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
        if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); handleActivate(); return; }
        // 拿掉獨立滑桿後，左右方向鍵改在刻度點本身補上「移到上/下一筆」，
        // 維持鍵盤使用者原本靠滑桿方向鍵逐筆瀏覽的能力。
        if(e.key === 'ArrowRight' || e.key === 'ArrowLeft'){
          const nextIdx = e.key === 'ArrowRight' ? i + 1 : i - 1;
          if(nextIdx < 0 || nextIdx >= dotList.length) return;
          e.preventDefault();
          stopPlaying();
          selectIndex(nextIdx, true);
          focusDot(nextIdx);
        }
      });

      dotWrap.appendChild(dot);
      dotWrap.appendChild(label);
      ticks.appendChild(dotWrap);
      dotList.push({ el: dot, layer: c.layer, src: c.src });
    });

    // ---------------------------------------------------------
    // 拖曳 scrub：取代原本獨立的 <input type=range> 滑桿。只有從刻度點
    // 本身按下才會啟動（e.target.closest('.timeline-dot')），刻意不讓
    // 刻度點之間的空白也能拖，避免跟手機上「橫向捲動看超出畫面的刻度
    // 點」的原生滑動手勢打架。用 ticks.setPointerCapture 讓按住後手指/
    // 滑鼠移出刻度點範圍一樣能持續收到 pointermove。移動中跟原本拖曳
    // pointermove 一樣走 SCRUB_DEBOUNCE_MS 節流；放開（pointerup/
    // cancel）時比照原本滑桿的 change 事件，立即套用不等 debounce。
    // ---------------------------------------------------------
    let dragPointerId = null;

    function nearestIndexForClientX(clientX){
      let bestIdx = currentIndex < 0 ? 0 : currentIndex;
      let bestDist = Infinity;
      dotList.forEach((item, i) => {
        const rect = item.el.getBoundingClientRect();
        const dist = Math.abs((rect.left + rect.width / 2) - clientX);
        if(dist < bestDist){ bestDist = dist; bestIdx = i; }
      });
      return bestIdx;
    }

    ticks.addEventListener('pointerdown', (e) => {
      if(!e.target.closest || !e.target.closest('.timeline-dot')) return;
      dragPointerId = e.pointerId;
      if(ticks.setPointerCapture) ticks.setPointerCapture(e.pointerId);
      stopPlaying();
      selectIndex(nearestIndexForClientX(e.clientX), true);
    });
    ticks.addEventListener('pointermove', (e) => {
      if(dragPointerId === null || e.pointerId !== dragPointerId) return;
      selectIndex(nearestIndexForClientX(e.clientX), false);
    });
    function endDrag(e){
      if(dragPointerId === null || e.pointerId !== dragPointerId) return;
      dragPointerId = null;
      if(pendingTimer){ clearTimeout(pendingTimer); pendingTimer = null; }
      selectIndex(currentIndex, true);
    }
    ticks.addEventListener('pointerup', endDrag);
    ticks.addEventListener('pointercancel', endDrag);

    const timelineRow = document.createElement('div');
    timelineRow.className = 'timeline-row';

    // 播放/暫停鈕＋加速播放鈕只有一筆以上才需要（只有一筆沒什麼好播放/
    // 拖曳的），這種情況下 timelineRow 只包刻度點列本身。
    if(dotList.length > 1){
      playBtn = document.createElement('button');
      playBtn.type = 'button';
      playBtn.className = 'timeline-play-btn';
      playBtn.textContent = '▶';
      playBtn.title = '播放';
      playBtn.setAttribute('aria-label', '播放');
      playBtn.addEventListener('click', () => { playing ? stopPlaying() : startPlaying(); });

      // 加速播放：0.5x/1x/2x/4x 循環切換，只改變自動播放的步進間隔，
      // 對「拖曳/點擊挑選某一筆立即套用」的互動完全沒有影響。title／
      // aria-label 同步標示目前速度，避免使用者誤以為每一檔都是加速。
      speedBtn = document.createElement('button');
      speedBtn.type = 'button';
      speedBtn.className = 'timeline-speed-btn';
      speedBtn.textContent = `${SPEED_LEVELS[speedIndex]}x`;
      speedBtn.title = `目前播放速度 ${SPEED_LEVELS[speedIndex]}x，點擊切換下一個速度`;
      speedBtn.setAttribute('aria-label', speedBtn.title);
      speedBtn.addEventListener('click', () => {
        speedIndex = (speedIndex + 1) % SPEED_LEVELS.length;
        speedBtn.textContent = `${SPEED_LEVELS[speedIndex]}x`;
        speedBtn.title = `目前播放速度 ${SPEED_LEVELS[speedIndex]}x，點擊切換下一個速度`;
        speedBtn.setAttribute('aria-label', speedBtn.title);
        if(playing){ // 播放中立即套用新速度，不用等目前這一步走完
          if(playTimer){ clearTimeout(playTimer); }
          playTimer = setTimeout(stepPlay, currentInterval());
        }
      });

      timelineRow.appendChild(playBtn);
      timelineRow.appendChild(ticks);
      timelineRow.appendChild(speedBtn);
    } else {
      timelineRow.appendChild(ticks);
    }
    container.appendChild(timelineRow);
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
