/* ---------------------------------------------------------
   features/multiOverlay.js — 複合疊圖模式：多選圖層 UI
   ---------------------------------------------------------
   兩個畫面元件：
     1. 側邊欄的 checkbox 式圖層樹（#multiCategories）：可以勾選
        多張圖層，勾一次加入疊圖組合、再勾一次移出。跟疊圖模式的
        單選手風琴（sidebarUI.js 的 #categories）是完全獨立的一份
        DOM，即使畫的是同一批 LAYER_SOURCES 資料，也不會共用節點——
        共用的話，兩種點擊語意（單選 toggle vs 多選 checkbox）會
        互相干擾。複用的是 uiTree.js 的 buildCategoryList()，跟
        sidebarUI.js／features/compareMode.js 的做法一致。
     2. 地圖下方浮動的「已選圖層」清單面板（#multiOverlayBar）：每
        張圖層一列，各自的透明度滑桿、疊放順序上下移、移除。跟
        #mapTimelineBar／.compare-float-item 走同一套「模式專屬控制
        放在地圖上的浮動元件」慣例（見 index.html 的既有安排），不
        塞進側邊欄，因為側邊欄同時還要放 checkbox 圖層樹，兩份清單
        擠在一起會太擁擠。

   透明度滑桿刻意不是「拖曳中就即時寫回 store」：跟
   core/layerManager.js 疊圖模式的透明度滑桿理由一樣——如果每次
   'input' 事件都觸發 store 廣播，multiOverlayLayers 改變會讓
   renderMultiOverlayBar() 整份清單重新建立 DOM，拖曳中的那顆滑桿
   元素被換掉，手感會斷掉。所以 'input' 只直接調整地圖上的圖層＋
   更新這一列自己的顯示文字，放開滑桿的 'change' 事件才真的寫回
   store（讓這個透明度值能在清單增減／重新排序時被正確保留、重繪）。

   對外只匯出 core/modeManager.js 需要用到的部分：
     - initMultiOverlayUI()：初始化 DOM，由 mapCore.js 的
       initMapCore() 呼叫一次。
     - syncMultiLayerCheckedClasses()：依 store.multiOverlayLayers
       同步側邊欄 checkbox 的勾選樣式。
     - renderMultiOverlayBar()：重繪浮動清單面板。
--------------------------------------------------------- */
import {
  state as store,
  toggleMultiOverlayLayer,
  removeMultiOverlayLayer,
  setMultiOverlayOpacity,
  moveMultiOverlayLayer,
  clearMultiOverlayLayers,
  addCustomSource,
  removeCustomSource,
  clearCustomSources
} from '../store.js';
import { LAYER_SOURCES, layerKey, titleForKey, setCustomSourcesProvider } from '../data.js';
import { buildCategoryList } from '../uiTree.js';
import { createCountryFilterBar } from '../ui/countryFilter.js';
import { setLayerOpacity } from '../core/layerCache.js';
import { map } from '../core/map.js';
import { fetchCapabilities, listLayers, buildWmtsEntryConfig } from './wmtsImport.js';

let multiCategoriesEl, multiOverlayBarInnerEl;
const sourceWraps = []; // [{ src, wrap }]，供 syncMultiLayerCheckedClasses() 用來限定查詢範圍

