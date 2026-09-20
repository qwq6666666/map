/* ---------------------------------------------------------
   features/trackStore.js — 軌跡的本機儲存（IndexedDB）
   ---------------------------------------------------------
   為什麼不用 localStorage（features/storage.js 存繪圖用的那個）：走幾小時
   會累積上萬個點，localStorage 約 5MB 上限、又是同步寫入會卡畫面。
   IndexedDB 不可用時（無痕模式、部分 WebView、測試環境）退回記憶體
   Map——這次的記錄與匯出仍然能用，只是重新整理後不會留下來。
   每個函式都吞掉例外、永遠回傳可用的值：儲存失敗不能讓記錄本身中斷。
--------------------------------------------------------- */

const DB_NAME = 'hundredYearMap';
const DB_VERSION = 1;
const STORE = 'tracks';

let dbPromise = null;
const memory = new Map(); // IndexedDB 不可用時的替身，測試也靠它

function openDb(){
  if(dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try{
      if(typeof indexedDB === 'undefined'){ resolve(null); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    }catch{
      resolve(null);
    }
  });
  return dbPromise;
}

function request(db, mode, fn){
  return new Promise((resolve) => {
    try{
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => resolve(undefined);
      tx.onabort = () => resolve(undefined);
    }catch{
      resolve(undefined);
    }
  });
}

// 存入前複製一份：記錄器之後還會繼續改同一個物件，記憶體替身不能存到參照。
const clone = (track) => JSON.parse(JSON.stringify(track));

export async function saveTrack(track){
  const db = await openDb();
  if(!db){ memory.set(track.id, clone(track)); return true; }
  const done = await request(db, 'readwrite', (store) => store.put(clone(track)));
  return done !== undefined;
}

export async function loadTrack(id){
  const db = await openDb();
  if(!db) return memory.has(id) ? clone(memory.get(id)) : null;
  return (await request(db, 'readonly', (store) => store.get(id))) ?? null;
}

export async function listTracks(){
  const db = await openDb();
  const all = db ? ((await request(db, 'readonly', (store) => store.getAll())) ?? []) : [...memory.values()].map(clone);
  return all.sort((a, b) => b.startedAt - a.startedAt); // 新的在前
}

export async function loadLatestTrack(){
  return (await listTracks())[0] ?? null;
}

export async function deleteTrack(id){
  const db = await openDb();
  if(!db){ memory.delete(id); return; }
  await request(db, 'readwrite', (store) => store.delete(id));
}

// 測試用：清掉記憶體替身並重置連線。
export function _resetTrackStoreForTests(){
  memory.clear();
  dbPromise = null;
}
