/* ---------------------------------------------------------
   ui/mobileRegionBrowse.js — 手機版「台灣」「中國」分頁共用的
   大區域→地區→來源手風琴底層邏輯
   ---------------------------------------------------------
   純函式與 DOM 建構邏輯抽出來給 mobileTwBrowse.js／mobileCnBrowse.js
   共用；各自的大區域對照表（MACRO_REGION_MAP）、地區標籤覆寫表
   （REGION_LABEL_OVERRIDES）、固定排序（FIXED_AREA_ORDER）仍留在
   各自檔案裡，用參數傳進來。
--------------------------------------------------------- */

// 跟 sidebarUI.js 的 buildSourceGroup() 內算來源總筆數同一套算法，
// 這裡只是用來排序地區 chip，刻意不 import sidebarUI.js（避免循環依賴，
// 這支檔案本來就是被 sidebarUI.js 間接 import）。
export function layerCountForSource(src){
  return src.categories.reduce((s, c) =>
    s + (c.groups ? c.groups.reduce((gs, g) => gs + g.layers.length, 0) : c.layers.length), 0);
}

function sourcesForMacro(sources, macro, macroRegionForSource){
  return sources.filter(src => macroRegionForSource(src) === macro);
}

// 統計某個大區域裡「實際有資料的地區」（筆數＝該地區底下所有來源的圖層總數）。
function computeAreasForMacro(sources, macro, { macroRegionForSource, regionLabelForSource, fixedAreaOrder }){
  const counts = new Map();
  sourcesForMacro(sources, macro, macroRegionForSource).forEach(src => {
    const label = regionLabelForSource(src);
    counts.set(label, (counts.get(label) || 0) + layerCountForSource(src));
  });
  const areas = Array.from(counts.entries()).map(([label, count]) => ({ label, count }));
  const fixedOrder = fixedAreaOrder[macro];
  if(fixedOrder){
    areas.sort((a, b) => fixedOrder.indexOf(a.label) - fixedOrder.indexOf(b.label));
  } else {
    areas.sort((a, b) => b.count - a.count);
  }
  return areas;
}

function sourcesForArea(sources, macro, area, { macroRegionForSource, regionLabelForSource }){
  const filtered = sourcesForMacro(sources, macro, macroRegionForSource);
  if(!area) return filtered;
  return filtered.filter(src => regionLabelForSource(src) === area);
}

/* ---------------------------------------------------------
   best-effort 猜測：讀「最近一次地址搜尋」在畫面上留下的結果文字，
   猜出使用者可能想找哪個地區。唯讀 DOM，不 import 任何 search 模組、
   不新增 store 欄位，猜不到就回傳 null（呼叫端維持「全部地區」）。
   expectedCountryCode：只有 locationResultEl.dataset.countryCode
   跟這個參數相符才會猜（例如中國分頁傳 'cn'），避免地址搜尋固定只查
   台灣（見 src/geocode.js 的 countrycodes=tw）卻被拿去誤判成中國地區
   的跨國別誤判（例如「南京東路」被中國分頁誤判成「南京」）。
--------------------------------------------------------- */
export function guessRegionFromLastLocation(candidateLabels, expectedCountryCode){
  const resultEl = document.getElementById('locationResult');
  const nameEl = document.getElementById('locationName');
  if(!resultEl || !nameEl) return null;
  if(resultEl.style.display === 'none' || !resultEl.style.display) return null; // 目前沒有顯示中的搜尋結果
  if((resultEl.dataset.countryCode || '') !== expectedCountryCode) return null;
  const text = nameEl.textContent || '';
  if(!text) return null;
  return candidateLabels.find(label => text.includes(label)) || null;
}

/**
 * 建立手機版分頁的大區域→地區→來源手風琴 UI，回傳可直接 append 進
 * #categories 的容器（不會自行 append，由呼叫端決定時機）。
 * @param {object} opts
 * @param {string} opts.rootId 容器 id（例如 'mobileTwBrowse'）
 * @param {string} opts.rootClassName 容器 className（沿用既有 CSS class）
 * @param {string} opts.countryCode 傳給 guessRegionFromLastLocation 的國別碼
 * @param {string[]} opts.macroOrder 大區域按鈕順序
 * @param {(src:object)=>string} opts.macroRegionForSource
 * @param {(src:object)=>string} opts.regionLabelForSource
 * @param {object} opts.fixedAreaOrder
 * @param {Array} sources LAYER_SOURCES 篩過對應 country 的子集
 * @param {(src:object) => HTMLElement} buildSourceGroup
 *   sidebarUI.js 抽出的單一來源手風琴建置函式（跟桌機共用同一套邏輯，
 *   每次呼叫都會 document.createElement 全新建立一份獨立 DOM，不會跟
 *   桌機那份手風琴共用節點，也不需要手動同步兩者的展開狀態）。
 */
export function buildMobileRegionBrowseUI(opts, sources, buildSourceGroup){
  const { rootId, rootClassName, countryCode, macroOrder, macroRegionForSource, regionLabelForSource, fixedAreaOrder } = opts;
  const helpers = { macroRegionForSource, regionLabelForSource, fixedAreaOrder };

  const root = document.createElement('div');
  root.id = rootId;
  root.className = rootClassName;

  const macroRow = document.createElement('div');
  macroRow.className = 'mobile-tw-macro-row';

  const areaRow = document.createElement('div');
  areaRow.className = 'mobile-tw-area-row';
  areaRow.hidden = true;

  const hint = document.createElement('div');
  hint.className = 'mobile-tw-hint';
  hint.textContent = '請先選擇地區';

  const sourcesWrap = document.createElement('div');
  sourcesWrap.className = 'mobile-tw-sources';

  let selectedMacro = null;
  let selectedArea = null; // null = 全部地區

  const macroButtons = new Map();
  macroOrder.forEach(macro => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'avail-year-sort-btn mobile-tw-macro-btn';
    btn.textContent = macro;
    btn.addEventListener('click', () => selectMacro(macro));
    macroButtons.set(macro, btn);
    macroRow.appendChild(btn);
  });

  function renderAreaRow(areas){
    areaRow.innerHTML = '';
    if(!selectedMacro){
      areaRow.hidden = true;
      return;
    }
    areaRow.hidden = false;
    areas.forEach(({ label, count }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'avail-year-sort-btn mobile-tw-area-btn';
      btn.textContent = `${label} ${count}`;
      btn.classList.toggle('active', selectedArea === label);
      btn.addEventListener('click', () => {
        selectedArea = (selectedArea === label) ? null : label;
        Array.from(areaRow.children).forEach(b => b.classList.remove('active'));
        if(selectedArea === label) btn.classList.add('active');
        renderSources();
      });
      areaRow.appendChild(btn);
    });
  }

  function renderSources(){
    sourcesWrap.innerHTML = '';
    if(!selectedMacro){
      hint.hidden = false;
      return;
    }
    hint.hidden = true;
    sourcesForArea(sources, selectedMacro, selectedArea, helpers).forEach(src => {
      sourcesWrap.appendChild(buildSourceGroup(src));
    });
  }

  function selectMacro(macro){
    selectedMacro = macro;
    macroButtons.forEach((btn, key) => btn.classList.toggle('active', key === macro));

    const areas = computeAreasForMacro(sources, macro, helpers);
    selectedArea = guessRegionFromLastLocation(areas.map(a => a.label), countryCode);

    renderAreaRow(areas);
    renderSources();
  }

  root.appendChild(macroRow);
  root.appendChild(areaRow);
  root.appendChild(hint);
  root.appendChild(sourcesWrap);

  return root;
}
