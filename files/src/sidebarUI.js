/* ---------------------------------------------------------
   sidebarUI.js — 側邊欄：WMTS 圖資來源 → 分類(→ 堡等次分類) → 圖層
   手風琴建置
--------------------------------------------------------- */
import { LAYER_SOURCES, layerKey } from './data.js';
import { buildCategoryList } from './uiTree.js';
import { selectOverlayLayer } from './store.js';
import { flyToSourceExtent } from './mapCore.js';
import { createCountryFilterBar } from './ui/countryFilter.js';

/* 動態量測「歷史圖層透明度」吸附區塊的實際高度，寫成 CSS 變數，
   讓 .source-head / .category-head 的 scroll-snap-margin-top 精準對齊
   吸附區塊底部，捲動時清單只會停在標題完整可見的位置，
   不會停在被吸附區塊腰斬一半的中間狀態。 */
function updateStickyOffset(){
  const ob = document.querySelector('.opacity-block');
  if(!ob) return;
  let h = Math.ceil(ob.getBoundingClientRect().height);
  // 國家篩選列（.country-filter）疊在透明度區塊下方、跟它一起吸附在
  // 側邊欄可視範圍最上方；#categories／#multiCategories 只會有一個在
  // 目前這個模式下顯示，隱藏那份的高度量出來是 0，直接加總即可。
  document.querySelectorAll('#categories > .country-filter, #multiCategories > .country-filter').forEach(el=>{
    const r = el.getBoundingClientRect();
    if(r.height > 0) h += Math.ceil(r.height);
  });
  document.documentElement.style.setProperty('--sticky-offset', h + 'px');
}

export function initSidebar(){
  const categoriesEl = document.getElementById('categories');

  window.addEventListener('resize', updateStickyOffset);
  window.addEventListener('load', updateStickyOffset);

  const sourceWraps = []; // [{ src, wrap }]，篩選列用來知道要顯示／隱藏哪些來源
  const { bar: filterBar, refresh: refreshCountryFilter } = createCountryFilterBar(() => sourceWraps);
  categoriesEl.appendChild(filterBar);

  LAYER_SOURCES.forEach((src) => {
    const srcWrap = document.createElement('div');
    srcWrap.className = 'source-group';

    const srcHead = document.createElement('button');
    srcHead.type = 'button';
    srcHead.className = 'source-head';
    const total = src.categories.reduce((s,c)=> s + (c.groups ? c.groups.reduce((gs,g)=>gs+g.layers.length,0) : c.layers.length), 0);
    srcHead.innerHTML = `<span><span class="chevron">▸</span>${src.name}</span><span class="count">${total}</span>`;
    srcHead.addEventListener('click', ()=>{
      const opening = !srcWrap.classList.contains('open');
      if(opening){
        // 手風琴行為：展開這個來源時，先收合其他已展開的來源，
        // 一次只保留一個最大階層是開啟的狀態。
        categoriesEl.querySelectorAll('.source-group.open').forEach(g=>{
          if(g !== srcWrap) g.classList.remove('open');
        });
      }
      srcWrap.classList.toggle('open');
      if(opening){
        flyToSourceExtent(src.id);
        // 展開後自動捲動，讓來源標題貼齊側邊欄可視範圍頂端
        // （已透過 .source-head 的 scroll-margin-top 自動避開吸附的透明度區塊）。
        srcHead.scrollIntoView({ behavior:'smooth', block:'start' });
      }
    });

    const srcBody = document.createElement('div');
    srcBody.className = 'source-body';
    buildCategoryList(src.categories, srcBody, (layer) => selectOverlayLayer(layerKey(src, layer)), false);

    srcWrap.appendChild(srcHead);
    srcWrap.appendChild(srcBody);
    categoriesEl.appendChild(srcWrap);
    sourceWraps.push({ src, wrap: srcWrap });
  });

  refreshCountryFilter();
  updateStickyOffset();
}
