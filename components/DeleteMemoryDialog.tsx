'use client';
import{useEffect,useRef,useState}from'react';
import{CalendarDays,Camera,LoaderCircle,MapPin,Trash2,X}from'lucide-react';
import type{Visit}from'../lib/model';
interface Props{visit:Visit;remainingCount:number;onCancel:()=>void;onConfirm:(visit:Visit)=>Promise<void>;}
export default function DeleteMemoryDialog({visit,remainingCount,onCancel,onConfirm}:Props){
 const dialogRef=useRef<HTMLDialogElement>(null),cancelRef=useRef<HTMLButtonElement>(null),busyRef=useRef(false),mounted=useRef(true);
 const[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{mounted.current=true;const trigger=document.activeElement as HTMLElement|null;const dialog=dialogRef.current;if(dialog&&!dialog.open)dialog.showModal();cancelRef.current?.focus();return()=>{mounted.current=false;if(dialog?.open)dialog.close();requestAnimationFrame(()=>{if(trigger?.isConnected)trigger.focus();else document.querySelector<HTMLElement>('[data-delete-focus-fallback=true]')?.focus();});};},[]);
 async function confirm(){if(busyRef.current)return;busyRef.current=true;setBusy(true);setError('');try{await onConfirm(visit);}catch(e){if(mounted.current)setError(e instanceof Error?e.message:'删除失败，请重试');}finally{busyRef.current=false;if(mounted.current)setBusy(false);}}
 return <dialog className="delete-memory-dialog" ref={dialogRef} role="alertdialog" aria-labelledby="delete-memory-title" aria-describedby="delete-memory-description" onCancel={e=>{e.preventDefault();if(!busyRef.current)onCancel();}} onKeyDown={e=>e.stopPropagation()} onClick={e=>{if(e.target!==e.currentTarget||busyRef.current)return;const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)onCancel();}}>
  <button className="icon-button delete-dialog-close" aria-label="关闭删除确认" disabled={busy} onClick={onCancel}><X size={19}/></button>
  <div className="delete-memory-mark" aria-hidden="true"><Trash2 size={24} strokeWidth={1.5}/></div>
  <span className="eyebrow">REMOVE A MEMORY</span>
  <h2 id="delete-memory-title">删除这一段回忆？</h2>
  <div className="delete-memory-summary"><strong>{visit.title||visit.region.name}</strong><span><MapPin size={15}/>{[visit.region.name,visit.region.parentName,visit.region.countryName].filter((v,i,a)=>v&&a.indexOf(v)===i).join(' · ')}</span><div><span><CalendarDays size={14}/>{visit.visitedOn||'日期未记'}</span>{visit.photos.length>0&&<span><Camera size={14}/>{visit.photos.length} 张照片</span>}</div></div>
  <p id="delete-memory-description">只删除这条记录，同一地区的其他回忆会保留。地图足迹与统计会根据剩余记录更新。</p>
  {remainingCount>0&&<p className="delete-remaining-note">该地区还有 {remainingCount} 条其他回忆，删除后仍会按剩余记录显示颜色。</p>}
  <p className="delete-permanent-note">确认后立即删除，无法撤销。</p>
  {error&&<p className="form-error" role="alert">{error}</p>}
  <form onSubmit={e=>{e.preventDefault();void confirm();}} className="delete-memory-actions"><button ref={cancelRef} type="button" className="delete-cancel" disabled={busy} onClick={onCancel}>保留回忆</button><button type="submit" className="delete-confirm" disabled={busy}>{busy?<LoaderCircle size={16} className="spin"/>:<Trash2 size={16}/>} {busy?'正在删除…':'确认删除'}</button></form>
 </dialog>;
}
