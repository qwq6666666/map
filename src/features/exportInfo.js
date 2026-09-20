/* ---------------------------------------------------------
   features/exportInfo.js — 截圖底部「出處資訊列」
   ---------------------------------------------------------
   給報告／簡報用的地圖截圖（drawTool.js 的 exportImage()）在地圖畫面
   下方多接一條資訊列，寫明「這張圖是什麼、從哪來」，避免圖被轉貼之後
   沒人找得到出處：目前的歷史圖層（年代＋名稱＋透明度）、圖資來源、
   正在顯示的地名今昔對照卡摘要、匯出時間與網站網址。
   兩層拆開：
     - collectExportInfo()：純函式，只讀 store／資料表，回傳要寫的文字
       （不碰 canvas，單元測試直接呼叫）。
     - layoutInfoBand()：只依 canvas 2D context 量測文字、算出高度並
       回傳畫圖函式；不碰 DOM、不認得地圖。
   資訊列接在地圖下方（不是蓋在地圖上），不會遮到圖資內容。
--------------------------------------------------------- */
import { resolveOverlayKey, titleForKey, attributionForKey } from '../data.js';
import { sourceTypeLabel } from './placeNames.js';

const INK = '#17211D';
const PAPER = '#EAE3D3';
const BRASS = '#A8813C';
const MUTED = '#4A544F'; // 對 PAPER 約 6:1，次要文字也維持可讀
const FONT_FAMILY = "'Public Sans', 'Noto Sans TC', 'Microsoft JhengHei', -apple-system, sans-serif";

const MAX_MULTI_LAYERS_LISTED = 5;
const PLACE_DESCRIPTION_MAX_CHARS = 120;

const STYLES = {
  layer: { size: 13, weight: 700, color: INK },
  source: { size: 11, weight: 400, color: MUTED },
  placeHeading: { size: 13, weight: 700, color: INK },
  place: { size: 12, weight: 400, color: INK },
  footer: { size: 10, weight: 400, color: MUTED }
};

function pad2(n){ return String(n).padStart(2, '0'); }

