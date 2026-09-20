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
import { sourceTypeLabel, setDisplayedPlaceNameCard } from '../features/placeNames.js';

let placeNameCardEl, placeNameCardToggleBtn, placeNameCardBodyEl;

// 取得卡片 DOM 並綁定「收合／展開」按鈕，由 ui/search.js 的 initSearchUI() 呼叫一次。
export function initPlaceNameCard(){
  placeNameCardEl = document.getElementById('placeNameCard');
  placeNameCardToggleBtn = document.getElementById('placeNameCardToggle');
  placeNameCardBodyEl = document.getElementById('placeNameCardBody');
  placeNameCardToggleBtn.addEventListener('click', ()=>{
    const collapsed = placeNameCardEl.classList.toggle('collapsed');
    placeNameCardToggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    placeNameCardToggleBtn.textContent = collapsed ? '▸' : '▾';
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

// 「地名說明」欄位超過此字元數才截斷＋加「展開全文」按鈕。
const PLACE_NAME_DESC_TRUNCATE_LENGTH = 100;

// 建立「地名說明」欄位，長文字預設截斷並附「展開全文」按鈕，點擊切換
// 全文／截斷版本；用一個布林旗標＋重繪這個欄位區塊即可，不用整張卡重繪。
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

  const needsTruncate = description.length > PLACE_NAME_DESC_TRUNCATE_LENGTH;
  if(!needsTruncate){
    valueEl.textContent = description;
    return row;
  }

  let expanded = false;
  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'place-name-desc-toggle-btn';

  function renderValue(){
    valueEl.textContent = expanded ? description : `${description.slice(0, PLACE_NAME_DESC_TRUNCATE_LENGTH)}…`;
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

// 渲染「地名今昔對照卡」內容：現名（一定顯示）、別名／舊稱（僅
// aliases 非空才顯示）、現代位置（一定顯示）、地名說明（僅 description
// 非空字串才顯示，長文字可展開/收合）、資料來源（一定顯示）。
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

  placeNameCardBodyEl.appendChild(buildPlaceNameRow('現名', place.name));

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

  placeNameCardBodyEl.appendChild(buildPlaceNameRow('現代位置', `${place.county}${place.town || ''}`));

  if(place.description){
    placeNameCardBodyEl.appendChild(buildPlaceNameDescriptionRow(place.description));
  }

  placeNameCardBodyEl.appendChild(buildPlaceNameRow('資料來源', `臺灣地區地名資料（${sourceTypeLabel(place.sourceType)}類）`));
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
