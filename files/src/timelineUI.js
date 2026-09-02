/* ---------------------------------------------------------
   timelineUI.js — 搜尋結果的時間軸檢視（原型／第一版）
   ---------------------------------------------------------
   把「此地點可套疊的歷史圖層」依年代畫成一條橫向時間軸，取代／
   輔助原本分類手風琴的瀏覽方式。只依賴瀏覽器原生 SVG，不需要額外
   圖表函式庫。

   資料需求：每筆候選圖層的 layer.yearNum 是數字或 null（見
   data.js 的 mapLayer）。沒有 yearNum 的圖層無法定位在時間軸上，
   另外收在時間軸下方的「年代不明」清單。

   互動：時間軸上的圓點沿用跟主清單／搜尋結果清單同一個
  「layer-item + data-layer-id」慣例，所以 mapCore.js 裡
   syncActiveLayerItemClasses() 的高亮同步機制不需要另外改，
   點時間軸上的圖層一樣會正確標示成 active、也能跟其他檢視方式
   保持同步。

   這是第一版原型：目前只用簡單的線性比例尺定位、同年份圖層垂直
   往上堆疊。如果之後年份分布很極端（例如大多數集中在某幾年、
   少數散得很開），可能需要改成非線性比例尺或分段呈現，先試用看看
   實際搜尋結果的效果再調整。
--------------------------------------------------------- */

const SVG_NS = 'http://www.w3.org/2000/svg';

// 拖曳搖桿時，畫面（指示線、年份文字）即時跟著手指走，完全不花任何網路
// 成本；但「真正套疊圖層」這個動作（會讓瀏覽器去抓圖磚）刻意做了節流：
//   1. 只有拖到的「代表圖層」真的換了一筆，才會考慮觸發
//   2. 而且要等手指停下來 SCRUB_DEBOUNCE_MS 之後才真的觸發
// 這樣快速滑過中間好幾個年份時，只有最後停下來的那一筆會真的載入，
// 而不是每移動一點點就發一次圖磚請求。放開手指（pointerup）時，
// 不等 debounce，直接立即套用目前指到的圖層。
const SCRUB_DEBOUNCE_MS = 150;

// 自動播放時，每個年份停留的時間。故意比拖曳的 debounce 長很多，
// 讓每一張圖至少有機會開始把圖磚載入完，畫面才看得出東西。
const PLAY_INTERVAL_MS = 1800;

function chooseTickYears(minYear, maxYear){
  if(minYear === maxYear) return [minYear];
  const span = maxYear - minYear;
  const step = span <= 20 ? 5 : span <= 60 ? 10 : span <= 150 ? 25 : 50;
  const ticks = [];
  let y = Math.ceil(minYear / step) * step;
  for(; y <= maxYear; y += step) ticks.push(y);
  if(ticks.length === 0 || ticks[0] !== minYear) ticks.unshift(minYear);
  if(ticks[ticks.length - 1] !== maxYear) ticks.push(maxYear);
  return ticks;
}

