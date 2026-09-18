import { defineConfig } from 'vitest/config';

// 測試設定：掃描 tests/specs/ 底下所有 *.test.mjs。
// environment 用預設的 'node'：tests/env-stub.mjs 是用手動塞 globalThis 的方式
// 模擬 document／window／ol，不需要（也不該疊加）jsdom 之類的真實 DOM 實作。
// pool 維持 vitest 5 預設的 'threads'：已驗證 env-stub.mjs 對 globalThis 的
// 側效應在每個測試檔案（各自獨立 worker）之間互不汙染；如果將來發現有汙染，
// 再改成 pool: 'forks' 退回 process 隔離模型。
export default defineConfig({
  test: {
    include: ['tests/specs/**/*.test.mjs'],
    environment: 'node',
    globals: false,
  },
});
