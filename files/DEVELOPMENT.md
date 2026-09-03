# DEVELOPMENT.md — 技術筆記

給接手這個專案的開發者（或未來的 Claude 對話）快速抓到現況用的。使用者本人不寫程式，所有改動都是透過對話請 Claude 執行的，這份筆記記錄了「為什麼會長成現在這樣」，省得每次都要重新從程式碼反推設計決策。

## 專案定位

純前端、零建置工具（no bundler/no framework）的靜態網站：`index.html` + `style.css` + ES modules（`src/*.js`，瀏覽器原生 `<script type="module">`載入，不經過 webpack/vite 等打包）。地圖引擎是 OpenLayers v9.2.4（透過 CDN `<script>` 標籤載入為全域 `ol`，不是 npm import）。

## 資料層（`data/`）

```
data/
  layers/
    index.json          來源清單（開發用，逐一列出每個來源的 id/file/name/layerCount）
    <sourceId>.json      每個 WMTS 來源一個檔案：圖層目錄 + provider（tile URL 樣板）+ region（bbox）
  layers.bundle.json     瀏覽器實際 fetch 的合併檔（由 tools/build-layers-bundle.js 產生）
  source-map.json        縣市→來源的比對規則（見下方「地址比對」）
  historical-names.json  地名詞尾 + 新舊地名對照表（aliases）
```

**重要**：`data/layers/*.json` 是給人編輯的來源檔案，`src/data.js` 的 `loadAppData()` 實際 fetch 的是 `data/layers.bundle.json`。**改了任何 `data/layers/*.json` 之後，一定要重跑 `node tools/build-layers-bundle.js`**，不然瀏覽器看到的還是舊資料。這是最容易忘記的一步。

### 圖層資料結構

```
source: { id, name, attribution, provider: {tileTemplate} | {literalUrl:true}, region: {bbox}, categories: [...] }
category: { name, layers: [...] }  或  { name, groups: [{name, layers:[...]}] }
layer: { id, title, format, year(number|null), dateLabel(string), type, scale, region, keywords, url? }
```

`type`/`keywords` 目前完全沒有程式在讀，是當初資料分離時就先留好給「依類型篩選」這類未來功能的欄位。`scale` 目前只有 `sinica.json` 有實際填值（用來源 titl 文字 regex 解析出來的），其他來源都是 `null`。

只有 `thm`（桃竹苗舊地籍圖）用 `groups` 巢狀結構（廳→堡→庄），其餘 18 個來源都是扁平的 `category.layers`。**這個結構差異直接影響搜尋演算法的行為，見下方「地址比對」一節**，新增來源時如果也想用 `groups`，要回頭檢視 `searchUI.js` 的篩選規則。

`udd`（臺北市歷史圖資展示系統）的 `provider` 是 `{literalUrl:true}`，因為它的 tile 網址不是套統一樣板算出來的（ArcGIS WMTS REST 版 / 舊版 UDDWMTS 版兩種格式混用），每筆圖層自己帶完整 `url` 欄位。`resolveTileUrl()`（`data.js`）依這個旗標決定要套樣板還是直接用 `layer.url`。

## 程式模組（`src/`）

依賴方向是單向的，刻意設計成沒有循環 import。下面這份清單是拆分後的
現況（`mapCore.js` 現在是組合層，實際邏輯分散在 `core/`／`features/`／
`ui/` 底下）：