export function formatExportTimestamp(d){
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// key -> 顯示文字。歷史圖層用「年代／日期標籤＋名稱」；底圖、自訂圖層走
// titleForKey()（這些沒有年代）。
function describeKey(key){
  const resolved = resolveOverlayKey(key);
  if(resolved){
    const { src, layer } = resolved;
    const when = layer.dateLabel || layer.year || '';
    return { label: [when, layer.title].filter(Boolean).join(' '), sourceName: src.name || '' };
  }
  return { label: titleForKey(key), sourceName: '' };
}

function opacitySuffix(opacity){
  return Number.isFinite(opacity) && opacity < 100 ? `（透明度 ${Math.round(opacity)}%）` : '';
}

function truncate(text, maxChars){
  const chars = Array.from(text);
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : text;
}

function buildPlaceLines(place){
  if(!place || !place.name) return [];
  const lines = [{ text: `地名：${place.name}`, style: 'placeHeading', maxLines: 1 }];
  if(place.aliases && place.aliases.length > 0){
    lines.push({ text: `別名／舊稱：${place.aliases.join('、')}`, style: 'place', maxLines: 2 });
  }
  const where = `${place.county || ''}${place.town || ''}`;
  if(where) lines.push({ text: `現代位置：${where}`, style: 'place', maxLines: 1 });
  if(place.description){
    lines.push({ text: truncate(place.description, PLACE_DESCRIPTION_MAX_CHARS), style: 'place', maxLines: 3 });
  }
  const typeLabel = sourceTypeLabel(place.sourceType);
  lines.push({
    text: `地名資料：臺灣地區地名資料${typeLabel ? `（${typeLabel}類）` : ''}`,
    style: 'source',
    maxLines: 1
  });
  return lines;
}

/**
 * 依目前模式與狀態，整理出資訊列要寫的文字。
 * @param {object} args
 * @param {object} args.store     全域 store（讀 mode／baseLayer／activeOverlayKey／compareA／compareB／multiOverlayLayers／overlayOpacity）
 * @param {object|null} [args.place] 目前顯示中的地名卡（沒有就 null）
 * @param {Date} [args.now]
 * @param {string} [args.pageUrl] 網站網址（空字串就不寫）
 * @returns {{ layerLines: {text:string,style:string,maxLines:number}[], sourceText: string, placeLines: object[], footerText: string }}
 */
export function collectExportInfo({ store, place = null, now = new Date(), pageUrl = '' }){
  const baseKey = store.baseLayer === 'sat' ? 'base:sat' : 'base:osm';
  const layerLines = [];
  const shownKeys = [];
  const addLayerLine = (text) => layerLines.push({ text, style: 'layer', maxLines: 2 });

  if(store.mode === 'compare'){
    addLayerLine(`左側：${describeKey(store.compareA).label}`);
    addLayerLine(`右側：${describeKey(store.compareB).label}`);
    shownKeys.push(store.compareA, store.compareB);
  } else if(store.mode === 'multi'){
    const layers = store.multiOverlayLayers || [];
    layers.slice(0, MAX_MULTI_LAYERS_LISTED).forEach((entry) => {
      addLayerLine(`疊加圖層：${describeKey(entry.key).label}${opacitySuffix(entry.opacity)}`);
    });
    if(layers.length > MAX_MULTI_LAYERS_LISTED){
      addLayerLine(`…另有 ${layers.length - MAX_MULTI_LAYERS_LISTED} 張疊加圖層`);
    }
    addLayerLine(`底圖：${describeKey(baseKey).label}`);
    shownKeys.push(...layers.map(l => l.key), baseKey);
  } else {
    if(store.activeOverlayKey){
      addLayerLine(`歷史圖層：${describeKey(store.activeOverlayKey).label}${opacitySuffix(store.overlayOpacity)}`);
      shownKeys.push(store.activeOverlayKey);
    }
    addLayerLine(`底圖：${describeKey(baseKey).label}`);
    shownKeys.push(baseKey);
  }

  const sources = [];
  shownKeys.forEach((key) => {
    const text = attributionForKey(key) || describeKey(key).sourceName;
    if(text && !sources.includes(text)) sources.push(text);
  });

  const footerParts = [`匯出時間 ${formatExportTimestamp(now)}`];
  if(pageUrl) footerParts.push(`百年歷史地圖 ${pageUrl}`);

  return {
    layerLines,
    sourceText: sources.length > 0 ? `圖資來源：${sources.join('；')}` : '',
    placeLines: buildPlaceLines(place),
    footerText: footerParts.join('　｜　')
  };
}

/**
 * Canvas 不會自動換行：依字元寬度折行，超過 maxLines 時最後一行以「…」結尾。
 * 不用斷詞，中文逐字折行就夠了；英文單字可能被折斷，這裡可以接受。
 */
export function wrapTextLines(ctx, text, maxWidth, maxLines){
  const lines = [];
  let line = '';
  const chars = Array.from(String(text || ''));
  for(let i = 0; i < chars.length; i++){
    const candidate = line + chars[i];
    if(line && ctx.measureText(candidate).width > maxWidth){
      lines.push(line);
      if(lines.length === maxLines){
        // 已經放滿又還有剩字：最後一行改成「…」結尾（先留出省略號的寬度）。
        let last = lines[maxLines - 1];
        while(last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
        lines[maxLines - 1] = `${last}…`;
        return lines;
      }
      line = chars[i];
    } else {
      line = candidate;
    }
  }
  if(line) lines.push(line);
  return lines;
}

const fontOf = (style, scale) => `${style.weight} ${style.size * scale}px ${FONT_FAMILY}`;
const LINE_HEIGHT = 1.55;

/**
 * 量測並排版資訊列。ctx 只拿來量文字寬度（用暫時的 canvas 即可，不必是
 * 最終輸出的那張），回傳 { height, draw(ctx, top) }：呼叫端先用 height
 * 決定輸出 canvas 要多高，再用 draw() 把資訊列畫在 top 這個 y 座標起的
 * 區域。
 * @param {CanvasRenderingContext2D} ctx
 * @param {ReturnType<typeof collectExportInfo>} info
 * @param {number} width 輸出圖片寬度（實際像素）
 * @param {number} scale devicePixelRatio，所有尺寸都乘上它
 */
export function layoutInfoBand(ctx, info, width, scale = 1){
  const padX = 16 * scale;
  const padY = 12 * scale;
  const groupGap = 8 * scale;
  const maxWidth = width - padX * 2;

  const groups = [];
  const addGroup = (items) => {
    const rows = [];
    items.forEach((item) => {
      const style = STYLES[item.style];
      ctx.font = fontOf(style, scale);
      rows.push({ style, lines: wrapTextLines(ctx, item.text, maxWidth, item.maxLines) });
    });
    if(rows.length > 0) groups.push(rows);
  };

  addGroup(info.layerLines);
  if(info.sourceText) addGroup([{ text: info.sourceText, style: 'source', maxLines: 3 }]);
  addGroup(info.placeLines);
  addGroup([{ text: info.footerText, style: 'footer', maxLines: 2 }]);

  let height = padY * 2 + 2 * scale; // 上下內距 ＋ 頂端銅色細線
  groups.forEach((rows, gi) => {
    if(gi > 0) height += groupGap;
    rows.forEach(row => { height += row.lines.length * row.style.size * scale * LINE_HEIGHT; });
  });

  const draw = (target, top) => {
    target.save();
    target.fillStyle = PAPER;
    target.fillRect(0, top, width, height);
    target.fillStyle = BRASS;
    target.fillRect(0, top, width, 2 * scale);
    target.textAlign = 'left';
    target.textBaseline = 'alphabetic';
    let y = top + 2 * scale + padY;
    groups.forEach((rows, gi) => {
      if(gi > 0) y += groupGap;
      rows.forEach((row) => {
        target.font = fontOf(row.style, scale);
        target.fillStyle = row.style.color;
        row.lines.forEach((text) => {
          target.fillText(text, padX, y + row.style.size * scale * 1.1);
          y += row.style.size * scale * LINE_HEIGHT;
        });
      });
    });
    target.restore();
  };

  return { height, draw };
}
