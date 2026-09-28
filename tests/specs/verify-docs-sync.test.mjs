import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import verifyDocsSync from '../../tools/verify-docs-sync.js';

const { listFiles, readNormalized, diffDocs } = verifyDocsSync;

/* ---------------------------------------------------------
   tests/specs/verify-docs-sync.test.mjs
   ---------------------------------------------------------
   tools/verify-docs-sync.js 是「改了原始碼卻忘了重新 build 並 commit
   docs/」的最後一道防線（CI／pre-push hook 都靠它），本身卻一直沒有測試
   （全站掃描的 tools/ 目錄零覆蓋清單之一）。比照 pre-push-check.test.mjs
   的作法：main() 用 `require.main === module` 擋住，只 export 純邏輯
  （listFiles／readNormalized／diffDocs）供這裡直接呼叫真的暫存目錄——
   這支腳本的核心價值就是「比對真的檔案系統」，捏造記憶體假物件測不出
   實際的換行／副檔名判斷邏輯有沒有問題。
--------------------------------------------------------- */

let committedDir, freshDir;

function write(dir, relPath, content){
  const full = path.join(dir, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  committedDir = mkdtempSync(path.join(tmpdir(), 'docs-sync-committed-'));
  freshDir = mkdtempSync(path.join(tmpdir(), 'docs-sync-fresh-'));
});

afterEach(() => {
  rmSync(committedDir, { recursive: true, force: true });
  rmSync(freshDir, { recursive: true, force: true });
});

describe('listFiles', () => {
  test('遞迴列出所有檔案的相對路徑，已排序', () => {
    write(committedDir, 'index.html', 'x');
    write(committedDir, 'assets/index-abc.js', 'x');
    write(committedDir, 'data/layers/sinica.json', 'x');
    expect(listFiles(committedDir)).toEqual(['assets/index-abc.js', 'data/layers/sinica.json', 'index.html']);
  });

  test('排除 .map 檔與 .gitkeep（sourcemap／空目錄佔位檔，跟功能無關）', () => {
    write(committedDir, 'assets/index-abc.js', 'x');
    write(committedDir, 'assets/index-abc.js.map', 'x');
    write(committedDir, 'data/presets/.gitkeep', '');
    expect(listFiles(committedDir)).toEqual(['assets/index-abc.js']);
  });

  test('空目錄回傳空陣列', () => {
    expect(listFiles(committedDir)).toEqual([]);
  });
});

describe('readNormalized', () => {
  test('文字副檔名（.html／.js…）會把 \\r 全部移除，不論 CRLF 或落單的 \\r', () => {
    write(committedDir, 'a.html', '<html>\r\n<body>\r</body>\r\n</html>');
    const normalized = readNormalized(path.join(committedDir, 'a.html'));
    expect(normalized.toString('utf-8')).toBe('<html>\n<body></body>\n</html>');
  });

  test('非文字副檔名（例如 .png）原樣回傳位元組，不做任何正規化', () => {
    write(committedDir, 'a.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
    const normalized = readNormalized(path.join(committedDir, 'a.png'));
    expect(normalized).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])); // 0x0d 沒被當成 \r 移除
  });
});

describe('diffDocs', () => {
  test('兩邊完全一致（含 CRLF/LF 差異）→ 三個陣列都是空的', () => {
    write(committedDir, 'index.html', 'Hello\r\nWorld');
    write(freshDir, 'index.html', 'Hello\nWorld'); // 換行不同，但正規化後內容相同
    const { missing, stale, changed, total } = diffDocs(committedDir, freshDir);
    expect(missing).toEqual([]);
    expect(stale).toEqual([]);
    expect(changed).toEqual([]);
    expect(total).toBe(1);
  });

  test('新 build 多出檔案 → missing（docs/ 忘了 commit 新檔案）', () => {
    write(committedDir, 'index.html', 'x');
    write(freshDir, 'index.html', 'x');
    write(freshDir, 'assets/new-Cabc123.js', 'x');
    const { missing, stale, changed } = diffDocs(committedDir, freshDir);
    expect(missing).toEqual(['assets/new-Cabc123.js']);
    expect(stale).toEqual([]);
    expect(changed).toEqual([]);
  });

  test('docs/ 有、新 build 已不產生 → stale（過期殘留檔案，例如舊 hash 檔名沒被清掉）', () => {
    write(committedDir, 'index.html', 'x');
    write(committedDir, 'assets/old-Dxyz789.js', 'x');
    write(freshDir, 'index.html', 'x');
    const { missing, stale, changed } = diffDocs(committedDir, freshDir);
    expect(missing).toEqual([]);
    expect(stale).toEqual(['assets/old-Dxyz789.js']);
    expect(changed).toEqual([]);
  });

  test('同名檔案內容不同（正規化換行後仍不同）→ changed', () => {
    write(committedDir, 'index.html', '<title>舊版</title>');
    write(freshDir, 'index.html', '<title>新版</title>');
    const { missing, stale, changed } = diffDocs(committedDir, freshDir);
    expect(missing).toEqual([]);
    expect(stale).toEqual([]);
    expect(changed).toEqual(['index.html']);
  });

  test('.map 檔案內容不同也不算 changed（sourcemap 不影響使用者看到的功能，刻意忽略）', () => {
    write(committedDir, 'a.js', 'same');
    write(freshDir, 'a.js', 'same');
    write(committedDir, 'a.js.map', '{"version":3,"old":true}');
    write(freshDir, 'a.js.map', '{"version":3,"old":false}');
    const { missing, stale, changed } = diffDocs(committedDir, freshDir);
    expect(missing).toEqual([]);
    expect(stale).toEqual([]);
    expect(changed).toEqual([]);
  });

  test('三種問題可以同時出現，各自獨立回報', () => {
    write(committedDir, 'stale.js', 'x');
    write(committedDir, 'changed.html', '舊');
    write(freshDir, 'changed.html', '新');
    write(freshDir, 'missing.js', 'x');
    const { missing, stale, changed } = diffDocs(committedDir, freshDir);
    expect(missing).toEqual(['missing.js']);
    expect(stale).toEqual(['stale.js']);
    expect(changed).toEqual(['changed.html']);
  });
});
