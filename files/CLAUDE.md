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

## 子代理分工與路由 (Subagents Routing)
遇到具體模組需求時，主代理請即刻將任務派發給對應的 Subagent，勿在主階段載入過多非權責程式碼：

| 任務領域 | 調度代理 | 權責檔案邊界 |
| :--- | :--- | :--- |
| 地圖底層、圖磚容錯、座標換算 | `map-core-agent` | `src/mapCore.js`, `src/core/`, `src/tileChecker.js`, `src/geocode.js` |
| 介面樣式、RWD、側邊欄、時間軸滑桿 | `ui-frontend-agent` | `index.html`, `style.css`, `src/ui/`, `src/timelineUI.js`, `src/sidebarUI.js` |
| 模式切換、雙圖比對、繪圖工具、Store、地圖落點探針 | `feature-state-agent` | `src/features/`（含 `identifyPin.js`）, `src/store.js`, `src/runtime.js`, `src/drawTool.js` |
| 圖層 JSON、地名映射、圖資打包 | `data-processing-agent` | `data/layers/`, `data/historical-names.json`, `tools/` |
| 整合回歸測試、品質把關 | `qa-testing-agent` | `tests/` |

## 開發守則與防護 (Guardrails)
1. **原生 ESM 架構：** 保持純原生 JavaScript ES Module，非必要絕不安裝任何重型 npm 第三方依賴。
2. **資料管線同步：** 凡異動 `data/layers/*.json`（尤其新增圖層），完成後必須先執行 `node tools/tag-layer-types.js` 自動打標 type，再執行 `node tools/build-layers-bundle.js` 重新打包。
3. **驗證先行：** 所有邏輯或狀態修改，結束前必須執行對應的測試檔確認通過，嚴禁留下未驗證的 break changes。
4. **Subagent 權責清單同步 (Role Whitelist Sync)：** 上表是概略路由，各 subagent 實際遵守的是 `.claude/agents/<name>.md` 裡「你僅能檢視與修改」逐檔列舉的白名單——這份清單比本表嚴格，且**不會**因為新檔案落在該 agent 負責的目錄下就自動視為已授權。
   - 新增 `src/features/`、`src/core/` 等目錄下的檔案時，主代理當下就要把該檔案路徑加進對應 `.claude/agents/<name>.md` 的權責清單，不要留給下一輪任務才補。
   - 若某 subagent 以「不在白名單」拒絕明明屬於其目錄的檔案（即使是它自己前幾輪建立的），代表清單漏列而非任務指派錯誤：主代理應先把該路徑補進對應 `.claude/agents/*.md`，而不是重複用同一個訊息說服 subagent 擴權（subagent 不應該、也不會接受單純的口頭再授權）。若時間急迫可由主代理直接以 `Edit` 完成該次修改，事後仍要記得補寫清單，避免下次重蹈覆轍。
5. **`src/main.js` 不劃給任何 subagent：** 進入點／組合層，橫跨三個代理的初始化呼叫，由主代理直接 `Edit` 維護，避免單一 subagent 片面增刪其他代理的初始化邏輯。
6. **建置基礎設施不劃給任何 subagent：** `package.json`、`vite.config.js`、`public/sw.js`、`public/manifest.webmanifest` 屬於橫跨全站的建置／PWA 設定，跟 `src/main.js` 一樣由主代理直接 `Edit` 維護，不派給 subagent。
   - `vite.config.js` 目前用一個內建（無額外套件）plugin 讓 `/data/*` 在 dev／build 都對應到專案根目錄的 `data/`（因為 Vite 的 `publicDir` 只能設一個，這裡設為預設的 `public/` 放 `sw.js`／manifest）。異動 `data/` 目錄結構前要留意這個對應關係。
   - `public/sw.js` 走三層快取（圖磚 Cache-First+LRU／圖層 JSON Stale-While-Revalidate／App Shell Cache-First），只在 `import.meta.env.PROD`（即 `npm run build` 後）才會被 `src/main.js` 註冊，`npm run dev` 底下不會啟用，避免快取干擾開發。