export function initMultiOverlayUI(){
  multiCategoriesEl = document.getElementById('multiCategories');
  multiOverlayBarInnerEl = document.getElementById('multiOverlayBarInner');

  const { bar: filterBar, refresh: refreshCountryFilter } = createCountryFilterBar(() => sourceWraps);
  multiCategoriesEl.appendChild(filterBar);

  LAYER_SOURCES.forEach((src) => {
    const srcWrap = document.createElement('div');
    srcWrap.className = 'source-group';

    const srcHead = document.createElement('button');
    srcHead.type = 'button';
    srcHead.className = 'source-head';
    const total = src.categories.reduce((s,c)=> s + (c.groups ? c.groups.reduce((gs,g)=>gs+g.layers.length,0) : c.layers.length), 0);
    srcHead.innerHTML = `<span><span class="chevron">▸</span>${src.name}</span><span class="count">${total}</span>`;
    srcHead.addEventListener('click', ()=> srcWrap.classList.toggle('open'));

    const srcBody = document.createElement('div');
    srcBody.className = 'source-body';
    // singleOpen = false：checkbox 多選圖層樹要讓使用者能同時展開
    // 多個分類／次分類跨著勾選，不套用手風琴收合行為（見 uiTree.js 註解）。
    buildCategoryList(src.categories, srcBody, (layer) => toggleMultiOverlayLayer(layerKey(src, layer)), false, false);

    srcWrap.appendChild(srcHead);
    srcWrap.appendChild(srcBody);
    multiCategoriesEl.appendChild(srcWrap);
    sourceWraps.push({ src, wrap: srcWrap });
  });

  refreshCountryFilter();

  document.getElementById('multiOverlayClearBtn').addEventListener('click', clearMultiOverlayLayers);

  // 讓 data.js 的 makeSourceForKey()／titleForKey() 能查到使用者自訂
  // 來源清單，同時又不用讓 data.js 反過來 import store.js（見 data.js
  // 檔頭關於「不依賴任何其他 src 模組」的說明，這裡用參數注入取代
  // 直接 import）。
  setCustomSourcesProvider(() => store.customSources);
  initCustomSourcesUI();
}

/* ---------------------------------------------------------
   使用者自訂 WMTS／XYZ 圖層：新增表單 + 清單
   ---------------------------------------------------------
   刻意不走疊圖模式（activeOverlayKey）那條路：那條路徑的 stamp／
   淡入淡出效果依賴內建圖層才有的 year／title 欄位，自訂來源沒有這些
   資料。改成沿用複合疊圖模式現成的 { key, opacity } 勾選機制
   （toggleMultiOverlayLayer），對 layerCache／protectedKeys 而言
   custom: 開頭的 key 跟 hist: 開頭的 key 沒有分別，不需要另外改動
   那兩支模組。
--------------------------------------------------------- */
let customListEl, customFormEls;

function handleAddCustomSource(){
  const { name, url, format, attribution } = customFormEls;
  const urlTemplate = url.value.trim();
  if(!urlTemplate){
    url.focus();
    return;
  }
  if(!urlTemplate.includes('{z}') || !urlTemplate.includes('{x}') || !urlTemplate.includes('{y}')){
    alert('網址樣板需要包含 {z}、{x}、{y} 三個佔位符，例如：\nhttps://example.com/tiles/{z}/{x}/{y}.png');
    return;
  }
  const entry = addCustomSource({
    name: name.value,
    urlTemplate,
    format: format.value,
    attribution: attribution.value
  });
  // 加入後直接勾選顯示，使用者不用「新增」完再手動點一次清單。
  toggleMultiOverlayLayer(`custom:${entry.id}`);
  name.value = ''; url.value = ''; format.value = ''; attribution.value = '';
  name.focus();
}

function initCustomSourcesUI(){
  customListEl = document.getElementById('customSourceList');
  customFormEls = {
    name: document.getElementById('customSourceName'),
    url: document.getElementById('customSourceUrl'),
    format: document.getElementById('customSourceFormat'),
    attribution: document.getElementById('customSourceAttribution')
  };
  document.getElementById('customSourceAddBtn').addEventListener('click', handleAddCustomSource);
  document.getElementById('customSourceClearAllBtn').addEventListener('click', ()=>{
    if(store.customSources.length === 0) return;
    if(!confirm('清除全部自訂圖層？這會一併從目前的疊圖組合移除，且無法復原。')) return;
    clearCustomSources();
  });
  initCustomSourceTabs();
  initWmtsImportUI();
  renderCustomSourcesPanel();
}

// 兩種新增方式共用同一個 .custom-source-block，用分頁切換顯示，避免
// 兩份表單同時擠在畫面上；「手動貼網址」是原本就有的簡單模式，
// 「從 WMTS 服務匯入」是這次新加的（見下方 initWmtsImportUI()）。
function initCustomSourceTabs(){
  const tabButtons = Array.from(document.querySelectorAll('#customSourceTabs button[data-tab]'));
  const panels = {
    manual: document.getElementById('customSourceManualPanel'),
    wmts: document.getElementById('customSourceWmtsPanel')
  };
  tabButtons.forEach(btn=>{
    btn.addEventListener('click', ()=>{
      tabButtons.forEach(b => b.classList.toggle('active', b === btn));
      Object.entries(panels).forEach(([tabId, el])=>{
        if(el) el.style.display = (tabId === btn.dataset.tab) ? 'block' : 'none';
      });
    });
  });
}

