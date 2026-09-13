/* ---------------------------------------------------------
   vite.config.js — 建置設定
   ---------------------------------------------------------
   publicDir 維持預設的 public/（放 sw.js、manifest.webmanifest），
   但既有程式碼（src/data.js 等）是用 fetch('./data/xxx.json') 讀取
   專案根目錄的 data/，而 Vite 只能設定「一個」publicDir，兩邊會衝突。
   所以這裡用一個極簡的自製 plugin（不額外裝套件）：
     - dev：middleware 直接把 /data/* 對應到 data/ 目錄底下的檔案。
     - build：complete bundle 後把整個 data/ 目錄複製進 files/data/。
   這樣原本 data/layers.bundle.json、data/layers/*.json 等 fetch
   路徑完全不用改。
--------------------------------------------------------- */
import { defineConfig } from 'vite';
import { existsSync, statSync, createReadStream, cpSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, 'data');

const MIME_TYPES = {
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
};

function serveDataDir(){
  return {
    name: 'serve-data-dir',
    configureServer(server){
      server.middlewares.use((req, res, next) => {
        if(!req.url?.startsWith('/data/')) return next();
        const relPath = decodeURIComponent(req.url.split('?')[0]).replace(/^\/data\//, '');
        const filePath = path.join(dataDir, relPath);
        if(!filePath.startsWith(dataDir) || !existsSync(filePath) || !statSync(filePath).isFile()){
          return next();
        }
        const ext = path.extname(filePath);
        res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
        createReadStream(filePath).pipe(res);
      });
    },
    closeBundle(){
      if(existsSync(dataDir)){
        cpSync(dataDir, path.join(__dirname, 'files', 'data'), { recursive: true });
      }
    }
  };
}

export default defineConfig({
  plugins: [serveDataDir()],
  base: './',
  build: {
    // GitHub Pages（qwq6666666/map repo）用「Deploy from a branch：main /
    // 根目錄」，實際發布的網址是 .../map/files/，所以建置輸出直接指到
    // files/，本機建置完成、commit 這個資料夾就是完整部署流程，不用再
    // 手動複製貼上到另一個 repo。
    outDir: 'files',
    sourcemap: true,
    emptyOutDir: true,
    // src/main.js 用頂層 await（見該檔案註解），預設 esbuild target 不含
    // 支援頂層 await 的 ES2022，明確指定才能建置成功。
    target: 'es2022'
  }
});