```
data.js                    資料載入、圖層查詢、地址比對演算法（不依賴任何其他 src 模組）
store.js                   全域可變狀態（mode/baseLayer/activeOverlayKey/
                            compareA/compareB/swipePercent/multiOverlayLayers）+ pub/sub
runtime.js                 非使用者意圖的執行期狀態（OL 圖層實例、計時器），不放進 store
geocode.js                 Nominatim API 呼叫（純函式，不碰 DOM／地圖）
uiTree.js                  共用的分類手風琴 DOM 建構（沒有依賴，避免互相 import）
tileChecker.js              圖磚探測 + 快取 + 節流（TileChecker class）
timelineUI.js               時間軸箭頭視覺元件（buildTimeline，SVG 畫的）
mapCore.js                  組合層（facade），把下面子模組的初始化組合起來，對外維持原本的匯出名稱
core/map.js                 地圖本體、底圖切換
core/layerManager.js        疊圖模式：單一歷史圖層的交叉淡出淡入、透明度控制
core/multiOverlayManager.js 複合疊圖模式：多張歷史圖層同時疊加（zIndex／opacity），不做淡出淡入
core/layerCache.js          WMTS Layer Cache（跨疊圖／比對／時間軸／複合疊圖模式共用）
core/protectedKeys.js       統一計算「目前使用中，不能被 layerCache LRU 淘汰」的 key 集合，
                             集中一份、避免每個模式各自維護子集導致漏保護
core/modeManager.js         模式切換協調中心（四種模式：overlay/compare/timeline/multi）
features/location.js        定位（目前位置藍點、定位失敗提示）
features/compareMode.js     左右比對模式
features/multiOverlay.js    複合疊圖模式的 UI（側邊欄 checkbox 圖層樹＋浮動已選清單面板）
ui/sidebarToggle.js         側邊欄收合、收合後的浮動透明度控制
sidebarUI.js                左側主清單手風琴（依賴 store 的 selectOverlayLayer 等）
searchUI.js                 地址搜尋、定位搜尋、兩階段候選篩選（依賴 mapCore/geocode/tileChecker）
timelineMode.js             時間軸模式（依賴 map 但不 import mapCore.js，靠 initTimelineMode(map, callback) 參數注入，避免循環依賴）
drawTool.js                  點／線／面繪製、量測、匯出（依賴 mapCore 的 map）
main.js                      進入點，依序 initXxx()
```

**循環依賴的坑**：`mapCore.js` 需要呼叫 `timelineMode.js` 的 `initTimelineMode()`，`timelineMode.js` 又需要 `mapCore.js` 匯出的 `preloadOverlayKeys`。解法是 `initTimelineMode(map, preloadOverlayKeysFn)` 用參數注入，`timelineMode.js` 完全不 `import` `mapCore.js`。以後如果又遇到「A 要 import B，B 又要 import A」的情況，先想能不能用參數注入解決，不要硬 import。

## 狀態管理（`store.js`）

輕量 pub/sub，不是 Redux/Vuex 那種完整框架。`state` 是一個永遠不重新賦值、只修改內部欄位的物件，其他模組 `import { state as store }` 拿到的是同一個參照，直接讀 `store.mode` 之類的屬性即可。寫入一律透過 `store.js` 匯出的 action 函式（`setMode`/`selectOverlayLayer` 等），不要在其他模組直接改 `store.xxx = ...`（唯一例外是 `mapCore.js` 的 `applyModeTransition()` 內部，進入 compare 模式時直接寫 `store.compareA = ...`，因為那是渲染邏輯自己算出來的預設值，不需要觸發廣播，寫的時候有留註解說明）。

## 四種模式（`core/modeManager.js` 的 `applyModeTransition()`）

`overlay` / `compare` / `timeline` / `multi`，前三種共用 `activeOverlayKey` 這個 store 欄位，在模式之間切換時**不會被清掉**（除非使用者主動清除疊圖），這是刻意設計成的：從時間軸或比對模式切回疊圖模式，會自動回到你之前選的那張圖層。

進場時的順序很固定：`applyModeTransition()` 每次都無條件重新套用整個狀態（`applyBaseLayer()` + 各模式自己的套用函式），不是用「跟上次比對哪裡不同」的差異更新——這樣可以避免遺漏邊界情況（例如切換模式時忘記處理某個殘留狀態）。

### 複合疊圖模式（`multi`）

跟前三種模式（永遠只顯示「一張」歷史圖層，只是這張是誰不一樣）不同，`multi` 模式可以同時疊加**多張**，用獨立的 store 欄位 `multiOverlayLayers`（`[{key, opacity}, ...]`，陣列順序＝疊放順序，index 越大疊越上層），跟 `activeOverlayKey` 完全分開存放、互不覆蓋。

幾個容易忘記、之後改這塊要特別注意的地方：

