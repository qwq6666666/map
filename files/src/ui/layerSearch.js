/* ---------------------------------------------------------
   ui/layerSearch.js — 圖資搜尋的 DOM 邏輯
   ---------------------------------------------------------
   跟 ui/search.js（地址搜尋的 DOM 邏輯）完全獨立：不同的輸入框
   （#layerSearchInput vs #addressInput）、不同的結果容器
   （#layerSearchPanel vs #addressSuggest／#locationResult）、不同的
   事件監聽器，兩邊不共用任何 state，也不互相監聽對方的 input。

   核心比對邏輯（searchLayers）與套用動作（activateLayerSearchResult）
   都委派給 features/layerSearch.js，這支檔案只負責畫面渲染與事件綁定，
   完全不呼叫任何地理編碼 API、不掃描 DOM 以外的地址相關元素。
--------------------------------------------------------- */
import { searchLayers, activateLayerSearchResult } from '../features/layerSearch.js';
import { layerKey } from '../data.js';

const INITIAL_DISPLAY_LIMIT = 8;
const DISPLAY_STEP = 8;

export function initLayerSearchUI(){
  const input = document.getElementById('layerSearchInput');
  const clearBtn = document.getElementById('layerSearchClearBtn');
  const panel = document.getElementById('layerSearchPanel');
  const countEl = document.getElementById('layerSearchCount');
  const collapseBtn = document.getElementById('layerSearchCollapseBtn');
  const listEl = document.getElementById('layerSearchList');
  const moreBtn = document.getElementById('layerSearchMoreBtn');
  if(!input || !clearBtn || !panel || !countEl || !collapseBtn || !listEl || !moreBtn) return;

  let currentResults = [];
  let displayLimit = INITIAL_DISPLAY_LIMIT;

  function renderResults(){
    panel.hidden = false;

    if(currentResults.length === 0){
      countEl.textContent = '找不到符合的圖資';
      listEl.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'layer-search-empty';
      empty.textContent = '找不到符合的圖資';
      listEl.appendChild(empty);
      moreBtn.hidden = true;
      return;
    }

    countEl.textContent = `共 ${currentResults.length} 筆結果`;
    listEl.innerHTML = '';

    currentResults.slice(0, displayLimit).forEach(entry => {
      const { src, layer } = entry;
      const item = document.createElement('div');
      item.className = 'layer-search-item';
      item.dataset.key = layerKey(src, layer);

      const title = document.createElement('div');
      title.className = 'layer-search-item-title';
      title.textContent = `🗺 ${layer.title}`;

      const meta = document.createElement('div');
      meta.className = 'layer-search-item-meta';
      meta.textContent = `${layer.year || '年代不明'} · ${src.name}`;

      item.appendChild(title);
      item.appendChild(meta);
      item.addEventListener('click', () => activateLayerSearchResult(entry));
      listEl.appendChild(item);
    });

    const remaining = currentResults.length - displayLimit;
    if(remaining > 0){
      moreBtn.hidden = false;
      moreBtn.textContent = `顯示更多（還有 ${remaining} 筆）`;
    } else {
      moreBtn.hidden = true;
    }
  }

  function clearResults(){
    panel.hidden = true;
    listEl.innerHTML = '';
    currentResults = [];
    moreBtn.hidden = true;
  }

  input.addEventListener('input', () => {
    const query = input.value.trim();
    clearBtn.hidden = query.length === 0;

    if(query.length === 0){
      clearResults();
      return;
    }

    currentResults = searchLayers(query);
    displayLimit = INITIAL_DISPLAY_LIMIT;
    renderResults();
  });

  moreBtn.addEventListener('click', () => {
    displayLimit += DISPLAY_STEP;
    renderResults();
  });

  collapseBtn.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('collapsed');
    collapseBtn.textContent = collapsed ? '▸' : '▾';
  });

  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearResults();
    clearBtn.hidden = true;
    input.focus();
  });
}
