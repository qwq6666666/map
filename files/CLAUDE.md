# 專案：百年歷史地圖 (Web GIS)

## 語言與交互規範 (Token-Saving Rules)
- **語言偏好：** 一律使用繁體中文（台灣習慣用語）溝通與註解。
- **輸出極小化 (Diff Only)：**
  - 嚴禁重印未修改的完整程式碼檔案，優先使用 `Edit` 工具進行局部修改。
  - 對話開頭切勿使用客套話或重複問題；任務完成後僅回報：異動檔案、修改行數、測試結果。
  - 嚴禁主動載入 `data/layers.bundle.json` 等超大打包檔，避免爆衝上下文 (Context bloat)。

## 常用指令 (Commands)
- 安裝依賴：`npm install`
- 開發模式（Vite，含 HMR）：`npm run dev`
- 正式建置：`npm run build`（輸出到 `dist/`，含 hash 檔名與 sourcemap）
- 預覽建置結果：`npm run preview`
- 免建置純靜態啟動（備用，不經過 Vite）：`.\start-website.bat` 或 `npx serve`
- 全域測試：`node tests/run-all.mjs`（或 `npm test`）
- 單元測試：`node tests/run-all.mjs tests/specs/<test-file>.mjs`
- 圖資打包：`node tools/build-layers-bundle.js`
- 圖層類型自動打標：`node tools/tag-layer-types.js`（以 title/keywords/階層繼承自動判定 type，新增圖層後、打包 bundle 前執行）
- WMTS bbox 空間索引重新產生：`node tools/fetch-wmts-bbox.js`（解析中研院各 WMTS Capabilities，將各圖層 `ows:WGS84BoundingBox` 寫入對應 `data/layers/<id>.json` 的 `layer.region.bbox`；只在建置階段執行，前端不重新下載解析 Capabilities）
- 完整資料建置流程（bbox 索引＋打標＋打包一次跑完）：`npm run build:data`
- 地名今昔對照資料重新產生：`npm run build:place-names`（讀工作區外的兩份內政部地名 CSV，輸出 `data/place-names.json`；預設路徑寫死在 `tools/build-place-names.js`，也可傳自訂 CSV 路徑當參數；**不含**在 `build:data` 裡，因為那兩份 CSV 不在 repo 內、無法假設每台機器都有）

## 圖層空間索引 (WMTS bbox 空間篩選)
搜尋流程已從「大量 WMTS file-exists probe 猜測圖層是否存在」改為「先用 bbox 本地篩選、只對少量候選圖層 probe」：
- `tools/fetch-wmts-bbox.js`：建置階段解析 `SOURCES` 陣列列出的各來源 WMTS Capabilities，寫入對應 `data/layers/<id>.json` 圖層的 `region.bbox`（`[minLon,minLat,maxLon,maxLat]`，原始精度）。目前全站 33 個來源中 32 個已 100% 覆蓋（`tests/specs/spatial-index.test.mjs` 的全站 bbox 覆蓋率回歸測試可見統計），只有 `udd`（都市地籍圖，54 筆）沒有對應 Capabilities 端點，維持 `region: null`。新增來源時只要在 `AUTO_IDS` 加一個 id（前提是該來源網址規則符合 `https://gis.sinica.edu.tw/<id>/wmts/1.0.0/WMTSCapabilities.xml`），不需要改解析邏輯；另外別忘了同步在 `data/source-map.json` 登記該來源該在哪些地址被列為候選（`alwaysInclude` 或 `rules`），否則地址搜尋不會用到新來源（`ls`、`korea` 這兩個來源就是前車之鑑）。
- `pointInBbox(lon, lat, bbox)`（`src/core/tileGeo.js`）：純幾何比對，bbox 缺失／格式錯誤一律 `return true`（fallback，不可誤排除，退回原本「可能有資料就檢查」的行為）。
- `filterCandidatesByBbox(candidates, lon, lat)`（`src/features/search.js`，已 export）：接在文字比對之後、`tileChecker.checkBatch()` 之前，篩掉「有合法 bbox 且確定不涵蓋座標」的候選；沒有 bbox 索引的圖層一律保留。
- `TileChecker`（`src/tileChecker.js`）的 `_probe()` 一律包在 `RequestPool.run()` 裡才真的送出 `Image` 請求，確保 `checkBatchAny()` 巢狀 `Promise.all()`（鄰近圖磚 fallback）、timeout retry 都不會讓實際併發 HTTP 請求數超過上限。沒有明確傳入 `pool` 時，各 instance 用自己的 `concurrency` 建立專屬 pool；`search.js`／`timelineMode.js` 則明確共用同一個 `globalTileRequestPool`（上限 `TILE_REQUEST_MAX_CONCURRENCY = 8`），避免兩邊各自的請求量疊加超過總上限。
- 測試集中在 `tests/specs/spatial-index.test.mjs`（含全站 32/33 來源 bbox 覆蓋率回歸測試，另有寫死的全站總圖層數斷言，新增/移除圖層來源時要同步更新）與 `tests/specs/tile-request-pool.test.mjs`（RequestPool 併發上限、cache/in-flight dedup、timeout 釋放 slot、retry 不繞過 pool）。

