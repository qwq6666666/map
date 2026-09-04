/* ---------------------------------------------------------
   customTimeline.js — 自訂時間軸：從搜尋結果多選一批圖層，
   依年代排序組成一條時間軸，交給獨立的浮動 dock UI
  （features/customTimelineUI.js）顯示與操作。這個功能完全獨立於
   全站時間軸模式（timelineMode.js／timelineUI.js／store.mode），
   不會共用、也不會互相干擾。
--------------------------------------------------------- */
import { getOrCreateLayer, hideLayer, setLayerOpacity } from '../core/layerCache.js';
import { getProtectedKeys } from '../core/protectedKeys.js';
import { layerKey } from '../data.js';
import { openCustomTimelineDock } from './customTimelineUI.js';

// 擷取西元年份數字用的正則：抓第一組 18xx/19xx/20xx 四位數字。
const YEAR_REGEX = /(1[89]\d{2}|20\d{2})/;

/**
 * 從 layer 擷取西元年份數字：優先使用 data.js 載入時已經解析好的
 * layer.yearNum；沒有的話 fallback 用正則表達式從 layer.year（顯示
 * 用字串，例如「明治28年」「1904」）或 layer.title 抓第一組年份，
 * 兩邊都抓不到就回傳 null（年代不明）。
 * @param {{ yearNum?: number, year?: string, title?: string }} layer
 * @returns {number|null}
 */
export function extractYearNum(layer){
  if(typeof layer.yearNum === 'number') return layer.yearNum;
  const text = `${layer.year || ''} ${layer.title || ''}`;
  const m = text.match(YEAR_REGEX);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * 依年代由遠到近（西元年數字由小到大）排序 selected（{src,layer} 陣列，
 * 通常是使用者在搜尋結果多選出來的一批）；年代不明的排在最後面，彼此
 * 之間維持原始被勾選的順序（Array.prototype.sort 對相同排序值保證穩定，
 * 不用額外處理）。回傳新陣列，不 mutate 傳入的 selected；每筆的 layer
 * 若原本沒有 yearNum，會補上 fallback 算出來的值，避免 timelineUI.js
 * 的 buildTimeline() 誤判成「年代不明」。
 * @param {Array<{src, layer}>} selected
 * @returns {Array<{src, layer}>}
 */
export function buildCustomTimelineCandidates(selected){
  return [...selected]
    .map(c => {
      const yearNum = typeof c.layer.yearNum === 'number' ? c.layer.yearNum : extractYearNum(c.layer);
      return yearNum === c.layer.yearNum ? c : { ...c, layer: { ...c.layer, yearNum } };
    })
    .sort((a, b) => {
      const ay = a.layer.yearNum, by = b.layer.yearNum;
      if(ay == null && by == null) return 0;
      if(ay == null) return 1;  // 年代不明排最後
      if(by == null) return -1;
      return ay - by; // 由小到大＝由遠到近
    });
}

// ---------------------------------------------------------
// 獨立的單一預覽圖層機制：完全不透過 store.activeOverlayKey／
// runtime.historyLayer，直接操作 core/layerCache.js，確保跟系統
// 原本「疊圖模式目前這一張」互不影響——這是「自訂時間軸」功能
// 要求完全獨立（不污染全域時間軸/疊圖狀態）的核心手段，搜尋結果
// 面板的「瞬態預覽」跟這裡自訂時間軸 dock 的「目前顯示這一張」
// 共用同一份機制與同一個 previewedKey，因為兩者在時間軸上互斥
// （dock 開啟時搜尋面板一定已經退出多選/清過預覽），不會衝突。
// ---------------------------------------------------------
let previewedKey = null;

export function previewLayerOnMap(src, layer, opacityPercent = 100){
  const key = layerKey(src, layer);
  if(previewedKey && previewedKey !== key) hideLayer(previewedKey);
  const tileLayer = getOrCreateLayer(key, getProtectedKeys());
  tileLayer.setOpacity(Math.max(0, Math.min(100, opacityPercent)) / 100);
  previewedKey = key;
  return key;
}

export function setPreviewOpacity(opacityPercent){
  if(!previewedKey) return;
  setLayerOpacity(previewedKey, Math.max(0, Math.min(100, opacityPercent)) / 100);
}

export function clearPreviewLayer(){
  if(previewedKey) hideLayer(previewedKey);
  previewedKey = null;
}

/**
 * 供搜尋面板呼叫的唯一進入點：把使用者從搜尋結果勾選的一批圖層依
 * 年代排序，開啟獨立的自訂時間軸 dock（customTimelineUI.js），並
 * 立即預覽排序後第一筆（年代最舊）的圖層。回傳排序後的候選清單。
 * @param {Array<{src, layer}>} selected
 * @returns {Array<{src, layer}>}
 */
export function createCustomTimelineFromSelection(selected){
  const candidates = buildCustomTimelineCandidates(selected);
  let opacity = 100;

  openCustomTimelineDock(candidates, {
    // dock 本身已經有完整的 candidates 陣列，callback 直接把使用者選到
    // 的那個項目（{src, layer}）傳回來，這裡不需要另外自己存一份序列。
    onSelectIndex: (idx, item) => {
      if(!item) return;
      previewLayerOnMap(item.src, item.layer, opacity);
    },
    onOpacityChange: (percent) => {
      opacity = percent;
      setPreviewOpacity(percent);
    },
    onClose: () => {
      clearPreviewLayer();
    }
  });

  if(candidates.length > 0) previewLayerOnMap(candidates[0].src, candidates[0].layer, opacity);

  return candidates;
}