/* ---------------------------------------------------------
   從 WMTS 服務的 GetCapabilities 匯入圖層
   ---------------------------------------------------------
   實際的抓取／解析／座標系比對邏輯都在 features/wmtsImport.js，這裡
   只管畫面：輸入網址 → 讀取圖層清單 → 勾選 → 加入。wmtsImportState
   保留「這次讀到的 capabilities 物件＋圖層清單」，讓「加入勾選的圖層」
   不用重新抓一次 GetCapabilities。
--------------------------------------------------------- */
let wmtsImportEls;
let wmtsImportState = { capabilities: null, layers: [] };

function initWmtsImportUI(){
  wmtsImportEls = {
    url: document.getElementById('wmtsCapabilitiesUrl'),
    fetchBtn: document.getElementById('wmtsFetchBtn'),
    status: document.getElementById('wmtsImportStatus'),
    list: document.getElementById('wmtsLayerList'),
    selectAllBtn: document.getElementById('wmtsSelectAllBtn'),
    addSelectedBtn: document.getElementById('wmtsAddSelectedBtn')
  };
  wmtsImportEls.fetchBtn.addEventListener('click', handleFetchWmtsCapabilities);
  wmtsImportEls.selectAllBtn.addEventListener('click', handleToggleSelectAllWmtsLayers);
  wmtsImportEls.addSelectedBtn.addEventListener('click', handleAddSelectedWmtsLayers);
}

function setWmtsStatus(message, isError){
  wmtsImportEls.status.textContent = message;
  wmtsImportEls.status.classList.toggle('custom-source-error', !!isError);
}

async function handleFetchWmtsCapabilities(){
  const url = wmtsImportEls.url.value.trim();
  wmtsImportEls.list.innerHTML = '';
  wmtsImportEls.selectAllBtn.style.display = 'none';
  wmtsImportEls.addSelectedBtn.style.display = 'none';
  wmtsImportState = { capabilities: null, layers: [] };
  setWmtsStatus('讀取中…', false);
  wmtsImportEls.fetchBtn.disabled = true;
  try{
    const capabilities = await fetchCapabilities(url);
    const layers = listLayers(capabilities);
    wmtsImportState = { capabilities, layers };
    renderWmtsLayerList(layers);
    setWmtsStatus(`找到 ${layers.length} 張圖層，勾選要加入的圖層後按「加入勾選的圖層」。`, false);
    wmtsImportEls.selectAllBtn.style.display = 'inline-block';
    wmtsImportEls.addSelectedBtn.style.display = 'inline-block';
  }catch(err){
    setWmtsStatus(err.message || '讀取失敗，請確認網址是否正確', true);
  }finally{
    wmtsImportEls.fetchBtn.disabled = false;
  }
}

function renderWmtsLayerList(layers){
  wmtsImportEls.list.innerHTML = '';
  layers.forEach(l=>{
    const row = document.createElement('label');
    row.className = 'wmts-layer-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.identifier = l.identifier;

    const titleSpan = document.createElement('span');
    titleSpan.className = 'wmts-layer-title';
    titleSpan.textContent = l.title;
    titleSpan.title = l.identifier; // 滑鼠移過去可以看到原始圖層識別碼，方便跟服務文件對照

    row.appendChild(checkbox);
    row.appendChild(titleSpan);
    wmtsImportEls.list.appendChild(row);
  });
}

function handleToggleSelectAllWmtsLayers(){
  const checkboxes = wmtsImportEls.list.querySelectorAll('input[type=checkbox]');
  const allChecked = checkboxes.length > 0 && Array.from(checkboxes).every(cb => cb.checked);
  checkboxes.forEach(cb => { cb.checked = !allChecked; });
}

