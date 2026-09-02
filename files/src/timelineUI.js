/* ---------------------------------------------------------
   timelineUI.js — 搜尋結果的時間軸檢視
   ---------------------------------------------------------
   把「此地點可套疊的歷史圖層」畫成一列箭頭形狀（chevron），一個箭頭
   代表一筆圖層，箭頭首尾相接、視覺上像一條連續的路徑；不用額外的
   指示線／浮動搖桿，直接用箭頭本身的顏色表示「播放進度」：
     - 尚未經過：淡色外框
     - 已經經過：實心底色（brass）
     - 目前所在：實心強調色（stamp），沿用跟其他檢視共用的
       .layer-item.active 高亮慣例，讓 mapCore.js 的
       syncActiveLayerItemClasses() 不用另外改就能正確同步
   只依賴瀏覽器原生 SVG，不需要額外圖表函式庫。

   資料需求：每筆候選圖層的 layer.yearNum 是數字或 null（見
   data.js 的 mapLayer）。沒有 yearNum 的圖層無法定位在時間軸上，
   另外收在時間軸下方的「年代不明」清單。

   排列方式：依年份「順序」等間距排開，不按實際年份比例定位——
   真實年代分布常常前後跳很多年，照實際比例畫，畫面會一段擠成一團、
   一段留一大片空白；等間距能讓畫面平均分布、乾淨好讀，兩個箭頭之間
   的距離不代表真實年數差距，但每一組箭頭下方都會標示自己的年份。
--------------------------------------------------------- */

const SVG_NS = 'http://www.w3.org/2000/svg';

// 拖曳／播放時，畫面（箭頭顏色）即時跟著手指走，完全不花任何網路成本；
// 但「真正套疊圖層」這個動作（會讓瀏覽器去抓圖磚）刻意做了節流：
//   1. 只有拖到的箭頭真的換了一筆，才會考慮觸發
//   2. 而且要等手指停下來 SCRUB_DEBOUNCE_MS 之後才真的觸發
// 這樣快速滑過中間好幾筆時，只有最後停下來的那一筆會真的載入，
// 而不是每移動一點點就發一次圖磚請求。放開手指（pointerup）時，
// 不等 debounce，直接立即套用目前指到的圖層。
const SCRUB_DEBOUNCE_MS = 150;

// 自動播放時，每一筆停留的時間。故意比拖曳的 debounce 長很多，
// 讓每一張圖至少有機會開始把圖磚載入完，畫面才看得出東西。
const PLAY_INTERVAL_MS = 1800;

function svgEl(tag, attrs){
  const el = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs || {}).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}

