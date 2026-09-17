/**
 * cors-proxy-worker.js — 給「百年歷史疊圖器」用的 WMTS GetCapabilities
 * CORS 代理，部署在 Cloudflare Workers。
 *
 * 只在使用者按「讀取圖層清單」（features/wmtsImport.js 的
 * fetchCapabilities()）、且該服務沒有開放 CORS 時才會被打到一次，
 * 不會用在圖磚顯示上——地圖平移／縮放的圖磚請求是瀏覽器直接對目標
 * WMTS 服務發的，完全不經過這支 Worker（見 DEVELOPMENT.md 的說明）。
 * 以這個用途來說用量非常低，Cloudflare Workers 的免費額度通常綽綽
 * 有餘（實際免費額度／定價請以 Cloudflare 官網當下公告為準，這裡
 * 不保證數字不會變動）。
 *
 * ---------------------------------------------------------
 * 部署方式（擇一）
 * ---------------------------------------------------------
 *   A. Cloudflare Dashboard（不需要安裝任何工具）：
 *      1. 登入 https://dash.cloudflare.com → Workers & Pages → Create
 *         → Create Worker，取一個名稱（例如 hundred-year-map-proxy）。
 *      2. 進編輯器，把這份檔案的內容整個貼進去覆蓋預設內容，存檔並
 *         部署（Deploy）。
 *      3. 部署完成後會拿到一個網址，格式類似
 *         https://hundred-year-map-proxy.<你的帳號>.workers.dev。
 *
 *   B. wrangler CLI（習慣命令列的話）：
 *      1. `npx wrangler login`
 *      2. 在這個資料夾（tools/cors-proxy-worker/）執行：
 *         `npx wrangler deploy worker.js --name hundred-year-map-proxy`
 *
 * 部署完成後，把拿到的網址填進
 * src/features/wmtsImport.js 最上面的 CAPABILITIES_PROXY_URL 常數。
 * 不填的話，這個功能形同沒有代理——遇到沒開 CORS 的服務會直接顯示
 * 錯誤，請使用者改用「手動貼網址」分頁（原本的行為，不會壞掉）。
 *
 * ---------------------------------------------------------
 * 用法
 * ---------------------------------------------------------
 *   GET <這支 Worker 的網址>?url=<目標 GetCapabilities 網址（要 URL 編碼）>
 *
 * ---------------------------------------------------------
 * 部署自己的正式站台時記得做的事
 * ---------------------------------------------------------
 *   把下面的 ALLOWED_ORIGIN 從 '*' 改成你實際的網站網域（例如
 *   'https://your-username.github.io'），避免任何網站都能免費借用你
 *   這支 Worker 的額度發送請求。開發／本機測試階段留 '*' 比較方便。
 */

const ALLOWED_ORIGIN = 'https://qwq6666666.github.io';

// 目標網址的回應快取多久（秒）。GetCapabilities 內容不常變動，快取
// 久一點可以大幅降低對目標服務、也降低這支 Worker 本身的用量。
const CACHE_TTL_SECONDS = 600;

function corsHeaders(){
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function jsonError(message, status){
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

// 粗略擋掉常見的內網／保留位址，避免這支 Worker 被拿來當作探測內網
// 的跳板（SSRF）。這是字串層級的檢查，不是完整解析 DNS 後比對真實
// IP，防禦力有限，但足以擋掉隨手亂打的請求；這支 Worker 的設計用途
// 本來就只是讀公開的 WMTS GetCapabilities，不是通用代理。
//
// 已知仍未涵蓋、之後如果這支 Worker 被賦予更敏感的用途才需要處理的
// 繞過手法：
//   - IPv6 的其他等價寫法（例如 IPv4-mapped 位址 [::ffff:127.0.0.1]、
//     壓縮寫法的各種變化）沒有逐一列舉比對，只擋了最常見的 `::1`。
//   - 八進位表示法（例如 0177.0.0.1）目前沒有涵蓋。
//   - DNS rebinding：這裡只檢查 URL 裡的 hostname 字串本身，`fetch()`
//     實際連線時的 DNS 解析結果可能跟這裡檢查當下不同（先解析到公開
//     IP 通過檢查，實際連線時 DNS 已經改指向內網位址），字串層級的
//     檢查天生擋不住這種攻擊。
function isBlockedHost(hostname){
  const h = hostname.toLowerCase();
  if(h === 'localhost' || h === '0.0.0.0' || h === '::1') return true;
  if(h.startsWith('127.')) return true;
  if(h.startsWith('10.')) return true;
  if(h.startsWith('192.168.')) return true;
  if(/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  if(h.startsWith('169.254.')) return true;
  // 數字型 IP（純十進位整數，或 0x 開頭十六進位）一律擋掉：合法的
  // WMTS GetCapabilities 主機名稱不會是純數字或十六進位字串，但部分
  // URL parser／HTTP client 會把這類字串解析成 IP（例如整數
  // 2130706433 等價於 127.0.0.1、0x7f000001 等價於 127.0.0.1），可以
  // 繞過上面逐段字串比對的私有位址檢查。
  if(/^0x[0-9a-f]+$/.test(h)) return true;
  if(/^\d+$/.test(h)) return true;
  return false;
}

async function handleRequest(request, ctx){
  if(request.method === 'OPTIONS'){
    return new Response(null, { headers: corsHeaders() });
  }
  if(request.method !== 'GET'){
    return jsonError('只支援 GET', 405);
  }

  const requestUrl = new URL(request.url);
  const target = requestUrl.searchParams.get('url');
  if(!target) return jsonError('缺少 url 參數', 400);

  let targetUrl;
  try{
    targetUrl = new URL(target);
  }catch(err){
    return jsonError('url 參數不是合法的網址', 400);
  }
  if(targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:'){
    return jsonError('只允許 http/https 網址', 400);
  }
  if(isBlockedHost(targetUrl.hostname)){
    return jsonError('不允許存取這個主機', 400);
  }

  // Cloudflare 的邊緣快取：同一個目標網址在 CACHE_TTL_SECONDS 內重複
  // 被請求，直接回快取內容，不會再打一次目標服務，也不會再消耗這支
  // Worker 的執行次數。
  const cache = caches.default;
  const cacheKey = new Request(requestUrl.toString(), request);
  const cached = await cache.match(cacheKey);
  if(cached) return cached;

  let upstream;
  try{
    upstream = await fetch(targetUrl.toString(), {
      headers: { 'User-Agent': 'hundred-year-map-cors-proxy/1.0' }
    });
  }catch(err){
    return jsonError('連線目標網址失敗', 502);
  }
  if(!upstream.ok){
    return jsonError(`目標伺服器回應錯誤（HTTP ${upstream.status}）`, 502);
  }

  const body = await upstream.text();
  const response = new Response(body, {
    status: 200,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') || 'text/xml; charset=utf-8',
      'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
      ...corsHeaders()
    }
  });

  // 用 ctx.waitUntil() 讓 Cloudflare Workers 保證執行環境會等這個
  // Promise resolve 才真正結束；原本 fire-and-forget 的寫法在回應已經
  // 送出給使用者後，Worker 執行環境可能被提前終止，cache.put() 還沒
  // 真的寫入邊緣快取就被中斷，導致 CACHE_TTL_SECONDS 這個 600 秒防
  // 重複打源站的機制隨機性失效。
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

export default {
  async fetch(request, env, ctx){
    return handleRequest(request, ctx);
  }
};
