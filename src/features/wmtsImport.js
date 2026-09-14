/* ---------------------------------------------------------
   features/wmtsImport.js — 從 WMTS 服務的 GetCapabilities 匯入圖層
   ---------------------------------------------------------
   跟「手動貼單一網址樣板」（見 features/multiOverlay.js 的
   custom-source-form）是兩條平行的新增路徑，這支模組負責的是：
     1. fetchCapabilities(url)：抓 GetCapabilities XML，用 OL 內建的
        ol.format.WMTSCapabilities 解析成 JS 物件。同一個網址在短時間內
        重複用到（使用者勾選好幾張圖層一次匯入）不會重複抓取——單一
        slot 快取有 CAPABILITIES_CACHE_TTL_MS（5 分鐘）存活期限，超過
        就視為過期重新抓取，避免遠端服務內容已更新卻一直讀到舊快取；
        使用者按「讀取」按鈕本身就是既有的手動重新整理入口。
     2. listLayers(capabilities)：把解析結果整理成 UI 要顯示的
        { identifier, title, abstract } 陣列。
     3. buildWmtsEntryConfig(capabilities, identifier)：這是最關鍵的
        一步——用 ol.source.WMTS.optionsFromCapabilities() 算出這張
        圖層在「地圖預設投影 EPSG:3857」底下能用的完整設定（會自動找
        跟 3857 相容的 TileMatrixSet；找不到就回傳 null，代表這張圖層
        沒有 Web Mercator 可用，沒辦法疊在這個地圖上），然後把裡面的
        ol.tilegrid.WMTS 物件「拆開」成純資料（resolutions／matrixIds／
        origin…），因為 store.customSources 要能存進 localStorage
        （JSON），沒辦法直接塞一個 OL 物件實例進去。
        這樣设計的好處：往後每次要建立這張圖層（data.js 的
        makeWmtsSourceFromEntry()）都是純資料組裝，不需要也不依賴
        使用者匯入當下那個 GetCapabilities 網址之後還連得到、還能
        再抓一次——服務商改版、網址失效都不影響已經匯入的圖層。

   已知限制（跟使用者說明時要提到）：
     - 只取 tileGrid 在第一個縮放層級的 origin／tileSize，假設所有
       層級共用同一組（絕大多數用 GoogleMapsCompatible 這類標準
       TileMatrixSet 的服務都是如此，但技術上 WMTS 規格允許每層不同，
       真的遇到這種服務，圖磚位置可能會跑掉）。
     - 不處理 Dimensions（例如時間序列圖層需要額外指定 TIME 參數的
       服務），這類圖層會被匯入但很可能載入不出圖磚。
     - GetCapabilities 是用 fetch() 讀文字內容，瀏覽器一定會做 CORS
       檢查，該服務不開放就沒辦法繞過——這點跟圖磚顯示不一樣（圖磚
       走 <img>，不受 CORS 影響，見 data.js 的說明）。如果部署時設定
       了 CAPABILITIES_PROXY_URL（見下方常數），直接 fetch 失敗時會
       自動改用代理伺服器再試一次，使用者不需要知道背後發生了什麼；
       沒設定的話就維持原本行為，直接顯示錯誤，請使用者改用「手動貼
       網址」分頁。代理伺服器本身見 tools/cors-proxy-worker/worker.js。
--------------------------------------------------------- */

// 自己部署過 tools/cors-proxy-worker/ 這支 Cloudflare Worker 的話，
// 把拿到的網址填在這裡（例如
// 'https://hundred-year-map-proxy.your-name.workers.dev'）。留空字串
// 就是不使用代理，遇到沒開 CORS 的服務會直接失敗（原本的行為）。
const CAPABILITIES_PROXY_URL = 'https://hundred-year-map.q032180396.workers.dev';

let lastCapabilitiesUrl = null;
let lastCapabilitiesObj = null;
let lastCapabilitiesFetchedAt = 0;

// 單一 slot 快取原本永不過期，同一網址在同一頁面 session 中重複讀取
// 一律吃快取，即使遠端服務內容已更新也讀不到最新結果。加上簡單的存活
// 時間：超過這個時間視為過期，下次呼叫 fetchCapabilities() 會重新抓取。
// 使用者按下「讀取」按鈕（見 multiOverlay.js 的 handleFetchWmtsCapabilities()）
// 本身就是既有的手動「重新整理」入口，這裡只是讓那個按鈕在快取過期後
// 真的會發出新的請求，不需要額外在畫面上多加一顆按鈕。
const CAPABILITIES_CACHE_TTL_MS = 5 * 60 * 1000; // 5 分鐘

// 透過代理伺服器讀取目標網址的文字內容。代理本身的錯誤訊息（JSON
// 格式的 { error } ）會被原樣帶出來，讓使用者看得懂到底是「代理連不
// 到目標」還是別的問題。
async function fetchTextViaProxy(targetUrl){
  const proxyRequestUrl = `${CAPABILITIES_PROXY_URL}?url=${encodeURIComponent(targetUrl)}`;
  const res = await fetch(proxyRequestUrl);
  if(!res.ok){
    let message = `代理伺服器回應錯誤（HTTP ${res.status}）`;
    try{
      const errBody = await res.json();
      if(errBody?.error) message = errBody.error;
    }catch(err){ /* 代理沒有回傳 JSON 錯誤內容時，就用上面的預設訊息 */ }
    throw new Error(message);
  }
  return res.text();
}

