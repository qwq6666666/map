/* ---------------------------------------------------------
   tools/verify-docs-sync.js
   ---------------------------------------------------------
   部署驗證：GitHub Pages 發布的就是 repo 裡已 commit 的 docs/，
   所以「改了原始碼卻忘了重新 build 並 commit docs/」會讓線上網站
   停在舊版、而且沒有任何錯誤訊息。

   CI 流程是：先把 commit 進來的 docs/ 複製到暫存目錄 → 重新
   `npm run build`（會覆寫 docs/）→ 用這支腳本比對兩份內容。

   比對時刻意忽略兩種「與程式邏輯無關」的差異，否則在 Windows 開發
   （CRLF）、Linux CI（LF）之間會天天誤報：
     - 文字檔的換行字元（CRLF 與 LF 視為相同）。已實測：JS／CSS 在兩種
       換行環境下 hash 檔名與內容完全一致；index.html、sw.js、data/、
       svg 這類含換行的檔案則會因換行不同而位元組不同。
     - *.map（sourcemap 內嵌原始碼，換行被跳脫成字串，無法用上面的
       方式正規化；且 sourcemap 不影響使用者看到的功能）。

   用法：
       node tools/verify-docs-sync.js <已 commit 的 docs 目錄> <重新 build 的 docs 目錄>

   結束碼：0 = 同步；1 = 不同步（有檔案缺少／多出／內容不同）。
--------------------------------------------------------- */
const fs = require('node:fs');
const path = require('node:path');

const TEXT_EXTENSIONS = new Set(['.html', '.css', '.js', '.json', '.svg', '.webmanifest', '.xml', '.txt', '.md']);
const IGNORED_EXTENSIONS = new Set(['.map']);
// .gitkeep 只是讓空目錄能進 git 的佔位檔（內容是說明註解，
// path.extname() 會判成「無副檔名」而走位元組比對、被換行差異誤報）
const IGNORED_BASENAMES = new Set(['.gitkeep']);
const MAX_LISTED = 20;

function listFiles(root){
  const out = [];
  (function walk(dir){
    for(const entry of fs.readdirSync(dir, { withFileTypes: true })){
      const full = path.join(dir, entry.name);
      if(entry.isDirectory()) walk(full);
      else if(!IGNORED_EXTENSIONS.has(path.extname(entry.name)) && !IGNORED_BASENAMES.has(entry.name)) out.push(path.relative(root, full).replaceAll('\\', '/'));
    }
  })(root);
  return out.sort();
}

function readNormalized(filePath){
  const buf = fs.readFileSync(filePath);
  if(!TEXT_EXTENSIONS.has(path.extname(filePath))) return buf;
  // 直接移除所有 \r，而不是只把 \r\n 換成 \n：Vite 在 CRLF 的 index.html 裡
  // 插入 <script> 標籤時會產生落單的 \r，只換 \r\n 清不乾淨（CI 曾因此誤報）
  return Buffer.from(buf.toString('utf-8').replaceAll('\r', ''), 'utf-8');
}

function main(){
  const [committedDir, freshDir] = process.argv.slice(2);
  if(!committedDir || !freshDir){
    console.error('用法：node tools/verify-docs-sync.js <已 commit 的 docs> <重新 build 的 docs>');
    process.exit(2);
  }

  const committed = new Set(listFiles(committedDir));
  const fresh = new Set(listFiles(freshDir));

  // 只有重新 build 才會產生、卻沒 commit 進來 → 線上缺這些檔案
  const missing = [...fresh].filter(f => !committed.has(f));
  // commit 進來、但新 build 已不產生 → 過期的殘留檔案
  const stale = [...committed].filter(f => !fresh.has(f));
  const changed = [...fresh].filter(f => committed.has(f)
    && !readNormalized(path.join(committedDir, f)).equals(readNormalized(path.join(freshDir, f))));

  const problems = missing.length + stale.length + changed.length;
  if(problems === 0){
    console.log(`docs/ 與目前原始碼同步（比對 ${fresh.size} 個檔案）。`);
    return;
  }

  const show = (title, files) => {
    if(files.length === 0) return;
    console.error(`\n${title}（${files.length}）：`);
    files.slice(0, MAX_LISTED).forEach(f => console.error(`  - ${f}`));
    if(files.length > MAX_LISTED) console.error(`  ……另外還有 ${files.length - MAX_LISTED} 個`);
  };
  console.error('docs/ 與目前原始碼「不同步」——線上網站會停在舊版。');
  show('新 build 有、但 docs/ 沒有的檔案', missing);
  show('docs/ 有、但新 build 已不產生的檔案', stale);
  show('內容不同的檔案', changed);
  console.error('\n修法：在本機執行 npm run build，然後把 docs/ 一起 commit + push。');
  process.exit(1);
}

main();
