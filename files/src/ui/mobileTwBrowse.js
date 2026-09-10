/* ---------------------------------------------------------
   ui/mobileTwBrowse.js — 手機版「台灣」分頁專用：大區域→地區→來源手風琴
   ---------------------------------------------------------
   只服務 sidebarUI.js 的手機版（<=768px）「台灣」分頁瀏覽方式。第三段
   不再自己刻一份扁平清單，而是重用 sidebarUI.js 抽出的 buildSourceGroup()
   （跟桌機「來源(機構)→分類→次分類→圖層」手風琴共用同一套建置邏輯，見
   sidebarUI.js 的 renderSourceAccordion()／buildSourceGroup()），只是依
   目前選中的大區域／地區篩出對應來源，各自重新生成一份獨立的手風琴 DOM。

   這支檔案只留「台灣專屬設定資料」（REGION_LABEL_OVERRIDES／
   MACRO_REGION_MAP／FIXED_AREA_ORDER）與對應的純函式
   （macroRegionForSource／regionLabelForSource，刻意不碰 DOM，方便
   獨立單元測試）；實際共用的 DOM 建構邏輯與
   guessRegionFromLastLocation() 已抽到 src/ui/mobileRegionBrowse.js，
   跟 mobileCnBrowse.js 共用。buildMobileTwBrowseUI() 回傳的容器由呼叫端
   自行決定何時 append／顯示（見 sidebarUI.js 的 syncMobileBrowseView()，
   用 hidden attribute 控制）。
--------------------------------------------------------- */
import { buildMobileRegionBrowseUI } from './mobileRegionBrowse.js';

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

// 已跟使用者確認過的分組（北部 8、中部 4、南部 5、東部 3、離島 2、
// 全國 2，加總 24，跟目前 tw 來源總數一致）。
const MACRO_REGION_MAP = {
  sinica: '全國', nlsc: '全國',
  taipei: '北部', udd: '北部', newtaipei: '北部', tamsui: '北部',
  keelung: '北部', taoyuan: '北部', hsinchu: '北部', thm: '北部',
  taichung: '中部', changhua: '中部', lukang: '中部', puli: '中部',
  chiayi: '南部', tainan: '南部', kaohsiung: '南部', pingtung: '南部', hakkaliudui: '南部',
  hualien: '東部', taitung: '東部', yilan: '東部',
  kinmen: '離島', penghu: '離島'
};

export function macroRegionForSource(src){
  return MACRO_REGION_MAP[src.id] || '其他'; // fallback 防禦性，目前 24 個 tw 來源不會走到
}

// 北部／中部／南部固定顯示順序；東部／離島／全國維持依筆數由多到少排序。
export const FIXED_AREA_ORDER = {
  '北部': ['臺北', '新北', '基隆', '桃園', '新竹', '桃竹苗', '淡水'],
  '中部': ['臺中', '彰化', '鹿港', '埔里'],
  '南部': ['嘉義', '臺南', '高雄', '屏東', '六堆']
};

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
  return buildMobileRegionBrowseUI({
    rootClassName: 'mobile-tw-browse',
    countryCode: 'tw',
    macroOrder: MACRO_REGION_ORDER,
    macroRegionForSource,
    regionLabelForSource,
    fixedAreaOrder: FIXED_AREA_ORDER
  }, twSources, buildSourceGroup);
}
