// 使用指南（src/ui/onboarding.js 的 GUIDE_SECTIONS／buildGuideDrawer）的靜態回歸測試：
// 只讀原始碼字串，不需要瀏覽器環境（同 tile-source-cache-size.test.mjs 的做法）。
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const onboardingSrc = readFileSync('src/ui/onboarding.js', 'utf8');
const baseCss = readFileSync('styles/base.css', 'utf8');
const sprite = readFileSync('public/assets/map-emoji-style-a-icons.svg', 'utf8');

function loadSections(){
  const start = onboardingSrc.indexOf('const GUIDE_SECTIONS = [');
  const end = onboardingSrc.indexOf('\n];', start);
  return new Function(`return ${onboardingSrc.slice(start + 'const GUIDE_SECTIONS = '.length, end + 2)}`)();
}
const sections = loadSections();
const byTitle = (t) => sections.find(s => s.title === t);

test('「進階功能說明」已拆成「複合疊圖」「繪圖工具」「自訂圖層匯入」三段', () => {
  expect(byTitle('進階功能說明')).toBeUndefined();
  ['複合疊圖', '繪圖工具', '自訂圖層匯入'].forEach(t => expect(byTitle(t)).toBeDefined());
});

test('「⋯ 更多」選單的功能都有對應指南段落：分享與截圖、軌跡記錄、來源狀態／快取', () => {
  ['分享與截圖', '軌跡記錄', '來源狀態／快取'].forEach(t => expect(byTitle(t), t).toBeDefined());
  expect(byTitle('分享與截圖').body).toContain('下載截圖');
  expect(byTitle('軌跡記錄').body).toContain('我的軌跡');
  expect(byTitle('來源狀態／快取').body).toContain('已快取圖磚');
});

test('每段都有標題與內容，圖示不是 emoji：要嘛是 sprite 內存在的 symbol，要嘛留空', () => {
  const ids = new Set([...sprite.matchAll(/<symbol id="([^"]+)"/g)].map(m => m[1]));
  sections.forEach((s) => {
    expect(s.title).toBeTruthy();
    expect(s.body).toBeTruthy();
    if(s.icon === '') return;
    const id = /#([\w-]+)"/.exec(s.icon)?.[1];
    expect(ids.has(id), `${s.title} 的圖示 ${id} 不在 sprite 裡`).toBe(true);
  });
  expect(byTitle('手機版操作方式').icon).toBe('');
});

test('內文不再混用 emoji 當按鈕名稱標示', () => {
  sections.forEach((s) => {
    expect(s.body, s.title).not.toMatch(/📍|🔗|⭐|🕘|🗺|📱/u);
  });
});

test('步驟性內容用 <ol> 條列：落點探針右鍵兩步、自訂圖層匯入兩種流程', () => {
  const liCount = (s) => (byTitle(s).body.match(/<li>/g) || []).length;
  expect(liCount('落點探針')).toBe(2);
  expect((byTitle('自訂圖層匯入').body.match(/<ol>/g) || []).length).toBe(2);
});

test('<ol> 標籤之間不可有換行字元：內文是 white-space:pre-line，換行會被當成多餘空行', () => {
  sections.forEach((s) => {
    expect(s.body, s.title).not.toMatch(/<ol>\n|<li>\n|<\/li>\n|\n<\/ol>/);
  });
});

test('警示句有加粗：清空無法復原、資料不會雲端同步、自訂圖層不含在分享連結', () => {
  expect(byTitle('繪圖工具').body).toContain('<strong>這個動作無法復原</strong>');
  expect(byTitle('收藏與最近使用圖層').body).toMatch(/<strong>[^<]*不是雲端同步保存[^<]*<\/strong>/);
  expect(byTitle('分享與截圖').body).toMatch(/<strong>[^<]*不會包含在分享連結內[^<]*<\/strong>/);
  expect(byTitle('自訂圖層匯入').body).toMatch(/<strong>[^<]*不會包含在分享連結內[^<]*<\/strong>/);
});

test('手風琴標題按鈕同步維護 aria-expanded／aria-controls，展開與 toggle 兩處都有', () => {
  expect(onboardingSrc).toMatch(/aria-expanded="\$\{isOpen\}"/);
  expect(onboardingSrc).toMatch(/aria-controls="\$\{bodyId\}"/);
  expect(onboardingSrc).toMatch(/id="\$\{bodyId\}"/);
  expect(onboardingSrc).toContain("head.setAttribute('aria-expanded', String(isOpen))");
});

test('抽屜滿版斷點是 768px（跟全站手機版對齊），不在 640px 區塊裡', () => {
  const at768 = /@media \(max-width:768px\)\s*\{[^}]*\.guide-drawer\{[^}]*width:100vw/.exec(baseCss);
  expect(at768).not.toBeNull();
  const at640Blocks = [...baseCss.matchAll(/@media \(max-width:640px\)\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g)].map(m => m[1]);
  at640Blocks.forEach(b => expect(b).not.toMatch(/\.guide-drawer\{/));
});
