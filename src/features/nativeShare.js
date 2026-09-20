/* ---------------------------------------------------------
   features/nativeShare.js — 瀏覽器原生「分享」面板（Web Share API）
   ---------------------------------------------------------
   手機瀏覽器可以直接叫出系統分享面板，一步傳到 LINE／Instagram／訊息
   等 App；不用先複製連結、或先下載圖片再到別的 App 找檔案。
   只做兩件事：
     - canShareLink()／canShareFiles()：偵測目前環境支不支援（不支援就
       由 UI 端把按鈕藏起來，桌面瀏覽器多半沒有）。
     - shareLinkNative()／shareFileNative()：呼叫 navigator.share()，
       把各種結果統一成字串，呼叫端不用自己處理例外：
         'shared'      分享面板已送出（不代表對方收到，只代表使用者按了送出）
         'cancelled'   使用者自己關掉面板（不是錯誤，不該跳提示）
         'blocked'     瀏覽器認為不是使用者手勢觸發（NotAllowedError）。
                       截圖是非同步產生的，等太久手勢就過期，iOS Safari
                       比較嚴格；呼叫端應改走下載等備援
         'unsupported' 環境本來就不支援
         'failed'      其他錯誤
   navigator.share() 一定要在使用者手勢（click）裡呼叫，不能自己在背景觸發。
--------------------------------------------------------- */

export function canShareLink(){
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

// 不是每個支援 share() 的瀏覽器都能分享檔案（桌面 Chrome 就常常不行），
// 要用 canShare() 拿一個假檔案實際問過才準。
export function canShareFiles(){
  if(!canShareLink() || typeof navigator.canShare !== 'function' || typeof File === 'undefined') return false;
  try{
    return navigator.canShare({ files: [new File([''], 'probe.png', { type: 'image/png' })] });
  }catch{
    return false;
  }
}

async function runShare(data){
  try{
    await navigator.share(data);
    return 'shared';
  }catch(err){
    if(err?.name === 'AbortError') return 'cancelled';
    if(err?.name === 'NotAllowedError') return 'blocked';
    console.warn('原生分享失敗', err);
    return 'failed';
  }
}

export async function shareLinkNative({ url, title }){
  if(!canShareLink()) return 'unsupported';
  return runShare({ url, title });
}

export async function shareFileNative(file, { title } = {}){
  if(!canShareFiles()) return 'unsupported';
  return runShare({ files: [file], title });
}
