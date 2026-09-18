import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['docs/**', 'node_modules/**', 'data/**', 'tools/cors-proxy-worker/**'] },
  js.configs.recommended,
  {
    // 全形空白常被刻意用來對齊中文欄位寬度（例如 console.log 的樣板字串），
    // 跳過樣板字串檢查、只保留對一般程式碼／註解裡誤植不可見字元的偵測。
    rules: { 'no-irregular-whitespace': ['error', { skipTemplates: true }] }
  },
  {
    // 瀏覽器端原生 ESM 程式碼；ol 是 CDN 載入的全域 UMD 物件（見 CLAUDE.md）
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ol: 'readonly' }
    }
  },
  {
    // Service Worker：獨立執行環境，非 ESM（sw.js 以 classic script 註冊）
    files: ['public/sw.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: globals.serviceworker
    }
  },
  {
    // 建置工具：tools/package.json 覆寫為 commonjs
    files: ['tools/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: globals.node
    }
  },
  {
    files: ['tools/**/*.mjs', 'vite.config.js', 'vitest.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node
    }
  },
  {
    // 測試跑在 Node，但模擬瀏覽器環境（env-stub.mjs）
    files: ['tests/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser }
    }
  }
];
