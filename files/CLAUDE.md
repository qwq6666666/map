# 專案：百年歷史地圖 (Web GIS)

## 語言與交互規範 (Token-Saving Rules)
- 一律使用繁體中文（台灣習慣用語）溝通與註解。
- **輸出極小化 (Diff Only)：** 嚴禁重印未修改的完整檔案，優先用 `Edit` 局部修改；開頭免客套；任務完成後僅回報異動檔案、修改行數、測試結果；嚴禁主動載入 `data/layers.bundle.json` 等超大打包檔，避免爆衝上下文。

## 常用指令 (Commands)
- 安裝依賴：`npm install`
- 開發模式（Vite，含 HMR）：`npm run dev`
- 正式建置：`npm run build`（輸出到 `dist/`，含 hash 檔名與 sourcemap）
- 預覽建置結果：`npm run preview`
- 免建置純靜態啟動（備用，不經過 Vite）：`.\start-website.bat` 或 `npx serve`
- 全域測試：`node tests/run-all.mjs`（或 `npm test`）；單一測試：`node tests/run-all.mjs tests/specs/<test-file>.mjs`
- 圖資打包：`node tools/build-layers-bundle.js`
- 圖層類型自動打標：`node tools/tag-layer-types.js`（以 title/keywords/階層繼承判定 type，新增圖層後、打包 bundle 前執行）
- WMTS bbox 空間索引重新產生：`node tools/fetch-wmts-bbox.js`（解析中研院各來源 WMTS Capabilities，寫入 `data/layers/<id>.json` 的 `layer.region.bbox`；只在建置階段執行，前端不重新下載解析）
- 完整資料建置流程（bbox 索引＋打標＋打包一次跑完）：`npm run build:data`
- 地名今昔對照資料重新產生：`npm run build:place-names`（讀工作區外的兩份內政部地名 CSV，輸出 `data/place-names.json`；預設路徑寫死在 `tools/build-place-names.js`，也可傳自訂 CSV 路徑；**不含**在 `build:data` 裡，因為那兩份 CSV 不在 repo、無法假設每台機器都有）

## 圖層空間索引 (WMTS bbox 空間篩選)
搜尋流程已從「大量 WMTS file-exists probe 猜測圖層是否存在」改為「先用 bbox 本地篩選、只對少量候選圖層 probe」：
- `tools/fetch-wmts-bbox.js`：建置階段解析各來源 WMTS Capabilities，寫入 `data/layers/<id>.json` 的 `region.bbox`（`[minLon,minLat,maxLon,maxLat]`）。全站 33 個來源中 32 個已 100% 覆蓋（見 `spatial-index.test.mjs`），只有 `udd`（都市地籍圖）沒有對應端點，維持 `region: null`。新增來源只需在 `AUTO_IDS` 加 id（前提是網址符合 `https://gis.sinica.edu.tw/<id>/wmts/1.0.0/WMTSCapabilities.xml`），並同步在 `data/source-map.json` 登記候選規則（`alwaysInclude`／`rules`），否則地址搜尋不會用到新來源（`ls`、`korea` 曾漏改）。
- `pointInBbox(lon, lat, bbox)`（`src/core/tileGeo.js`）：純幾何比對，bbox 缺失／格式錯誤一律 `return true`（fallback，不可誤排除）。
- `filterCandidatesByBbox(candidates, lon, lat)`（`src/features/search.js`，已 export）：接在文字比對之後、`tileChecker.checkBatch()` 之前，篩掉有合法 bbox 且確定不涵蓋座標的候選；無索引的圖層一律保留。
- `TileChecker`（`src/tileChecker.js`）的 `_probe()` 一律包在 `RequestPool.run()` 裡才送出 `Image` 請求，確保巢狀 fallback／timeout retry 不會讓併發數超上限。未傳入 `pool` 時各 instance 自建專屬 pool；`search.js`／`timelineMode.js` 明確共用 `globalTileRequestPool`（上限 `TILE_REQUEST_MAX_CONCURRENCY = 8`）。
- 測試：`tests/specs/spatial-index.test.mjs`（bbox 覆蓋率回歸＋全站總圖層數斷言，增刪來源時同步更新）、`tests/specs/tile-request-pool.test.mjs`（併發上限、cache/in-flight dedup、timeout 釋放 slot、retry 不繞過 pool）。

