/* ---------------------------------------------------------
   custom-timeline-overlay-interaction.test.mjs
   ---------------------------------------------------------
   回歸案例（跨模組交互，透過完整操作序列模擬找出）：
   `multi-overlay-manager.test.mjs` 已經證實複合疊圖模式的
   hideMultiOverlayLayers()／applyMultiOverlayLayers() 都會刻意跳過
   「自訂時間軸」正在預覽的 previewedKey，避免悄悄把 dock 仍宣稱在
   顯示的圖層隱藏掉（見 core/multiOverlayManager.js 的 resetLayerVisual）。

   但疊圖模式（core/layerManager.js）的 fadeOutOrphanedLayers()——
   每次呼叫 applyActiveOverlayKey() 交叉淡出淡入新圖層時，會把
   layerCache 裡所有 opacity>0、不是這次新圖層、也不在 getProtectedKeys()
   保護名單裡的圖層全部淡出到 0——完全沒有同樣的 previewedKey 排除。
   getProtectedKeys()（core/protectedKeys.js）也不知道 previewedKey
   的存在（customTimeline.js 檔頭已註明這件事，只做了它自己能力所及
   的部分：在 multiOverlayManager.js 補洞，layerManager.js 這邊漏了）。

   重現步驟：
   1. 使用者從搜尋結果多選圖層，開啟自訂時間軸 dock，預覽圖層 A
      （previewLayerOnMap，不透過 store，直接操作 layerCache）。
   2. 使用者在疊圖模式（一般側邊欄操作，跟 dock 完全獨立）另外選了
      圖層 B：selectOverlayLayer(B) → applyActiveOverlayKey()。
   3. 預期：dock 仍顯示「正在預覽 A」，地圖上的 A 也應該維持可見；
      實際（修正前）：fadeOutOrphanedLayers(B) 把 A 一併淡出到 0，
      畫面上 A 悄悄消失，跟 dock UI 顯示的狀態不一致。
--------------------------------------------------------- */
import { test, expect, vi } from 'vitest';
import '../env-stub.mjs';
import { loadAppData, DATA } from '../../src/data.js';
import { selectOverlayLayer } from '../../src/store.js';
import { applyActiveOverlayKey } from '../../src/core/layerManager.js';
import { clearCache, getCachedLayer } from '../../src/core/layerCache.js';
import { previewLayerOnMap, clearPreviewLayer, getPreviewedKey } from '../../src/features/customTimeline.js';

await loadAppData();

const sinica = DATA.LAYER_SOURCES.find(s => s.id === 'sinica');
const layerA = sinica.categories[0].layers[0];
const layerB = sinica.categories[0].layers[1];
const keyA = `hist:sinica:${layerA.id}:${layerA.fmt}`;
const keyB = `hist:sinica:${layerB.id}:${layerB.fmt}`;

test('疊圖模式切換到新圖層 B 時，不應該把「自訂時間軸」正在預覽的圖層 A 一併淡出（回歸案例）', () => {
  vi.useFakeTimers();
  try{
    clearCache();
    selectOverlayLayer(null);
    clearPreviewLayer();

    // 自訂時間軸 dock 正在預覽 A（完全獨立於 store.activeOverlayKey）。
    previewLayerOnMap({ id: 'sinica' }, { id: layerA.id, fmt: layerA.fmt }, 100);
    expect(getPreviewedKey(), 'previewedKey 應該等於 keyA').toBe(keyA);
    expect(getCachedLayer(keyA).getOpacity(), '預覽中的 A 應該完全顯示').toBe(1);

    // 使用者另外在疊圖模式（跟 dock 無關）選了圖層 B。
    selectOverlayLayer(keyB);
    applyActiveOverlayKey();
    vi.runAllTimers(); // 讓交叉淡出淡入與孤兒圖層掃描全部跑完

    expect(getCachedLayer(keyB).getOpacity(), '新選擇的 B 應該完全顯示').toBe(1);
    expect(
      getCachedLayer(keyA).getOpacity(),
      '正被自訂時間軸預覽中的 A，不應該被疊圖模式的孤兒圖層淡出邏輯一併隱藏'
    ).toBe(1);
  } finally {
    vi.useRealTimers();
    clearPreviewLayer();
    clearCache();
  }
});
