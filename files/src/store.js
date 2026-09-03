/* ---------------------------------------------------------
   store.js — 輕量狀態收納箱（Vanilla JS Pub/Sub）
   ---------------------------------------------------------
   只放「使用者意圖／目前應該顯示什麼」這種可序列化的狀態，例如
   目前模式、目前底圖、目前套疊中的歷史圖層 key、比對模式左右兩側
   選了哪個 key、分隔線位置。UI（sidebarUI／searchUI／mapCore 自己
   的按鈕）要換圖層或換模式時，一律呼叫 setState()，不直接呼叫
   map.addLayer()／map.removeLayer()；真正碰地圖圖層的動作，統一
   由 mapCore.js 訂閱 store 之後集中處理（見 mapCore.js 的
   `render(state, prevState, changedKeys)`）。

   不放進 store 的東西：OL 圖層物件本身（historyLayer／
   swipeLayerA/B）、計時器、searchToken 這類「執行期內部狀態」──
   這些不是使用者意圖，是 mapCore 根據 store 狀態算出來的結果，
   繼續放在 state.js（改名 runtime.js 以跟這裡的 store 狀態區分）。
--------------------------------------------------------- */

// 使用者自訂 WMTS／XYZ 圖層清單存在 localStorage 的 key。這份清單完全
// 獨立於 data/layers/*.json 那套「開發者編輯 → 跑 build script → 產生
// layers.bundle.json」的管線之外——使用者自己在瀏覽器裡加的來源，
// 生命週期跟受眾都不一樣，不需要（也不能）經過那條路徑。
const CUSTOM_SOURCES_STORAGE_KEY = 'hundredYearMap:customSources';

