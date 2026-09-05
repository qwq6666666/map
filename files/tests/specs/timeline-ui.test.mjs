import '../env-stub.mjs';
import { test, run, assertEqual, assertTrue, sleep } from '../assert.mjs';
import { buildTimeline } from '../../src/timelineUI.js';

function makeCandidate(id, title, year){
  return { src: { id: 'sinica', name: '台灣百年歷史地圖' }, layer: { id, title, year: String(year), yearNum: year } };
}

test('依年份排序後，畫出跟資料筆數一樣多的刻度點', () => {
  const container = document.createElement('div');
  const candidates = [
    makeCandidate('a', '甲', 1950),
    makeCandidate('b', '乙', 1897),
    makeCandidate('c', '丙', 1921),
  ];
  buildTimeline(candidates, container, () => {});
  const dots = container.querySelectorAll('.timeline-dot');
  assertEqual(dots.length, 3, '刻度點數量應該等於候選圖層數');
});

test('刻度點在 DOM 中依年份由小到大排序（不是按真實時間比例定位）', () => {
  const container = document.createElement('div');
  // 故意讓年份間隔差很多：1897→1904(7年) vs 1944→1989(45年)，
  // 新版是等間距的 flex 圓點列，沒有座標可驗證間距，改驗證排序順序正確。
  const candidates = [1989, 1897, 1944, 1904].map((y, i) => makeCandidate('id' + i, 't' + i, y));
  buildTimeline(candidates, container, () => {});
  const labels = container.querySelectorAll('.timeline-dot-label').map(el => parseInt(el.textContent, 10));
  assertEqual(labels.join(','), '1897,1904,1944,1989', '刻度點應該依年份由小到大排列');
});

test('點擊某個刻度點，前面的變 passed、自己變 active', () => {
  const fired = [];
  const container = document.createElement('div');
  const candidates = [1897, 1904, 1944].map((y, i) => makeCandidate('id' + i, 't' + i, y));
  buildTimeline(candidates, container, (s, l) => fired.push(l.id));
  const dots = container.querySelectorAll('.timeline-dot');
  dots[1]._listeners['click'][0]();
  assertEqual(fired[0], 'id1', '應該觸發第二筆的選取');
  assertTrue(dots[0].classList.contains('passed'), '第一個刻度點應該是 passed');
  assertTrue(dots[1].classList.contains('active'), '第二個刻度點應該是 active');
  assertTrue(!dots[2].classList.contains('passed') && !dots[2].classList.contains('active'), '第三個刻度點應該維持預設狀態');
});

test('點擊年份文字（timeline-dot-label）效果跟點刻度點一樣', () => {
  const fired = [];
  const container = document.createElement('div');
  const candidates = [1897, 1904, 1944].map((y, i) => makeCandidate('id' + i, 't' + i, y));
  buildTimeline(candidates, container, (s, l) => fired.push(l.id));
  const dots = container.querySelectorAll('.timeline-dot');
  const labels = container.querySelectorAll('.timeline-dot-label');
  labels[2]._listeners['click'][0]();
  assertEqual(fired[0], 'id2', '點年份文字應該觸發對應那一筆的選取');
  assertTrue(dots[0].classList.contains('passed'), '第一個刻度點應該是 passed');
  assertTrue(dots[1].classList.contains('passed'), '第二個刻度點應該是 passed');
  assertTrue(dots[2].classList.contains('active'), '第三個刻度點應該是 active');
});

test('自動播放會依序觸發每一筆，播完自動停止', async () => {
  const fired = [];
  const container = document.createElement('div');
  const candidates = [1897, 1904, 1944].map((y, i) => makeCandidate('id' + i, 't' + i, y));
  buildTimeline(candidates, container, (s, l) => fired.push(l.id));
  const sliderRow = container.children.find(c => c.className === 'timeline-slider-row');
  const playBtn = sliderRow.children[0];
  playBtn._listeners['click'][0]();
  assertEqual(fired.length, 1, '按下播放應該立即觸發第一筆');
  await sleep(2000);
  assertEqual(fired.length, 2, '等待一輪應該推進到第二筆');
  await sleep(2000);
  assertEqual(fired.length, 3, '應該播完全部 3 筆');
  assertEqual(playBtn.textContent, '▶ 播放', '播完應該自動變回「播放」文字');
});

test('加速播放按鈕會依 1x→2x→4x→1x 循環切換', () => {
  const container = document.createElement('div');
  const candidates = [1897, 1904, 1944].map((y, i) => makeCandidate('id' + i, 't' + i, y));
  buildTimeline(candidates, container, () => {});
  const sliderRow = container.children.find(c => c.className === 'timeline-slider-row');
  const speedBtn = sliderRow.children[2];
  assertEqual(speedBtn.textContent, '1x', '初始應該是 1x');
  speedBtn._listeners['click'][0]();
  assertEqual(speedBtn.textContent, '2x', '點一次應該變 2x');
  speedBtn._listeners['click'][0]();
  assertEqual(speedBtn.textContent, '4x', '點兩次應該變 4x');
  speedBtn._listeners['click'][0]();
  assertEqual(speedBtn.textContent, '1x', '點三次應該循環回 1x');
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