## 手機版 Responsive UI (<=768px Bottom Sheet)
手機版是「地圖為主、可拖曳二態 Bottom Sheet 為輔」，不是桌面 `#sidebar` 縮小；平板 (769~1024px) 與桌面不受影響。協調層 `src/ui/mobileLayout.js`（不重新實作搜尋／模式切換／圖層邏輯，只做既有 DOM 搬移與 UI 狀態同步），樣式集中在 `style.css` 檔尾「Mobile Responsive Layout」區塊（`@media (max-width:768px)`，靠後宣告覆寫桌面規則、不改原規則）。
- **Bottom Sheet 二態**：縮小(peek) 沿用 `#sidebar.collapsed`；展開(75vh) 是唯一非收合態，僅用有無 `.collapsed` 表達兩態（無「半開」中間態）。高度吃 `--vvh`（`updateViewportMetrics()` 量測 `window.visualViewport.height` 寫入），**不可改回純 `vh`**——手機瀏覽器工具列動態顯隱會讓 `100vh` 跟可視高度不符（實機踩過的坑）。
- **導覽／指南入口**：`.tour-btn-row`（`#tourStartBtn`／`#guideOpenBtn`）手機版整排隱藏，入口併入「地圖工具」浮動選單（`#mobileModePopover`）新增的「說明」分類，點選純轉發 `.click()` 給隱藏的原按鈕，不重新實作 `src/ui/onboarding.js`。
- **頂部搜尋列**（`#mobileSearchBar`，僅透明疊圖模式顯示）：搬移桌面 DOM 節點、非複製。地址搜尋（`.address-search-row`／`#addressSuggest`）與圖資搜尋（`.layer-search-row`）由 `relocateSearchBar()`／`relocateLayerSearchRow()` 搬入，靠 `mobileSearchMode`（`'address'|'layer'`）與 `body.mobile-search-mode-<mode>` 互斥顯示。切換鈕 `#mobileSearchModeBtn` 需被 `relocateModeToggleBtn()` 動態搬進當前顯示的 row，否則切到圖資模式會被一起隱藏、卡死回不去（已踩坑）。切換模式不清狀態、不呼叫 reset，純 DOM 搬移＋CSS 切換。
- **圖資搜尋結果面板**（`#layerSearchPanel`）跟著 `.layer-search-row` 被 `relocateLayerSearchRow()` 搬進 `#mobileSearchBar`，浮在搜尋列下方自行捲動（比照 `#addressSuggest` 的 `position:absolute; top:calc(100% + 6px)`），不再留在 Bottom Sheet——因此舊的 `initLayerSearchResultAutoExpand()`（監看面板出現就強制展開 Sheet 至 75vh，已踩坑）已移除。切地址模式時靠 `body.mobile-search-mode-address`（class，非 `hidden` attribute）視覺隱藏，內容保留。
- **收合狀態要留視覺錨點**：搜尋列閒置 15 秒收合成圓鈕（`initSearchBarAutoCollapse()`），大部分子元素（含 `#mobileSearchModeBtn`）收到寬度 0；地址模式有 `#addressSearchBtn`（放大鏡）倖免，圖資模式原本沒有倖免元素、圓圈全空白（已修正：`body.mobile-search-mode-layer` 覆蓋規則讓 `#mobileSearchModeBtn` 保持可見）。**新增第三種模式時務必留同等視覺錨點**，否則重蹈覆轍。
- **「地圖模式」浮動按鈕**（`#mobileModeBtn`/`#mobileModePopover`）只轉發點擊給 `#modeSwitch`/`#drawToggleBtn`；可拖曳、位置存 `localStorage`；`z-index:50` 蓋過所有手機浮動列。側邊欄原本的模式切換手風琴（`#modeSection`）手機版整段隱藏。
- 依 Sheet 開合（`body.mobile-sheet-open`）與目前模式（`body.mobile-mode-<mode>`）動態隱藏互相重疊的浮動控制項，由 `initSheetOpenStateSync()`/`initModeClassSync()` 同步，改動前先確認有無規則吃這兩個 class。
- **CSS specificity 陷阱**：`.floating-opacity.show.has-layer` 這類多 class 規則，要蓋過去的新規則 class 數量須相等或更多，只靠「後宣告」贏不了 class 數較少的規則。另一種陷阱：用原生 `hidden` attribute 控制顯示時，`[hidden]{display:none}` 是屬性選擇器 specificity 很低，若同時用 **ID 選擇器**寫 `#foo{display:flex}`，ID 會贏過 `[hidden]` 導致藏不住——應改用 class 選擇器（`.foo{display:none;} .foo:not([hidden]){display:flex;}`）。
- **手機版「台灣」「中國」分頁三段式瀏覽**（`src/ui/mobileTwBrowse.js`／`src/ui/mobileCnBrowse.js`，架構、匯出介面、CSS class 完全對稱，共用 `mobile-tw-*` class）：國家篩選列選到「台灣」或「中國」且 `mq.matches`（<=768px）時取代原本「來源→分類→次分類→圖層」手風琴，`sidebarUI.js` 的 `syncMobileBrowseView()` 管顯示切換。三段式是「大區域→地區→圖層」：台灣「全國/北部/中部/南部/東部/離島」（地區合併同縣市多個來源），中國「全國/華北/華東/華中/華南/西南」（比照台灣只放實際有資料的大區域）。第三段重用 `sidebarUI.js` 的 `buildSourceGroup(src)`（與桌機共用建立分類/次分類/圖層區塊邏輯，依選中地區篩出來源後各自重建獨立 DOM）。來源→大區域對照表（`MACRO_REGION_MAP`）與地區標籤字尾規則（`regionLabelForSource()`）寫在各自檔案，新增/搬動來源時記得同步；`mobile-tw-browse.test.mjs`／`mobile-cn-browse.test.mjs` 各有全站 24 個 tw／11 個 cn 來源的分組總數回歸測試會抓漏改。
- **手機版「其他」分頁二段式瀏覽**（`src/ui/mobileOtherBrowse.js`）：跟 tw/cn 不同，「其他」目前 4 個來源（`japan`／`korea`／`ls`／`southeast_asia`）彼此是不同國家/主題、無法合併成「地區」，所以省略大區域層，只有「來源→分類/圖層」二段——第一層是來源 chip 單選列，選中後下方直接顯示該來源的 `buildSourceGroup(src)`。沿用 `mobile-tw-*` 系列 class（沒有另開新 rootClassName），`layerCountForSource()` 沿用 `mobileRegionBrowse.js` 匯出的版本。`sidebarUI.js`／`src/features/multiOverlay.js`／`src/features/compareMode.js` 三處呼叫 `initMobileCountryBrowse()`／組 `MOBILE_BROWSE_CONFIGS` 的地方都要各自加上 `{ country: 'other', build: buildMobileOtherBrowseUI }`，漏改任一處會導致該手機版選單的「其他」分頁停留在舊手風琴縮小版、跟其他選單不一致。

