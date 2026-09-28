import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import spotCheckTiles from '../../tools/spot-check-tiles.js';

const { collectJobs } = spotCheckTiles;

function readLayersJson(name){
  return JSON.parse(readFileSync(path.join(process.cwd(), 'data/layers', name), 'utf-8'));
}

/* ---------------------------------------------------------
   tests/specs/spot-check-tiles.test.mjs
   ---------------------------------------------------------
   tools/spot-check-tiles.js 是每季手動跑的 udd／nlsc 抽測工具，原本零
   測試覆蓋。比照其他 tools/ 腳本的模式：只測 collectJobs()（URL 樣板
   填值，不含網路請求），直接對真的 data/layers/udd.json、nlsc.json
   操作——這支工具的核心風險就是「座標填錯位置」，捏造假資料測不出
   真樣板格式有沒有問題。main()（含 fetch）不在這裡測，只用
   `require.main === module` 確保 import 這支模組不會誤觸發。
--------------------------------------------------------- */

describe('collectJobs', () => {
  test('每個 job 的網址都已經把 {z}/{x}/{y} 換成真的數字，沒有殘留占位字串', () => {
    const jobs = collectJobs(15, 12345, 6789);
    expect(jobs.length).toBeGreaterThan(0);
    for(const job of jobs){
      expect(job.url, `${job.src}/${job.id} 的網址不該還有占位字串`).not.toMatch(/\{[zxy]\}/);
      expect(job.url).toContain('15');
    }
  });

  test('只收 udd 與 nlsc 兩種來源，且每筆都有 src／id／url 三個欄位', () => {
    const jobs = collectJobs(15, 0, 0);
    const sources = new Set(jobs.map(j => j.src));
    expect(sources).toEqual(new Set(['udd', 'nlsc']));
    for(const job of jobs){
      expect(typeof job.src).toBe('string');
      expect(typeof job.id).toBe('string');
      expect(typeof job.url).toBe('string');
    }
  });

  test('不同的 z/x/y 會換算出不同的網址（確認真的有把座標填進去，不是回傳固定樣板）', () => {
    const jobsA = collectJobs(15, 100, 200);
    const jobsB = collectJobs(16, 300, 400);
    expect(jobsA[0].url).not.toBe(jobsB[0].url);
  });

  test('udd 來源只收有 url 屬性的圖層（見腳本裡 `if(l.url) jobs.push(...)` 的防呆）', () => {
    const uddData = readLayersJson('udd.json');
    let uddLayerCountWithUrl = 0;
    for(const cat of uddData.categories) for(const l of cat.layers || []) if(l.url) uddLayerCountWithUrl++;
    const jobs = collectJobs(15, 0, 0).filter(j => j.src === 'udd');
    expect(jobs.length).toBe(uddLayerCountWithUrl);
  });

  test('nlsc 來源的圖層數量跟 data/layers/nlsc.json 的實際圖層數一致', () => {
    const nlscData = readLayersJson('nlsc.json');
    let nlscLayerCount = 0;
    for(const cat of nlscData.categories) nlscLayerCount += (cat.layers || []).length;
    const jobs = collectJobs(15, 0, 0).filter(j => j.src === 'nlsc');
    expect(jobs.length).toBe(nlscLayerCount);
  });
});