## 手機版 Responsive UI (<=768px Bottom Sheet)
手機版不是把桌面 `#sidebar` 縮小，而是「地圖為主、可拖曳二態 Bottom Sheet 為輔」；平板 (769~1024px) 與桌面互動完全不受影響。協調層在 `src/ui/mobileLayout.js`（**不**重新實作搜尋／模式切換／圖層邏輯，只做既有 DOM 節點搬移與 UI 狀態同步），對應樣式集中在 `style.css` 檔尾的「Mobile Responsive Layout」區塊（全部包在 `@media (max-width:768px)`，同選擇器靠後宣告覆寫桌面規則，不改動原規則本身）。
- **Bottom Sheet 二態**：縮小(peek) 沿用桌面既有 `#sidebar.collapsed`；展開(75vh) 是唯一的非收合態，單純用有無 `.collapsed` 這一個 class 表達兩態（不再有「半開」中間態、也不再需要額外疊加 class）。高度算式吃 `--vvh`（`updateViewportMetrics()` 即時量測 `window.visualViewport.height` 寫入的 CSS 變數），**不能改回純 `vh`**——手機瀏覽器工具列動態顯示/收起會讓 `100vh` 跟實際可視高度對不上，這是實機踩過的坑。
- **「新手導覽／使用指南」入口**：側邊欄 header 原本的 `.tour-btn-row`（`#tourStartBtn`／`#guideOpenBtn`）在手機版整排隱藏，入口併入「地圖工具」浮動選單（`#mobileModePopover`）裡新增的「說明」分類，點選項純轉發 `.click()` 到那兩顆被隱藏但仍在 DOM 裡的真實按鈕，不重新實作 `src/ui/onboarding.js` 的導覽/指南邏輯。
- **頂部搜尋列**（`#mobileSearchBar`，僅透明疊圖模式顯示）是把桌面版的 DOM 節點搬過去，不是複製，畫面上每個輸入框／按鈕永遠只有一份。地址搜尋（`.address-search-row`／`#addressSuggest`）與圖資搜尋（`.layer-search-row`）兩個真實 `.search-row` 都會被搬進 `#mobileSearchBar`（`relocateSearchBar()`／`relocateLayerSearchRow()`），手機版靠 `mobileSearchMode`（`'address' | 'layer'`）與對應的 `body.mobile-search-mode-<mode>` class 讓兩者互斥顯示、視覺上像單一個合併輸入框＋切換鈕；`#mobileSearchModeBtn` 這顆切換鈕本身也會被 `relocateModeToggleBtn()` 動態搬進「目前顯示中」的那個 row（不會固定留在 `.address-search-row` 裡），否則切到圖資模式後這顆鈕會跟著整排一起被隱藏、卡死回不去地址模式（已踩過的坑）。切換模式不會清除任一邊的搜尋狀態或呼叫任何 reset 函式，純粹是 DOM 搬移＋ CSS 顯示切換，切回去先前的搜尋結果原封不動還在。
- **收合狀態要留視覺錨點**：頂部搜尋列閒置 15 秒會收合成一顆圓鈕（`initSearchBarAutoCollapse()`），收合規則會把 row 裡大部分子元素（含合併切換鈕 `#mobileSearchModeBtn`）都收到寬度 0；地址模式因為 `#addressSearchBtn`（放大鏡）從未被收合規則隱藏，收合後還看得到圖示，圖資模式原本沒有任何倖免的子元素，導致圓圈裡完全空白、看起來像圖示消失（已修正，用 `body.mobile-search-mode-layer` 覆蓋規則讓 `#mobileSearchModeBtn` 在圖資模式收合時維持可見）。**之後如果在合併搜尋列裡新增第三種模式，切記也要留一個等同的收合視覺錨點**，不然會重蹈覆轍。
- **「地圖模式」浮動按鈕**（`#mobileModeBtn`/`#mobileModePopover`）只轉發點擊到 `#modeSwitch`/`#drawToggleBtn` 既有按鈕；可拖曳、位置存 `localStorage`；`z-index:50` 蓋過所有手機浮動列、不受 Sheet 開合影響。側邊欄裡原本的模式切換手風琴（`#modeSection`）已被取代，手機版整段隱藏。
- 依 Sheet 開合（`body.mobile-sheet-open`）與目前模式（`body.mobile-mode-<mode>`）動態隱藏會互相重疊的浮動控制項，這兩個 body class 由 `initSheetOpenStateSync()`/`initModeClassSync()` 同步，改動前先確認有沒有規則吃這兩個 class。
- **CSS specificity 陷阱**：`.floating-opacity.show.has-layer` 這類多 class 規則，要蓋過去的新規則 class 數量必須相等或更多，只靠「後宣告」贏不了 class 數較少的規則（style.css 對應規則已加註解，新增類似隱藏規則前先確認蓋得過去）。同類陷阱還有一種：用原生 `hidden` attribute（`el.hidden = true/false`）控制顯示與否時，瀏覽器內建 `[hidden]{display:none}` 是屬性選擇器、specificity 很低，如果同時用 **ID 選擇器**寫 `#foo{display:flex}` 想讓它「平常顯示」，ID 的 specificity 會贏過 `[hidden]`，導致 `hidden` 屬性怎麼設都藏不住——這種情境要改用 class 選擇器（`.foo{display:none;} .foo:not([hidden]){display:flex;}`），不要用 ID 選擇器直接宣告 `display`。
- **手機版「台灣」「中國」分頁三段式瀏覽**（`src/ui/mobileTwBrowse.js`／`src/ui/mobileCnBrowse.js`，兩者架構、匯出介面、CSS class 完全對稱，`mobileCnBrowse.js` 刻意沿用 `mobile-tw-*` 這組 class 不另外新增一套）：國家篩選列（`src/ui/countryFilter.js`）選到「台灣」或「中國」且 `mq.matches`（<=768px）時，各自取代原本「來源(機構)→分類→次分類→圖層」手風琴；「其他」分頁與桌機一律維持原本手風琴不變，`sidebarUI.js` 的 `syncMobileBrowseView()` 同時管兩邊的顯示切換。三段式是「大區域→地區→圖層」：台灣是「全國/北部/中部/南部/東部/離島」（地區會合併同縣市的多個來源，例如 udd+taipei 都算「臺北」），中國是「全國/華北/華東/華中/華南/西南」（目前 11 個 cn 來源沒有東北／西北，比照台灣「只放實際有資料的大區域」原則不列空分類）。第三段**不是**自己刻的扁平清單，而是重用 `sidebarUI.js` 抽出的 `buildSourceGroup(src)`（跟桌機手風琴共用同一份「建立單一來源的分類/次分類/圖層區塊」邏輯，只是依目前選中的地區篩出對應來源、各自重新 `document.createElement` 建一份獨立 DOM，不會跟桌機那份手風琴搶節點）。來源→大區域的對照表（`MACRO_REGION_MAP`）跟來源→地區標籤的字尾規則（`regionLabelForSource()`）都寫在各自檔案裡，新增/搬動 tw 或 cn 來源時記得同步這兩份表，`tests/specs/mobile-tw-browse.test.mjs`／`tests/specs/mobile-cn-browse.test.mjs` 分別有全站 24 個 tw 來源／11 個 cn 來源的分組總數回歸測試會抓到漏改。

