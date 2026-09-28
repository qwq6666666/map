import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import spotCheckTiles from '../../tools/spot-check-tiles.js';

const { collectJobs } = spotCheckTiles;
const require = createRequire(import.meta.url);
const { forEachLayer } = require('../../tools/lib/layerWalk.js');

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
    forEachLayer(uddData, (l) => { if(l.url) uddLayerCountWithUrl++; });
    const jobs = collectJobs(15, 0, 0).filter(j => j.src === 'udd');
    expect(jobs.length).toBe(uddLayerCountWithUrl);
  });

  test('nlsc 來源的圖層數量跟 data/layers/nlsc.json 的實際圖層數一致（含 groups 底下的分組圖層）', () => {
    const nlscData = readLayersJson('nlsc.json');
    let nlscLayerCount = 0;
    forEachLayer(nlscData, () => { nlscLayerCount++; });
    const jobs = collectJobs(15, 0, 0).filter(j => j.src === 'nlsc');
    expect(jobs.length).toBe(nlscLayerCount);
  });

  test('nlsc 的 groups 底下的分組圖層（歷年地形圖／正射影像等）也會被收進 job 清單，不是只有沒有 groups 的分類', () => {
    const nlscData = readLayersJson('nlsc.json');
    // nlsc.json 目前絕大多數圖層都藏在 category.groups[].layers 裡（例如歷年
    // 地形圖、正射影像），只走訪 category.layers 會漏掉這些——曾經真的漏過。
    const groupedIds = new Set();
    for(const cat of nlscData.categories){
      if(!cat.groups) continue;
      for(const g of cat.groups) for(const l of g.layers) groupedIds.add(l.id);
    }
    expect(groupedIds.size).toBeGreaterThan(0);
    const jobIds = new Set(collectJobs(15, 0, 0).filter(j => j.src === 'nlsc').map(j => j.id));
    for(const id of groupedIds){
      expect(jobIds.has(id), `分組圖層 ${id} 應該出現在抽測清單裡`).toBe(true);
    }
  });
});
