/* ---------------------------------------------------------
   tests/env-stub.mjs — 假瀏覽器／OpenLayers 環境
   ---------------------------------------------------------
   給 tests/ 底下所有測試共用的假環境：模擬 document／window／ol
   全域物件，讓 src/ 底下的程式碼可以在 Node.js（沒有真的瀏覽器）
   裡執行、驗證邏輯是否正確。

   這不是真的瀏覽器，沒辦法驗證「畫面長什麼樣子」「滑鼠點起來手感
   好不好」這類視覺／體感的東西——這些還是要實際部署後用真的瀏覽器
   確認。這個假環境驗證的是「邏輯有沒有跑對」：資料載入對不對、
   狀態切換對不對、篩選演算法對不對、匯出的檔案內容對不對。

   用法：每個測試檔案最開頭 import 這個檔案一次即可
  （`import '../env-stub.mjs';`），之後再 import 要測試的 src/ 模組。
--------------------------------------------------------- */
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const fs = require('fs');

/* ---------- 假 DOM ---------- */

class FakeClassList {
  constructor(node){ this._node = node; }
  add(c){ this._node._classes.add(c); }
  remove(c){ this._node._classes.delete(c); }
  toggle(c, force){
    if(force === undefined){ this._node._classes.has(c) ? this._node._classes.delete(c) : this._node._classes.add(c); }
    else { force ? this._node._classes.add(c) : this._node._classes.delete(c); }
  }
  contains(c){ return this._node._classes.has(c); }
}

