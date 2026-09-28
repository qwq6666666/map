/* ---------------------------------------------------------
   layer-search-ui.test.mjs — ui/layerSearch.js 的 DOM 接線
   ---------------------------------------------------------
   既有 tests/specs/layer-search.test.mjs 只測 features/layerSearch.js
   的純邏輯（searchLayers／activateLayerSearchResult），initLayerSearchUI()
   本身（輸入框、收合鈕、清除鈕的 DOM 接線）完全沒有測試覆蓋，這裡補上。
--------------------------------------------------------- */
import { test, expect } from 'vitest';
import '../env-stub.mjs';
import { sleep } from '../helpers.mjs';
import { loadAppData } from '../../src/data.js';
import { initLayerSearchUI } from '../../src/ui/layerSearch.js';

await loadAppData();

// LAYER_SEARCH_DEBOUNCE_MS（120ms）比照 place-name-card-ui.test.mjs 等既有
// 寫法，用真實的 setTimeout 等待，不引入假計時器。
const DEBOUNCE_WAIT_MS = 200;

// document.body 是整份測試檔案共用的同一棵樹（見 env-stub.mjs），為了讓
// 兩個 test case 能各自獨立驗證、又不必處理「DOM 節點重複建立、
// getElementById 撈到舊節點」的問題，DOM 只在模組層級建立一次、
// initLayerSearchUI() 只呼叫一次，兩個 test case 依序共用同一組節點
// （比照 tests/specs/place-name-card-ui.test.mjs 等既有寫法）。
function buildDom(){
  const block = document.createElement('div');
  block.className = 'layer-search-block';

  const input = document.createElement('input');
  input.id = 'layerSearchInput';

  const clearBtn = document.createElement('button');
  clearBtn.id = 'layerSearchClearBtn';
  clearBtn.hidden = true;

  const panel = document.createElement('div');
  panel.id = 'layerSearchPanel';
  panel.hidden = true;

  const countEl = document.createElement('span');
  countEl.id = 'layerSearchCount';

  const collapseBtn = document.createElement('button');
  collapseBtn.id = 'layerSearchCollapseBtn';
  collapseBtn.textContent = '▾';

  const listEl = document.createElement('div');
  listEl.id = 'layerSearchList';

  panel.appendChild(countEl);
  panel.appendChild(collapseBtn);
  panel.appendChild(listEl);
  block.appendChild(input);
  block.appendChild(clearBtn);
  block.appendChild(panel);
  document.body.appendChild(block);

  return { input, clearBtn, panel, countEl, collapseBtn, listEl };
}

async function typeQuery(input, text){
  input.value = text;
  input._listeners.input[0]();
  await sleep(DEBOUNCE_WAIT_MS);
}

// 兩個情境（透過清除鈕清空／手動把輸入框清成空字串）合併在同一個 test
// 案例裡依序跑完，而不是拆成兩個各自呼叫 buildDom() 的 test：env-stub.mjs
// 的 document.body 是整份測試檔案共用的同一棵樹、getElementById 只會撈到
// 第一個符合 id 的節點，拆成兩個各自建立 DOM 的 test 會讓第二個 test 建立
// 的節點永遠撈不到（initLayerSearchUI() 還是綁在第一個 test 建立的舊節點
// 上），比照 tests/specs/place-name-card-ui.test.mjs 等既有寫法，同一份
// DOM／初始化只做一次。
test('initLayerSearchUI：手動收合面板後清空輸入框（清除鈕／手動清空皆同），新一輪搜尋結果不應殘留 collapsed 狀態', async () => {
  const { input, panel, collapseBtn, clearBtn } = buildDom();
  initLayerSearchUI();

  await typeQuery(input, '地形圖');
  expect(panel.hidden, '有結果時面板應該顯示').toBe(false);
  expect(panel.classList.contains('collapsed'), '剛渲染完的結果預設應該是展開狀態').toBe(false);

  // 使用者手動收合面板（比照點擊面板外側的 collapsePanel() 效果）
  collapseBtn.click();
  expect(panel.classList.contains('collapsed'), '手動收合後應該有 collapsed class').toBe(true);
  expect(collapseBtn.textContent, '收合後按鈕文字應該是展開箭頭').toBe('▸');

  // 情境一：點清除鈕清空輸入框（觸發 clearResults()，面板應該完全重置）
  clearBtn.click();
  expect(panel.hidden, '清除後面板應該隱藏').toBe(true);

  // 重新輸入新的關鍵字，應該是一次全新的搜尋結果，理應展開顯示
  await typeQuery(input, '堡圖');
  expect(panel.hidden, '新搜尋有結果時面板應該顯示').toBe(false);
  expect(panel.classList.contains('collapsed'), '新一輪搜尋結果不應該殘留上一輪的 collapsed 狀態').toBe(false);
  expect(collapseBtn.textContent, '收合鈕文字應該同步重置成收合箭頭').toBe('▾');

  // 情境二：不點清除鈕，改成手動把輸入框清到空字串（同樣走 clearResults()）
  collapseBtn.click();
  expect(panel.classList.contains('collapsed'), '前置狀態：再次手動收合').toBe(true);

  await typeQuery(input, '');
  expect(panel.hidden, '空字串應該隱藏面板').toBe(true);

  await typeQuery(input, '堡圖');
  expect(panel.classList.contains('collapsed'), '手動清空後的新搜尋結果同樣不應該殘留 collapsed').toBe(false);
  expect(collapseBtn.textContent, '收合鈕文字應該同步重置成收合箭頭').toBe('▾');
});
