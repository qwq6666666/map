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