// 產生一個「首尾相接」的箭頭（chevron）多邊形座標：左側有個凹口，
// 正好卡進前一個箭頭右側的尖端，視覺上像一條連續的路徑，不需要
// 額外畫連接線。x/y 是箭頭外框左上角，w/h 是箭頭外框寬高，
// notch 是凹口／尖端的深度。
function arrowPoints(x, y, w, h, notch){
  const midY = y + h / 2;
  return [
    `${x},${y}`,
    `${x + w - notch},${y}`,
    `${x + w},${midY}`,
    `${x + w - notch},${y + h}`,
    `${x},${y + h}`,
    `${x + notch},${midY}`
  ].join(' ');
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
    // 依年份排序（年份相同時維持原本清單順序），決定箭頭從左到右的排列。
    const items = [...dated].sort((a, b) => a.layer.yearNum - b.layer.yearNum);

    const ARROW_W = 40;   // 箭頭不要太長，維持緊湊
    const ARROW_H = 30;
    const NOTCH = 9;      // 凹口／尖端深度，越大箭頭形狀越明顯
    const PADDING = 10;
    const STEP = ARROW_W - NOTCH; // 每個箭頭往右移動的距離（扣掉凹口讓箭頭相連）

    const width = Math.max(320, items.length * STEP + NOTCH + PADDING * 2);
    const height = ARROW_H + 24; // 箭頭本體 + 底下年份文字空間
    const rowY = 2;

    const svg = svgEl('svg', {
      viewBox: `0 0 ${width} ${height}`,
      width, height,
      class: 'timeline-svg',
      role: 'img',
      'aria-label': '搜尋結果依年代排列的時間軸'
    });

    // 把相鄰、同一年份的箭頭分成一組，年份文字置中標示在整組下方，
    // 避免同年份好幾個箭頭下面重複印出一樣的年份、看起來很擠。
    const groups = [];
    items.forEach(c => {
      const last = groups[groups.length - 1];
      if(last && last.year === c.layer.yearNum) last.items.push(c);
      else groups.push({ year: c.layer.yearNum, items: [c] });
    });

    const arrowList = []; // { el, layer, src, year }，依左到右順序，供播放／拖曳／鍵盤操作使用

    let x = PADDING;
    groups.forEach(group => {
      const groupStartX = x;
      group.items.forEach(c => {
        const poly = svgEl('polygon', {
          points: arrowPoints(x, rowY, ARROW_W, ARROW_H, NOTCH),
          class: 'layer-item timeline-arrow', // 沿用 layer-item，跟其他檢視共用 active 高亮機制
          tabindex: '0', role: 'button'
        });
        poly.dataset.layerId = c.layer.id;

        const tooltip = svgEl('title', {});
        tooltip.textContent = `${c.layer.year} ${c.layer.title}（${c.src.name}）`;
        poly.appendChild(tooltip);

        svg.appendChild(poly);
        arrowList.push({ el: poly, layer: c.layer, src: c.src, year: c.layer.yearNum });
        x += STEP;
      });
      const groupEndX = groupStartX - STEP + group.items.length * STEP + ARROW_W;
      const label = svgEl('text', {
        x: (groupStartX + groupEndX) / 2, y: rowY + ARROW_H + 17,
        'text-anchor': 'middle', class: 'timeline-tick-label'
      });
      label.textContent = group.year;
      svg.appendChild(label);
    });

    // ---------------------------------------------------------
    // 播放進度上色：目前所在的箭頭標記 active（沿用跟其他檢視共用的
    // 高亮慣例），已經播過的箭頭標記 passed（實心底色），還沒播到的
    // 維持預設的淡色外框。
    // ---------------------------------------------------------
    let currentIndex = -1; // 還沒選過任何一筆之前是 -1，全部維持預設外觀
    let pendingTimer = null;
    let lastFiredLayerId = null;

    function paintProgress(idx){
      arrowList.forEach((item, i) => {
        item.el.classList.toggle('passed', i < idx);
        item.el.classList.toggle('active', i === idx);
      });
    }

    function selectIndex(idx, immediate){
      idx = Math.max(0, Math.min(arrowList.length - 1, idx));
      currentIndex = idx;
      paintProgress(idx);
      const item = arrowList[idx];
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

    function stopPlaying(){
      if(!playing) return;
      playing = false;
      if(playTimer){ clearTimeout(playTimer); playTimer = null; }
      playBtn.textContent = '▶ 播放';
      playBtn.classList.remove('playing');
    }

    function stepPlay(){
      const nextIdx = currentIndex + 1;
      if(nextIdx >= arrowList.length){
        stopPlaying();
        return;
      }
      selectIndex(nextIdx, true);
      if(nextIdx >= arrowList.length - 1){
        stopPlaying(); // 這一步剛好到最後一筆，直接停止，不用再空等一輪才停
      } else {
        playTimer = setTimeout(stepPlay, PLAY_INTERVAL_MS);
      }
    }

    function startPlaying(){
      if(arrowList.length < 2) return; // 只有一筆沒什麼好播放的
      playing = true;
      playBtn.textContent = '⏸ 暫停';
      playBtn.classList.add('playing');
      const startIdx = currentIndex >= arrowList.length - 1 ? 0 : Math.max(0, currentIndex);
      selectIndex(startIdx, true); // 確保目前這一筆有真的套用過（一開始還沒選過任何東西時）
      playTimer = setTimeout(stepPlay, PLAY_INTERVAL_MS);
    }

    let playBtn = null;
    if(arrowList.length > 1){
      playBtn = document.createElement('button');
      playBtn.type = 'button';
      playBtn.className = 'timeline-play-btn';
      playBtn.textContent = '▶ 播放';
      playBtn.addEventListener('click', () => { playing ? stopPlaying() : startPlaying(); });
    }

    // ---------------------------------------------------------
    // 互動：點單一箭頭直接選取；在整排箭頭上按住拖曳，依手指位置
    // 即時上色、放開才真正套用（debounce 見 selectIndex）；鍵盤
    // 選取某個箭頭後可用左右鍵切換到前一筆／後一筆。
    // ---------------------------------------------------------
    function indexFromEvent(e){
      const rect = svg.getBoundingClientRect ? svg.getBoundingClientRect() : { left: 0, width };
      const scale = width / (rect.width || width); // viewBox 座標跟實際像素寬度換算
      const x = (e.clientX - rect.left) * scale;
      const idx = Math.round((x - PADDING - ARROW_W / 2) / STEP);
      return Math.max(0, Math.min(arrowList.length - 1, idx));
    }

    let dragging = false;
    function onPointerMove(e){
      if(!dragging) return;
      selectIndex(indexFromEvent(e), false);
    }
    function onPointerUp(e){
      if(!dragging) return;
      dragging = false;
      svg.classList.remove('dragging');
      if(pendingTimer){ clearTimeout(pendingTimer); pendingTimer = null; }
      selectIndex(indexFromEvent(e), true); // 放開時不等 debounce，立刻套用
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    }
    svg.addEventListener('pointerdown', (e)=>{
      if(!e.target.classList || !e.target.classList.contains('timeline-arrow')) return;
      stopPlaying(); // 使用者自己動手拖，代表想自己控制，先停掉自動播放
      dragging = true;
      svg.classList.add('dragging');
      selectIndex(indexFromEvent(e), false);
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      e.preventDefault();
    });

    arrowList.forEach((item, i) => {
      item.el.addEventListener('click', () => { stopPlaying(); selectIndex(i, true); });
      item.el.addEventListener('keydown', (e)=>{
        if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); stopPlaying(); selectIndex(i, true); }
        else if(e.key === 'ArrowRight' && i < arrowList.length - 1){ e.preventDefault(); stopPlaying(); selectIndex(i + 1, true); arrowList[i+1].el.focus && arrowList[i+1].el.focus(); }
        else if(e.key === 'ArrowLeft' && i > 0){ e.preventDefault(); stopPlaying(); selectIndex(i - 1, true); arrowList[i-1].el.focus && arrowList[i-1].el.focus(); }
      });
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
