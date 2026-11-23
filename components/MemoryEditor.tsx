'use client';
import {privateSessionLease} from '../lib/private-session';

import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, Camera, Heart, Home, MapPin, Route, Trash2, Upload, X, LoaderCircle } from 'lucide-react';
import type { Coverage, Photo, Region, Visit, VisitStatus } from '../lib/model';
import { STATUS_LABEL } from '../lib/model';
import { api, ApiError, preparePhoto } from '../lib/client-api';

interface Props {
  userId: string;
  region: Region;
  visit: Visit | null;
  visits: Visit[];
  coverage?: Coverage;
  onClose: () => void;
  onNew: () => void;
  onSaved: (v: Visit) => void;
  onDelete: (v: Visit) => void;
  onExplore: () => void;
  onEdit: (v: Visit) => void;
}
const statusIcons = {visited:MapPin,lived:Home,passed:Route,wishlist:Heart};

export default function MemoryEditor({userId,region,visit,visits,coverage,onClose,onNew,onSaved,onDelete,onExplore,onEdit}: Props) {
  const [status,setStatus] = useState<VisitStatus>(visit?.status ?? 'visited');
  const [date,setDate] = useState(visit?.visitedOn ?? '');
  const [title,setTitle] = useState(visit?.title ?? '');
  const [notes,setNotes] = useState(visit?.notes ?? '');
  const [trip,setTrip] = useState(visit?.tripName ?? '');
  const [photos,setPhotos] = useState<Photo[]>(visit?.photos ?? []);
  const [busy,setBusy] = useState(false);
  const [uploading,setUploading] = useState(false);
  const [error,setError] = useState('');
  const [recordId,setRecordId] = useState(visit?.id ?? crypto.randomUUID());
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const draftKey = `atlas-draft:${userId}:${visit?.id ?? region.id}`;
  const [draftReady,setDraftReady] = useState(false);
  const sameVisits = visits.filter(v => v.region.id === region.id);
  const isHistoricalFrance = region.countryCode==='FRA' && region.level==='local' && region.adminLevel!==coverage?.adminLevel;

  useEffect(() => {
    panelRef.current?.focus();
    try {
      const saved = sessionStorage.getItem(draftKey);
      if (saved) {
        const draft = JSON.parse(saved);
        if (typeof draft.notes === 'string') {
          setNotes(draft.notes); setDate(draft.date || ''); setTitle(draft.title || ''); setTrip(draft.trip || '');
          if (['visited','lived','passed','wishlist'].includes(draft.status)) setStatus(draft.status);
          if (Array.isArray(draft.photos) && draft.photos.every((p:Photo)=>p && /^[\w-]+$/.test(p.id) && p.url===`/api/photos/${p.id}`)) setPhotos(draft.photos.slice(0,6));
          if (!visit && typeof draft.recordId==='string' && /^[\w-]{1,100}$/.test(draft.recordId)) setRecordId(draft.recordId);
        }
      }
    } catch { /* Device draft is optional; authoritative record is on the server. */ }
    setDraftReady(true);
    const key = (e: KeyboardEvent) => {if(e.key === 'Escape') onClose();};
    window.addEventListener('keydown',key);
    return () => window.removeEventListener('keydown',key);
  }, [draftKey,onClose]);
  useEffect(() => {
    if (!draftReady) return;
    try { privateSessionLease(userId).assert();sessionStorage.setItem(draftKey,JSON.stringify({notes,date,title,trip,status,photos,recordId})); } catch { /* Saving remains available via server. */ }
  },[notes,date,title,trip,status,photos,recordId,draftKey,draftReady]);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    if (photos.length + files.length > 6) {setError('每段回忆最多添加 6 张照片');return;}
    setUploading(true);setError('');
    try {
      const lease=privateSessionLease(userId);
      for (const file of Array.from(files)) {
        lease.assert();const prepared = await preparePhoto(file);lease.assert();
        const form = new FormData();form.set('file',prepared);
        const result = await api<{photo:Photo}>('/api/photos',{method:'POST',body:form});
        lease.assert();setPhotos(previous=>[...previous,result.photo]);
      }
    } catch(e) {setError(e instanceof Error ? e.message : '照片上传失败');}
    finally {setUploading(false);if(inputRef.current) inputRef.current.value='';}
  }

  async function save(e: React.FormEvent) {
    e.preventDefault(); if (busy || uploading) return;
    setBusy(true);setError('');
    const record = {id:recordId,region:visit?.region??region,status,visitedOn:date.trim(),title:title.trim(),notes:notes.trim(),tripName:trip.trim(),photos};
    try {
      const lease=privateSessionLease(userId);
      let saved:Visit;
      try { saved=(await api<{visit:Visit}>(visit ? `/api/visits/${visit.id}` : '/api/visits',{method:visit ? 'PATCH' : 'POST',body:JSON.stringify(record)})).visit; }
      catch(error) {
        if(!visit && error instanceof ApiError && error.status===409){lease.assert();saved=(await api<{visit:Visit}>(`/api/visits/${recordId}`,{method:'PATCH',body:JSON.stringify(record)})).visit;}
        else throw error;
      }
      lease.assert();try { sessionStorage.removeItem(draftKey); } catch { /* Server success is authoritative. */ }
      onSaved(saved);
    } catch(e) {setError(e instanceof Error ? e.message : '暂时无法保存');}
    finally {setBusy(false);}
  }

  return <aside className="memory-panel" ref={panelRef} tabIndex={-1} aria-label={`${region.name}的旅行记录`}>
    <div className="drawer-heading"><span className="eyebrow">{visit ? 'EDIT A MEMORY' : 'A PLACE IN YOUR WORLD'}</span><button className="icon-button" onClick={onClose} aria-label="关闭地区详情"><X size={18}/></button></div>
    <div className="memory-panel-scroll">
    <div className="place-heading"><span className="place-kind">{region.boundaryStatus==='historical'?'历史版本区域':region.nameStatus==='boundary-undetermined'?'归属未定区域':region.level==='country' ? '国家 / 地区' : region.adminLevel&&coverage?.adminLevel&&region.adminLevel!==coverage.adminLevel?'旧版地方区域':coverage?.label ?? '地方行政区'}</span><h2>{region.name}</h2><p>{[region.parentName,region.countryName].filter((x,i,a)=>x && a.indexOf(x)===i).join(' · ')}</p></div>
    {sameVisits.length>0&&<div className="record-context"><details className="previous-visits" open={!visit}><summary>你在这里的回忆 · {sameVisits.length}</summary>{sameVisits.map(v=><button type="button" key={v.id} onClick={()=>onEdit(v)}><span>{v.title||STATUS_LABEL[v.status]}</span><small>{v.visitedOn||'日期未记'}</small><ArrowUpRight size={14}/></button>)}</details>{visit&&<button type="button" className="text-link record-new" onClick={onNew}>再记一次 <ArrowUpRight size={14}/></button>}</div>}
    {region.nameNote&&<details className="boundary-note name-quality-note" open={region.nameStatus==='unresolved'}><summary>{region.boundaryStatus==='historical'?'历史区划说明':'边界与名称说明'}{region.year?` · ${region.year}`:''}</summary><p>{region.nameNote}{region.nameSourceUrl&&<> <a href={region.nameSourceUrl} target="_blank" rel="noreferrer">核验来源</a></>}</p></details>}
    {region.level==='country' && <div className="country-callout"><p>{coverage ? `可探索 ${(coverage.displayCount??coverage.count).toLocaleString()} 个${coverage.label}。` : '这个地区尚无可用的地方边界，可以先保存国家／地区级回忆。'}</p>{coverage && <button className="text-link" type="button" onClick={onExplore}>探索地方地图 <ArrowUpRight size={15}/></button>}</div>}
    <form id="memory-record-form" onSubmit={save}><fieldset disabled={busy} className="editor-fields">
      <div className="status-options" aria-label="记录状态">{(['visited','lived','passed','wishlist'] as VisitStatus[]).map(s=>{const Icon=statusIcons[s];return <button type="button" key={s} className={status===s ? 'active' : ''} onClick={()=>setStatus(s)} aria-pressed={status===s}><Icon size={15}/>{STATUS_LABEL[s]}</button>;})}</div>
      <div className="field-row"><label>时间 <span>可留空</span><input name="visitedOn" value={date} onChange={e=>setDate(e.target.value)} maxLength={80} placeholder="2024-05-01，或某年夏天"/></label></div>
      <label className="field">给这段回忆起个名字<input name="title" value={title} onChange={e=>setTitle(e.target.value)} maxLength={120} placeholder={status==='wishlist' ? '为什么想去这里？' : '那一天，值得记住的事'}/></label>
      <label className="field">属于哪次旅行 <span>可选</span><input name="tripName" value={trip} onChange={e=>setTrip(e.target.value)} maxLength={120} placeholder="例如：毕业后的第一场旅行" list="trip-names"/><datalist id="trip-names">{[...new Set(visits.map(v=>v.tripName).filter(Boolean))].map(t=><option key={t} value={t}/>)}</datalist></label>
      <label className="field">留下一点回忆<textarea name="notes" value={notes} onChange={e=>setNotes(e.target.value)} maxLength={10000} rows={3} placeholder="遇见的人、走过的路，或当时的心情……"/></label>
      <div className="photo-label"><span>照片 <small>{photos.length} / 6</small></span><span>保存适合浏览的清晰副本</span></div>
      <div className="photo-strip">{photos.map(p=><div className="photo-thumb" key={p.id}><img src={p.url} alt={p.filename}/><button type="button" aria-label={`移除照片 ${p.filename}`} onClick={()=>setPhotos(photos.filter(x=>x.id!==p.id))}><X size={12}/></button></div>)}{photos.length<6 && <button type="button" className="photo-upload" onClick={()=>inputRef.current?.click()} disabled={uploading} aria-label="添加照片">{uploading ? <LoaderCircle size={18} className="spin"/> : <Camera size={20}/>}<small>{uploading ? '上传中' : '添加照片'}</small></button>}</div>
      <input ref={inputRef} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={e=>void upload(e.target.files)} tabIndex={-1}/>
    </fieldset></form>
    <details className="boundary-provenance"><summary>地图数据来源</summary><p className="boundary-note">{region.level==='local' ? `边界代表年份：${region.year || coverage?.year || '以数据来源为准'}。点亮表示曾到访。` : '国家与地方足迹分别统计。'}<br/>{region.level==='local' && (isHistoricalFrance ? '旧版区域色块使用原始历史区界，保留原始地区标识、区名和年份。与其他年份的市镇边界可能不同。' : coverage?.coverageNote || '行政区可能已调整，记录会保留原始地区信息。')}</p></details>
    </div>
    <div className="editor-actions">
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="submit" form="memory-record-form" className="primary-button save-button" disabled={busy || uploading}>{busy ? <LoaderCircle size={17} className="spin"/> : <Check size={17}/>} {busy ? '正在保存…' : visit ? '保存修改' : status==='wishlist' ? '收进愿望清单' : '点亮并保存回忆'}</button>
      {visit && <div className="delete-row"><button type="button" className="danger-link memory-editor-delete" disabled={busy||uploading} onClick={()=>onDelete(visit)}><Trash2 size={15}/>删除这段回忆</button></div>}
    </div>
  </aside>;
}
