#!/usr/bin/env node
/* ---------------------------------------------------------
   tests/run-all.mjs — 一次跑完全部測試
   ---------------------------------------------------------
   用法（在專案根目錄執行）：
       node tests/run-all.mjs

   每個 tests/specs/*.test.mjs 檔案會用獨立的 process 執行（因為
   src/ 裡的模組大多是「載入一次、狀態留在記憶體」的單例，不同測試
   檔案之間如果共用同一個 process，前一份檔案跑過的狀態會汙染下一份，
   分開執行才乾淨）。任何一份測試檔案有失敗，這支腳本最後會用非 0
   狀態碼結束，方便串進其他自動化流程判斷成功或失敗。
--------------------------------------------------------- */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const specsDir = path.join(__dirname, 'specs');
const files = readdirSync(specsDir).filter(f => f.endsWith('.test.mjs')).sort();

console.log(`找到 ${files.length} 份測試檔案\n`);

let totalPassed = 0;
let totalFailed = 0;
let anyFailed = false;

// 從單一測試檔案的 stdout 裡擷取「X 通過, Y 失敗」小計，累加進全域計數器。
// 抽成獨立函式讓 try（該檔案全數通過、exit code 0）與 catch（該檔案有
// 斷言失敗、assert.mjs 的 run() 設了非 0 process.exitCode、execFileSync
// 因此 throw）兩條路徑都會呼叫到，避免其中一條路徑漏加計數
//（曾經發生：catch 分支只印出 err.stdout、從未呼叫這段解析邏輯，導致
// 有失敗案例的檔案完全沒被計入總計，總計行看起來比逐檔加總還要少）。
// SonarQube javascript:S8786（ReDoS／超線性回溯）修正：\d+ 改成有
// 上限的 \d{1,6}（單一測試檔案不可能有百萬筆案例），量詞最壞情況
// 回溯步數有明確上界，消除超線性風險。
function accumulateCounts(output){
  const m = output.match(/(\d{1,6}) 通過, (\d{1,6}) 失敗/);
  if(m){
    totalPassed += Number(m[1]);
    totalFailed += Number(m[2]);
    if(Number(m[2]) > 0) anyFailed = true;
  }
}

for(const file of files){
  console.log(`\n=== ${file} ===`);
  try{
    // 用 process.execPath（目前執行中 node 執行檔的絕對路徑）取代裸字串 'node'，
    // 避免透過 PATH 搜尋解析執行檔（PATH injection 風險）。
    const output = execFileSync(process.execPath, [path.join(specsDir, file)], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf-8',
    });
    console.log(output.trimEnd());
    accumulateCounts(output);
  }catch(err){
    anyFailed = true;
    const output = err.stdout ? err.stdout.trimEnd() : '';
    console.log(output || '（測試檔案執行時發生未預期的錯誤）');
    if(err.stderr) console.log(err.stderr.trimEnd());
    if(output) accumulateCounts(output);
  }
}

console.log('\n' + '='.repeat(50));
console.log(`總計：${totalPassed} 通過, ${totalFailed} 失敗`);
console.log('='.repeat(50));

if(anyFailed) process.exitCode = 1;
