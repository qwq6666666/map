/* ---------------------------------------------------------
   ui/placeNameCard.js — 地名今昔對照卡（渲染／收合）
   ---------------------------------------------------------
   從 ui/search.js 拆出來的「單張卡片」渲染邏輯：建立卡片內容列、
   顯示／隱藏／展開卡片。只認得 #placeNameCard 這組 DOM，不碰地址搜尋
   輸入框、建議清單或結果面板；搜尋流程（何時該顯示哪一張卡片）仍由
   ui/search.js 決定，這裡只負責「把一筆 place 畫出來」。
   ui/search.js 有 re-export hidePlaceNameCard／renderPlaceNameCard／
   focusPlaceNameCard，既有的 import 路徑（main.js、tests）不用改。
--------------------------------------------------------- */
import { sourceTypeLabel, setDisplayedPlaceNameCard, summarizeDescription } from '../features/placeNames.js';

let placeNameCardEl, placeNameCardToggleBtn, placeNameCardBodyEl, placeNameCardTeaserEl;

// 取得卡片 DOM 並綁定「收合／展開」按鈕，由 ui/search.js 的 initSearchUI() 呼叫一次。
export function initPlaceNameCard(){
  placeNameCardEl = document.getElementById('placeNameCard');
  placeNameCardToggleBtn = document.getElementById('placeNameCardToggle');
  placeNameCardBodyEl = document.getElementById('placeNameCardBody');
  placeNameCardTeaserEl = document.getElementById('placeNameCardTeaser');
  placeNameCardToggleBtn.addEventListener('click', ()=>{
    const collapsed = placeNameCardEl.classList.toggle('collapsed');
    placeNameCardToggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    placeNameCardToggleBtn.textContent = collapsed ? '▸' : '▾';
  });
  // 整條標題列都能點來收合／展開：只有右邊 20px 的圓鈕太小，手機上很難
  // 點準。轉發給圓鈕的 click，狀態切換邏輯仍只有上面那一份；點到圓鈕
  // 本身時不轉發，否則會切換兩次等於沒動。
  const head = placeNameCardEl.querySelector('.place-name-card-head');
  head?.addEventListener('click', (e)=>{
    if(e.target === placeNameCardToggleBtn) return;
    placeNameCardToggleBtn.click();
  });
}

// 隱藏並清空「地名今昔對照卡」，同時把收合狀態重設回收合（目前的預設
// 初始狀態），確保下次顯示時是乾淨的初始狀態。
// 有 export：供 tests/specs/place-name-card-ui.test.mjs 直接呼叫驗證，
// 純粹讓函式可測試化，不影響原本模組內部呼叫方式或行為。
export function hidePlaceNameCard(){
  setDisplayedPlaceNameCard(null);
  if(!placeNameCardEl) return;
  placeNameCardEl.hidden = true;
  placeNameCardBodyEl.innerHTML = '';
  if(placeNameCardTeaserEl) placeNameCardTeaserEl.textContent = '';
  placeNameCardEl.classList.add('collapsed');
  placeNameCardToggleBtn?.setAttribute('aria-expanded', 'false');
  if(placeNameCardToggleBtn) placeNameCardToggleBtn.textContent = '▸';
}

// 建立單一欄位列（label + value），value 可以是字串或已組好的元素。
function buildPlaceNameRow(label, valueNode){
  const row = document.createElement('div');
  row.className = 'place-name-row';
  const labelEl = document.createElement('span');
  labelEl.className = 'place-name-row-label';
  labelEl.textContent = label;
  row.appendChild(labelEl);
  if(typeof valueNode === 'string'){
    const valueEl = document.createElement('span');
    valueEl.className = 'place-name-row-value';
    valueEl.textContent = valueNode;
    row.appendChild(valueEl);
  } else {
    row.appendChild(valueNode);
  }
  return row;
}

// 建立「地名說明」欄位：預設只顯示一句話摘要（summarizeDescription），
// 說明較長時附「展開全文」按鈕，點擊切換全文／摘要；用一個布林旗標＋
// 重繪這個欄位區塊即可，不用整張卡重繪。
function buildPlaceNameDescriptionRow(description){
  const row = document.createElement('div');
  row.className = 'place-name-row';
  const labelEl = document.createElement('span');
  labelEl.className = 'place-name-row-label';
  labelEl.textContent = '地名說明';
  row.appendChild(labelEl);

  const valueEl = document.createElement('span');
  valueEl.className = 'place-name-row-value';
  row.appendChild(valueEl);

  const { summary, truncated } = summarizeDescription(description);
  if(!truncated){
    valueEl.textContent = summary;
    return row;
  }

  let expanded = false;
  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'place-name-desc-toggle-btn';

  function renderValue(){
    valueEl.textContent = expanded ? description : summary;
    toggleBtn.textContent = expanded ? '收合' : '展開全文';
  }
  toggleBtn.addEventListener('click', ()=>{
    expanded = !expanded;
    renderValue();
  });
  renderValue();
  row.appendChild(toggleBtn);
  return row;
}