export async function fetchCapabilities(url){
  const trimmed = (url || '').trim();
  if(!trimmed) throw new Error('請輸入 WMTS 服務的 GetCapabilities 網址');
  const cacheIsFresh = (Date.now() - lastCapabilitiesFetchedAt) < CAPABILITIES_CACHE_TTL_MS;
  if(trimmed === lastCapabilitiesUrl && lastCapabilitiesObj && cacheIsFresh) return lastCapabilitiesObj;

  let text;
  try{
    // 先直接 fetch：如果目標服務本來就開放 CORS，這樣最快，也不用
    // 依賴任何代理伺服器。
    const res = await fetch(trimmed);
    if(!res.ok) throw new Error(`伺服器回應錯誤（HTTP ${res.status}），請確認網址是否正確`);
    text = await res.text();
  }catch(directErr){
    // 保留原始錯誤到 console 方便除錯（例如實際是 CORS 還是網路中斷），
    // 但不直接把 directErr.message 丟給使用者——瀏覽器對 CORS 擋下的
    // fetch 錯誤訊息通常很技術性、對一般使用者沒有意義，下面統一改成
    // 講人話的錯誤訊息。
    console.warn('直接讀取 WMTS Capabilities 失敗：', directErr);
    if(!CAPABILITIES_PROXY_URL){
      // 沒有設定代理：最常見原因是該服務沒有開放 CORS，瀏覽器直接
      // 擋下，看不到真正的 HTTP 狀態碼。純前端沒有後端可以代為轉發，
      // 遇到這種情況沒有辦法繞過——請使用者改用「手動貼網址」分頁
      // （圖磚本身用 <img> 載入，不受 CORS 影響，見 data.js 的說明）。
      throw new Error('無法讀取這個網址（可能是網路問題，或該服務沒有開放跨網域讀取 CORS，前端沒有辦法繞過這個限制）。如果你已經知道這個服務的圖磚網址規則，可以改用「手動貼網址」分頁直接加入。');
    }
    // 有設定代理：直接 fetch 失敗（十之八九是 CORS）時，自動改用代理
    // 伺服器再試一次，使用者不需要知道背後發生了什麼。
    try{
      text = await fetchTextViaProxy(trimmed);
    }catch(proxyErr){
      throw new Error(`直接讀取失敗，透過代理伺服器讀取也失敗：${proxyErr.message}`);
    }
  }

  const parser = new ol.format.WMTSCapabilities();
  let capabilities;
  try{
    capabilities = parser.read(text);
  }catch(err){
    // 解析失敗（XML 格式不對、不是 WMTS Capabilities 等）在這裡不特別處理，
    // 直接讓 capabilities 維持 null，交給緊接在下面的 if 檢查統一轉成
    // 使用者看得懂的錯誤訊息（「讀不到任何圖層…」），不需要重複的錯誤處理。
    capabilities = null;
  }
  if(!capabilities?.Contents || !Array.isArray(capabilities.Contents.Layer) || capabilities.Contents.Layer.length === 0){
    throw new Error('讀不到任何圖層，請確認這是正確的 WMTS GetCapabilities XML 網址');
  }

  lastCapabilitiesUrl = trimmed;
  lastCapabilitiesObj = capabilities;
  lastCapabilitiesFetchedAt = Date.now();
  return capabilities;
}

// 整理成 UI 清單要用的簡化格式，標題找不到就退回用 identifier 顯示。
export function listLayers(capabilities){
  return capabilities.Contents.Layer.map(l => ({
    identifier: l.Identifier,
    title: l.Title || l.Identifier,
    abstract: l.Abstract || ''
  }));
}

// 回傳 null 代表這張圖層找不到跟地圖預設投影（EPSG:3857）相容的
// TileMatrixSet，呼叫端要把它當成「不支援、略過」處理，不是程式錯誤。
export function buildWmtsEntryConfig(capabilities, identifier){
  let options;
  try{
    options = ol.source.WMTS.optionsFromCapabilities(capabilities, { layer: identifier });
  }catch(err){
    return null;
  }
  if(!options?.tileGrid) return null;

  const tileGrid = options.tileGrid;
  return {
    urls: options.urls,
    layer: options.layer,
    matrixSet: options.matrixSet,
    format: options.format,
    projection: (typeof options.projection?.getCode === 'function')
      ? options.projection.getCode() : 'EPSG:3857',
    requestEncoding: options.requestEncoding,
    style: options.style,
    origin: tileGrid.getOrigin(0),
    resolutions: tileGrid.getResolutions(),
    matrixIds: tileGrid.getMatrixIds(),
    tileSize: (typeof tileGrid.getTileSize === 'function') ? tileGrid.getTileSize(0) : 256,
    extent: (typeof tileGrid.getExtent === 'function') ? tileGrid.getExtent() : undefined
  };
}

// 幫 UI 清單裡的每張圖層先標示是否跟地圖預設投影（EPSG:3857）相容，純
// 函式（不碰 DOM）。給 multiOverlay.js 的 renderWmtsLayerList() 在使用者
// 勾選前就先用disabled／灰階呈現結果，避免「勾了 5 張、加入後才發現只有
// 3 張成功」——buildWmtsEntryConfig() 本來就是無副作用的判斷，這裡只是
// 把它套用到整批圖層並附加 compatible 欄位，方便呼叫端直接用。
export function annotateLayersWithCompatibility(capabilities, layers){
  return layers.map(l => ({
    ...l,
    compatible: !!buildWmtsEntryConfig(capabilities, l.identifier)
  }));
}
