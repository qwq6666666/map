/* ---------------------------------------------------------
   storage.js — 使用者繪圖／匯入圖資的 localStorage 本地持久化
   ---------------------------------------------------------
   純函式模組，不依賴任何其他 src 模組（比照 data.js／geocode.js 的
   風格），只負責把一份 GeoJSON FeatureCollection 讀寫進 localStorage。

   設計取捨：
   - MAX_BYTES 上限：localStorage 常見配額約 5MB，同一個網域下還有
     store.js 的自訂圖層清單（customSources）等其他 key 共用額度，
     這裡保守抓在 4.5MB，避免使用者畫了大量圖形把配額整個用光、
     連自訂圖層都存不進去。
   - 所有函式都不丟例外：這是「錦上添花」的自動儲存功能，不是關鍵
     路徑，任何一步（序列化、寫入、配額超過、快取壞掉）失敗都不該讓
     繪圖工具本身或整個 app 掛掉，呼叫端只需要看回傳值決定要不要提示。
--------------------------------------------------------- */

const STORAGE_KEY = 'taiwan_map_user_features';
const MAX_BYTES = 4.5 * 1024 * 1024; // 保守抓在 localStorage 常見 5MB 配額之下，留緩衝給其他 key（例如 customSources）

/**
 * 把一份 GeoJSON FeatureCollection 存進 localStorage。
 * @param {object} featureCollection 標準 GeoJSON FeatureCollection 物件
 * @returns {boolean} 是否成功寫入
 */
export function saveUserFeatures(featureCollection){
  try{
    const json = JSON.stringify(featureCollection);
    if(json.length > MAX_BYTES){
      console.warn('繪製內容過大，超過本機儲存上限，放棄自動儲存。');
      return false;
    }
    localStorage.setItem(STORAGE_KEY, json);
    return true;
  }catch(err){
    // 常見情況：QuotaExceededError（配額已滿）或瀏覽器停用 localStorage（無痕模式等）
    console.warn('儲存繪製內容到本機失敗', err);
    return false;
  }
}

/**
 * 讀出先前存過的 GeoJSON FeatureCollection。
 * @returns {object|null} 沒有快取或格式錯誤回傳 null
 */
export function loadUserFeatures(){
  try{
    const json = localStorage.getItem(STORAGE_KEY);
    if(!json) return null;
    return JSON.parse(json);
  }catch(err){
    console.warn('讀取本機繪製內容快取失敗，忽略這份壞掉的快取', err);
    return null;
  }
}

/**
 * 清除本機儲存的繪製內容快取。
 * @returns {boolean} 是否成功清除
 */
export function clearUserFeatures(){
  try{
    localStorage.removeItem(STORAGE_KEY);
    return true;
  }catch(err){
    console.warn('清除本機繪製內容快取失敗', err);
    return false;
  }
}
