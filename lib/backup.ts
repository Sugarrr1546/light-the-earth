import JSZip from 'jszip';
import {readBounded} from './archive';
import type { Visit, Photo } from './model';
import { parseBackup, stringifyBackup, BACKUP_JSON_LIMIT, BACKUP_RECORD_LIMIT, BACKUP_ARCHIVE_LIMIT } from './collections';
import { api, ApiError, privateFetch } from './client-api';
import {privateSessionLease,verifyPrivateSession} from './private-session';
import { validateImage } from './validation';

export async function exportBackup(visits: Visit[], onProgress: (s: string) => void) {
  const lease=privateSessionLease();
  if (visits.length > BACKUP_RECORD_LIMIT) throw new Error('记录过多，请按年份分别导出备份');
  const zip = new JSZip();
  const photos = new Map<string,string>();
  const records = [];
  let total = 0;
  for (let i = 0; i < visits.length; i++) {
    lease.assert();onProgress(`正在打包回忆 ${i + 1} / ${visits.length}`);
    const v = visits[i];
    const savedPhotos = [];
    for (const p of v.photos) {
      let path = photos.get(p.id);
      if (!path) {
        const response = await privateFetch(p.url);lease.assert();
        if (!response.ok) throw new Error('有照片无法读取，备份尚未完成，请重试');
        const blob = await response.blob();lease.assert(); total += blob.size;
        if (total > BACKUP_ARCHIVE_LIMIT) throw new Error('本次照片超过 200 MB，请按年份分别导出');
        const ext = blob.type.includes('png') ? 'png' : blob.type.includes('webp') ? 'webp' : 'jpg';
        path = `photos/${p.id}.${ext}`;
        zip.file(path, blob); photos.set(p.id, path);
      }
      savedPhotos.push({id:p.id, filename:p.filename, archivePath:path});
    }
    records.push({...v, photos:savedPhotos});
  }
  zip.file('atlas.json', stringifyBackup({version:1,exportedAt:new Date().toISOString(),visits:records}));
  zip.file('说明.txt','点亮地球备份\n照片位于 photos 文件夹；全部旅行记录位于 atlas.json。\n可在点亮地球的“导入备份”中恢复。\n');
  const blob = await zip.generateAsync({type:'blob',compression:'STORE'});
  if(!await verifyPrivateSession())throw new Error('无法确认登录状态，备份未下载，请重试。');
  lease.assert();if (blob.size > BACKUP_ARCHIVE_LIMIT) throw new Error('备份超过 200 MB，请按年份分别导出');
  const url = URL.createObjectURL(blob);
  lease.assert();const link = document.createElement('a'); link.href = url; link.download = `点亮地球-${new Date().toISOString().slice(0,10)}.zip`; link.click();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
}

export async function importBackup(file: File, existing: Visit[], onProgress: (s: string) => void): Promise<number> {
  const lease=privateSessionLease();
  if (file.size > BACKUP_ARCHIVE_LIMIT) throw new Error('请导入小于 200 MB 的备份');
  const zip = await JSZip.loadAsync(file);lease.assert();
  const jsonFile = zip.file('atlas.json');
  if (!jsonFile) throw new Error('这个文件不是点亮地球备份');
  const json = new TextDecoder().decode(await readBounded(jsonFile,BACKUP_JSON_LIMIT));
  lease.assert();const backup = parseBackup(JSON.parse(json));
  const known = new Set(existing.map(v=>v.id));
  const pending = backup.visits.filter(v=>!known.has(v.id));
  // Validate all referenced files before the first write. Existing records stay untouched.
  for (const v of pending) for (const p of v.photos) if (!zip.file(p.archivePath)) throw new Error(`备份中缺少照片：${p.filename}`);
  let photoBytes=0;
  const verifiedPhotos=new Set<string>();
  for(const v of pending) for(const p of v.photos) {
    if(verifiedPhotos.has(p.archivePath))continue;
    const bytes=await readBounded(zip.file(p.archivePath)!,4*1024*1024);lease.assert();
    const declared=p.archivePath.endsWith('.png')?'image/png':p.archivePath.endsWith('.webp')?'image/webp':'image/jpeg';
    validateImage(bytes,declared);
    photoBytes+=bytes.byteLength;
    if(photoBytes>BACKUP_ARCHIVE_LIMIT)throw new Error('备份照片总量超过 200 MB');
    verifiedPhotos.add(p.archivePath);
  }
  const importedPhotos = new Map<string,Photo>();
  const attachedPhotos = new Set<string>();
  let count = 0;
  try {
    for (const v of pending) {
      lease.assert();onProgress(`正在恢复 ${count + 1} / ${pending.length}`);
      const photos = [];
      for (const p of v.photos) {
        let uploaded = importedPhotos.get(p.archivePath);
        if (!uploaded) {
          const blob = await zip.file(p.archivePath)!.async('blob');lease.assert();
          if (blob.size > 4 * 1024 * 1024) throw new Error('备份包含过大的照片');
          const form = new FormData();
          const type = p.archivePath.endsWith('.png') ? 'image/png' : p.archivePath.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
          form.set('file',new File([blob],p.filename,{type}));
          uploaded = (await api<{photo:Photo}>('/api/photos',{method:'POST',body:form})).photo;
          importedPhotos.set(p.archivePath,uploaded);
        }
        lease.assert();photos.push(uploaded);
      }
      lease.assert();try { await api('/api/visits',{method:'POST',body:JSON.stringify({...v,photos})}); }
      catch(error){
        if(error instanceof ApiError && error.status===409 && error.code==='VISIT_ALREADY_EXISTS') continue;
        throw error;
      }
      lease.assert();photos.forEach(photo=>attachedPhotos.add(photo.id));
      count++;
    }
  } catch (error) {
    throw new Error(`已恢复 ${count} 条，剩余记录未恢复。${error instanceof Error ? error.message : '请重试'}；再次导入会跳过已恢复记录。`);
  } finally {
    // Only this invocation's new uploads are eligible. DELETE atomically refuses
    // removal if another request attached one in the meantime.
    for (const photo of importedPhotos.values()) if (!attachedPhotos.has(photo.id)) {
      try { lease.assert();await api(`/api/photos/${encodeURIComponent(photo.id)}`,{method:'DELETE'}); }
      catch { /* A referenced photo or transient cleanup failure must not hide restore errors. */ }
    }
  }
  return count;
}
