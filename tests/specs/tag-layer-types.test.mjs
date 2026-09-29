import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'vitest';

/* ---------------------------------------------------------
   tests/specs/tag-layer-types.test.mjs
   ---------------------------------------------------------
   tools/tag-layer-types.js 原本零測試覆蓋。這裡測三件事：
     1. Step 1／Step 2 的關鍵字比對與優先順序（TYPE_RULES／
        PARENT_TYPE_RULES 陣列順序即優先順序，較前面先命中者勝出）。
     2. isRawPhotoLayer() 的 Step 0 排除邏輯：標題含「航照影像」「航拍」
        的原始空拍照片，即使標題或父層名稱裡湊巧出現「市區」「地形」
        等關鍵字，也必須強制維持 type: null（2026-09 審查發現的真實
        誤判：基隆市區舊航照影像／屏東市區舊航照影像／美軍_舊市區航拍
        因「市區」二字被誤標成行政區劃圖，見 keelung.json／pingtung.json／
        hualien.json 的 Keelung_aerialphoto_1962／Pingtung_aerialphoto_1948／
        Hualien_1945D）。
     3. 用真的 data/layers/*.json 全站掃描，驗證目前已 commit 的
        layer.type 欄位與腳本邏輯重新計算的結果完全一致（防止「新增
        圖層後忘記重新執行 tag-layer-types.js」或「改了規則卻忘記
        重新打標」兩種資料與程式碼不同步的情況）。
--------------------------------------------------------- */
const require = createRequire(import.meta.url);
const tagLayerTypes = require('../../tools/tag-layer-types.js');
const { forEachLayer } = require('../../tools/lib/layerWalk.js');

const {
  detectType,
  detectTypeFromParent,
  isRawPhotoLayer,
  resolveLayerType,
} = tagLayerTypes;

describe('detectType（Step 1：圖層自身標題／關鍵字）', () => {
  test('地形圖關鍵字優先於行政區劃圖：都市計畫地形圖類標題應歸為地形圖', () => {
    expect(detectType({ title: '新莊都市計畫地形圖', keywords: [] })).toBe('地形圖');
  });

  test('地籍圖關鍵字優先於行政區劃圖：市區舊地籍圖應歸為地籍圖', () => {
    expect(detectType({ title: '新竹市區舊地籍圖(1/1200)', keywords: [] })).toBe('地籍圖');
  });

  test('沒有任何關鍵字命中時回傳 null', () => {
    expect(detectType({ title: '某某不知名圖層', keywords: [] })).toBeNull();
  });

  test('keywords 陣列也會被納入比對文字', () => {
    expect(detectType({ title: '未命名', keywords: ['地籍'] })).toBe('地籍圖');
  });
});

describe('isRawPhotoLayer（Step 0：原始空拍照片排除）', () => {
  test('標題含「航照影像」即使湊巧含「市區」也視為原始照片', () => {
    const layer = { title: '基隆市區舊航照影像', keywords: [] };
    expect(isRawPhotoLayer(layer)).toBe(true);
    expect(detectType(layer)).toBeNull();
  });

  test('標題含「航拍」即使湊巧含「市區」也視為原始照片', () => {
    const layer = { title: '美軍_舊市區航拍(1945)', keywords: [] };
    expect(isRawPhotoLayer(layer)).toBe(true);
    expect(detectType(layer)).toBeNull();
  });

  test('「地形圖(航照修正版)」不是原始照片，仍應正常歸為地形圖（不誤殺）', () => {
    const layer = { title: '地形圖(航照修正版) 1:25,000', keywords: [] };
    expect(isRawPhotoLayer(layer)).toBe(false);
    expect(detectType(layer)).toBe('地形圖');
  });

  test('「像片基本圖」（正式圖幅產品，非原始照片）不受 Step 0 排除影響', () => {
    const layer = { title: '1/5000像片基本圖65', keywords: [] };
    expect(isRawPhotoLayer(layer)).toBe(false);
  });

  test('resolveLayerType：原始照片即使父層名稱含地形圖關鍵字，Step 2 也不應接手繼承', () => {
    const layer = { title: '某地舊航照影像', keywords: [] };
    const { type, inherited } = resolveLayerType(layer, '日治時期地形圖／地圖');
    expect(type).toBeNull();
    expect(inherited).toBe(false);
  });
});

describe('detectTypeFromParent（Step 2：父層關鍵字繼承）', () => {
  test('父層名稱含「地形」時繼承為地形圖', () => {
    expect(detectTypeFromParent('日治時期地形圖／地圖')).toBe('地形圖');
  });

  test('父層名稱含「都市計畫」不會被繼承為行政區劃圖（PARENT_TYPE_RULES 刻意不收錄）', () => {
    expect(detectTypeFromParent('市街／都市計畫圖')).toBeNull();
  });

  test('父層名稱沒有任何專用關鍵字時回傳 null', () => {
    expect(detectTypeFromParent('未分類主題圖')).toBeNull();
  });
});

describe('resolveLayerType 與全站 data/layers/*.json 現況一致性回歸', () => {
  const LAYERS_DIR = path.join(process.cwd(), 'data', 'layers');
  const index = JSON.parse(readFileSync(path.join(LAYERS_DIR, 'index.json'), 'utf-8'));

  test('每一筆圖層目前 commit 的 type 欄位，都與腳本邏輯重新計算的結果一致', () => {
    const mismatches = [];
    let total = 0;

    index.sources.forEach(entry => {
      const src = JSON.parse(readFileSync(path.join(LAYERS_DIR, entry.file), 'utf-8'));
      forEachLayer(src, (layer, parentText) => {
        total += 1;
        const { type: computed } = resolveLayerType(layer, parentText);
        const existing = layer.type === undefined ? null : layer.type;
        if(existing !== computed){
          mismatches.push({ source: entry.file, id: layer.id, title: layer.title, existing, computed });
        }
      });
    });

    expect(total).toBeGreaterThan(0);
    expect(mismatches, `發現 ${mismatches.length} 筆圖層 type 與重新打標結果不一致，請執行 node tools/tag-layer-types.js 後再 node tools/build-layers-bundle.js：\n${JSON.stringify(mismatches, null, 2)}`).toEqual([]);
  });
});
