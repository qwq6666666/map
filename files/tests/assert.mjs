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
--------------------------------------------------------- */
const cases = [];

export function test(name, fn){
  cases.push({ name, fn });
}

export function sleep(ms){
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    }catch(err){
      failed++;
      console.log(`  ✗ ${name}`);
      console.log(`    ${err.message}`);
    }
  }
  console.log(`\n${passed} 通過, ${failed} 失敗（共 ${cases.length} 項）`);
  if(failed > 0) process.exitCode = 1;
  return { passed, failed, total: cases.length };
}
