import '../env-stub.mjs';
import { test, expect } from 'vitest';
import { sleep } from '../assert.mjs';
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
  expect(dots.length, '刻度點數量應該等於候選圖層數').toBe(3);
});

test('刻度點在 DOM 中依年份由小到大排序（不是按真實時間比例定位）', () => {
  const container = document.createElement('div');
  // 故意讓年份間隔差很多：1897→1904(7年) vs 1944→1989(45年)，
  // 新版是等間距的 flex 圓點列，沒有座標可驗證間距，改驗證排序順序正確。
  const candidates = [1989, 1897, 1944, 1904].map((y, i) => makeCandidate('id' + i, 't' + i, y));
  buildTimeline(candidates, container, () => {});
  const labels = container.querySelectorAll('.timeline-dot-label').map(el => parseInt(el.textContent, 10));
  expect(labels.join(','), '刻度點應該依年份由小到大排列').toBe('1897,1904,1944,1989');
});

test('點擊某個刻度點，前面的變 passed、自己變 active', () => {
  const fired = [];
  const container = document.createElement('div');
  const candidates = [1897, 1904, 1944].map((y, i) => makeCandidate('id' + i, 't' + i, y));
  buildTimeline(candidates, container, (s, l) => fired.push(l.id));
  const dots = container.querySelectorAll('.timeline-dot');
  dots[1]._listeners['click'][0]();
  expect(fired[0], '應該觸發第二筆的選取').toBe('id1');
  expect(dots[0].classList.contains('passed'), '第一個刻度點應該是 passed').toBeTruthy();
  expect(dots[1].classList.contains('active'), '第二個刻度點應該是 active').toBeTruthy();
  expect(!dots[2].classList.contains('passed') && !dots[2].classList.contains('active'), '第三個刻度點應該維持預設狀態').toBeTruthy();
});

test('點擊年份文字（timeline-dot-label）效果跟點刻度點一樣', () => {
  const fired = [];
  const container = document.createElement('div');
  const candidates = [1897, 1904, 1944].map((y, i) => makeCandidate('id' + i, 't' + i, y));
  buildTimeline(candidates, container, (s, l) => fired.push(l.id));
  const dots = container.querySelectorAll('.timeline-dot');
  const labels = container.querySelectorAll('.timeline-dot-label');
  labels[2]._listeners['click'][0]();
  expect(fired[0], '點年份文字應該觸發對應那一筆的選取').toBe('id2');
  expect(dots[0].classList.contains('passed'), '第一個刻度點應該是 passed').toBeTruthy();
  expect(dots[1].classList.contains('passed'), '第二個刻度點應該是 passed').toBeTruthy();
  expect(dots[2].classList.contains('active'), '第三個刻度點應該是 active').toBeTruthy();
});

test('自動播放會依序觸發每一筆，播完自動停止', async () => {
  const fired = [];
  const container = document.createElement('div');
  const candidates = [1897, 1904, 1944].map((y, i) => makeCandidate('id' + i, 't' + i, y));
  buildTimeline(candidates, container, (s, l) => fired.push(l.id));
  const timelineRow = container.children.find(c => c.className === 'timeline-row');
  const playBtn = timelineRow.children[0];
  playBtn._listeners['click'][0]();
  expect(fired.length, '按下播放應該立即觸發第一筆').toBe(1);
  await sleep(2000);
  expect(fired.length, '等待一輪應該推進到第二筆').toBe(2);
  await sleep(2000);
  expect(fired.length, '應該播完全部 3 筆').toBe(3);
  // 播放/暫停鈕改成 <svg><use href="...#play/#pause">（見 timelineUI.js 的
  // setPlayBtnIcon()），不再是文字字元；env-stub 的 innerHTML setter 不會
  // 真的解析出子節點，改直接比對存進去的 markup 字串裡有沒有指到 #play。
  expect(playBtn.innerHTML.includes('#play'), '播完應該自動變回「播放」圖示').toBeTruthy();
});

test('加速播放按鈕會依 1x→2x→4x→0.5x→1x 循環切換（跟自訂時間軸共用同一組級距）', () => {
  const container = document.createElement('div');
  const candidates = [1897, 1904, 1944].map((y, i) => makeCandidate('id' + i, 't' + i, y));
  buildTimeline(candidates, container, () => {});
  const timelineRow = container.children.find(c => c.className === 'timeline-row');
  const speedBtn = timelineRow.children[2];
  expect(speedBtn.textContent, '初始應該是 1x').toBe('1x');
  speedBtn._listeners['click'][0]();
  expect(speedBtn.textContent, '點一次應該變 2x').toBe('2x');
  speedBtn._listeners['click'][0]();
  expect(speedBtn.textContent, '點兩次應該變 4x').toBe('4x');
  speedBtn._listeners['click'][0]();
  expect(speedBtn.textContent, '點三次應該變 0.5x（新增的減速選項，不再誤標成加速）').toBe('0.5x');
  speedBtn._listeners['click'][0]();
  expect(speedBtn.textContent, '點四次應該循環回 1x').toBe('1x');
});

test('自動播放中若被重新呼叫 buildTimeline()（比照 timelineMode.js 的 refreshNow() 在地圖移動時重建時間軸），舊一輪的 playTimer 不應該在之後還觸發舊的 onSelect（回歸：兩輪呼叫共用模組層級計時器變數，見 timelineUI.js 檔頭說明）', async () => {
  const firedA = [];
  const firedB = [];
  const containerA = document.createElement('div');
  const candidatesA = [1897, 1904, 1944].map((y, i) => makeCandidate('a' + i, 'tA' + i, y));
  buildTimeline(candidatesA, containerA, (s, l) => firedA.push(l.id));

  const timelineRowA = containerA.children.find(c => c.className === 'timeline-row');
  const playBtnA = timelineRowA.children[0];
  playBtnA._listeners['click'][0](); // 立即觸發第一筆，並排定 ~1800ms 後的下一步

  // 還沒等到 A 的下一步計時器到期，模擬地圖移動觸發重新整理：對另一個
  // container 重新呼叫 buildTimeline()。
  const containerB = document.createElement('div');
  const candidatesB = [1950, 1960].map((y, i) => makeCandidate('b' + i, 'tB' + i, y));
  buildTimeline(candidatesB, containerB, (s, l) => firedB.push(l.id));

  expect(firedA.length, 'A 應該只有開始播放當下立即觸發的那一筆').toBe(1);

  await sleep(2000); // 超過 PLAY_INTERVAL_MS，若舊計時器沒被清掉，這裡 firedA 會多出一筆
  expect(firedA.length, 'A 的自動播放計時器應該已經被下一輪 buildTimeline() 清掉，不會再觸發').toBe(1);
  expect(firedB.length, 'B 沒有按播放，不應該自己觸發任何一筆').toBe(0);
});

test('沒有年份資料的圖層，收在「年代不明」清單，不會出現在時間軸上', () => {
  const container = document.createElement('div');
  const candidates = [
    { src: { id: 'sinica', name: 'x' }, layer: { id: 'a', title: '有年份', year: '1950', yearNum: 1950 } },
    { src: { id: 'sinica', name: 'x' }, layer: { id: 'b', title: '沒年份', year: '—', yearNum: null } },
  ];
  buildTimeline(candidates, container, () => {});
  const undatedWrap = container.children.find(c => c.className === 'timeline-undated');
  expect(!!undatedWrap, '應該有年代不明區塊').toBeTruthy();
  expect(undatedWrap.children[1].children.length, '年代不明清單應該有 1 筆').toBe(1);
});
