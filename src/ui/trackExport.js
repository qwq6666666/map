/* ---------------------------------------------------------
   ui/trackExport.js — 把一條軌跡存成檔案（GPX／GeoJSON）
   ---------------------------------------------------------
   手機（<=768px）優先叫出系統分享面板（iOS 下載檔案很不順）；分享成功或使用者
   自己取消就結束，環境不支援／被擋（'unsupported'／'blocked'／'failed'）才退回
   直接下載。桌面一律直接下載。至少要有兩個點才有東西可匯出。
--------------------------------------------------------- */
import { trackToGpx, trackToGeoJSON, trackFileStamp, trackPointCount } from '../features/trackMath.js';
import { shareFileNative } from '../features/nativeShare.js';
import { showLocateToast } from '../features/location.js';
import { downloadBlob } from '../drawTool.js';

const FORMATS = {
  gpx: { ext: 'gpx', type: 'application/gpx+xml', build: (t) => trackToGpx(t) },
  geojson: { ext: 'geojson', type: 'application/geo+json', build: (t) => JSON.stringify(trackToGeoJSON(t)) }
};

export async function exportTrackFile(track, format){
  const spec = FORMATS[format];
  if(!track || !spec || trackPointCount(track) < 2){
    showLocateToast('這條軌跡不到兩個點，沒有東西可以匯出');
    return;
  }
  const filename = `軌跡_${trackFileStamp(track.startedAt)}.${spec.ext}`;
  const text = spec.build(track);

  if(globalThis.matchMedia?.('(max-width: 768px)')?.matches && typeof File !== 'undefined'){
    const result = await shareFileNative(new File([text], filename, { type: spec.type }), { title: track.name });
    if(result === 'shared' || result === 'cancelled') return;
  }
  downloadBlob(new Blob([text], { type: spec.type }), filename);
  showLocateToast(`已下載 ${filename}`);
}
