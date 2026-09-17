import { defineConfig } from 'vitest/config';

// 試點階段專用設定：只掃描 tests/specs-vitest/ 底下的檔案，
// 完全不碰 tests/specs/（那邊仍由 tests/run-all.mjs + assert.mjs 手刻框架負責），
// 兩套測試互不干擾，方便比對遷移前後的結果與行為差異。
// environment 用預設的 'node'：tests/env-stub.mjs 是用手動塞 globalThis 的方式
// 模擬 document／window／ol，不需要（也不該疊加）jsdom 之類的真實 DOM 實作。
// pool 刻意先不覆寫、維持 vitest 5 預設的 'threads'：試點的目的就是要驗證
// 這個預設值底下 env-stub.mjs 對 globalThis 的側效應是否真的有做到
// 「每個測試檔案互不汙染」，跟現在 run-all.mjs 用 process-per-file 達到的
// 隔離效果是否等價；如果試點發現有汙染，再改成 pool: 'forks' 退回等價的
// process 隔離模型。
export default defineConfig({
  test: {
    include: ['tests/specs-vitest/**/*.test.mjs'],
    environment: 'node',
    globals: false,
  },
});