## 地名今昔對照卡 (`data/place-names.json` + `src/features/placeNames.js`)
整合在既有「地址／位置搜尋」流程裡的附加功能，**不是**獨立頁面或入口，跟 `data/historical-names.json`（`thm` 舊堡名輔助篩選用的小型對照表）完全獨立、互不匯入，兩者名稱相近但用途不同，改動前先確認改的是哪一份。
- **資料來源與重新產生**：`tools/build-place-names.js`（CommonJS，`tools/package.json` 是 `{"type":"commonjs"}`）解析內政部「臺灣地區地名資料」CSV（聚落類＋行政區域類，原始檔在工作區外，**不進 repo**），輸出精簡的 `data/place-names.json`（約 4.6 萬筆、10MB，minify）。核心的 `parseCsv`／`splitAliases`／`rowToPlace` 是不做檔案 I/O 的純函式，方便不依賴外部 CSV 就能單元測試。
- **延遲載入**：`src/features/placeNames.js` 只在使用者第一次觸發搜尋（`findPlaceNameCandidates()`）時才 `fetch()` 這份 10MB 檔案、之後全部吃記憶體快取，不放進 app 啟動流程（比照 `data/presets/` 的既有慣例）。
- **比對規則**：現名或別名**精確相符**（不是模糊/子字串比對），且只保留有經緯度的候選（約 3.5 萬筆有座標）；`matchPlaceNames(places, query)` 是不碰 fetch 的純函式版本，單元測試優先呼叫這支。
- **搜尋流程**（`src/ui/search.js` 的 `runImmediateSearch()`）：比對到 0 筆才退回原本的 `geocodeAddress` 流程（既有地址搜尋完全不受影響）；1 筆直接定位＋顯示卡片；多筆重用既有的 `#addressSuggest` 容器列出候選清單（**不要**另外新增獨立容器，否則手機版 `mobileLayout.js` 的 `relocateSearchBar()` 不會把它搬到頂部搜尋列，會出現「候選清單跑到看不到的地方」的 bug）。
- **已踩過的坑**：`#addressSuggest` 的桌面版 CSS 是 `position:absolute; top:100%` 相對 `.search-block` 定位，這個定位祖先同時包住 `#locationResult`——只要已經有一次搜尋結果展開（含這張新卡片），`.search-block` 總高度被撐高，建議清單／候選清單會被推到目前結果面板下方、捲動範圍外看不到。已在 `renderSuggestList()`／`renderPlaceNameCandidateList()` 開頭呼叫 `repositionSuggestBelowInputRow()` 動態改寫 `top`（只在桌面版生效，判斷依據是 `#addressSuggest` 目前是否還在 `.search-block` 底下、不是被搬進 `#mobileSearchBar`），之後如果又在 `.search-block` 裡新增別的固定在輸入框下方的浮動元素，記得比照辦理。
- **點位資訊視窗整合**：`initIdentifyPin({ getPlaceNameMatch, onViewPlaceNameCard })` 兩個可選參數（`main.js` 接到 `placeNames.js` 的 `getActivePlaceNameMatchAt` 與 `search.js` 的 `focusPlaceNameCard`）。誤差容許 `1e-4` 度（約 11 公尺）才視為同一點，刻意保守——只有使用者剛透過搜尋選定過某個地名、且點擊座標精準落在那個點附近時才顯示「歷史地名」提示列，不對任意地圖點擊做地名反查／距離推測。
- **已知限制**：別名只取自 CSV 的 `AnotherName` 欄位，不等於正式舊名（有些真正舊稱只寫在 `PlaceMean` 沿革說明文字裡，程式不會反推）；代表點是資料庫座標點，不是歷史行政界線；約 1.1 萬筆行政區域類資料沒有座標，目前不會出現在搜尋結果裡。
- 測試分散在 `tests/specs/place-names-data.test.mjs`（CSV 解析純函式）、`place-names-matching.test.mjs`（比對邏輯）、`place-name-card-ui.test.mjs`（卡片渲染／收合／候選清單）、`identify-pin.test.mjs`（新增的「歷史地名」小區塊案例）。

