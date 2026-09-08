/* ---------------------------------------------------------
   ui/mobileTwBrowse.js — 手機版「台灣」分頁專用：大區域→地區→來源手風琴
   ---------------------------------------------------------
   只服務 sidebarUI.js 的手機版（<=768px）「台灣」分頁瀏覽方式。第三段
   不再自己刻一份扁平清單，而是重用 sidebarUI.js 抽出的 buildSourceGroup()
   （跟桌機「來源(機構)→分類→次分類→圖層」手風琴共用同一套建置邏輯，見
   sidebarUI.js 的 renderSourceAccordion()／buildSourceGroup()），只是依
   目前選中的大區域／地區篩出對應來源，各自重新生成一份獨立的手風琴 DOM。

   純函式（macroRegionForSource／regionLabelForSource）刻意不碰 DOM，方便
   獨立單元測試；buildMobileTwBrowseUI() 才是實際組 DOM 的部分，回傳的
   容器由呼叫端自行決定何時 append／顯示（見 sidebarUI.js 的
   syncMobileTwView()，用 hidden attribute 控制）。
--------------------------------------------------------- */

// 少數來源不適用「去掉 name 尾端字樣」規則，直接寫死對照表；
// udd（臺北市歷史圖資展示系統）刻意跟 taipei（臺北百年歷史地圖）合併成
// 同一個「臺北」地區 chip，不是 bug。
const REGION_LABEL_OVERRIDES = {
  sinica: '全國性圖資',
  nlsc: '全國性圖資',
  thm: '桃竹苗',
  udd: '臺北'
};

export function regionLabelForSource(src){
  if(REGION_LABEL_OVERRIDES[src.id]) return REGION_LABEL_OVERRIDES[src.id];
  const name = src.name || '';
  if(name.endsWith('百年歷史地圖')) return name.slice(0, -6);
  if(name.endsWith('歷史地圖')) return name.slice(0, -4);
  return name; // 防禦性 fallback，目前 24 個 tw 來源不會走到這條
}

export const MACRO_REGION_ORDER = ['全國', '北部', '中部', '南部', '東部', '離島'];

// 已跟使用者確認過的分組（北部 9、中部 4、南部 5、東部 2、離島 2、
// 全國 2，加總 24，跟目前 tw 來源總數一致）。
const MACRO_REGION_MAP = {
  sinica: '全國', nlsc: '全國',
  taipei: '北部', udd: '北部', newtaipei: '北部', tamsui: '北部',
  keelung: '北部', taoyuan: '北部', hsinchu: '北部', thm: '北部', yilan: '北部',
  taichung: '中部', changhua: '中部', lukang: '中部', puli: '中部',
  chiayi: '南部', tainan: '南部', kaohsiung: '南部', pingtung: '南部', hakkaliudui: '南部',
  hualien: '東部', taitung: '東部',
  kinmen: '離島', penghu: '離島'
};

export function macroRegionForSource(src){
  return MACRO_REGION_MAP[src.id] || '其他'; // fallback 防禦性，目前 24 個 tw 來源不會走到
}

// 跟 sidebarUI.js 的 buildSourceGroup() 內算來源總筆數同一套算法，
// 這裡只是用來排序地區 chip，刻意不 import sidebarUI.js（避免循環依賴，
// 這支檔案本來就是被 sidebarUI.js import）。
function layerCountForSource(src){
  return src.categories.reduce((s, c) =>
    s + (c.groups ? c.groups.reduce((gs, g) => gs + g.layers.length, 0) : c.layers.length), 0);
}

function sourcesForMacro(twSources, macro){
  return twSources.filter(src => macroRegionForSource(src) === macro);
}

// 依筆數（該地區底下所有來源的圖層總數）由多到少，統計某個大區域裡
// 「實際有資料的地區」。
function computeAreasForMacro(twSources, macro){
  const counts = new Map();
  sourcesForMacro(twSources, macro).forEach(src => {
    const label = regionLabelForSource(src);
    counts.set(label, (counts.get(label) || 0) + layerCountForSource(src));
  });
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => ({ label, count }));
}

function sourcesForArea(twSources, macro, area){
  const sources = sourcesForMacro(twSources, macro);
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
 * 建立手機版「台灣」分頁的大區域→地區→來源手風琴 UI，回傳可直接
 * append 進 #categories 的容器（不會自行 append，由呼叫端決定時機）。
 * @param {Array} twSources LAYER_SOURCES 篩過 country==='tw' 的子集
 * @param {(src:object) => HTMLElement} buildSourceGroup
 *   sidebarUI.js 抽出的單一來源手風琴建置函式（跟桌機共用同一套邏輯，
 *   每次呼叫都會 document.createElement 全新建立一份獨立 DOM，不會跟
 *   桌機那份手風琴共用節點，也不需要手動同步兩者的展開狀態）。
 */
export function buildMobileTwBrowseUI(twSources, buildSourceGroup){
  const root = document.createElement('div');
  root.id = 'mobileTwBrowse';
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
    sourcesForArea(twSources, selectedMacro, selectedArea).forEach(src => {
      sourcesWrap.appendChild(buildSourceGroup(src));
    });
  }

  function selectMacro(macro){
    selectedMacro = macro;
    macroButtons.forEach((btn, key) => btn.classList.toggle('active', key === macro));

    const areas = computeAreasForMacro(twSources, macro);
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