## 地圖載入提示 (`body.map-ready`)
`#map` 預設底色是 `var(--paper-dim)`，非純黑，避免瓦片載入完成前被誤認當機；`index.html` 的 `#mapLoading`（spinner＋文字）純靠 CSS 淡出、**沒有**自己的 JS 監聽。淡出時機是 `src/core/map.js` 在 `map.once('rendercomplete', ...)` 對 `document.body` 加 `map-ready` class，`style.css` 靠 `body.map-ready .map-loading{opacity:0; pointer-events:none;}` 反應——map-core-agent 只出訊號、ui-frontend-agent 全權處理視覺，**`map-ready` 是跨檔案契約，不要改名或另建第二套訊號**。

## 地名今昔對照卡 (`data/place-names.json` + `src/features/placeNames.js`)
整合在既有「地址／位置搜尋」流程裡，**不是**獨立頁面，跟 `data/historical-names.json`（`thm` 舊堡名輔助篩選小型對照表）完全獨立、互不匯入，改動前先確認改的是哪一份。
- **資料來源**：`tools/build-place-names.js`（CommonJS）解析內政部「臺灣地區地名資料」CSV（聚落類＋行政區域類，原始檔在工作區外、不進 repo，`DEFAULT_SETTLEMENT_CSV`／`DEFAULT_ADMIN_CSV` 寫死目前這份的檔名），輸出 `data/place-names.json`（46,282 筆、有座標 35,270 筆、約 10.2MB，minify）。核心 `parseCsv`／`splitAliases`／`rowToPlace`／`extractAliasesFromDescription` 是不做檔案 I/O 的純函式，方便單元測試。
- **別名擴充（`extractAliasesFromDescription`）**：除了 `AnotherName` 欄位，`rowToPlace()` 也會從 `PlaceMean` 沿革文字裡用保守 regex 抓「舊稱／原名／又名／俗稱／古稱／曾稱／改稱」等前導語句後緊接的候選片段（上限 8 個中文字、遇標點截斷、排除跟主名稱相同的候選），合併進 `aliases` 並去重複。已用真實 CSV 驗證過抓取品質（有座標的 35,270 筆裡約 1.6% 能抽到候選，本來就是錦上添花不是主力）：前導語句後緊接「為／稱」連接詞（如「改稱為富興」）已跳過只留真正候選；「沿用至今」等純語意殘留、「此／應為／該」開頭的指示詞殘留、「公所／辦事處／派出所／管理處／事務所／委員會／支署／支廳」等機構名尾綴都已過濾排除，不會混進別名清單誤導搜尋。**已知仍存在但評估後決定不追加修正的殘留限制**：「舊稱Ｘ或Ｙ」這類用「或」併列的雙候選會被當成一整串沒拆開；候選超過 8 字的複合地名會被截斷成不完整字串；前導語句後緊接引號（如「又名『ＯＯ』」）抓不到（刻意保守）；「之為」「是」等較少見的連接詞未涵蓋；純語意詞殘留（如「原名同今名」）不在目前的過濾清單內仍可能漏網——這些都是 regex 表面比對的先天限制，不是真正的 NLP／斷詞，之後若要繼續打磨才需要回來調整 `DESC_ALIAS_*` 系列常數。
- **延遲載入**：`src/features/placeNames.js` 只在使用者第一次搜尋（`findPlaceNameCandidates()`）時才 `fetch()` 這份 10MB 檔案、之後吃記憶體快取，不放進 app 啟動流程（比照 `data/presets/`）。
- **比對規則**：現名或別名**精確相符**（非模糊比對），只保留有經緯度的候選（約 3.5 萬筆）；`matchPlaceNames(places, query)` 是不碰 fetch 的純函式版本，單元測試優先呼叫。
- **搜尋流程**（`src/ui/search.js` 的 `runImmediateSearch()`）：0 筆才退回 `geocodeAddress`；1 筆直接定位＋顯示卡片；多筆重用既有 `#addressSuggest` 列候選（**不要**另建獨立容器，否則手機版 `relocateSearchBar()` 不會搬到頂部搜尋列）。debounce 建議清單同樣並行查 `findPlaceNameCandidates()`，用 `renderMergedSuggestList()` 把地名候選（`.place-name-suggest-item`）釘在地址建議（`.address-suggest-item`）上方，Enter／debounce 兩條路徑行為一致。`renderPlaceNameCard()` 預設收合（`.collapsed`，內容照常渲染只是 CSS 隱藏），避免選到候選後一次全部展開太長；`focusPlaceNameCard()`（identify pin「查看地名沿革」）例外強制展開。
- **已踩過的坑**：`#addressSuggest` 桌面版 CSS 是 `position:absolute; top:100%` 相對 `.search-block` 定位，此祖先同時包住 `#locationResult`——已有搜尋結果展開時容器被撐高，建議/候選清單會被推到捲動範圍外看不到。已在 `renderSuggestList()`／`renderPlaceNameCandidateList()` 開頭呼叫 `repositionSuggestBelowInputRow()` 動態改寫 `top`（只在桌面版生效），之後在 `.search-block` 新增類似浮動元素記得比照辦理。
- **點位資訊視窗整合**：`initIdentifyPin({ getPlaceNameMatch, onViewPlaceNameCard })` 兩個可選參數。誤差容許 `1e-4` 度（約 11 公尺）才視為同一點，刻意保守——只有剛透過搜尋選定過地名、且點擊座標精準落在附近時才顯示「歷史地名」提示列，不對任意點擊做地名反查。
- **附近歷史地名（空間鄰近搜尋）**：精確比對是「打對字才找得到」，`findNearbyPlaceNames(places, lon, lat, { radiusMeters=800, limit=5 })`／`findNearbyPlaceNamesAsync(lon, lat, opts)`（`src/features/placeNames.js`，純函式＋async 包裝比照 `matchPlaceNames`／`findPlaceNameCandidates` 寫法）補上反向管道——用 haversine 算距離，線性掃描全部有座標候選（35,270 筆在 JS 內是毫秒等級，沒建空間索引）。**只掛在 `selectGeocodeResult()`（一般地址 geocoding 命中）這條路徑**，`selectPlaceNameCandidate()`（精確比對到古地名）不觸發，避免打對古地名時畫面疊加兩份。`src/ui/search.js` 的 `renderNearbyPlaceNames()` 查無結果安靜不顯示（不跳「查無」訊息），有結果就插進 `#locationResult`（座標資訊之後、可用圖層清單之前），點擊項目重用既有 `renderPlaceNameCard()`／`focusPlaceNameCard()` 展開卡片，不重刻渲染邏輯；`showLocationAndFindLayers()` 開頭統一清舊的 `.nearby-place-names`，三條落點路徑（地址搜尋／地名比對／定位）都不會殘留上一輪清單。半徑 800m／上限 5 筆是初版預設值，資料密度不均（市區密、山區可能方圓數公里內都沒資料），之後如果使用回饋覺得太鬆或太緊，回來調這兩個參數即可。
- **已知限制**：別名取自 `AnotherName` 欄位＋`PlaceMean` 沿革文字的保守前導語句抽取（見上），不是完整的舊名反推，仍可能有漏抓／誤抓（見上一點）；代表點是資料庫座標點，非歷史行政界線；總共約 1.1 萬筆無座標、不會出現在搜尋結果，其中行政區域類佔大宗（8,589 筆裡僅 2,629 筆有座標，覆蓋率約 3 成，遠低於聚落類的 86.6%）。
- 測試：`place-names-data.test.mjs`（CSV 解析）、`place-names-matching.test.mjs`（比對邏輯）、`place-name-card-ui.test.mjs`（卡片渲染／收合／候選清單）、`identify-pin.test.mjs`（「歷史地名」小區塊案例）、`place-names-nearby.test.mjs`（`findNearbyPlaceNames` 距離/半徑/排序/邊界）、`nearby-place-names-ui.test.mjs`（附近地名清單渲染／點擊展開／清空／精確比對路徑不觸發）。