function svgEl(tag, attrs){
  const el = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs || {}).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}

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
    const years = dated.map(c => c.layer.yearNum);
    const minYear = Math.min(...years);
    const maxYear = Math.max(...years);

    const byYear = new Map();
    dated.forEach(c => {
      const y = c.layer.yearNum;
      if(!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push(c);
    });

    const PADDING = 36;
    const DOT_R = 6;
    const COL_GAP = 16; // 同一年份的圖層左右散開的間距

    // 同一年份的圖層一律水平排開（依原本清單順序，由左到右），不再往上
    // 堆疊成方陣：一來同年份多筆時「依序排列」更直覺、也更好用鍵盤或
    // 滑鼠依序點過去；二來讓整條時間軸固定是「一列」的高度，不會因為
    // 某些年份筆數多，就把整條時間軸的可視高度撐得越來越高。
    const width = Math.max(560, dated.length * 24 + PADDING * 2, (maxYear - minYear) * 4 + PADDING * 2);
    const height = PADDING + 34;
    const axisY = height - 30;

    const svg = svgEl('svg', {
      viewBox: `0 0 ${width} ${height}`,
      width, height,
      class: 'timeline-svg',
      role: 'img',
      'aria-label': '搜尋結果依年代排列的時間軸'
    });

    svg.appendChild(svgEl('line', {
      x1: PADDING, x2: width - PADDING, y1: axisY, y2: axisY, class: 'timeline-axis'
    }));

    const xForYear = (y) => (maxYear === minYear)
      ? width / 2
      : PADDING + (y - minYear) / (maxYear - minYear) * (width - PADDING * 2);

    chooseTickYears(minYear, maxYear).forEach(y => {
      const x = xForYear(y);
      svg.appendChild(svgEl('line', { x1: x, x2: x, y1: axisY - 4, y2: axisY + 4, class: 'timeline-tick' }));
      const label = svgEl('text', { x, y: axisY + 18, 'text-anchor': 'middle', class: 'timeline-tick-label' });
      label.textContent = y;
      svg.appendChild(label);
    });

    byYear.forEach((items, y) => {
      const x = xForYear(y);
      const cy = axisY - 12;
      const offsetStart = -(items.length - 1) / 2; // 這一年份的圖層以年份刻度為中心，左右對稱排開

      if(items.length > 1){
        // 同一年份筆數 > 1 時，畫一小段橫線把這幾個點連起來，
        // 讓使用者一眼看出它們是同一年、依序排列的一組。
        const spanHalf = offsetStart * -1 * COL_GAP;
        svg.appendChild(svgEl('line', {
          x1: x - spanHalf, x2: x + spanHalf, y1: cy, y2: cy, class: 'timeline-stem timeline-stem-row'
        }));
      }
      const stem = svgEl('line', { x1: x, x2: x, y1: cy, y2: axisY, class: 'timeline-stem' });
      svg.appendChild(stem);

      items.forEach((c, i) => {
        const cx = x + (offsetStart + i) * COL_GAP;
        const dot = svgEl('circle', {
          cx, cy, r: DOT_R,
          class: 'layer-item timeline-dot', // 沿用 layer-item，跟其他檢視共用 active 高亮機制
          tabindex: '0', role: 'button'
        });
        dot.dataset.layerId = c.layer.id;
        dot.addEventListener('click', () => onSelect(c.src, c.layer));
        dot.addEventListener('keydown', (e)=>{ if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); onSelect(c.src, c.layer); } });

        const tooltip = svgEl('title', {});
        tooltip.textContent = `${c.layer.year} ${c.layer.title}（${c.src.name}）`;
        dot.appendChild(tooltip);

        svg.appendChild(dot);
      });
    });

    // ---------------------------------------------------------
    // 拖曳搖桿：沿時間軸拖動，即時顯示目前指到的年份／圖層，
    // 只有在停下來或放開時才真的觸發套疊（節流見上方 SCRUB_DEBOUNCE_MS 說明）。
    // ---------------------------------------------------------
    const sortedYears = [...byYear.keys()].sort((a, b) => a - b);
    const nearestYear = (x) => {
      let best = sortedYears[0], bestDist = Infinity;
      sortedYears.forEach(y => {
        const d = Math.abs(xForYear(y) - x);
        if(d < bestDist){ bestDist = d; best = y; }
      });
      return best;
    };

    const scrubGroup = svgEl('g', { class: 'timeline-scrub-group' });
    const scrubLine = svgEl('line', {
      x1: xForYear(sortedYears[0]), x2: xForYear(sortedYears[0]),
      y1: PADDING - 22, y2: axisY, class: 'timeline-scrub-line'
    });
    const scrubHandle = svgEl('circle', {
      cx: xForYear(sortedYears[0]), cy: axisY, r: 9,
      class: 'timeline-scrub-handle', tabindex: '0', role: 'slider',
      'aria-label': '拖曳選擇年代'
    });
    const scrubLabel = svgEl('text', {
      x: xForYear(sortedYears[0]), y: PADDING - 26,
      'text-anchor': 'middle', class: 'timeline-scrub-label'
    });
    scrubGroup.appendChild(scrubLine);
    scrubGroup.appendChild(scrubLabel);
    scrubGroup.appendChild(scrubHandle);
    svg.appendChild(scrubGroup);

    function labelForYear(y){
      const items = byYear.get(y);
      const title = items.length === 1 ? items[0].layer.title : `${items[0].layer.title} 等 ${items.length} 筆`;
      return `${y}　${title}`;
    }

    let pendingTimer = null;
    let lastFiredLayerId = null;

    function moveScrubTo(y, immediate){
      const x = xForYear(y);
      scrubLine.setAttribute('x1', x); scrubLine.setAttribute('x2', x);
      scrubHandle.setAttribute('cx', x);
      scrubLabel.setAttribute('x', x);
      scrubLabel.textContent = labelForYear(y);

      const rep = byYear.get(y)[0]; // 同一年份多筆時，搖桿預設帶出第一筆；要指定其中特定一筆仍可直接點該年份的圓點
      if(rep.layer.id === lastFiredLayerId) return; // 還是同一筆，不用重新觸發

      if(pendingTimer) clearTimeout(pendingTimer);
      const fire = () => {
        pendingTimer = null;
        lastFiredLayerId = rep.layer.id;
        onSelect(rep.src, rep.layer);
      };
      if(immediate) fire();
      else pendingTimer = setTimeout(fire, SCRUB_DEBOUNCE_MS);
    }

    // ---------------------------------------------------------
    // 自動播放：依序推進到下一個年份，讓時間軸自己動起來，不用手動拖。
    // 每一格都是使用者明確要求「請依序播放」的一部分，所以每一步都直接
    // 套用（不像手動拖曳快速滑過要 debounce 掉中間路過的），但仍然只在
    // 真的換了一筆代表圖層時才觸發 onSelect（moveScrubTo 本身已經處理）。
    // ---------------------------------------------------------
    let playTimer = null;
    let playing = false;

    function stopPlaying(){
      if(!playing) return;
      playing = false;
      if(playTimer){ clearTimeout(playTimer); playTimer = null; }
      playBtn.textContent = '▶ 播放';
      playBtn.classList.remove('playing');
    }

    function stepPlay(){
      const curX = parseFloat(scrubHandle.getAttribute('cx'));
      const curIdx = sortedYears.indexOf(nearestYear(curX));
      const nextIdx = curIdx + 1;
      if(nextIdx >= sortedYears.length){
        stopPlaying();
        return;
      }
      moveScrubTo(sortedYears[nextIdx], true);
      if(nextIdx >= sortedYears.length - 1){
        stopPlaying(); // 這一步剛好到最後一格，直接停止，不用再空等一輪才停
      } else {
        playTimer = setTimeout(stepPlay, PLAY_INTERVAL_MS);
      }
    }

    function startPlaying(){
      if(sortedYears.length < 2) return; // 只有一個年份沒什麼好播放的
      playing = true;
      playBtn.textContent = '⏸ 暫停';
      playBtn.classList.add('playing');
      const curX = parseFloat(scrubHandle.getAttribute('cx'));
      let curIdx = sortedYears.indexOf(nearestYear(curX));
      if(curIdx >= sortedYears.length - 1) curIdx = 0; // 已經在最後一格（或還沒開始過），從頭播
      moveScrubTo(sortedYears[curIdx], true); // 確保目前這一格有真的套用過（搖桿初始位置從沒觸發過選取）
      playTimer = setTimeout(stepPlay, PLAY_INTERVAL_MS);
    }

    let playBtn = null;
    if(sortedYears.length > 1){
      playBtn = document.createElement('button');
      playBtn.type = 'button';
      playBtn.className = 'timeline-play-btn';
      playBtn.textContent = '▶ 播放';
      playBtn.addEventListener('click', () => { playing ? stopPlaying() : startPlaying(); });
    }

    let dragging = false;
    function xFromEvent(e){
      const rect = svg.getBoundingClientRect ? svg.getBoundingClientRect() : { left: 0, width };
      const scale = width / (rect.width || width); // viewBox 座標跟實際像素寬度換算
      return (e.clientX - rect.left) * scale;
    }
    function onPointerMove(e){
      if(!dragging) return;
      const x = Math.max(PADDING, Math.min(width - PADDING, xFromEvent(e)));
      moveScrubTo(nearestYear(x), false);
    }
    function onPointerUp(){
      if(!dragging) return;
      dragging = false;
      scrubGroup.classList.remove('dragging');
      // 放開時不等 debounce，立刻套用目前指到的圖層
      if(pendingTimer){ clearTimeout(pendingTimer); pendingTimer = null; }
      const x = parseFloat(scrubHandle.getAttribute('cx'));
      moveScrubTo(nearestYear(x), true);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    }
    scrubHandle.addEventListener('pointerdown', (e)=>{
      stopPlaying(); // 使用者自己動手拖，代表想自己控制，先停掉自動播放
      dragging = true;
      scrubGroup.classList.add('dragging');
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      e.preventDefault();
    });
    // 鍵盤操作：選取搖桿後用左右鍵切換到前一個／後一個年份
    scrubHandle.addEventListener('keydown', (e)=>{
      if(e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      stopPlaying(); // 手動鍵盤操作也視為使用者想自己控制
      const curX = parseFloat(scrubHandle.getAttribute('cx'));
      const curIdx = sortedYears.indexOf(nearestYear(curX));
      if(e.key === 'ArrowRight' && curIdx < sortedYears.length - 1){
        e.preventDefault(); moveScrubTo(sortedYears[curIdx + 1], true);
      } else if(e.key === 'ArrowLeft' && curIdx > 0){
        e.preventDefault(); moveScrubTo(sortedYears[curIdx - 1], true);
      }
    });

    if(playBtn){
      const controls = document.createElement('div');
      controls.className = 'timeline-controls';
      controls.appendChild(playBtn);
      container.appendChild(controls);
    }

    const scrollWrap = document.createElement('div');
    scrollWrap.className = 'timeline-scroll';
    scrollWrap.appendChild(svg);
    container.appendChild(scrollWrap);
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
