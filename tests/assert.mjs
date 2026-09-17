/* ---------------------------------------------------------
   tests/assert.mjs — 極簡的測試小工具，不依賴任何套件
   ---------------------------------------------------------
   用法：
     import { test, run, sleep } from './assert.mjs';
     test('說明文字', () => {
       if(1 + 1 !== 2) throw new Error('數學壞掉了');
     });
     await run();  // 印出結果，任何一個失敗就會用非 0 狀態碼結束
                     // （這樣接到 CI 或自動化流程時，失敗會被偵測到）

   可選的 beforeEach／afterEach：
     import { test, beforeEach, run, assertEqual } from './assert.mjs';
     beforeEach(() => { resetToDefault(); });
     test('...', () => { ... }); // 不用再自己在每個 test() 開頭手動呼叫 resetToDefault()

   - 完全是「選用」機制：不呼叫 beforeEach／afterEach 的既有測試檔案行為
     不變（hooks 陣列預設是空的，run() 內部迴圈多繞一圈空陣列等同無操作）。
   - 呼叫多次 beforeEach／afterEach 會依註冊順序全部執行（不是後蓋前），
     用來對應「不同關注點分開寫」的情境。
   - beforeEach 拋出例外會讓該筆測試直接記為失敗（不會執行 fn 本體），
     訊息會標明是 beforeEach 出錯，不會誤導成是測試本體的斷言失敗。
   - afterEach 一律執行（即使 fn 或 beforeEach 已經失敗），確保清理動作
     不會因為測試失敗而被跳過；afterEach 自己出錯不會覆蓋原本的測試結果，
     只會額外印出來提醒。
--------------------------------------------------------- */
const cases = [];
const beforeEachHooks = [];
const afterEachHooks = [];

export function test(name, fn){
  cases.push({ name, fn });
}

export function beforeEach(fn){
  beforeEachHooks.push(fn);
}

export function afterEach(fn){
  afterEachHooks.push(fn);
}

export function sleep(ms){
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 輪詢直到 conditionFn() 回傳 truthy，或超過 timeoutMs 逾時。比照
// tests/specs/tile-load-guard.test.mjs 原本就有的 waitForState() 模式，
// 抽成這裡的共用版本：優先用「輪詢某個可觀察條件」取代「固定 sleep()
// 賭一個經驗值夠不夠長」，逾時時間到了才真的算失敗，條件提早成立就
// 提早繼續，不用像 sleep() 一樣每次都乾等固定時間。conditionFn 拋出
// 例外會直接 reject（視為條件檢查本身出錯，不是「條件還沒成立」）。
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

export function assertEqual(actual, expected, msg){
  if(actual !== expected){
    throw new Error(`${msg || '斷言失敗'}：預期 ${JSON.stringify(expected)}，實際 ${JSON.stringify(actual)}`);
  }
}

export function assertTrue(actual, msg){
  if(!actual) throw new Error(msg || '斷言失敗：預期為 true');
}

export async function run(){
  let passed = 0;
  let failed = 0;
  for(const { name, fn } of cases){
    try{
      try{
        for(const hook of beforeEachHooks) await hook();
      }catch(err){
        throw new Error(`beforeEach 出錯，未執行測試本體：${err.message}`);
      }
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    }catch(err){
      failed++;
      console.log(`  ✗ ${name}`);
      console.log(`    ${err.message}`);
    }finally{
      for(const hook of afterEachHooks){
        try{
          await hook();
        }catch(err){
          // afterEach 出錯不覆蓋原本測試結果（該筆成功/失敗已經算過了），
          // 只額外印出來提醒清理動作本身壞掉，避免真正原因被吃掉。
          console.log(`    （afterEach 發生錯誤：${err.message}）`);
        }
      }
    }
  }
  console.log(`\n${passed} 通過, ${failed} 失敗（共 ${cases.length} 項）`);
  if(failed > 0) process.exitCode = 1;
  return { passed, failed, total: cases.length };
}
