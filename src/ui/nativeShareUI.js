/* ---------------------------------------------------------
   ui/nativeShareUI.js — 「傳送連結…」「傳送截圖…」按鈕
   ---------------------------------------------------------
   叫出系統分享面板（Web Share API，見 features/nativeShare.js）。跟既有
   「分享連結」（複製到剪貼簿）並存、不取代：想貼到別處或瀏覽器不支援
   時，原本的複製仍然可用。
   按鈕預設 hidden，環境支援才顯示：桌面瀏覽器多半沒有分享面板，藏起來
   比按下去才說不支援好。同一功能有兩組入口——「⋯ 更多」選單
   （#shareNative*Btn）與手機版「地圖工具」浮動選單（data-help-action，
   由 ui/mobileLayout.js 轉發 click 給前者）——都用 data-native-share
   標記，這裡一次處理。
--------------------------------------------------------- */
import { canShareLink, canShareFiles, shareLinkNative } from '../features/nativeShare.js';
import { buildShareURL, shareStateHasCustomLayers } from '../features/shareLink.js';
import { showLocateToast } from '../features/location.js';
import { shareImage } from '../drawTool.js';

export function initNativeShareUI(){
  const supported = { link: canShareLink(), image: canShareFiles() };
  document.querySelectorAll('[data-native-share]').forEach((el) => {
    el.hidden = !supported[el.dataset.nativeShare];
  });

  const linkBtn = document.getElementById('shareNativeLinkBtn');
  const imageBtn = document.getElementById('shareNativeImageBtn');

  linkBtn?.addEventListener('click', async () => {
    const result = await shareLinkNative({ url: buildShareURL(), title: '百年歷史地圖' });
    if(result === 'shared' && shareStateHasCustomLayers()){
      showLocateToast('已分享（自訂圖層不會包含在分享連結內）');
    } else if(result === 'blocked' || result === 'failed' || result === 'unsupported'){
      showLocateToast('無法開啟分享面板，請改用「分享連結」複製網址');
    }
  });

  // 截圖是非同步產生的，成功／失敗的提示與下載備援都在 drawTool.shareImage() 內。
  imageBtn?.addEventListener('click', () => shareImage());
}