function loadCustomSourcesFromStorage(){
  try{
    const raw = localStorage.getItem(CUSTOM_SOURCES_STORAGE_KEY);
    if(!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  }catch(err){
    // 無痕模式／儲存空間被清過／內容壞掉時，安靜地當成沒有既有資料，
    // 不要讓整個 app 因為讀不到自訂圖層而掛掉。
    console.warn('讀取自訂圖層清單失敗，忽略本機儲存的資料', err);
    return [];
  }
}

function persistCustomSources(){
  try{
    localStorage.setItem(CUSTOM_SOURCES_STORAGE_KEY, JSON.stringify(state.customSources));
  }catch(err){
    // 例如無痕模式或儲存空間已滿：使用者這次加的圖層還是能用，只是
    // 不會被記住，不需要因此中斷操作或跳出干擾性的錯誤訊息。
    console.warn('儲存自訂圖層清單失敗（可能是無痕模式或儲存空間已滿）', err);
  }
}

export const state = {
  mode: 'overlay',        // 'overlay'／'compare'／'timeline'／'multi'（複合疊圖：可同時疊加多張）
  baseLayer: 'osm',       // 'osm' 或 'sat'，兩種模式共用的底圖
  activeOverlayKey: null, // 透明疊圖模式目前套疊的歷史圖層 key（null 代表沒有）
  compareA: 'hist:sinica:JM20K_1904:jpg', // 比對模式左側 key
  compareB: 'base:osm',                    // 比對模式右側 key
  swipePercent: 50,       // 比對模式分隔線位置（0~100）
  // 複合疊圖模式：可同時勾選多張歷史圖層一起疊在地圖上，陣列順序＝
  // 疊放順序（index 越大＝疊在越上層，跟 z-index 的直覺一致）。跟
  // activeOverlayKey（單選）刻意分開存放，兩者互不影響，切換模式時
  // 不會互相覆蓋掉對方記得的選擇。
  multiOverlayLayers: [], // [{ key, opacity }, ...]，opacity 是 0~100 的整數
  // 使用者自訂的 WMTS／XYZ 圖層來源，跟 data/layers/*.json 那批「內建
  // 圖資」完全分開存放，key 命名空間是 `custom:<id>`（見 data.js 的
  // setCustomSourcesProvider）。開啟頁面時自動從 localStorage 還原，
  // 每次新增／刪除都自動寫回，離開頁面不會遺失（見與使用者的討論：
  // 這個功能沒有帳號系統，「保存」只能是「留在這台瀏覽器裡」，所以
  // 預設自動保存，把「要不要清掉」的主控權交給使用者自己按刪除）。
  customSources: loadCustomSourcesFromStorage()
};

const listeners = [];

// 訂閱狀態變化。listener(state, prevState, changedKeys) 會在每次
// setState() 真的改到值的時候被呼叫；changedKeys 是這次變動的欄位
// 名稱陣列，訂閱者可以只處理自己在意的欄位，不用每次都全部重算。
export function subscribe(listener){
  listeners.push(listener);
  return () => {
    const idx = listeners.indexOf(listener);
    if(idx !== -1) listeners.splice(idx, 1);
  };
}

export function setState(patch){
  const prev = { ...state };
  Object.assign(state, patch);
  const changedKeys = Object.keys(patch).filter(k => prev[k] !== state[k]);
  if(changedKeys.length === 0) return; // 沒有實際改變就不廣播，避免多餘重繪
  listeners.forEach(listener => listener(state, prev, changedKeys));
}

/* ---------------------------------------------------------
   意圖動作（actions）── sidebarUI／searchUI／mapCore 自己的按鈕
   一律呼叫這些函式表達「使用者想要什麼」，不直接碰地圖圖層。
   真正的地圖操作統一在 mapCore.js 訂閱 store 之後集中處理。
--------------------------------------------------------- */

// 點選歷史圖層：再次點擊目前已啟用的同一個圖層 -> 取消（回到未套疊狀態）。
export function selectOverlayLayer(key){
  setState({ activeOverlayKey: state.activeOverlayKey === key ? null : key });
}

export function clearOverlayLayer(){
  setState({ activeOverlayKey: null });
}

export function setMode(mode){
  setState({ mode });
}

export function setBaseLayer(id){
  setState({ baseLayer: id });
}

export function setCompareSide(side, key){
  setState(side === 'A' ? { compareA: key } : { compareB: key });
}

export function setSwipePercent(percent){
  setState({ swipePercent: percent });
}

/* ---------------------------------------------------------
   複合疊圖模式的意圖動作。跟 selectOverlayLayer（單選 toggle）並列，
   語意是「加入/移出目前的疊圖組合」而不是「取代目前顯示的圖層」。
--------------------------------------------------------- */

// 勾選/取消勾選一張圖層：不在清單裡就加到最上層（陣列尾端）、
// 已經在清單裡就移除，是側邊欄 checkbox 點擊的核心邏輯。
export function toggleMultiOverlayLayer(key){
  const idx = state.multiOverlayLayers.findIndex(e => e.key === key);
  const next = idx === -1
    ? [...state.multiOverlayLayers, { key, opacity: 100 }]
    : state.multiOverlayLayers.filter(e => e.key !== key);
  setState({ multiOverlayLayers: next });
}

export function removeMultiOverlayLayer(key){
  const next = state.multiOverlayLayers.filter(e => e.key !== key);
  if(next.length === state.multiOverlayLayers.length) return; // 沒有這個 key，不用觸發廣播
  setState({ multiOverlayLayers: next });
}

export function setMultiOverlayOpacity(key, opacity){
  const next = state.multiOverlayLayers.map(e => e.key === key ? { ...e, opacity } : e);
  setState({ multiOverlayLayers: next });
}

// 調整疊放順序：direction 為 +1（疊到更上層，陣列往後移一格）或
// -1（疊到更下層，陣列往前移一格）。已經在最上/最下層時不做事。
export function moveMultiOverlayLayer(key, direction){
  const list = state.multiOverlayLayers;
  const idx = list.findIndex(e => e.key === key);
  if(idx === -1) return;
  const newIdx = idx + direction;
  if(newIdx < 0 || newIdx >= list.length) return;
  const next = [...list];
  [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
  setState({ multiOverlayLayers: next });
}

export function clearMultiOverlayLayers(){
  if(state.multiOverlayLayers.length === 0) return;
  setState({ multiOverlayLayers: [] });
}

/* ---------------------------------------------------------
   使用者自訂 WMTS／XYZ 圖層來源的意圖動作。跟複合疊圖模式共用同一套
   「勾選加入 multiOverlayLayers」機制來實際顯示在地圖上（見
   features/multiOverlay.js），這裡只負責維護「使用者加過哪些來源」
   這份清單本身，以及自動同步到 localStorage。
--------------------------------------------------------- */

// 產生一個不需要後端、在瀏覽器裡就能保證同一批清單內不重複的 id。
function generateCustomSourceId(){
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// entry: 手動新增時傳 { name, urlTemplate, format, attribution }（type
// 預設 'xyz'）；從 WMTS 服務匯入時傳 { name, type:'wmts', wmts, attribution }，
// `wmts` 是 features/wmtsImport.js 從 GetCapabilities 解析、抽出來的純資料
// tileGrid 設定（見 data.js 的 makeWmtsSourceFromEntry() 如何使用）。
// 回傳新建立的完整項目（含自動產生的 id），方便呼叫端立刻知道要用哪個 key。
export function addCustomSource(entry){
  const item = {
    id: generateCustomSourceId(),
    type: entry.type === 'wmts' ? 'wmts' : 'xyz',
    name: (entry.name || '').trim() || '未命名圖層',
    attribution: (entry.attribution || '').trim()
  };
  if(item.type === 'wmts'){
    item.wmts = entry.wmts; // 已經是可序列化的 plain object，呼叫端負責組好，這裡不重新驗證內容
  } else {
    item.urlTemplate = (entry.urlTemplate || '').trim();
    item.format = (entry.format || '').trim();
  }
  setState({ customSources: [...state.customSources, item] });
  persistCustomSources();
  return item;
}

// 刪除單筆自訂來源；如果這張圖層目前正疊在地圖上（在 multiOverlayLayers
// 清單裡），一併移除，避免留下一個指向已刪除來源、載入不出圖磚的殘留 key。
export function removeCustomSource(id){
  const next = state.customSources.filter(s => s.id !== id);
  if(next.length === state.customSources.length) return; // 沒有這筆，不用觸發廣播
  const key = `custom:${id}`;
  const nextMulti = state.multiOverlayLayers.filter(e => e.key !== key);
  setState({ customSources: next, multiOverlayLayers: nextMulti });
  persistCustomSources();
}

// 一次清空所有自訂來源，同樣要把它們從目前疊圖組合裡一併移除。
export function clearCustomSources(){
  if(state.customSources.length === 0) return;
  const customKeys = new Set(state.customSources.map(s => `custom:${s.id}`));
  const nextMulti = state.multiOverlayLayers.filter(e => !customKeys.has(e.key));
  setState({ customSources: [], multiOverlayLayers: nextMulti });
  persistCustomSources();
}
