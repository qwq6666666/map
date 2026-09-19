/* ---------------------------------------------------------
   tools/pre-push-check.js
   ---------------------------------------------------------
   由 .githooks/pre-push 呼叫。推送到 main 前，先在本機做跟 CI 一樣的
   「docs/ 同步驗證」：把已 commit 的 docs/ 備份 → 重新 build → 比對。
   原始碼改了卻忘了重新 build 並 commit docs/，GitHub Pages 會停在舊版
   而且沒有任何錯誤訊息，這裡在 push 之前就攔下來，不用等 CI。

   只在「推送 main 分支」時檢查（其他分支不會被部署）；刪除分支也略過。
   需要乾淨的工作區：檢查的是「目前工作區」，有未 commit 的異動會讓結果
   跟實際要推送的內容對不上。

   驗證通過：把 build 過程對 docs/ 造成的雜訊（換行、sourcemap）還原，
   工作區維持乾淨。驗證失敗：保留新 build 的 docs/，直接 commit 就能修好。

   緊急繞過：git push --no-verify
--------------------------------------------------------- */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ZERO_SHA = /^0+$/;

// pre-push 的 stdin：每行 <local ref> <local sha> <remote ref> <remote sha>
function pushesToMain(stdinText){
  return stdinText.split('\n').some(line => {
    const [, localSha, remoteRef] = line.trim().split(/\s+/);
    return remoteRef === 'refs/heads/main' && localSha && !ZERO_SHA.test(localSha);
  });
}

function run(cmd, args){
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' });
}

// Windows 的 npm 是 npm.cmd，必須走 shell；整串命令字串傳入（不帶 args 陣列），
// 避免 Node 對「shell:true 又傳 args」的 DEP0190 警告
function runNpmBuild(){
  return spawnSync('npm run build', { cwd: ROOT, encoding: 'utf8', shell: true });
}

function fail(lines){
  console.error('\n[pre-push] 已攔下這次推送：');
  for(const line of lines) console.error('  ' + line);
  console.error('  （確定要略過檢查時：git push --no-verify）\n');
  process.exit(1);
}

function main(){
  let stdinText = '';
  try { stdinText = fs.readFileSync(0, 'utf8'); } catch { /* 沒有 stdin 視為沒有要推的 ref */ }
  if(!pushesToMain(stdinText)) return;

  const dirty = run('git', ['status', '--porcelain', '--untracked-files=no']).stdout.trim();
  if(dirty){
    fail(['工作區還有未 commit 的異動，檢查結果會跟實際推送內容對不上。', '請先 commit（或還原）再推送。', '', dirty]);
  }

  console.log('[pre-push] 驗證 docs/ 是否與原始碼同步（重新 build 中，約需數十秒）…');
  const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-committed-'));
  try {
    fs.cpSync(path.join(ROOT, 'docs'), backup, { recursive: true });

    const build = runNpmBuild();
    if(build.status !== 0){
      fail(['npm run build 失敗，請先修好建置錯誤。', '', (build.stdout || '') + (build.stderr || '')]);
    }

    const verify = run(process.execPath, [path.join('tools', 'verify-docs-sync.js'), backup, 'docs']);
    if(verify.status !== 0){
      fail([
        'docs/ 與原始碼不同步（改了原始碼卻沒重新 build 並 commit docs/）。',
        '新 build 的 docs/ 已寫進工作區，直接 commit 後再推送即可。',
        '',
        (verify.stdout || '') + (verify.stderr || '')
      ]);
    }

    // 通過：還原 build 造成的換行／sourcemap 雜訊，讓工作區保持乾淨
    run('git', ['checkout', '--', 'docs']);
    run('git', ['clean', '-fdq', '--', 'docs']);
    console.log('[pre-push] docs/ 已同步，繼續推送。');
  } finally {
    fs.rmSync(backup, { recursive: true, force: true });
  }
}

if(require.main === module) main();

module.exports = { pushesToMain };
