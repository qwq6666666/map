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
  clearMultiOverlayLayers
} from '../store.js';
import { LAYER_SOURCES, layerKey, titleForKey } from '../data.js';
import { buildCategoryList } from '../uiTree.js';
import { setLayerOpacity } from '../core/layerCache.js';
import { map } from '../core/map.js';

let multiCategoriesEl, multiOverlayBarInnerEl;
const sourceWraps = []; // [{ src, wrap }]，供 syncMultiLayerCheckedClasses() 用來限定查詢範圍

export function initMultiOverlayUI(){
  multiCategoriesEl = document.getElementById('multiCategories');
  multiOverlayBarInnerEl = document.getElementById('multiOverlayBarInner');

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

  document.getElementById('multiOverlayClearBtn').addEventListener('click', clearMultiOverlayLayers);
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
