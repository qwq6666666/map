/* ---------------------------------------------------------
   features/deviceHeading.js — 裝置朝向（羅盤）
   ---------------------------------------------------------
   持續追蹤位置時，額外用 DeviceOrientationEvent 讀裝置朝向，讓
   features/location.js 的藍點能疊一個指向使用者面向方位的錐形箭頭
   （比照 Google 地圖的「藍色錐形」）。跟定位本身是兩條獨立的資料
   來源、互不依賴：拿不到朝向（桌面電腦、瀏覽器不支援、使用者拒絕
   權限）只是錐形箭頭不出現，藍點本身完全不受影響，這支模組的所有
   函式都不會拋例外、呼叫端也不需要特別處理「沒有朝向資料」的情況。

   iOS 13+ 的 Safari 要求 DeviceOrientationEvent.requestPermission()
   必須在使用者手勢（click 等）的呼叫堆疊內、還沒有任何 await 之前
   同步呼叫才會生效，事後呼叫一律直接被拒絕；location.js 的「持續
   追蹤」按鈕本身就是使用者手勢，所以權限請求要排在 trackBtn 的
   click handler 最前面。Android Chrome／其餘瀏覽器沒有這個 API，
   不需要額外要權限，加監聽器就能直接收到事件。

   **尚未實機驗證**：
   - 螢幕旋轉成橫向時的方位校正（screen.orientation.angle 偏移）
     刻意不處理，只支援直向手持——這裡是走路導覽情境，直向是絕大
     多數使用方式；橫向時方位角可能偏差最多 90 度，之後如果有人
     反映再回來補。
   - computeCompassHeading() 的換算公式是業界通用寫法（MDN 範例／
     多數羅盤網頁共用），但沒有真機測過實際指向準確度，不同廠牌／
     瀏覽器的 alpha 校準基準可能有落差。
--------------------------------------------------------- */

// iOS Safari（13+）在 DeviceOrientationEvent 上多了 requestPermission()
// 這個靜態方法，且要求明確呼叫過、使用者同意才會派送事件；非 iOS
// 瀏覽器沒有這個方法，加監聽器就能直接收到事件，不需要額外要求。
export function needsOrientationPermission(){
  return typeof DeviceOrientationEvent !== 'undefined'
    && typeof DeviceOrientationEvent.requestPermission === 'function';
}

// 回傳 'granted'｜'denied'｜'unsupported'｜'not-needed'，呼叫端不需要處理
// 例外（比照 features/nativeShare.js 把結果正規化成字串的既有慣例）。
// 一定要在使用者手勢（click 等）呼叫堆疊內、還沒有任何 await 之前呼叫，
// iOS 才會認得這是使用者主動觸發；事後才呼叫（例如包在別的非同步流程
// 完成之後）一律直接被拒絕，這是 iOS 自己的安全限制，不是這裡的 bug。
export async function requestOrientationPermission(){
  if(typeof DeviceOrientationEvent === 'undefined') return 'unsupported';
  if(!needsOrientationPermission()) return 'not-needed';
  try{
    const result = await DeviceOrientationEvent.requestPermission();
    return result === 'granted' ? 'granted' : 'denied';
  }catch{
    return 'denied'; // 使用者拒絕，或瀏覽器本身拒絕（例如非 HTTPS）
  }
}

// 從單一 DeviceOrientationEvent 算出指南針方位角（0~360，0=正北，順時針
// 遞增，跟地圖／羅盤習慣一致）。優先用 iOS 的 webkitCompassHeading
// （Safari 自己校準過，已經是真北方位角，直接採用最準）；其餘瀏覽器
// 退回標準的 alpha 換算——alpha 是裝置繞 z 軸的旋轉角（W3C
// DeviceOrientation 規格），面朝正北時 alpha 通常趨近 0，方位角則隨
// 裝置往東轉而遞增，兩者方向剛好相反，業界通用寫法是 (360 - alpha) % 360
// （MDN 範例／多數羅盤網頁共用寫法，見函式頂端「尚未實機驗證」的說明）。
// alpha 缺失（部分瀏覽器/情境讀不到）回傳 null，呼叫端應該忽略這次事件，
// 不要誤更新成 0（0 是一個合法的「面朝正北」讀數，不能拿來當預設值）。
export function computeCompassHeading(event){
  if(typeof event.webkitCompassHeading === 'number' && Number.isFinite(event.webkitCompassHeading)){
    return event.webkitCompassHeading;
  }
  if(!Number.isFinite(event.alpha)) return null;
  return (360 - event.alpha) % 360;
}

// deviceorientation 事件不保證是「絕對方位」（相對於真北／磁北），部分
// 裝置沒有磁力計、只能提供相對於開始監聽當下姿態的相對角度，這種情況
// event.absolute 會是 false（或未定義），此時 alpha 不能當成指南針方位
// 使用，會誤導使用者往錯的方向走。iOS 的 webkitCompassHeading 是獨立的
// 屬性、一律代表真的指南針方位，不受這個限制。
function isUsableEvent(event){
  if(typeof event.webkitCompassHeading === 'number') return true;
  return event.absolute === true;
}

// 開始監聽裝置朝向，onHeading(headingDegrees) 每次有新讀數就呼叫一次
// （已經是 computeCompassHeading() 算好、且通過 isUsableEvent() 篩選的
// 值，呼叫端不用再處理原始事件）。回傳 stop()，供
// features/location.js 在停止追蹤時呼叫取消監聽。
//
// 不主動要求權限——呼叫端要在使用者手勢當下先呼叫
// requestOrientationPermission()，確認不是 'denied'／'unsupported' 才呼叫
// 這支函式，這裡只單純負責「掛監聽器、算方位、篩選、餵回呼叫端」，
// 職責跟權限請求分開，方便個別測試。
export function startWatchingHeading(onHeading){
  if(typeof window === 'undefined' || typeof window.addEventListener !== 'function'){
    return () => {};
  }
  const handleEvent = (event) => {
    if(!isUsableEvent(event)) return;
    const heading = computeCompassHeading(event);
    if(heading !== null) onHeading(heading);
  };
  // 兩個事件名稱都掛：deviceorientationabsolute（Chrome/Android，明確保證
  // 絕對方位）跟 deviceorientation（其餘瀏覽器，含 iOS）。同一個瀏覽器
  // 只會真的派送其中一種，沒有支援的事件名稱單純永遠不會 fire，掛兩個
  // 不會造成同一筆讀數重複觸發，比自己判斷「這個瀏覽器該用哪一種」更
  // 可靠、也更省維護。
  window.addEventListener('deviceorientationabsolute', handleEvent);
  window.addEventListener('deviceorientation', handleEvent);
  return function stop(){
    window.removeEventListener('deviceorientationabsolute', handleEvent);
    window.removeEventListener('deviceorientation', handleEvent);
  };
}
