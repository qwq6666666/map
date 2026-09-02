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
--------------------------------------------------------- */

export function buildLayerItem(layer, onLayerClick){
  const item = document.createElement('div');
  item.className = 'layer-item';
  item.dataset.layerId = layer.id;
  item.innerHTML = `<span class="layer-year">${layer.year}</span><span class="layer-title">${layer.title}</span>`;
  item.addEventListener('click', ()=> onLayerClick(layer, item));
  return item;
}

export function buildCategoryList(categories, container, onLayerClick, openFirst){
  categories.forEach((cat, ci) => {
    const wrap = document.createElement('div');
    wrap.className = 'category';

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'category-head';
    const catCount = cat.groups ? cat.groups.reduce((s,g)=>s+g.layers.length, 0) : cat.layers.length;
    head.innerHTML = `<span><span class="chevron">▸</span>${cat.category}</span><span class="count">${catCount}</span>`;
    head.addEventListener('click', ()=> wrap.classList.toggle('open'));

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
        gHead.addEventListener('click', ()=> gWrap.classList.toggle('open'));

        const gBody = document.createElement('div');
        gBody.className = 'subcategory-body';
        group.layers.forEach(layer => gBody.appendChild(buildLayerItem(layer, onLayerClick)));

        gWrap.appendChild(gHead);
        gWrap.appendChild(gBody);
        body.appendChild(gWrap);
      });
    } else {
      cat.layers.forEach(layer => body.appendChild(buildLayerItem(layer, onLayerClick)));
    }

    wrap.appendChild(head);
    wrap.appendChild(body);
    container.appendChild(wrap);
    if(openFirst && ci === 0) wrap.classList.add('open');
  });
}
