/* ---------------------------------------------------------
   tests/helpers.mjs
   ---------------------------------------------------------
   vitest 測試共用的非同步輔助函式（原本放在已移除的手刻框架
   tests/assert.mjs，遷移到 vitest 後抽出，內容逐字保留）。
--------------------------------------------------------- */
export function sleep(ms){
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 輪詢等待條件成立；逾時 reject。比固定 sleep 穩定，也比較快。
export function waitFor(conditionFn, { timeoutMs = 5000, intervalMs = 5, message } = {}){
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      let ok;
      try{ ok = conditionFn(); }catch(err){ reject(err); return; }
      if(ok) { resolve(); return; }
      if(Date.now() - start >= timeoutMs){
        reject(new Error(message || `等待條件成立逾時（超過 ${timeoutMs}ms）`));
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}
