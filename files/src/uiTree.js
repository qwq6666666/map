/* ---------------------------------------------------------
   uiTree.js — 共用：建立「分類 → (堡等次分類 →) 圖層」手風琴清單
   ---------------------------------------------------------
   側邊欄主清單、比對模式的圖層選擇器、搜尋結果清單，三個地方都要
   畫同一種「來源/分類/次分類/圖層」手風琴，所以獨立成共用模組，
   不屬於任何單一功能模組，避免 mapCore / sidebarUI / searchUI
   互相 import 對方造成循環依賴。

   cat.groups 存在時，代表該分類（例：XX廳）底下還要再依
   cat.groups[].name（例：堡）分一層，才會到最底層的圖層清單；
   沒有 cat.groups 時則沿用「分類 → 圖層」兩層結構。

   singleOpen（預設 true）：是否在「分類」「次分類」這兩層也採用
   手風琴行為——展開某一項時，先收合同層其他已展開的項目。
   最上層「來源」的手風琴收合邏輯由各呼叫端（sidebarUI.js／
   search.js／compareMode.js）自行處理，這裡管的是分類／次分類這
   兩層，避免使用者展開多個分類、次分類後清單無限往下疊、越滑越長。

   multiOverlay.js 的 checkbox 多選圖層樹是例外：使用者常需要同時
   打開好幾個分類跨著勾選圖層，若也強制收合同層其他項目，勾到一半
   清單就會收起來、體驗反而更差，所以該呼叫端會傳入 singleOpen =
   false，維持「可同時展開多個」的原行為。
--------------------------------------------------------- */

export function buildLayerItem(layer, onLayerClick){
  const item = document.createElement('div');
  item.className = 'layer-item';
  item.dataset.layerId = layer.id;
  item.innerHTML = `<span class="layer-year">${layer.year}</span><span class="layer-title">${layer.title}</span>`;
  item.addEventListener('click', ()=> onLayerClick(layer, item));
  return item;
}

// 把一批圖層項目掛進 container，超過 threshold 筆時預設只顯示前 threshold 筆，
// 其餘加上 'layer-item-overflow' class 並隱藏，清單底部加一顆「展開其餘 N 筆
// 圖資 ▾」／「收合 ▴」的切換按鈕。不使用 overflow-y:auto 局部捲軸，純粹用
// display 切換元素可見度（交給 CSS 的 .expanded 規則統一控制），讓外層容器
// 自然撐開高度，交由外層主捲軸捲動，避免側邊欄內出現雙重捲軸。
export function appendLayerList(container, layers, onLayerClick, threshold = 8){
  layers.forEach((layer, i) => {
    const item = buildLayerItem(layer, onLayerClick);
    if(i >= threshold) item.classList.add('layer-item-overflow');
    container.appendChild(item);
  });
  if(layers.length <= threshold) return;

  const remaining = layers.length - threshold;
  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'layer-list-toggle';
  toggleBtn.textContent = `展開其餘 ${remaining} 筆圖資 ▾`;
  toggleBtn.addEventListener('click', ()=>{
    const expanding = !container.classList.contains('expanded');
    container.classList.toggle('expanded', expanding);
    toggleBtn.textContent = expanding ? '收合 ▴' : `展開其餘 ${remaining} 筆圖資 ▾`;
  });
  container.appendChild(toggleBtn);
}

export function buildCategoryList(categories, container, onLayerClick, openFirst, singleOpen = true){
  categories.forEach((cat, ci) => {
    const wrap = document.createElement('div');
    wrap.className = 'category';

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'category-head';
    const catCount = cat.groups ? cat.groups.reduce((s,g)=>s+g.layers.length, 0) : cat.layers.length;
    head.innerHTML = `<span><span class="chevron">▸</span>${cat.category}</span><span class="count">${catCount}</span>`;
    head.addEventListener('click', ()=>{
      const opening = !wrap.classList.contains('open');
      if(opening && singleOpen){
        // 手風琴行為：展開這個分類時，先收合同一個來源底下
        // 其他已展開的分類，一次只保留一個分類是開啟的狀態。
        container.querySelectorAll(':scope > .category.open').forEach(c=>{
          if(c !== wrap) c.classList.remove('open');
        });
      }
      wrap.classList.toggle('open');
    });

    const body = document.createElement('div');
    body.className = 'category-body';

    if(cat.groups){
      cat.groups.forEach(group => {
        const gWrap = document.createElement('div');
        gWrap.className = 'subcategory';

        const gHead = document.createElement('button');
        gHead.type = 'button';
        gHead.className = 'subcategory-head';
        gHead.innerHTML = `<span><span class="chevron">▸</span>${group.name}</span><span class="count">${group.layers.length}</span>`;
        gHead.addEventListener('click', ()=>{
          const opening = !gWrap.classList.contains('open');
          if(opening && singleOpen){
            // 手風琴行為：展開這個次分類（例如「堡」）時，先收合
            // 同一個分類底下其他已展開的次分類。
            body.querySelectorAll(':scope > .subcategory.open').forEach(g=>{
              if(g !== gWrap) g.classList.remove('open');
            });
          }
          gWrap.classList.toggle('open');
        });

        const gBody = document.createElement('div');
        gBody.className = 'subcategory-body';
        appendLayerList(gBody, group.layers, onLayerClick);

        gWrap.appendChild(gHead);
        gWrap.appendChild(gBody);
        body.appendChild(gWrap);
      });
    } else {
      appendLayerList(body, cat.layers, onLayerClick);
    }

    wrap.appendChild(head);
    wrap.appendChild(body);
    container.appendChild(wrap);
    if(openFirst && ci === 0) wrap.classList.add('open');
  });
}
