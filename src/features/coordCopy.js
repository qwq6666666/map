/* ---------------------------------------------------------
   features/coordCopy.js — 座標資訊複製共用工具
   ---------------------------------------------------------
   location.js（定位彈窗）與 search.js（搜尋結果座標資訊）原本各自
   逐字複製一份「複製座標文字＋短暫視覺回饋」「WGS84／TWD97 座標列」
   的 DOM 工廠邏輯，已出現分歧（location.js 版曾多一行冗餘的
   `btn.style.pointerEvents = 'auto'`，實際上已由 CSS 規則生效）。
   抽成這支共用模組，兩邊都改成 import，避免日後各自修改走鐘。
--------------------------------------------------------- */
import { toTWD97, formatWGS84, formatTWD97 } from '../core/tileGeo.js';

// 複製座標文字到剪貼簿，並讓按鈕短暫顯示 .copied 視覺回饋（1.5 秒後移除）。
// navigator.clipboard 在非安全上下文（例如 http）可能不存在，退回舊式
// execCommand('copy') 做基本容錯，失敗就靜默略過，不影響呼叫端功能本身。
// SonarQube javascript:S1874 複查：document.execCommand 雖已棄用，但目前
// 沒有涵蓋範圍相同的替代 API（Clipboard API 需要安全上下文），這裡刻意
// 只在 navigator.clipboard 不可用時才走這條 fallback 路徑，判定為可接受
// 的刻意選擇，維持原寫法。
export function copyCoordText(text, btn){
  const flash = () => {
    btn.classList.add('copied');
    setTimeout(()=> btn.classList.remove('copied'), 1500);
  };
  if(navigator.clipboard?.writeText){
    navigator.clipboard.writeText(text).then(flash).catch(()=>{});
    return;
  }
  try{
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    flash();
  }catch{ /* 略過 */ }
}

// 一列座標資訊（label + 值 + 複製按鈕），純 DOM 工廠函式，呼叫端決定
// 要 append 到哪裡（搜尋結果卡片、地圖 Pin 彈窗、定位彈窗皆可共用）。
// getText（選填）：複製時才即時取值。座標會隨持續定位不斷更新的列（定位
// 彈窗）要用它，否則按鈕會一直複製「建立這一列當下」的舊座標。
export function buildCoordRow(label, text, getText){
  const row = document.createElement('div');
  row.className = 'coord-info-row';
  row.innerHTML = `<span class="coord-info-label">${label}</span><span class="coord-info-value">${text}</span>`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'coord-copy-btn';
  btn.textContent = '複製';
  btn.addEventListener('click', ()=> copyCoordText(getText ? getText() : text, btn));
  row.appendChild(btn);
  return row;
}

// 座標資訊區塊（WGS84／TWD97 各一行＋一鍵複製），包一層 .coord-info 容器。
export function buildCoordInfoElement(lat, lon){
  const wrap = document.createElement('div');
  wrap.className = 'coord-info';
  wrap.appendChild(buildCoordRow('WGS84', formatWGS84(lat, lon)));
  const { x, y } = toTWD97(lat, lon);
  wrap.appendChild(buildCoordRow('TWD97', formatTWD97(x, y)));
  return wrap;
}
