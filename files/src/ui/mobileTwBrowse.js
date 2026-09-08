/* ---------------------------------------------------------
   ui/mobileTwBrowse.js — 手機版「台灣」分頁專用：年代→地區→扁平圖層清單
   ---------------------------------------------------------
   只服務 sidebarUI.js 的手機版（<=768px）「台灣」分頁瀏覽方式，取代
   原本「來源(機構)→分類→次分類→圖層」手風琴（那份手風琴本身完全不動，
   桌機／中國／其他分頁繼續沿用，見 sidebarUI.js 的 renderSourceAccordion()）。

   純函式（YEAR_BUCKET_ORDER／yearBucketOf／regionLabelForSource）刻意
   不碰 DOM，方便獨立單元測試；buildMobileTwBrowseUI() 才是實際組
   DOM 的部分，回傳的容器由呼叫端自行決定何時 append／顯示（見
   sidebarUI.js 的 syncMobileTwView()，用 hidden attribute 控制）。
--------------------------------------------------------- */

export const YEAR_BUCKET_ORDER = ['清領時期', '日治初期', '日治中期', '日治後期', '戰後', '近代', '年代不明'];

export function yearBucketOf(yearNum){
  if(yearNum == null) return '年代不明';
  if(yearNum < 1895) return '清領時期';
  if(yearNum <= 1911) return '日治初期';
  if(yearNum <= 1926) return '日治中期';
  if(yearNum <= 1945) return '日治後期';
  if(yearNum <= 1980) return '戰後';
  return '近代';
}

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

/* ---------------------------------------------------------
   把 twSources（LAYER_SOURCES 篩過 country==='tw' 的子集）攤平成
   { src, layer, bucket, region } 陣列，一次算好年代桶／地區標籤避免
   後續重複計算。走訪邏輯風格參考 features/search.js 的
   findAvailableLayersAt()，但刻意不 import 該檔案，自成一份輕量版。
--------------------------------------------------------- */
function flattenTwLayers(twSources){
  const flat = [];
  twSources.forEach(src => {
    src.categories.forEach(cat => {
      const layers = cat.groups ? cat.groups.flatMap(g => g.layers) : cat.layers;
      layers.forEach(layer => {
        flat.push({
          src,
          layer,
          bucket: yearBucketOf(layer.yearNum),
          region: regionLabelForSource(src)
        });
      });
    });
  });
  return flat;
}

// 依筆數由多到少，統計某個年代桶裡「實際有資料的地區」。
function computeRegionsForBucket(flat, bucket){
  const counts = new Map();
  flat.forEach(entry => {
    if(entry.bucket !== bucket) return;
    counts.set(entry.region, (counts.get(entry.region) || 0) + 1);
  });
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => ({ label, count }));
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

const LIST_THRESHOLD = 8;

function buildLayerItem(entry, onSelectLayer){
  const { src, layer } = entry;
  const item = document.createElement('div');
  item.className = 'layer-search-item mobile-tw-layer-item';
  item.dataset.layerId = layer.id;

  const title = document.createElement('div');
  title.className = 'layer-search-item-title';
  title.textContent = `🗺 ${layer.title}`;

  const meta = document.createElement('div');
  meta.className = 'layer-search-item-meta';
  meta.textContent = `${layer.year || '年代不明'} · ${src.name}`;

  item.appendChild(title);
  item.appendChild(meta);
  item.addEventListener('click', () => onSelectLayer(src, layer));
  return item;
}

/**
 * 建立手機版「台灣」分頁的年代→地區→扁平圖層清單 UI，回傳可直接
 * append 進 #categories 的容器（不會自行 append，由呼叫端決定時機）。
 * @param {Array} twSources LAYER_SOURCES 篩過 country==='tw' 的子集
 * @param {(src:object, layer:object) => void} onSelectLayer 點擊圖層時呼叫
 */