## 子代理分工與路由 (Subagents Routing)
遇到具體模組需求時，主代理請即刻將任務派發給對應的 Subagent，勿在主階段載入過多非權責程式碼：

| 任務領域 | 調度代理 | 權責檔案邊界 |
| :--- | :--- | :--- |
| 地圖底層、圖磚容錯、座標換算 | `map-core-agent` | `src/mapCore.js`, `src/core/`, `src/tileChecker.js`, `src/geocode.js` |
| 介面樣式、RWD、側邊欄、時間軸滑桿、地址搜尋介面（含地名今昔對照卡渲染） | `ui-frontend-agent` | `index.html`, `style.css`, `src/ui/`（含 `src/ui/search.js`，地址搜尋 UI／候選清單／地名今昔對照卡渲染都在這裡）, `src/timelineUI.js`, `src/sidebarUI.js`, `src/features/customTimelineUI.js`（例外：自訂時間軸的浮動 dock UI，雖然放在 `src/features/` 底下，但純屬介面渲染，歸這個 agent） |
| 模式切換、雙圖比對、繪圖工具、Store、地圖落點探針、地名比對邏輯 | `feature-state-agent` | `src/features/`（含 `identifyPin.js`、`customTimeline.js`、`placeNames.js`；**不含** `customTimelineUI.js`，見上一列）, `src/store.js`, `src/runtime.js`, `src/drawTool.js` |
| 圖層 JSON、地名映射、圖資打包、地名今昔對照資料 | `data-processing-agent` | `data/layers/`, `data/historical-names.json`, `data/place-names.json`, `tools/`（含 `tools/build-place-names.js`） |
| 整合回歸測試、品質把關 | `qa-testing-agent` | `tests/` |

