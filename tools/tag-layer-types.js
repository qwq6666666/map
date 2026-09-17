/* ---------------------------------------------------------
   tools/tag-layer-types.js
   ---------------------------------------------------------
   批次依關鍵字比對，自動填入 data/layers/<id>.json 內每筆圖層的
   type 欄位（地形圖／地籍圖／海圖／行政區劃圖），供前端搜尋結果面板的
   「依類型篩選」功能使用（見 src/features/search.js 的
   SEARCH_RESULT_TYPES；新增「海圖」type 後，若要在前端開放獨立篩選
   分頁，需另外同步更新 SEARCH_RESULT_TYPES，屬 feature-state-agent
   權責，本檔僅負責資料標記）。

   比對依據（Step 1）：layer.title 與 layer.keywords 合併後的字串，
   依優先順序（地形圖 > 地籍圖 > 海圖 > 行政區劃圖）比對關鍵字，第一個
   命中的分類即採用。「海圖」涵蓋日式/海事測繪常見的港灣海圖、水路圖、
   水道圖等史料（實測抽樣 hongkong/tamsui/japan/wuhan 四個來源標題後
   歸納），另補上「海口圖」「港區」「港灣」「築港」等更精確的港灣測繪
   用詞（2026-09 覆蓋率調整；刻意不用單一「港」字，會誤中「南港」「鹿港」
   「花蓮港」「新港郡」等地名）；「行政區劃圖」額外收錄「市街」（含日式
   漢字「市街図」）與「界址」，涵蓋城市街道圖／疆界圖等未被既有關鍵字
   涵蓋的常見標題，2026-09 再補上「都市計畫／都市計劃」「全圖」「管內圖」
   「城市圖」「略圖」「明細圖」等常見市街／都市計畫圖標題型態（實測抽樣
   全站未分類標題後歸納，詳見 TYPE_RULES 旁註解）。「航照」「航測影像」
   「正射影像」等空拍照片刻意不歸類到任何既有分類，維持 type: null。

   若 Step 1 比對不到任何關鍵字（type 仍為 null），則進入 Step 2：
   改用該圖層所屬的父層名稱（cat.name，若有 group.name 則一併合併）
   依同樣的優先順序，比對父層專用關鍵字（PARENT_TYPE_RULES 刻意維持比
   Step 1 更保守的關鍵字組合，避免混合主題資料夾把子層誤判成同一類，
   詳見 PARENT_TYPE_RULES 旁註解）。兩階段都沒命中則維持 type: null
   （不新增「其他」分類，前端目前沒有對應的篩選入口）。

   用法：
       node tools/tag-layer-types.js

   執行後記得重新打包：
       node tools/build-layers-bundle.js
--------------------------------------------------------- */
const fs = require('node:fs');
const path = require('node:path');
const { forEachLayer } = require('./lib/layerWalk');

const LAYERS_DIR = path.join(__dirname, '..', 'data', 'layers');

// 依優先順序排列：陣列中較前面的分類優先比對（Step 1：圖層自身標題/關鍵字）
// 覆蓋率調整（2026-09）：實測抽樣全站未分類標題後，補上下列語意上明確歸屬既有
// 分類、且不會誤判的關鍵字——「港」單獨一字風險過高（會誤中「南港」「鹿港」
// 「花蓮港」「新港郡」等地名，並非都指港灣海圖），改用更精確的「海口圖」
// 「港區」「港灣」「築港」；「都市計畫／都市計劃」「全圖」「管內圖」「城市圖」
// 「略圖」「明細圖」則是市街／行政區域圖常見標題型態，語意上與既有「市街」
// 「市區」同一類。「航照」「航測」「正射影像」等空拍影像刻意不歸類到任何既有
// type（不是地圖類型，硬塞會造成語意錯誤），維持 null 交由前端「未分類」呈現。
const TYPE_RULES = [
  { type: '地形圖', keywords: ['地形', '等高線'] },
  { type: '地籍圖', keywords: ['地籍', '土地', '地番'] },
  { type: '海圖', keywords: ['海圖', '水路圖', '水道圖', '海口圖', '港區', '港灣', '築港'] },
  { type: '行政區劃圖', keywords: ['行政區', '市區', '街庄', '堡里', '地圖', '市街', '界址', '都市計畫', '都市計劃', '全圖', '管內圖', '城市圖', '略圖', '明細圖'] },
];

// 依同樣的優先順序排列：Step 2 父層（category／group 名稱）專用關鍵字
// 注意：「都市計畫／都市計劃」刻意不加進這裡——父層分類常是「地形圖／都市計畫圖」
// 「市街／都市計畫圖」這類混合主題資料夾，folder 名稱含「都市計畫」不代表夾在裡面
// 的每一筆圖層都是都市計畫圖（實測發現會誤中灌溉區域圖、官有林野圖、台灣堡圖、
// 國家公園區域圖、數值高程圖等明顯不屬於行政區劃圖的項目），僅在 Step 1（圖層自身
// 標題）採用該關鍵字，父層繼承仍維持原本較保守的關鍵字組合。
const PARENT_TYPE_RULES = [
  { type: '地形圖', keywords: ['地形', '測量部', '等高線', '萬分一'] },
  { type: '地籍圖', keywords: ['地籍', '登記所', '土地調查'] },
  { type: '海圖', keywords: ['海圖', '水路部'] },
  { type: '行政區劃圖', keywords: ['市區改正', '行政區', '管轄', '境界'] },
];

function matchRules(text, rules){
  for(const rule of rules){
    if(rule.keywords.some(kw => text.includes(kw))) return rule.type;
  }
  return null;
}

function detectType(layer){
  const text = `${layer.title || ''} ${(layer.keywords || []).join(' ')}`;
  return matchRules(text, TYPE_RULES);
}

function detectTypeFromParent(parentText){
  return matchRules(parentText, PARENT_TYPE_RULES);
}

const index = JSON.parse(fs.readFileSync(path.join(LAYERS_DIR, 'index.json'), 'utf-8'));

const counts = { '地形圖': 0, '地籍圖': 0, '海圖': 0, '行政區劃圖': 0, '未分類': 0 };
let total = 0;
let inheritedCount = 0;

index.sources.forEach(entry => {
  const filePath = path.join(LAYERS_DIR, entry.file);
  const src = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

  forEachLayer(src, (layer, parentText) => {
    let type = detectType(layer);
    if(type === null){
      const inherited = detectTypeFromParent(parentText);
      if(inherited !== null){
        type = inherited;
        inheritedCount += 1;
      }
    }
    layer.type = type;
    total += 1;
    counts[type === null ? '未分類' : type] += 1;
  });

  fs.writeFileSync(filePath, JSON.stringify(src, null, 2) + '\n');
});

console.log('圖層 type 標記統計：');
console.log(`  地形圖　　：${counts['地形圖']}`);
console.log(`  地籍圖　　：${counts['地籍圖']}`);
console.log(`  海圖　　　：${counts['海圖']}`);
console.log(`  行政區劃圖：${counts['行政區劃圖']}`);
console.log(`  未分類　　：${counts['未分類']}`);
console.log(`  總筆數　　：${total}`);
console.log(`  （其中透過父層繼承判定：${inheritedCount} 筆）`);
