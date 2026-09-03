import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue, sleep } from '../assert.mjs';
import { buildTimeline } from '../../src/timelineUI.js';

function makeCandidate(id, title, year){
  return { src: { id: 'sinica', name: '台灣百年歷史地圖' }, layer: { id, title, year: String(year), yearNum: year } };
}

test('依年份排序後，畫出跟資料筆數一樣多的箭頭', () => {
  const container = document.createElement('div');
  const candidates = [
    makeCandidate('a', '甲', 1950),
    makeCandidate('b', '乙', 1897),
    makeCandidate('c', '丙', 1921),
  ];
  buildTimeline(candidates, container, () => {});
  const scrollWrap = container.children.find(c => c.className === 'timeline-scroll');
  const svg = scrollWrap.children[0];
  const arrows = svg.querySelectorAll('.timeline-arrow');
  assertEqual(arrows.length, 3, '箭頭數量應該等於候選圖層數');
});

test('不管實際年份差多少，相鄰箭頭的間距都一樣（等間距排列，不是按真實時間比例）', () => {
  const container = document.createElement('div');
  // 故意讓年份間隔差很多：1897→1904(7年) vs 1944→1989(45年)，
  // 如果是等間距排列，畫面上這兩段間距應該相等
  const candidates = [1897, 1904, 1944, 1989].map((y, i) => makeCandidate('id' + i, 't' + i, y));
  buildTimeline(candidates, container, () => {});
  const scrollWrap = container.children.find(c => c.className === 'timeline-scroll');
  const svg = scrollWrap.children[0];
  const xs = svg.querySelectorAll('.timeline-arrow').map(a => parseFloat(a.attrs.cx || a.attrs.points.split(' ')[0].split(',')[0]));
  // 箭頭是 polygon，用 points 屬性取第一個點的 x 座標當作參考位置
  const arrows = svg.querySelectorAll('.timeline-arrow');
  const firstX = arrows.map(a => parseFloat(a.attrs.points.split(' ')[0].split(',')[0]));
  const gaps = [];
  for(let i = 1; i < firstX.length; i++) gaps.push(firstX[i] - firstX[i - 1]);
  const allEqual = gaps.every(g => Math.abs(g - gaps[0]) < 0.5);
  assertTrue(allEqual, `間距應該全部相等，實際: ${gaps.join(', ')}`);
});

test('點擊某個箭頭，前面的箭頭變 passed、自己變 active', () => {
  const fired = [];
  const container = document.createElement('div');
  const candidates = [1897, 1904, 1944].map((y, i) => makeCandidate('id' + i, 't' + i, y));
  buildTimeline(candidates, container, (s, l) => fired.push(l.id));
  const scrollWrap = container.children.find(c => c.className === 'timeline-scroll');
  const svg = scrollWrap.children[0];
  const arrows = svg.querySelectorAll('.timeline-arrow');
  arrows[1]._listeners['click'][0]();
  assertEqual(fired[0], 'id1', '應該觸發第二筆的選取');
  assertTrue(arrows[0].classList.contains('passed'), '第一個箭頭應該是 passed');
  assertTrue(arrows[1].classList.contains('active'), '第二個箭頭應該是 active');
  assertTrue(!arrows[2].classList.contains('passed') && !arrows[2].classList.contains('active'), '第三個箭頭應該維持預設狀態');
});

test('自動播放會依序觸發每一筆，播完自動停止', async () => {
  const fired = [];
  const container = document.createElement('div');
  const candidates = [1897, 1904, 1944].map((y, i) => makeCandidate('id' + i, 't' + i, y));
  buildTimeline(candidates, container, (s, l) => fired.push(l.id));
  const controls = container.children.find(c => c.className === 'timeline-controls');
  const playBtn = controls.children[0];
  playBtn._listeners['click'][0]();
  assertEqual(fired.length, 1, '按下播放應該立即觸發第一筆');
  await sleep(2000);
  assertEqual(fired.length, 2, '等待一輪應該推進到第二筆');
  await sleep(2000);
  assertEqual(fired.length, 3, '應該播完全部 3 筆');
  assertEqual(playBtn.textContent, '▶ 播放', '播完應該自動變回「播放」文字');
});

test('沒有年份資料的圖層，收在「年代不明」清單，不會出現在時間軸上', () => {
  const container = document.createElement('div');
  const candidates = [
    { src: { id: 'sinica', name: 'x' }, layer: { id: 'a', title: '有年份', year: '1950', yearNum: 1950 } },
    { src: { id: 'sinica', name: 'x' }, layer: { id: 'b', title: '沒年份', year: '—', yearNum: null } },
  ];
  buildTimeline(candidates, container, () => {});
  const undatedWrap = container.children.find(c => c.className === 'timeline-undated');
  assertTrue(!!undatedWrap, '應該有年代不明區塊');
  assertEqual(undatedWrap.children[1].children.length, 1, '年代不明清單應該有 1 筆');
});

await run();