- **`core/protectedKeys.js` 是唯一算「保護名單」的地方**：疊圖／比對／複合疊圖模式各自都會用到 `core/layerCache.js` 的 WMTS Layer Cache，如果各自維護一份「哪些 key 不能被 LRU 淘汰」的子集，很容易漏掉別的模式正在用的 key。新增任何會呼叫 `getOrCreateLayer`／`getOrCreateSource` 的地方，一律 import 這支的 `getProtectedKeys()`，不要另外寫一份。
- **zIndex 是跨模式共用的圖層物件屬性，離開時一定要重設回 `undefined`**：`multiOverlayManager.js` 用 `layer.setZIndex()` 明確控制疊放順序，但這個 layer 物件是 layerCache 共用的（同一個 key 不管哪個模式用到都是同一個物件）。如果隱藏圖層時只把 opacity 調回 0、沒有把 zIndex 重設掉，下次這個 key 被疊圖／比對模式用到時，會殘留一個不該有的 zIndex，干擾到那些模式原本依賴「加入地圖先後順序」決定疊放順序的假設。`resetLayerVisual()` 已經把這兩件事綁在一起做，之後如果要新增其他地方隱藏 multi 圖層，記得也要呼叫這支，不要自己另外寫 `setLayerOpacity(key, 0)` 了事。
- **透明度滑桿刻意不即時經過 store**：`features/multiOverlay.js` 的每列透明度滑桿，`input` 事件（拖曳中）只直接呼叫 `layerCache.js` 的 `setLayerOpacity()` 調整地圖上的圖層＋更新這一列自己的文字，`change` 事件（放開滑桿）才寫回 `setMultiOverlayOpacity()`。如果拖曳中就寫回 store，會觸發 `renderMultiOverlayBar()` 整份清單重新建立 DOM，拖曳中的滑桿元素被換掉，手感會斷掉——這跟 `core/layerManager.js` 疊圖模式那顆透明度滑桿完全不經過 store 是同一個理由，只是複合疊圖模式因為每張圖層要各自的值，沒辦法完全不進 store（要留到下次重繪清單、或重新整理頁面時還原）。
- **離開 `multi` 模式不會清空 `multiOverlayLayers`**：只是呼叫 `hideMultiOverlayLayers()` 把畫面上的圖層隱藏，store 裡的清單保留，下次切回來還在。這點刻意跟離開時間軸模式會整個 `clearLayerPool()` 不同——複合疊圖是使用者刻意組合出來的一組圖層，不像時間軸模式比較像探索性質。
- **疊放順序目前是上／下移按鈕，不是拖曳排序**：原本討論時有提到「拖曳排序」，但這個專案完全沒有任何 drag-and-drop 的既有慣例（`tests/env-stub.mjs` 的假 DOM 也沒有支援 `dragstart`/`drop` 事件），手機版又完全沒測過（見下方「沒做、但資料骨架已經備好的功能」），native drag 在觸控裝置上經常需要額外處理才順手。權衡之下先用上/下移按鈕（`moveMultiOverlayLayer(key, ±1)`），行為明確、不需要額外測試假環境的支援。如果之後真的想要拖曳排序，`store.multiOverlayLayers` 的陣列結構已經可以直接支援，只需要換掉 `features/multiOverlay.js` 裡建立按鈕的那段。

## 地址搜尋演算法（`searchUI.js` + `data.js`）

三層篩選，最後一層才是真正的答案：

1. **來源層級**（`matchSourceIdsForAddress`）：用 `source-map.json` 的規則比對縣市，決定要看哪些「來源」。**這裡不特別區分 Nominatim 回傳的哪個欄位是「縣市」哪個是「鄉鎮」**，而是把 15 個可能相關的欄位全部合併成一個字串再比對——之前分開判斷時，「八德區」這種直轄市底下的「區」有時候會被 Nominatim 塞進 `city` 欄位（原本以為是縣市層級的欄位），導致比對失敗、抓不到桃園相關來源。合併比對雖然理論上可能有極小機率誤觸發到不相關的規則，但比起「漏掉整個來源」的後果好很多。

2. **座標層級**（`isPointNearExtent`）：用 `REGION_EXTENTS` 的 bbox 做粗篩，純數學運算不花網路成本。