## 子代理分工與路由 (Subagents Routing)
遇到具體模組需求時，主代理即刻將任務派發給對應 Subagent，勿在主階段載入過多非權責程式碼：

| 任務領域 | 調度代理 | 權責檔案邊界 |
| :--- | :--- | :--- |
| 地圖底層、圖磚容錯、座標換算 | `map-core-agent` | `src/mapCore.js`, `src/core/`, `src/tileChecker.js`, `src/geocode.js` |
| 介面樣式、RWD、側邊欄、時間軸滑桿、地址搜尋介面（含地名今昔對照卡渲染） | `ui-frontend-agent` | `index.html`, `style.css`, `src/ui/`（含 `src/ui/search.js`）, `src/timelineUI.js`, `src/sidebarUI.js`, `src/features/customTimelineUI.js`（例外：純介面渲染） |
| 模式切換、雙圖比對、繪圖工具、Store、地圖落點探針、地名比對邏輯 | `feature-state-agent` | `src/features/`（含 `identifyPin.js`、`customTimeline.js`、`placeNames.js`；不含 `customTimelineUI.js`）, `src/store.js`, `src/runtime.js`, `src/drawTool.js` |
| 圖層 JSON、地名映射、圖資打包、地名今昔對照資料 | `data-processing-agent` | `data/layers/`, `data/historical-names.json`, `data/place-names.json`, `tools/`（含 `tools/build-place-names.js`） |
| 整合回歸測試、品質把關 | `qa-testing-agent` | `tests/` |