// 收合時標題列右側的「預覽」：讓使用者不用展開就看得到最有感的一句——
// 有舊稱優先顯示舊稱（「今昔」對照的重點），沒有就用說明的一句話摘要，
// 再沒有才顯示現代位置。單行、超出以省略號截斷（CSS 處理）。
function buildTeaserText(place){
  if(place.aliases && place.aliases.length > 0) return `舊稱：${place.aliases.join('、')}`;
  if(place.description) return summarizeDescription(place.description).summary;
  return `${place.county || ''}${place.town || ''}`;
}

// 「現名」與「現代位置」併成同一列：現名粗體，位置接在旁邊用小字，
// 省下一整列，也不再有兩個標籤各佔一行。
function buildPlaceNameHeadingRow(place){
  const valueEl = document.createElement('span');
  valueEl.className = 'place-name-row-value';
  const nameEl = document.createElement('strong');
  nameEl.className = 'place-name-current';
  nameEl.textContent = place.name;
  valueEl.appendChild(nameEl);
  const loc = `${place.county || ''}${place.town || ''}`;
  if(loc){
    const locEl = document.createElement('span');
    locEl.className = 'place-name-loc';
    locEl.textContent = loc;
    valueEl.appendChild(locEl);
  }
  return buildPlaceNameRow('現名', valueEl);
}

// 渲染「地名今昔對照卡」內容：現名＋現代位置（同一列、一定顯示）、
// 別名／舊稱（僅 aliases 非空才顯示）、地名說明（僅 description 非空
// 字串才顯示，預設一句話摘要、較長時可展開全文）、資料來源（一定顯示，
// 淡色小字註腳）。
// 卡片內容一律完整渲染好，但外層預設收合（避免跟定位結果列、可用圖層
// 清單一次疊出過長內容），使用者點展開鈕時不需要重新渲染就能看到內容。
// 有 export：供 tests/specs/place-name-card-ui.test.mjs 直接呼叫驗證，
// 純粹讓函式可測試化，不影響原本模組內部呼叫方式或行為。
export function renderPlaceNameCard(place){
  if(!placeNameCardEl) return;
  setDisplayedPlaceNameCard(place);
  placeNameCardBodyEl.innerHTML = '';
  placeNameCardEl.hidden = false;
  placeNameCardEl.classList.add('collapsed');
  placeNameCardToggleBtn?.setAttribute('aria-expanded', 'false');
  if(placeNameCardToggleBtn) placeNameCardToggleBtn.textContent = '▸';
  if(placeNameCardTeaserEl) placeNameCardTeaserEl.textContent = buildTeaserText(place);

  placeNameCardBodyEl.appendChild(buildPlaceNameHeadingRow(place));

  if(place.aliases && place.aliases.length > 0){
    const aliasWrap = document.createElement('div');
    aliasWrap.className = 'place-name-alias-list';
    place.aliases.forEach(alias=>{
      const tag = document.createElement('span');
      tag.className = 'place-name-alias-tag';
      tag.textContent = alias;
      aliasWrap.appendChild(tag);
    });
    placeNameCardBodyEl.appendChild(buildPlaceNameRow('別名／舊稱', aliasWrap));
  }

  if(place.description){
    placeNameCardBodyEl.appendChild(buildPlaceNameDescriptionRow(place.description));
  }

  const sourceNote = document.createElement('div');
  sourceNote.className = 'place-name-source-note';
  sourceNote.textContent = `資料來源：臺灣地區地名資料（${sourceTypeLabel(place.sourceType)}類）`;
  placeNameCardBodyEl.appendChild(sourceNote);
}

// 供 identifyPin.js 落點彈窗「查看地名沿革」按鈕呼叫（由 main.js 接進
// initIdentifyPin() 的 onViewPlaceNameCard 參數），把目前顯示中的地名
// 今昔對照卡展開並捲動進畫面。卡片本來就隱藏（例如使用者已清除搜尋、
// 或目前作用中的比對點跟這次落點不同）時不做任何事。
export function focusPlaceNameCard(){
  if(!placeNameCardEl || placeNameCardEl.hidden) return;
  placeNameCardEl.classList.remove('collapsed');
  placeNameCardToggleBtn?.setAttribute('aria-expanded', 'true');
  if(placeNameCardToggleBtn) placeNameCardToggleBtn.textContent = '▾';
  placeNameCardEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