## 開發守則與防護 (Guardrails)
1. **原生 ESM 架構：** 保持純原生 JavaScript ES Module，非必要絕不安裝任何重型 npm 第三方依賴。
2. **資料管線同步：** 凡異動 `data/layers/*.json`（尤其新增圖層），完成後必須先執行 `node tools/tag-layer-types.js` 自動打標 type，再執行 `node tools/build-layers-bundle.js` 重新打包。
3. **驗證先行：** 所有邏輯或狀態修改，結束前必須執行對應的測試檔確認通過，嚴禁留下未驗證的 break changes。
3a. **`src/data.js` 的資料存取方式：** `LAYER_SOURCES`／`REGION_EXTENTS`／`SOURCE_MAP_RULES`／`HISTORICAL_NAMES`／`PLACE_NAME_SUFFIXES` 已改成單一 `export const DATA = { LAYER_SOURCES, REGION_EXTENTS, ... }` 物件（原本 `export let` 各自匯出會被 SonarQube 標記為可變匯出），消費端一律 `import { DATA } from './data.js'` 後讀 `DATA.LAYER_SOURCES` 等屬性，不要再寫裸的 `LAYER_SOURCES`。
4. **Subagent 權責清單同步 (Role Whitelist Sync)：** 上表是概略路由，各 subagent 實際遵守的是 `.claude/agents/<name>.md` 裡「你僅能檢視與修改」逐檔列舉的白名單——這份清單比本表嚴格，且**不會**因為新檔案落在該 agent 負責的目錄下就自動視為已授權。
   - 新增 `src/features/`、`src/core/` 等目錄下的檔案時，主代理當下就要把該檔案路徑加進對應 `.claude/agents/<name>.md` 的權責清單，不要留給下一輪任務才補。
   - 若某 subagent 以「不在白名單」拒絕明明屬於其目錄的檔案（即使是它自己前幾輪建立的），代表清單漏列而非任務指派錯誤：主代理應先把該路徑補進對應 `.claude/agents/*.md`，而不是重複用同一個訊息說服 subagent 擴權（subagent 不應該、也不會接受單純的口頭再授權）。若時間急迫可由主代理直接以 `Edit` 完成該次修改，事後仍要記得補寫清單，避免下次重蹈覆轍。
5. **`src/main.js` 不劃給任何 subagent：** 進入點／組合層，橫跨三個代理的初始化呼叫，由主代理直接 `Edit` 維護，避免單一 subagent 片面增刪其他代理的初始化邏輯。
6. **建置基礎設施不劃給任何 subagent：** `package.json`、`vite.config.js`、`public/sw.js`、`public/manifest.webmanifest` 屬於橫跨全站的建置／PWA 設定，跟 `src/main.js` 一樣由主代理直接 `Edit` 維護，不派給 subagent。
   - `vite.config.js` 目前用一個內建（無額外套件）plugin 讓 `/data/*` 在 dev／build 都對應到專案根目錄的 `data/`（因為 Vite 的 `publicDir` 只能設一個，這裡設為預設的 `public/` 放 `sw.js`／manifest）。異動 `data/` 目錄結構前要留意這個對應關係。
   - `public/sw.js` 走三種快取，版本號互相脫鉤（`CACHE_VERSION` 管 App Shell／Data，`TILE_CACHE_VERSION` 管圖磚，改一個不會動到另一個）：圖磚 `tile-cache-*` Cache-First+LRU；`data/*.json` 的 `data-*` Network-First（有網路一律拿新版並更新快取，離線才退回舊版，避免新圖層／bbox／地名對照被舊快取鎖住）；App Shell `app-shell-*` 拆兩種——HTML（navigate）Network-First，JS/CSS（Vite 帶 content hash 檔名）Cache-First。`activate` 只清 `MANAGED_CACHE_PREFIXES`（`app-shell-`/`data-`，含舊命名 `shell-cache-`/`meta-cache-`）前綴且非目前版本的快取，`tile-cache-` 不在清單內，App 改版不會清掉使用者已下載的歷史地圖圖磚。只在 `import.meta.env.PROD`（即 `npm run build` 後）才會被 `src/main.js` 註冊，`npm run dev` 底下不會啟用，避免快取干擾開發。測試在 `tests/specs/service-worker.test.mjs`（用 `node:vm` 建立獨立假 SW 環境，不動用 `tests/env-stub.mjs`）。
