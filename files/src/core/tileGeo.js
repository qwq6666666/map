/* ---------------------------------------------------------
   core/tileGeo.js — 經緯度／Slippy Map 圖磚座標互轉的共用工具
   ---------------------------------------------------------
   原本 lonLatToTileXY() 在 features/search.js 跟 timelineMode.js
   裡各自維護一份（避免這兩個彼此無關的功能模組互相 import）。
   現在因為要新增「鄰近圖磚探測」，兩邊都需要同一套鄰近圖磚計算
   邏輯，與其再複製一次，改成從這支中立的 core 模組共用匯入——
   兩邊都是「由上往下」依賴 core，不會產生 search.js 跟
   timelineMode.js 互相依賴的循環問題。
--------------------------------------------------------- */

// 將經緯度換算成標準 Web Mercator（EPSG:3857）Slippy Map 圖磚座標
export function lonLatToTileXY(lon, lat, z){
  const n = Math.pow(2, z);
  const x = Math.floor((lon + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return {
    x: Math.max(0, Math.min(n - 1, x)),
    y: Math.max(0, Math.min(n - 1, y)),
    z
  };
}

/**
 * 給定一顆圖磚，算出它周圍最多 8 顆鄰近圖磚（3x3 範圍扣掉自己）。
 *
 * 用途：老地圖的實際掃描／涵蓋範圍常常不是整齊的矩形，圖幅邊界、
 * 拼接處的空白 margin 很容易剛好落在「地圖中心點所在的那一顆圖磚」
 * 裡；隔壁圖磚其實是有資料的。單點探測（只測中心點那一顆）在這種
 * 邊界情形下很容易誤判成「沒資料」。當中心點探測沒有資料時，
 * 改測這 8 顆鄰近圖磚，只要其中一顆有資料，就代表這個位置附近其實
 * 是有涵蓋的，不應該被算作「找不到」。
 *
 * 在世界地圖邊緣（x/y 超出 0 ~ 2^z-1 範圍）會被夾回合法範圍，並自動
 * 排除掉「夾回後其實跟中心點同一顆」或彼此重複的圖磚。
 */
export function neighborTiles(tile){
  const { x, y, z } = tile;
  const n = Math.pow(2, z);
  const seen = new Set();
  const result = [];
  for(let dy = -1; dy <= 1; dy++){
    for(let dx = -1; dx <= 1; dx++){
      if(dx === 0 && dy === 0) continue; // 自己（中心點那一顆）不算鄰近圖磚
      const nx = Math.max(0, Math.min(n - 1, x + dx));
      const ny = Math.max(0, Math.min(n - 1, y + dy));
      if(nx === x && ny === y) continue; // 邊界夾回後跟中心點重疊，跳過
      const key = `${nx}/${ny}`;
      if(seen.has(key)) continue; // 邊界夾回後跟另一顆鄰近圖磚重疊，跳過
      seen.add(key);
      result.push({ x: nx, y: ny, z });
    }
  }
  return result;
}

/**
 * 判斷一個 WGS84 經緯度點是否落在給定的 bbox 範圍內。
 *
 * 用途：WMTS 圖層空間索引化——先用圖層的 WGS84 bbox 做本地空間篩選，
 * 篩掉明顯不涵蓋查詢點的候選圖層，再只對少量候選圖層做真正的
 * tile file-exists 探測，減少不必要的 HTTP probe。
 *
 * 防呆規則（重要）：bbox 缺失（null/undefined）、不是陣列、長度不是
 * 4、或裡面任何一個值不是有限數字，一律直接回傳 true——代表「沒有
 * 可靠的索引資料時，不可以把這個候選排除掉」，寧可多檢查也不能漏判，
 * 退回原本「可能有資料就檢查」的行為。
 *
 * @param {number} lon 經度（十進位度）
 * @param {number} lat 緯度（十進位度）
 * @param {[number, number, number, number]} bbox [minLon, minLat, maxLon, maxLat]，EPSG:4326
 * @returns {boolean} 點是否落在 bbox 範圍內（邊界視為在範圍內）；bbox 格式不合法時一律回傳 true
 */
export function pointInBbox(lon, lat, bbox){
  if(!Array.isArray(bbox) || bbox.length !== 4) return true;
  const [minLon, minLat, maxLon, maxLat] = bbox;
  if(![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return true;
  return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
}

/* ---------------------------------------------------------
   toTWD97() — WGS84 經緯度 → TWD97 二分帶橫麥卡托投影座標
   （EPSG:3826）正算轉換。

   採用 GRS80 橢球體，搭配 Snyder 橫麥卡托正算公式（含子午線弧長
   高階級數展開 + 高階修正項），精度可達公分等級，供游標座標顯示
   等需要準確平面座標的功能使用。
--------------------------------------------------------- */
const TWD97_A = 6378137; // GRS80 長半軸
const TWD97_F = 1 / 298.257222101; // GRS80 扁率
const TWD97_LON0 = 121 * Math.PI / 180; // 中央經線 121°E
const TWD97_K0 = 0.9999; // 尺度比率
const TWD97_FALSE_EASTING = 250000;
const TWD97_FALSE_NORTHING = 0;

/**
 * 將 WGS84 經緯度（十進位度）轉換為 TWD97 二分帶（EPSG:3826）平面座標。
 * @param {number} lat 緯度（十進位度）
 * @param {number} lng 經度（十進位度）
 * @returns {{x:number, y:number}} x 為 Easting（已含 False Easting），y 為 Northing
 */
export function toTWD97(lat, lng){
  const a = TWD97_A;
  const f = TWD97_F;
  const e2 = f * (2 - f); // 第一離心率平方
  const ep2 = e2 / (1 - e2); // 第二離心率平方

  const phi = lat * Math.PI / 180;
  const lambda = lng * Math.PI / 180;

  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const tanPhi = Math.tan(phi);

  // 子午線弧長 M（原點緯度 0°，故不需扣除 M0）
  const M = a * (
    (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 * e2 * e2 / 256) * phi
    - (3 * e2 / 8 + 3 * e2 * e2 / 32 + 45 * e2 * e2 * e2 / 1024) * Math.sin(2 * phi)
    + (15 * e2 * e2 / 256 + 45 * e2 * e2 * e2 / 1024) * Math.sin(4 * phi)
    - (35 * e2 * e2 * e2 / 3072) * Math.sin(6 * phi)
  );

  const N = a / Math.sqrt(1 - e2 * sinPhi * sinPhi);
  const T = tanPhi * tanPhi;
  const C = ep2 * cosPhi * cosPhi;
  const A = (lambda - TWD97_LON0) * cosPhi;

  const x = TWD97_K0 * N * (
    A
    + (1 - T + C) * Math.pow(A, 3) / 6
    + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * Math.pow(A, 5) / 120
  );

  const y = TWD97_K0 * (
    M
    + N * tanPhi * (
      Math.pow(A, 2) / 2
      + (5 - T + 9 * C + 4 * C * C) * Math.pow(A, 4) / 24
      + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * Math.pow(A, 6) / 720
    )
  );

  return {
    x: Math.round(x + TWD97_FALSE_EASTING),
    y: Math.round(y + TWD97_FALSE_NORTHING)
  };
}

/**
 * 將 WGS84 經緯度格式化為易讀字串，緯度在前、經度在後，
 * 皆保留四位小數，並依正負號附加半球後綴（N/S、E/W）。
 * @param {number} lat 緯度（十進位度）
 * @param {number} lng 經度（十進位度）
 * @returns {string} 例如 "25.0418°N, 121.5132°E"
 */
export function formatWGS84(lat, lng){
  const latSuffix = lat < 0 ? 'S' : 'N';
  const lngSuffix = lng < 0 ? 'W' : 'E';
  const latStr = Math.abs(lat).toFixed(4);
  const lngStr = Math.abs(lng).toFixed(4);
  return `${latStr}°${latSuffix}, ${lngStr}°${lngSuffix}`;
}

/**
 * 將 TWD97 平面座標格式化為易讀字串（整數、千分位逗號）。
 * @param {number} x Easting
 * @param {number} y Northing
 * @returns {string} 例如 "X: 302,145, Y: 2,770,182"
 */
export function formatTWD97(x, y){
  const xStr = Math.round(x).toLocaleString('en-US');
  const yStr = Math.round(y).toLocaleString('en-US');
  return `X: ${xStr}, Y: ${yStr}`;
}