## 開發守則與防護 (Guardrails)
1. **原生 ESM 架構：** 保持純原生 JavaScript ES Module，非必要絕不安裝任何重型 npm 第三方依賴。
2. **資料管線同步：** 凡異動 `data/layers/*.json`（尤其新增圖層），完成後必須先執行 `node tools/tag-layer-types.js` 打標 type，再執行 `node tools/build-layers-bundle.js` 重新打包。
3. **驗證先行：** 所有邏輯或狀態修改，結束前必須執行對應測試檔確認通過，嚴禁留下未驗證的 breaking changes。
4. **`src/data.js` 資料存取：** `LAYER_SOURCES`／`REGION_EXTENTS`／`SOURCE_MAP_RULES`／`HISTORICAL_NAMES`／`PLACE_NAME_SUFFIXES` 已合併成單一 `export const DATA = { LAYER_SOURCES, ... }` 物件（原本各自 `export let` 會被 SonarQube 標記為可變匯出），消費端一律 `import { DATA } from './data.js'` 後讀 `DATA.LAYER_SOURCES`，不要再寫裸變數。
5. **Subagent 權責清單同步：** 上表是概略路由，各 subagent 實際遵守的是 `.claude/agents/<name>.md` 逐檔列舉的白名單——比本表嚴格，且不會因新檔案落在負責目錄下就自動視為已授權。新增 `src/features/`、`src/core/` 等目錄下的檔案時，主代理當下就要把路徑加進對應白名單，不要留到下一輪。若某 subagent 以「不在白名單」拒絕明明屬於其目錄的檔案（即使是自己前幾輪建立的），代表清單漏列而非任務指派錯誤：主代理應先補清單，而非重複口頭說服 subagent 擴權；急迫時可由主代理直接 `Edit` 完成，事後仍要補寫清單。
6. **不劃給任何 subagent、由主代理直接 `Edit` 維護：** `src/main.js`（進入點／組合層，橫跨三個代理的初始化呼叫）；`package.json`、`vite.config.js`、`public/sw.js`、`public/manifest.webmanifest`（橫跨全站的建置／PWA 設定）。
   - `vite.config.js` 用內建 plugin 讓 `/data/*` 在 dev／build 都對應專案根目錄的 `data/`（Vite `publicDir` 只能設一個，設為預設 `public/` 放 `sw.js`／manifest），異動 `data/` 目錄結構前留意此對應。
   - `public/sw.js` 走三種快取、版本號互相脫鉤（`CACHE_VERSION` 管 App Shell／Data，`TILE_CACHE_VERSION` 管圖磚）：`tile-cache-*` Cache-First+LRU；`data/*.json` 的 `data-*` Network-First（有網路拿新版並更新快取，離線才退回舊版）；App Shell `app-shell-*` 拆兩種——HTML（navigate）Network-First，JS/CSS（含 hash 檔名）Cache-First。`activate` 只清 `MANAGED_CACHE_PREFIXES`（`app-shell-`/`data-`，含舊命名）前綴且非目前版本的快取，`tile-cache-` 不在清單內，改版不會清掉使用者已下載的圖磚。只在 `import.meta.env.PROD` 才被 `src/main.js` 註冊，`npm run dev` 不啟用。測試：`tests/specs/service-worker.test.mjs`（`node:vm` 獨立假 SW 環境）。
