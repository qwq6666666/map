/* ---------------------------------------------------------
   ui/mobileCnBrowse.js — 手機版「中國」分頁專用：大區域→地區→來源手風琴
   ---------------------------------------------------------
   跟 src/ui/mobileTwBrowse.js 是同一種設計、服務不同分頁：只服務
   sidebarUI.js 的手機版（<=768px）「中國」分頁瀏覽方式。第三段一樣
   重用 sidebarUI.js 抽出的 buildSourceGroup()（跟桌機「來源(機構)→
   分類→次分類→圖層」手風琴共用同一套建置邏輯），只是依目前選中的
   大區域／地區篩出對應來源，各自重新生成一份獨立的手風琴 DOM。

   DOM 結構與 CSS class 刻意直接沿用 mobileTwBrowse.js 那組
  （mobile-tw-browse／mobile-tw-macro-row／mobile-tw-macro-btn／
   mobile-tw-area-row／mobile-tw-area-btn／mobile-tw-hint／
   mobile-tw-sources），不新增一套 mobile-cn-* 樣式——這些 class 雖然
   歷史命名帶了 tw，但 style.css 對應規則本身是純結構性的（chip 列、
   手風琴容器排版），沒有任何台灣專屬的視覺邏輯，兩個分頁共用完全
   沒問題，可以省下一份重複的 CSS。只有根節點 id 改成 mobileCnBrowse，
   避免跟 #mobileTwBrowse 撞 id。

   純函式（macroRegionForSource／regionLabelForSource）刻意不碰 DOM，方便
   獨立單元測試；buildMobileCnBrowseUI() 才是實際組 DOM 的部分，回傳的
   容器由呼叫端自行決定何時 append／顯示（見 sidebarUI.js 的
   syncMobileBrowseView()，用 hidden attribute 控制）。
--------------------------------------------------------- */

// 少數來源不適用「去掉 name 尾端字樣」規則，直接寫死對照表；
// shanghai（上海城市歷史地圖）結尾是「城市歷史地圖」不是「百年歷史
// 地圖」，套用去尾規則會切成「上海城市」而非「上海」，必須覆寫。
const REGION_LABEL_OVERRIDES = {
  ccts: '全國性圖資',
  shanghai: '上海'
};

export function regionLabelForSource(src){
  if(REGION_LABEL_OVERRIDES[src.id]) return REGION_LABEL_OVERRIDES[src.id];
  const name = src.name || '';
  if(name.endsWith('百年歷史地圖')) return name.slice(0, -6);
  if(name.endsWith('歷史地圖')) return name.slice(0, -4);
  return name; // 防禦性 fallback，目前 11 個 cn 來源不會走到這條
}

export const MACRO_REGION_ORDER = ['全國', '華北', '華東', '華中', '華南', '西南'];

// 已跟使用者確認過的分組（全國 1、華北 2、華東 4、華中 1、華南 2、
// 西南 1，加總 11，跟目前 cn 來源總數一致）。刻意不列「東北」「西北」
// ——目前 11 個 cn 來源沒有任何一個屬於這兩區，比照台灣版「只放實際
// 有資料的大區域」的原則，不加空的分類。
const MACRO_REGION_MAP = {
  ccts: '全國',
  beijing: '華北', tianjin: '華北',
  shanghai: '華東', nanjing: '華東', hangzhou: '華東', suzhou: '華東',
  wuhan: '華中',
  guangzhou: '華南', hongkong: '華南',
  kunming: '西南'
};

export function macroRegionForSource(src){
  return MACRO_REGION_MAP[src.id] || '其他'; // fallback 防禦性，目前 11 個 cn 來源不會走到
}

// 跟 sidebarUI.js 的 buildSourceGroup() 內算來源總筆數同一套算法，
// 這裡只是用來排序地區 chip，刻意不 import sidebarUI.js（避免循環依賴，
// 這支檔案本來就是被 sidebarUI.js import）。
function layerCountForSource(src){
  return src.categories.reduce((s, c) =>
    s + (c.groups ? c.groups.reduce((gs, g) => gs + g.layers.length, 0) : c.layers.length), 0);
}

