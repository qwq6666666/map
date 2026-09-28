/* ---------------------------------------------------------
   layer-manager-fade-race.test.mjs — core/layerManager.js 回歸測試
   ---------------------------------------------------------
   回歸案例：快速連續切換「疊圖模式目前這一張」歷史圖層（X→Y→X，
   三次呼叫都落在彼此的 FADE_GRACE_MS 暖機時間內），最後一次切回 X
   時因為 X 已經在快取裡（alreadyWarm），會立即開始交叉淡出淡入；
   但前兩次呼叫（X、Y 都是「當時」的 cold miss）各自排定的
   setTimeout(startFade, FADE_GRACE_MS) 仍然還沒觸發，稍後才依序
   觸發，各自拿著呼叫當下捕捉到的舊 newLayer／previousLayer 閉包，
   在使用者早已切回 X 之後，把已經不該顯示的 Y 淡入、把應該顯示的 X
   淡出——最終畫面顯示錯誤的圖層，即使 store.activeOverlayKey／
   runtime.historyLayerKey 都正確地是 X。

   不透過完整 UI 初始化（比照 layer-cache.test.mjs／
   multi-overlay-manager.test.mjs 的既有慣例），直接呼叫
   selectOverlayLayer() 更新 store，再手動呼叫 applyActiveOverlayKey()
   模擬 core/modeManager.js 的 store 訂閱者會做的事。
--------------------------------------------------------- */
import { test, expect, vi } from 'vitest';
import '../env-stub.mjs';
import { loadAppData, DATA } from '../../src/data.js';
import { clearCache, getCachedLayer } from '../../src/core/layerCache.js';
import { applyActiveOverlayKey } from '../../src/core/layerManager.js';
import { selectOverlayLayer } from '../../src/store.js';

await loadAppData();

const sinica = DATA.LAYER_SOURCES.find(s => s.id === 'sinica');
const layerX = sinica.categories[0].layers[0];
const layerY = sinica.categories[0].layers[1];
const keyX = `hist:sinica:${layerX.id}:${layerX.fmt}`;
const keyY = `hist:sinica:${layerY.id}:${layerY.fmt}`;

test('快速切換 X→Y→X（都在暖機時間內）：最終應顯示 X，過期的延遲淡入/淡出不應該事後蓋掉最新狀態', () => {
  vi.useFakeTimers();
  try{
    clearCache();
    selectOverlayLayer(null);

    selectOverlayLayer(keyX);
    applyActiveOverlayKey(); // X 是 cold miss，排定 250ms 後才開始交叉淡出淡入

    vi.advanceTimersByTime(50);
    selectOverlayLayer(keyY);
    applyActiveOverlayKey(); // Y 也是 cold miss，同樣排定 250ms 後才開始

    vi.advanceTimersByTime(50);
    selectOverlayLayer(keyX);
    applyActiveOverlayKey(); // X 已經在快取裡（alreadyWarm），立即開始交叉淡出淡入

    vi.runAllTimers(); // 讓所有還沒觸發的排程（含前兩次過期的暖機計時器與淡出淡入動畫）全部跑完

    const finalLayerX = getCachedLayer(keyX);
    const finalLayerY = getCachedLayer(keyY);
    expect(finalLayerX.getOpacity(), '最新選擇的 X 最終應該是完全顯示').toBe(1);
    expect(finalLayerY.getOpacity(), '已經切走的 Y 最終應該維持隱藏').toBe(0);
  } finally {
    vi.useRealTimers();
    clearCache();
  }
});