// 逐一把勾選的圖層轉成 customSources 項目。同一張圖層即使 GetCapabilities
// 裡列著，也可能找不到跟地圖 EPSG:3857 相容的 TileMatrixSet（見
// wmtsImport.js 的 buildWmtsEntryConfig() 說明）——這種情況不是程式錯誤，
// 是那張圖層本來就無法疊在這個地圖上，直接略過並在狀態列列出來，不要
// 整批操作因為其中一張失敗就整個中斷。
function handleAddSelectedWmtsLayers(){
  const checkboxes = Array.from(wmtsImportEls.list.querySelectorAll('input[type=checkbox]:checked'));
  if(checkboxes.length === 0){
    setWmtsStatus('請先勾選至少一張圖層', true);
    return;
  }
  if(!wmtsImportState.capabilities) return;

  let addedCount = 0;
  const skippedTitles = [];

  checkboxes.forEach(cb=>{
    const identifier = cb.dataset.identifier;
    const layerInfo = wmtsImportState.layers.find(l => l.identifier === identifier);
    const displayName = layerInfo ? layerInfo.title : identifier;
    const config = buildWmtsEntryConfig(wmtsImportState.capabilities, identifier);
    if(!config){
      skippedTitles.push(displayName);
      return;
    }
    const entry = addCustomSource({ type: 'wmts', name: displayName, wmts: config, attribution: '' });
    toggleMultiOverlayLayer(`custom:${entry.id}`); // 加入後直接勾選顯示，不用使用者再手動找一次
    addedCount++;
  });

  if(addedCount > 0 && skippedTitles.length === 0){
    setWmtsStatus(`已加入 ${addedCount} 張圖層。`, false);
  } else if(addedCount > 0){
    setWmtsStatus(`已加入 ${addedCount} 張圖層；「${skippedTitles.join('、')}」沒有相容 EPSG:3857 的座標系統，已略過。`, true);
  } else {
    setWmtsStatus(`勾選的圖層都沒有相容 EPSG:3857 的座標系統，無法加入：「${skippedTitles.join('、')}」`, true);
  }
}

function buildCustomSourceRow(entry){
  const row = document.createElement('div');
  row.className = 'custom-source-row';

  const label = document.createElement('label');
  label.className = 'custom-source-label';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  const key = `custom:${entry.id}`;
  checkbox.checked = store.multiOverlayLayers.some(e => e.key === key);
  checkbox.addEventListener('change', ()=> toggleMultiOverlayLayer(key));

  const nameSpan = document.createElement('span');
  nameSpan.className = 'custom-source-name';
  nameSpan.textContent = entry.name;
  nameSpan.title = entry.type === 'wmts'
    ? `WMTS：${entry.wmts && entry.wmts.layer || ''}（${entry.wmts && entry.wmts.matrixSet || ''}）`
    : entry.urlTemplate;

  if(entry.type === 'wmts'){
    const badge = document.createElement('span');
    badge.className = 'custom-source-badge';
    badge.textContent = 'WMTS';
    nameSpan.appendChild(document.createTextNode(' '));
    nameSpan.appendChild(badge);
  }

  label.appendChild(checkbox);
  label.appendChild(nameSpan);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'custom-source-remove';
  removeBtn.title = '刪除這筆自訂圖層';
  removeBtn.textContent = '✕';
  removeBtn.addEventListener('click', ()=> removeCustomSource(entry.id));

  row.appendChild(label);
  row.appendChild(removeBtn);
  return row;
}

// 重繪自訂來源清單：新增／刪除／勾選狀態改變時都呼叫這個，重新畫一次
// 整份清單即可——清單通常不會很長，不需要做局部更新的複雜度。
export function renderCustomSourcesPanel(){
  if(!customListEl) return;
  customListEl.innerHTML = '';
  if(store.customSources.length === 0){
    const empty = document.createElement('div');
    empty.className = 'custom-source-empty';
    empty.textContent = '尚未加入任何自訂圖層。';
    customListEl.appendChild(empty);
    return;
  }
  store.customSources.forEach(entry => customListEl.appendChild(buildCustomSourceRow(entry)));
}