3. **文字比對層級**（`prefilterLayersByPlaceName`）：**只對有 `groups` 巢狀結構的來源做**（目前只有 `thm`）。原因：`thm` 底下每個「庄」是互不重疊的小範圍地籍圖，一個座標本來就只會屬於一個庄，文字篩選命中、找到就停是安全的。但 `sinica` 這種全臺涵蓋、同一座標可能同時有十幾筆不同年代地圖都有效的來源，如果套用同樣邏輯，一旦文字篩選誤篩窄、又剛好命中其中一兩筆有資料的，會誤判「這個來源找到了」而不再檢查其餘圖層，導致其他真正有資料的圖層被漏掉。**這是一個真實發生過的 bug**（使用者回報桃園搜尋結果從 92 筆銳減，一路查到是這裡）。修法是判斷 `src.categories.some(cat => cat.groups)`，只有這樣的來源才嘗試文字篩選；沒有 groups 的來源一律全部檢查（反正這些來源筆數通常不多，十幾到一百多筆，全部檢查的成本還好）。

4. **就算是 `thm`**，文字篩選也不是「篩到就相信」，是兩階段：篩到的候選優先探測，如果這個來源優先探測完全沒有真的有資料的（可能是新舊地名對不上），才擴大檢查該來源剩下沒被篩到的圖層。

5. **圖磚探測層級**（`TileChecker.checkBatch`）：前面幾層都只是縮小候選範圍的效能優化，這一層才是唯一的正確性依據——實際發送圖磚請求，回傳的圖片有沒有資料才是最終答案。

## 歷史地名對照表（`historical-names.json` 的 `aliases`）

目前只做了 `thm` 的 11 個堡（桃竹苗地區，48 個現代行政區對照）。格式是「現代地名 → [舊堡名（含廳名前綴以避免不同廳同名堡互相干擾，例如 `新竹廳竹北二堡` vs `桃仔園廳竹北二堡`）]」。`extractPlaceKeywords()` 會查這個表，把對照到的舊堡名也加進關鍵字。其他來源目前沒有類似的對照表（多數來源已經不需要，因為第 3 點的規則已經排除了它們套用文字篩選）。

## 時間軸功能（`timelineUI.js` + `timelineMode.js`）

`timelineUI.js` 的 `buildTimeline(candidates, container, onSelect)` 是共用元件，兩個地方用：搜尋結果的時間軸檢視、`timelineMode.js` 的「時間軸模式」。畫成箭頭鏈（chevron polygon），不是圓點；等間距排列（不按實際年份比例），因為真實年代分布常常前後跳很多年，照比例畫容易一段擠成一團一段留一大片空白；同一年份多筆時水平排開、共用一個年份標籤，固定單列高度（不會因為某年份筆數多就往上長高）。播放進度用箭頭本身的顏色狀態（`passed`/`active` class）表示，沒有額外的指示線或浮動搖桿。

`timelineMode.js` 目前限定只探測 `sinica` 這個來源，而且只挑「同一種精細地形圖系列」的圖層（`PLAN_A_LAYER_IDS` = 1:25,000 系列 15 筆，`PLAN_B_LAYER_IDS` = 1:50,000 系列 9 筆，這兩份清單是跟使用者一起手動篩選出來的，不是自動判斷），因為 `sinica` 其餘圖層內容類型混雜（行政區劃圖、各縣市分開的灌溉圖、三角測量點位圖等），混在同一條時間軸上比較沒有意義。使用者可以在「1:25,000／1:50,000／混合」三個模式間切換。

**移動地圖不會自動重新探測**（刻意的設計，避免自由拖曳地圖時觸發一堆不必要的請求），只會在按鈕上標示「地圖已移動」，由使用者自己決定要不要按「重新整理」。

## 交叉淡出淡入 + 預先載入池（`mapCore.js`）

