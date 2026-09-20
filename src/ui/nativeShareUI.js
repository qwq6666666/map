/* ---------------------------------------------------------
   ui/nativeShareUI.js — 「分享連結」「傳送截圖…」「下載截圖」按鈕
   ---------------------------------------------------------
   「分享連結」只有一顆：觸控裝置（手機／平板）優先叫出系統分享面板
   （Web Share API，見 features/nativeShare.js），面板裡本來就有「複製」；
   桌面、或面板叫不出來（被擋、失敗、環境不支援）就直接複製網址，
   所以不需要另外一顆「傳送連結」。使用者自己關掉面板不算失敗，不再複製。
   「傳送截圖…」是另一件事（分享的是圖片檔），環境不支援檔案分享就維持
   hidden：桌面瀏覽器多半沒有，藏起來比按下去才說不支援好。
   「下載截圖」直接呼叫 drawTool.exportImage()，不必先打開繪圖工具列。
   同一功能有兩組入口——「⋯ 更多」選單（#shareLinkBtn／#shareNativeImageBtn／
   #downloadImageBtn）與手機版「地圖工具」浮動選單（data-help-action，
   由 ui/mobileLayout.js 轉發 click 給前者）。
--------------------------------------------------------- */
import { canShareFiles, prefersNativeShare, shareLinkNative } from '../features/nativeShare.js';
import { buildShareURL, copyShareLink, shareStateHasCustomLayers } from '../features/shareLink.js';
import { showLocateToast } from '../features/location.js';
import { shareImage, exportImage } from '../drawTool.js';

const CUSTOM_LAYER_NOTE = '（自訂圖層不會包含在分享連結內）';

async function onShareLinkClick(){
  // navigator.share() 一定要在使用者手勢內呼叫，所以這裡在任何 await 之前就先叫。
  if(prefersNativeShare()){
    const result = await shareLinkNative({ url: buildShareURL(), title: '百年歷史地圖' });
    if(result === 'shared'){
      if(shareStateHasCustomLayers()) showLocateToast(`已分享${CUSTOM_LAYER_NOTE}`);
      return;
    }
    if(result === 'cancelled') return;
    // blocked／failed／unsupported：面板叫不出來，退回直接複製，不讓這次操作白做。
  }
  const ok = await copyShareLink();
  if(ok && shareStateHasCustomLayers()){
    showLocateToast(`連結已複製${CUSTOM_LAYER_NOTE}`);
  }else{
    showLocateToast(ok ? '連結已複製' : '複製失敗，請手動複製網址列');
  }
}

export function initNativeShareUI(){
  const supported = { image: canShareFiles() };
  document.querySelectorAll('[data-native-share]').forEach((el) => {
    el.hidden = !supported[el.dataset.nativeShare];
  });

  document.getElementById('shareLinkBtn')?.addEventListener('click', onShareLinkClick);

  // 截圖是非同步產生的，成功／失敗的提示與下載備援都在 drawTool.shareImage() 內。
  document.getElementById('shareNativeImageBtn')?.addEventListener('click', () => shareImage());
  document.getElementById('downloadImageBtn')?.addEventListener('click', () => exportImage());
}