// 側邊欄 checkbox 樹的勾選樣式：沿用既有的 .layer-item.active（跟疊圖
// 模式單選時代表的意義不同，但視覺上都是「目前生效」高亮，可以共用
// 同一顆 class，不需要另外定義一組樣式）。用 data-layer-id 反查，
// 範圍限定在各自來源的 srcWrap 底下，避免不同來源剛好用了相同 id
// 互相誤觸發（layer.id 只保證同一個來源內唯一）。
export function syncMultiLayerCheckedClasses(){
  if(!multiCategoriesEl) return;
  sourceWraps.forEach(({ wrap }) => {
    wrap.querySelectorAll('.layer-item.active').forEach(el => el.classList.remove('active'));
  });
  store.multiOverlayLayers.forEach(entry => {
    const parts = entry.key.split(':'); // ["hist", sourceId, id, fmt]
    const wrapInfo = sourceWraps.find(w => w.src.id === parts[1]);
    if(!wrapInfo) return;
    wrapInfo.wrap.querySelectorAll(`.layer-item[data-layer-id="${parts[2]}"]`).forEach(el => el.classList.add('active'));
  });
}

function buildMultiLayerRow(entry, idx, total){
  const row = document.createElement('div');
  row.className = 'multi-layer-row';

  const titleEl = document.createElement('span');
  titleEl.className = 'multi-layer-title';
  titleEl.textContent = titleForKey(entry.key);

  const opacityInput = document.createElement('input');
  opacityInput.type = 'range';
  opacityInput.className = 'multi-layer-opacity';
  opacityInput.min = '0'; opacityInput.max = '100';
  opacityInput.value = String(entry.opacity);

  const opacityVal = document.createElement('span');
  opacityVal.className = 'multi-layer-opacity-val';
  opacityVal.textContent = entry.opacity + '%';

  opacityInput.addEventListener('input', ()=>{
    const v = parseInt(opacityInput.value, 10);
    opacityVal.textContent = v + '%';
    setLayerOpacity(entry.key, v/100); // 拖曳中：直接調圖層，不經過 store（見檔頭說明）
    map.render();
  });
  opacityInput.addEventListener('change', ()=>{
    setMultiOverlayOpacity(entry.key, parseInt(opacityInput.value, 10)); // 放開才寫回 store
  });

  const upBtn = document.createElement('button');
  upBtn.type = 'button'; upBtn.className = 'multi-layer-move'; upBtn.title = '疊到更上層';
  upBtn.textContent = '▲';
  if(idx === total - 1) upBtn.disabled = true;
  upBtn.addEventListener('click', ()=> moveMultiOverlayLayer(entry.key, 1));

  const downBtn = document.createElement('button');
  downBtn.type = 'button'; downBtn.className = 'multi-layer-move'; downBtn.title = '疊到更下層';
  downBtn.textContent = '▼';
  if(idx === 0) downBtn.disabled = true;
  downBtn.addEventListener('click', ()=> moveMultiOverlayLayer(entry.key, -1));

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button'; removeBtn.className = 'multi-layer-remove'; removeBtn.title = '移除這張圖層';
  removeBtn.textContent = '✕';
  removeBtn.addEventListener('click', ()=> removeMultiOverlayLayer(entry.key));

  const controls = document.createElement('div');
  controls.className = 'multi-layer-controls';
  controls.appendChild(opacityInput);
  controls.appendChild(opacityVal);
  controls.appendChild(upBtn);
  controls.appendChild(downBtn);
  controls.appendChild(removeBtn);

  row.appendChild(titleEl);
  row.appendChild(controls);
  return row;
}

// 重繪浮動清單面板。顯示順序（清單第一筆＝畫面最上面）刻意跟
// store.multiOverlayLayers 的儲存順序相反——陣列是「index 越大疊越
// 上層」，但清單面板比照一般繪圖軟體的圖層面板慣例「最上面那列＝
// 疊在最上層」，所以畫之前先反轉一次。
export function renderMultiOverlayBar(){
  if(!multiOverlayBarInnerEl) return;
  multiOverlayBarInnerEl.innerHTML = '';
  const list = store.multiOverlayLayers;
  if(list.length === 0){
    const empty = document.createElement('div');
    empty.className = 'multi-layer-empty';
    empty.textContent = '尚未選擇任何圖層，從左側清單勾選要疊加的歷史地圖。';
    multiOverlayBarInnerEl.appendChild(empty);
    return;
  }
  [...list].reverse().forEach(entry => {
    const idx = list.indexOf(entry);
    multiOverlayBarInnerEl.appendChild(buildMultiLayerRow(entry, idx, list.length));
  });
}