切換歷史圖層時，不是「先移除舊的、才開始載入新的」（會有一段空白），而是新圖層先以透明狀態加進地圖背景載入（給 `FADE_GRACE_MS`=250ms 暖機時間），舊圖層維持原樣，暖機結束後兩者同時交叉淡出淡入（`FADE_MS`=350ms）。`runtime.layerPool` 額外支援「預先載入」：時間軸模式探測完成後，會把確定有資料的圖層全部背景預載，之後拖曳／播放切換到已經預載過的圖層時，直接跳過暖機時間（因為圖磚早就開始下載了）。離開時間軸模式時，`clearLayerPool()` 會把還沒用到的預載圖層清掉，避免一直佔資源。

## 已知的坑

- **CORS / canvas tainted**：`drawTool.js` 的截圖功能需要把外部圖磚伺服器的圖片畫進 canvas 再讀出來，這要求圖磚來源設定 `crossOrigin: 'anonymous'`（`mapCore.js`/`data.js` 建立 `ol.source.XYZ`/`ol.source.OSM` 時都要帶這個選項），**而且伺服器本身要回傳允許跨網域的標頭**。這件事沒辦法在開發環境裡確認，只能部署後實際測試——如果加了 `crossOrigin` 之後某個圖層突然讀不出來，很可能是那個伺服器不支援，需要個別處理。
- **`map.once('rendercomplete', ...)` 可能永遠不觸發**：如果地圖畫面跟上次比對完全沒有變化，OpenLayers 有時候不會觸發這個事件。`drawTool.js` 的 `exportImage()` 因此加了 400ms 逾時保險，不能只依賴這個事件。
- **截圖畫質要乘上 `devicePixelRatio`**：不這樣做的話，Retina 螢幕匯出的圖片解析度會被砍到只剩 CSS 像素尺寸，明顯比螢幕上看到的模糊。
- **`syncActiveLayerItemClasses()` 在時間軸模式下不展開側邊欄分類**：因為時間軸模式會自動收合側邊欄，如果每次選圖層都展開背景的分類手風琴，使用者之後手動展開側邊欄會發現分類莫名其妙已經被展開過。
- **繪圖工具的命名輸入用瀏覽器原生 `prompt()`**：能動，但跟網站其他部分的視覺風格不一致，是刻意先求有再求好的取捨。

## 測試（`tests/`）

```
node tests/run-all.mjs
```

一次跑完全部測試（純 Node.js，零套件依賴，不需要 `npm install`）。`tests/env-stub.mjs` 是共用的假瀏覽器／OpenLayers 環境，`tests/assert.mjs` 是極簡的測試小工具。每份 `tests/specs/*.test.mjs` 用獨立 process 執行，避免不同測試檔案之間共用同一份 `src/store.js` 單例狀態互相汙染。

**寫測試時的陷阱**：`store.js` 的 `selectOverlayLayer(key)` 是 toggle 邏輯（同一個 key 呼叫兩次會變成「開→關」），測試之間如果沒有明確重設狀態，很容易因為前一個測試留下的殘留狀態而斷言失敗（不是程式壞了，是測試沒有隔離乾淨）。同理 `drawTool.js` 的工具按鈕也是 toggle（`setTool` 再點同一個工具會取消），測試裡用 `ensureToolActive()` 這種輔助函式明確保證結果狀態，不要假設「點一次」一定會是啟用。

假 DOM 環境（`env-stub.mjs`）目前支援的 CSS 選擇器只有：純 class（`.foo`）、純 tag（`button`）、`tag[data-x="y"]`、`[data-x="y"]`、以及這些的組合（`.foo[data-x="y"]`）。如果新程式碼用到更複雜的選擇器（例如 `:not()`、後代選擇器組合），要嘛避免用、要嘛擴充 `matchesSelector()`。

## 沒做、但資料骨架已經備好的功能

- 依年代／類型篩選（`type`/`keywords` 欄位存在但沒有程式在讀）
- 時間軸擴大到其他來源（`udd` 也是跨多年代資料，可能適合比照 `sinica` 做法）
- 手機版視覺沒有人用真的手機測試過，排版判斷都是憑 CSS 邏輯推算——複合疊圖模式又多加了一個浮動面板（`#multiOverlayBar`），小螢幕上跟既有的定位按鈕／繪圖工具列／透明度滑桿會不會互相遮擋，特別需要之後實機確認