export function buildMobileTwBrowseUI(twSources, onSelectLayer){
  const flat = flattenTwLayers(twSources);

  const root = document.createElement('div');
  root.id = 'mobileTwBrowse';
  root.className = 'mobile-tw-browse';

  const yearRow = document.createElement('div');
  yearRow.className = 'mobile-tw-year-row';

  const regionRow = document.createElement('div');
  regionRow.className = 'mobile-tw-region-row';
  regionRow.hidden = true;

  const hint = document.createElement('div');
  hint.className = 'mobile-tw-hint';
  hint.textContent = '請先選擇年代';

  const listWrap = document.createElement('div');
  listWrap.className = 'mobile-tw-layer-list';

  let selectedBucket = null;
  let selectedRegion = null; // null = 全部地區

  const yearButtons = new Map();
  YEAR_BUCKET_ORDER.forEach(bucket => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'avail-year-sort-btn mobile-tw-year-btn';
    btn.textContent = bucket;
    btn.addEventListener('click', () => selectBucket(bucket));
    yearButtons.set(bucket, btn);
    yearRow.appendChild(btn);
  });

  function renderRegionRow(regions){
    regionRow.innerHTML = '';
    if(!selectedBucket){
      regionRow.hidden = true;
      return;
    }
    regionRow.hidden = false;
    regions.forEach(({ label, count }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'avail-year-sort-btn mobile-tw-region-btn';
      btn.textContent = `${label} ${count}`;
      btn.classList.toggle('active', selectedRegion === label);
      btn.addEventListener('click', () => {
        selectedRegion = (selectedRegion === label) ? null : label;
        Array.from(regionRow.children).forEach(b => b.classList.remove('active'));
        if(selectedRegion === label) btn.classList.add('active');
        renderList();
      });
      regionRow.appendChild(btn);
    });
  }

  function renderList(){
    listWrap.innerHTML = '';
    listWrap.classList.remove('expanded');
    if(!selectedBucket){
      hint.hidden = false;
      return;
    }
    hint.hidden = true;

    let layerCount = 0;

    if(!selectedRegion){
      // 全部地區：依地區筆數由多到少插入不可點擊的分隔標題，
      // 分隔標題不計入 8 筆門檻，但跟著後面的圖層一起被隱藏／顯示。
      const regions = computeRegionsForBucket(flat, selectedBucket);
      regions.forEach(({ label, count }) => {
        const heading = document.createElement('div');
        heading.className = 'mobile-tw-region-heading';
        heading.textContent = `${label}（${count}）`;
        if(layerCount >= LIST_THRESHOLD) heading.classList.add('mobile-tw-overflow');
        listWrap.appendChild(heading);

        flat.filter(e => e.bucket === selectedBucket && e.region === label).forEach(entry => {
          const item = buildLayerItem(entry, onSelectLayer);
          if(layerCount >= LIST_THRESHOLD) item.classList.add('mobile-tw-overflow');
          listWrap.appendChild(item);
          layerCount++;
        });
      });
    } else {
      flat.filter(e => e.bucket === selectedBucket && e.region === selectedRegion).forEach(entry => {
        const item = buildLayerItem(entry, onSelectLayer);
        if(layerCount >= LIST_THRESHOLD) item.classList.add('mobile-tw-overflow');
        listWrap.appendChild(item);
        layerCount++;
      });
    }

    if(layerCount > LIST_THRESHOLD){
      const remaining = layerCount - LIST_THRESHOLD;
      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'layer-list-toggle';
      toggleBtn.textContent = `顯示更多其餘 ${remaining} 筆 ▾`;
      toggleBtn.addEventListener('click', () => {
        const expanding = !listWrap.classList.contains('expanded');
        listWrap.classList.toggle('expanded', expanding);
        toggleBtn.textContent = expanding ? '收合 ▴' : `顯示更多其餘 ${remaining} 筆 ▾`;
      });
      listWrap.appendChild(toggleBtn);
    }
  }

  function selectBucket(bucket){
    selectedBucket = bucket;
    yearButtons.forEach((btn, key) => btn.classList.toggle('active', key === bucket));

    const regions = computeRegionsForBucket(flat, bucket);
    selectedRegion = guessRegionFromLastLocation(regions.map(r => r.label));

    renderRegionRow(regions);
    renderList();
  }

  root.appendChild(yearRow);
  root.appendChild(regionRow);
  root.appendChild(hint);
  root.appendChild(listWrap);

  return root;
}
