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

// 結果筆數安全上限：超過這個數字仍然全部渲染（不分批、不截斷），只在
// 清單最上方加一行提示文字，避免極端情況下使用者誤以為卡住。
const RESULT_WARN_THRESHOLD = 200;

// 純 UI 節流，跟 features/layerSearch.js 的 buildIndex() 結果快取分別
// 解決「重建成本」與「按鍵密度」兩個不同問題。數字遠小於地址搜尋的
// ADDRESS_SUGGEST_DEBOUNCE_MS（1000ms，src/ui/search.js），因為圖資
// 搜尋比對的是本地已快取的 metadata 索引，不牽涉網路請求。
const LAYER_SEARCH_DEBOUNCE_MS = 120;

export function initLayerSearchUI(){
  const input = document.getElementById('layerSearchInput');
  const clearBtn = document.getElementById('layerSearchClearBtn');
  const panel = document.getElementById('layerSearchPanel');
  const countEl = document.getElementById('layerSearchCount');
  const collapseBtn = document.getElementById('layerSearchCollapseBtn');
  const listEl = document.getElementById('layerSearchList');
  if(!input || !clearBtn || !panel || !countEl || !collapseBtn || !listEl) return;

  let currentResults = [];
  let debounceTimer = null;

  // 改為浮動下拉卡片後不再分批載入：直接把 currentResults 全部渲染，
  // 交給 CSS 的 .layer-search-list{max-height;overflow-y:auto} 處理捲動。
  // 注意：點擊 .layer-search-item 只呼叫 activateLayerSearchResult()，
  // 不會呼叫 clearResults() 或把 panel 設回 hidden，讓使用者可以連續
  // 點多個結果疊圖，結果清單全程保留顯示。
  function renderResults(){
    panel.hidden = false;

    if(currentResults.length === 0){
      countEl.textContent = '找不到符合的圖資';
      listEl.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'layer-search-empty';
      empty.textContent = '找不到符合的圖資';
      listEl.appendChild(empty);
      return;
    }

    countEl.textContent = `共 ${currentResults.length} 筆結果`;
    listEl.innerHTML = '';

    if(currentResults.length > RESULT_WARN_THRESHOLD){
      const notice = document.createElement('div');
      notice.className = 'layer-search-list-notice';
      notice.textContent = '結果過多，請輸入更精確的關鍵字以縮小範圍。';
      listEl.appendChild(notice);
    }

    currentResults.forEach(entry => {
      const { src, layer } = entry;
      const item = document.createElement('div');
      item.className = 'layer-search-item';
      item.dataset.key = layerKey(src, layer);

      const title = document.createElement('div');
      title.className = 'layer-search-item-title';
      // layer.title 是動態資料，用 textNode 附加而非拼進 innerHTML，避免 XSS。
      title.innerHTML = '<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/map-emoji-style-a-icons.svg#map"></use></svg> ';
      title.appendChild(document.createTextNode(layer.title));

      const meta = document.createElement('div');
      meta.className = 'layer-search-item-meta';
      meta.textContent = `${layer.year || '年代不明'} · ${src.name}`;

      item.appendChild(title);
      item.appendChild(meta);
      item.addEventListener('click', () => activateLayerSearchResult(entry));
      listEl.appendChild(item);
    });
  }

  function clearResults(){
    panel.hidden = true;
    listEl.innerHTML = '';
    currentResults = [];
  }

  // 單向收合：只加 .collapsed，不清空 currentResults／listEl，讓使用者
  // 點外面收合面板後、再點 collapseBtn 展開仍能看到先前的搜尋結果，
  // 保留原本「可連續點多筆」的設計，跟 clearResults() 語意不同。
  function collapsePanel(){
    if(panel.hidden || panel.classList.contains('collapsed')) return;
    panel.classList.add('collapsed');
    collapseBtn.textContent = '▸';
  }

  input.addEventListener('input', () => {
    const query = input.value.trim();
    clearBtn.hidden = query.length === 0;

    if(debounceTimer) clearTimeout(debounceTimer);

    if(query.length === 0){
      clearResults();
      return;
    }

    debounceTimer = setTimeout(() => {
      currentResults = searchLayers(query);
      renderResults();
    }, LAYER_SEARCH_DEBOUNCE_MS);
  });

  collapseBtn.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('collapsed');
    collapseBtn.textContent = collapsed ? '▸' : '▾';
  });

  clearBtn.addEventListener('click', () => {
    if(debounceTimer) clearTimeout(debounceTimer);
    input.value = '';
    clearResults();
    clearBtn.hidden = true;
    input.focus();
  });

  // 比照 ui/search.js 對 #addressSuggest 的 outside-click 判斷邏輯：手機版
  // 時 .layer-search-row／#layerSearchPanel 會被 relocateLayerSearchRow()
  // 搬出 .layer-search-block、移進 #mobileSearchBar，兩個容器都要檢查，
  // 缺一個會在對應版型下把點擊面板本身誤判為「點擊外部」。跟地址建議
  // 清單不同的是這裡只收合、不清空 currentResults，保留使用者收合後
  // 展開仍能看到先前搜尋結果、可連續點多筆的設計。
  document.addEventListener('click', (e) => {
    if(e.target.closest('.layer-search-block')) return;
    if(e.target.closest('#mobileSearchBar')) return;
    collapsePanel();
  });
}