export class FakeNode {
  constructor(tag){
    this.tag = tag;
    this.children = [];
    this.parentElement = null;
    this.attrs = {};
    this.dataset = {};
    this._classes = new Set();
    this._listeners = {};
    this.textContent = '';
    this.value = '100';
    this.style = {};
  }
  get classList(){ return new FakeClassList(this); }
  set className(v){ this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className(){ return [...this._classes].join(' '); }
  setAttribute(k, v){ this.attrs[k] = String(v); if(k === 'class') this.className = v; }
  getAttribute(k){ return this.attrs[k]; }
  removeAttribute(k){ delete this.attrs[k]; }
  appendChild(c){ this.children.push(c); c.parentElement = this; return c; }
  insertBefore(c, ref){
    const i = this.children.indexOf(ref);
    this.children.splice(i < 0 ? 0 : i, 0, c);
    c.parentElement = this;
    return c;
  }
  addEventListener(ev, fn){ (this._listeners[ev] = this._listeners[ev] || []).push(fn); }
  removeEventListener(ev, fn){
    const arr = this._listeners[ev] || [];
    const i = arr.indexOf(fn);
    if(i >= 0) arr.splice(i, 1);
  }
  click(){ (this._listeners['click'] || []).forEach(fn => fn({ target: this, preventDefault(){}, stopPropagation(){} })); }
  closest(sel){
    // 只支援這個測試套件實際用得到的兩種：純 class、以及 tag[attr] 形式
    let node = this;
    while(node){
      if(matchesSelector(node, sel)) return node;
      node = node.parentElement;
    }
    return null;
  }
  querySelector(sel){
    const all = this.querySelectorAll(sel);
    return all.length ? all[0] : null;
  }
  querySelectorAll(sel){
    const results = [];
    const self = this;
    (function walk(node){
      if(matchesSelector(node, sel)) results.push(node);
      (node.children || []).forEach(walk);
    })(this);
    return results;
  }
  scrollIntoView(){}
  getBoundingClientRect(){ return { height: 20, width: parseFloat(this.attrs.width || 800), left: 0 }; }
  set innerHTML(v){ this.children = []; this._innerHTML = v; }
  get innerHTML(){ return this._innerHTML || ''; }
}

function matchesSelector(node, sel){
  let rest = sel.trim();
  if(rest.startsWith('.')){
    const m = rest.match(/^\.([a-zA-Z0-9_-]+)/);
    if(!m || !node._classes || !node._classes.has(m[1])) return false;
    rest = rest.slice(m[0].length);
  } else if(/^[a-zA-Z]/.test(rest)){
    const m = rest.match(/^([a-zA-Z0-9-]+)/);
    if(!m || node.tag !== m[1]) return false;
    rest = rest.slice(m[0].length);
  }
  rest = rest.trim();
  if(rest === '') return true;
  const attrMatch = rest.match(/^\[data-([a-zA-Z-]+)="([^"]*)"\]$/);
  if(attrMatch){
    const key = attrMatch[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return node.dataset && node.dataset[key] === attrMatch[2];
  }
  const attrExistsMatch = rest.match(/^\[data-([a-zA-Z-]+)\]$/);
  if(attrExistsMatch){
    const key = attrExistsMatch[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return node.dataset && node.dataset[key] !== undefined;
  }
  return false;
}

const elementCache = {};
function getOrCreate(id){
  if(!elementCache[id]) elementCache[id] = new FakeNode('div');
  return elementCache[id];
}

globalThis.document = {
  getElementById: (id) => getOrCreate(id),
  createElement: (tag) => new FakeNode(tag),
  createElementNS: (ns, tag) => new FakeNode(tag),
  querySelector(sel){ return this.querySelectorAll(sel)[0] || null; },
  querySelectorAll(sel){
    const results = [];
    Object.values(elementCache).forEach(root => {
      results.push(...root.querySelectorAll(sel));
      if(matchesSelector(root, sel)) results.push(root);
    });
    return results;
  },
  documentElement: { style: { setProperty(){} } },
  addEventListener(){},
};

const windowListeners = {};
globalThis.window = {
  addEventListener(ev, fn){ (windowListeners[ev] = windowListeners[ev] || []).push(fn); },
  removeEventListener(ev, fn){
    const arr = windowListeners[ev] || [];
    const i = arr.indexOf(fn);
    if(i >= 0) arr.splice(i, 1);
  },
  _dispatch(ev, e){ (windowListeners[ev] || []).forEach(fn => fn(e)); },
  innerWidth: 1000,
  devicePixelRatio: 1,
};

if(globalThis.navigator){ globalThis.navigator.geolocation = null; }
else { globalThis.navigator = { geolocation: null }; }

globalThis.alert = (msg) => {};
globalThis.confirm = () => true;
globalThis.prompt = () => '';
globalThis.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} };

globalThis.Image = class {
  constructor(){
    setTimeout(() => {
      this.naturalWidth = 10;
      this.naturalHeight = 10;
      if(this.onload) this.onload();
    }, 1);
  }
  set src(v){ this._url = v; }
};

/* ---------- fetch：從本機檔案系統讀 data/*.json ---------- */
globalThis.fetch = async (url) => {
  const p = path.join(process.cwd(), url.replace('./', ''));
  const text = fs.readFileSync(p, 'utf-8');
  return { json: async () => JSON.parse(text) };
};

/* ---------- 假 OpenLayers ---------- */

class FakeTileSource {
  constructor(opts){ this.opts = opts; }
}
class FakeVectorSource {
  constructor(){ this._features = []; }
  addFeature(f){ this._features.push(f); }
  removeFeature(f){ this._features = this._features.filter(x => x !== f); }
  getFeatures(){ return this._features; }
  clear(){ this._features = []; }
}
class FakeTileLayer {
  constructor(opts){ this.opts = opts; this._opacity = (opts && opts.opacity !== undefined) ? opts.opacity : 1; this._visible = !opts || opts.visible !== false; this._zIndex = undefined; }
  setVisible(v){ this._visible = v; }
  getVisible(){ return this._visible; }
  setOpacity(v){ this._opacity = v; }
  getOpacity(){ return this._opacity; }
  setZIndex(z){ this._zIndex = z; }
  getZIndex(){ return this._zIndex; }
  on(){}
}
class FakeVectorLayer {
  constructor(opts){ this.opts = opts; }
}
class FakeDrawInteraction {
  constructor(opts){ this.opts = opts; this._listeners = {}; }
  on(ev, fn){ (this._listeners[ev] = this._listeners[ev] || []).push(fn); }
  simulateDrawEnd(feature){
    if(this.opts && this.opts.source) this.opts.source.addFeature(feature);
    (this._listeners['drawend'] || []).forEach(fn => fn({ feature }));
  }
}
class FakeCollection {
  constructor(){ this._items = []; }
  push(x){ this._items.push(x); }
  forEach(fn){ this._items.forEach(fn); }
  clear(){ this._items = []; }
}
class FakeModifyInteraction { constructor(opts){ this.opts = opts; } }
class FakeSelectInteraction {
  constructor(opts){ this.opts = opts; this._features = new FakeCollection(); }
  getFeatures(){ return this._features; }
}

class FakeMap {
  constructor(opts){
    this.opts = opts;
    this._center = (opts.view && opts.view.opts) ? opts.view.opts.center : [120.9, 23.7];
    this._moveendHandlers = [];
    this._interactions = [];
    this._layers = [];
  }
  getView(){
    const self = this;
    return {
      fit(){}, setCenter(c){ self._center = c; }, setZoom(){}, getZoom(){ return 8; },
      animate(){}, getCenter(){ return self._center; }
    };
  }
  addLayer(l){ this._layers.push(l); }
  removeLayer(l){ this._layers = this._layers.filter(x => x !== l); }
  addInteraction(i){ if(i) this._interactions.push(i); }
  removeInteraction(i){ this._interactions = this._interactions.filter(x => x !== i); }
  addOverlay(){}
  getTargetElement(){ return null; }
  getSize(){ return [800, 600]; }
  getViewport(){ return { querySelectorAll: () => [] }; }
  render(){}
  renderSync(){}
  once(ev, fn){ if(ev === 'rendercomplete') fn(); }
  on(ev, fn){ if(ev === 'moveend') this._moveendHandlers.push(fn); }
  _triggerMoveEnd(){ this._moveendHandlers.forEach(fn => fn()); }
}

globalThis.ol = {
  source: { OSM: class extends FakeTileSource {}, XYZ: FakeTileSource, Vector: FakeVectorSource },
  layer: { Tile: FakeTileLayer, Vector: FakeVectorLayer },
  Map: FakeMap,
  View: class { constructor(opts){ this.opts = opts; } },
  proj: { transformExtent: (ext) => ext, fromLonLat: (c) => c, toLonLat: (c) => c },
  Overlay: class { constructor(opts){ this.opts = opts; } setPosition(){} },
  interaction: { Draw: FakeDrawInteraction, Modify: FakeModifyInteraction, Select: FakeSelectInteraction },
  style: {
    Style: class { constructor(opts){ this.opts = opts; } },
    Circle: class { constructor(opts){ this.opts = opts; } },
    Fill: class { constructor(opts){ this.opts = opts; } },
    Stroke: class { constructor(opts){ this.opts = opts; } },
    Text: class { constructor(opts){ this.opts = opts; } },
  },
  sphere: {
    getLength: (geom) => (geom && geom._length !== undefined) ? geom._length : 0,
    getArea: (geom) => (geom && geom._area !== undefined) ? geom._area : 0,
  },
  format: {
    GeoJSON: class {
      writeFeatures(features, opts){
        return JSON.stringify({
          type: 'FeatureCollection',
          opts,
          features: features.map(f => ({ type: 'Feature', properties: f._props })),
        });
      }
    }
  },
};

// document.createElement('canvas') 補強：drawTool.js 需要 getContext()/toBlob()
const originalCreateElement = globalThis.document.createElement;
globalThis.document.createElement = function(tag){
  const el = originalCreateElement(tag);
  if(tag === 'canvas'){
    el.getContext = () => ({ setTransform(){}, drawImage(){}, globalAlpha: 1 });
    el.toBlob = (cb) => cb({ fake: true, size: el.width * el.height });
  }
  return el;
};

export { elementCache };
