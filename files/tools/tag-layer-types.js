/* ---------------------------------------------------------
   tools/tag-layer-types.js
   ---------------------------------------------------------
   批次依關鍵字比對，自動填入 data/layers/<id>.json 內每筆圖層的
   type 欄位（地形圖／地籍圖／行政區劃圖），供前端搜尋結果面板的
   「依類型篩選」功能使用（見 src/features/search.js 的
   SEARCH_RESULT_TYPES）。

   比對依據（Step 1）：layer.title 與 layer.keywords 合併後的字串，
   依優先順序（地形圖 > 地籍圖 > 行政區劃圖）比對關鍵字，第一個命中的
   分類即採用。

   若 Step 1 比對不到任何關鍵字（type 仍為 null），則進入 Step 2：
   改用該圖層所屬的父層名稱（cat.name，若有 group.name 則一併合併）
   依同樣的優先順序，比對父層專用關鍵字。兩階段都沒命中則維持
   type: null（不新增「其他」分類，前端目前沒有對應的篩選入口）。

   用法：
       node tools/tag-layer-types.js

   執行後記得重新打包：
       node tools/build-layers-bundle.js
--------------------------------------------------------- */
const fs = require('fs');
const path = require('path');

const LAYERS_DIR = path.join(__dirname, '..', 'data', 'layers');

// 依優先順序排列：陣列中較前面的分類優先比對（Step 1：圖層自身標題/關鍵字）
const TYPE_RULES = [
  { type: '地形圖', keywords: ['地形', '等高線'] },
  { type: '地籍圖', keywords: ['地籍', '土地', '地番'] },
  { type: '行政區劃圖', keywords: ['行政區', '市區', '街庄', '堡里', '地圖'] },
];

// 依同樣的優先順序排列：Step 2 父層（category／group 名稱）專用關鍵字
const PARENT_TYPE_RULES = [
  { type: '地形圖', keywords: ['地形', '測量部', '等高線', '萬分一'] },
  { type: '地籍圖', keywords: ['地籍', '登記所', '土地調查'] },
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

function forEachLayer(src, fn){
  src.categories.forEach(cat => {
    if(cat.groups){
      cat.groups.forEach(g => {
        const parentText = `${cat.name || ''} ${g.name || ''}`;
        g.layers.forEach(layer => fn(layer, parentText));
      });
    } else {
      const parentText = `${cat.name || ''}`;
      cat.layers.forEach(layer => fn(layer, parentText));
    }
  });
}

const index = JSON.parse(fs.readFileSync(path.join(LAYERS_DIR, 'index.json'), 'utf-8'));

const counts = { '地形圖': 0, '地籍圖': 0, '行政區劃圖': 0, '未分類': 0 };
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

  fs.writeFileSync(filePath, JSON.stringify(src, null, 2));
});

console.log('圖層 type 標記統計：');
console.log(`  地形圖　　：${counts['地形圖']}`);
console.log(`  地籍圖　　：${counts['地籍圖']}`);
console.log(`  行政區劃圖：${counts['行政區劃圖']}`);
console.log(`  未分類　　：${counts['未分類']}`);
console.log(`  總筆數　　：${total}`);
console.log(`  （其中透過父層繼承判定：${inheritedCount} 筆）`);
