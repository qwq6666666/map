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
import { execFileSync } from 'child_process';
import { readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const specsDir = path.join(__dirname, 'specs');
const files = readdirSync(specsDir).filter(f => f.endsWith('.test.mjs')).sort();

console.log(`找到 ${files.length} 份測試檔案\n`);

let totalPassed = 0;
let totalFailed = 0;
let anyFailed = false;

for(const file of files){
  console.log(`\n=== ${file} ===`);
  try{
    const output = execFileSync('node', [path.join(specsDir, file)], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf-8',
    });
    console.log(output.trimEnd());
    const m = output.match(/(\d+) 通過, (\d+) 失敗/);
    if(m){
      totalPassed += Number(m[1]);
      totalFailed += Number(m[2]);
      if(Number(m[2]) > 0) anyFailed = true;
    }
  }catch(err){
    anyFailed = true;
    console.log(err.stdout ? err.stdout.trimEnd() : '（測試檔案執行時發生未預期的錯誤）');
    if(err.stderr) console.log(err.stderr.trimEnd());
  }
}

console.log('\n' + '='.repeat(50));
console.log(`總計：${totalPassed} 通過, ${totalFailed} 失敗`);
console.log('='.repeat(50));

if(anyFailed) process.exitCode = 1;