function sourcesForMacro(cnSources, macro){
  return cnSources.filter(src => macroRegionForSource(src) === macro);
}

// 華北／華東／華南固定顯示順序；華中／西南／全國各自只有一個地區，
// 不需要固定順序。
const FIXED_AREA_ORDER = {
  '華北': ['北京', '天津'],
  '華東': ['上海', '南京', '蘇州', '杭州'],
  '華南': ['廣州', '香港']
};

// 統計某個大區域裡「實際有資料的地區」（筆數＝該地區底下所有來源的圖層總數）。
function computeAreasForMacro(cnSources, macro){
  const counts = new Map();
  sourcesForMacro(cnSources, macro).forEach(src => {
    const label = regionLabelForSource(src);
    counts.set(label, (counts.get(label) || 0) + layerCountForSource(src));
  });
  const areas = Array.from(counts.entries()).map(([label, count]) => ({ label, count }));
  const fixedOrder = FIXED_AREA_ORDER[macro];
  if(fixedOrder){
    areas.sort((a, b) => fixedOrder.indexOf(a.label) - fixedOrder.indexOf(b.label));
  } else {
    areas.sort((a, b) => b.count - a.count);
  }
  return areas;
}

function sourcesForArea(cnSources, macro, area){
  const sources = sourcesForMacro(cnSources, macro);
  if(!area) return sources;
  return sources.filter(src => regionLabelForSource(src) === area);
}

/* ---------------------------------------------------------
   best-effort 猜測：讀「最近一次地址搜尋」在畫面上留下的結果文字，
   猜出使用者可能想找哪個地區。唯讀 DOM，不 import 任何 search 模組、
   不新增 store 欄位，猜不到就回傳 null（呼叫端維持「全部地區」）。
--------------------------------------------------------- */
function guessRegionFromLastLocation(candidateLabels){
  const resultEl = document.getElementById('locationResult');
  const nameEl = document.getElementById('locationName');
  if(!resultEl || !nameEl) return null;
  if(resultEl.style.display === 'none' || !resultEl.style.display) return null; // 目前沒有顯示中的搜尋結果
  const text = nameEl.textContent || '';
  if(!text) return null;
  return candidateLabels.find(label => text.includes(label)) || null;
}

/**
 * 建立手機版「中國」分頁的大區域→地區→來源手風琴 UI，回傳可直接
 * append 進 #categories 的容器（不會自行 append，由呼叫端決定時機）。
 * @param {Array} cnSources LAYER_SOURCES 篩過 country==='cn' 的子集
 * @param {(src:object) => HTMLElement} buildSourceGroup
 *   sidebarUI.js 抽出的單一來源手風琴建置函式（跟桌機共用同一套邏輯，
 *   每次呼叫都會 document.createElement 全新建立一份獨立 DOM，不會跟
 *   桌機那份手風琴共用節點，也不需要手動同步兩者的展開狀態）。
 */
export function buildMobileCnBrowseUI(cnSources, buildSourceGroup){
  const root = document.createElement('div');
  root.id = 'mobileCnBrowse';
  root.className = 'mobile-tw-browse';

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
  MACRO_REGION_ORDER.forEach(macro => {
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
    sourcesForArea(cnSources, selectedMacro, selectedArea).forEach(src => {
      sourcesWrap.appendChild(buildSourceGroup(src));
    });
  }

  function selectMacro(macro){
    selectedMacro = macro;
    macroButtons.forEach((btn, key) => btn.classList.toggle('active', key === macro));

    const areas = computeAreasForMacro(cnSources, macro);
    selectedArea = guessRegionFromLastLocation(areas.map(a => a.label));

    renderAreaRow(areas);
    renderSources();
  }

  root.appendChild(macroRow);
  root.appendChild(areaRow);
  root.appendChild(hint);
  root.appendChild(sourcesWrap);

  return root;
}
