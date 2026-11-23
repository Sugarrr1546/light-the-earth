'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ArrowDownToLine, ArrowRight, ArrowUpRight, Camera, Check, ChevronDown, Compass, Earth, Heart, Home, Info, Layers, LoaderCircle, LockKeyhole, MapPin, Minus, Plus, RotateCcw, Route, Settings2, Sparkles, Stamp, Upload, X } from 'lucide-react';
import EarthMap from './EarthMap';
import MemoryEditor from './MemoryEditor';
import DeleteMemoryDialog from './DeleteMemoryDialog';
import {atlasResources} from '../lib/atlas-resources';
import {latestRegionVisit} from '../lib/place-search';
import {deleteMemory} from '../lib/memory-deletion';
import PlaceSearch from './PlaceSearch';
import CoverageDialog from './CoverageDialog';
import ShortcutsDialog from './ShortcutsDialog';
import {ALTITUDE_STEP,shortcutFor,shortcutTarget,ZOOM_STEP,type ShortcutAction} from '../lib/map-shortcuts';
import type { Coverage, MapController, Region, Visit } from '../lib/model';
import { STATUS_LABEL } from '../lib/model';
import { filterVisits, getBadges, getStats, getYears } from '../lib/collections';
import { api, ApiError } from '../lib/client-api';
import {bindPrivateSession,verifyPrivateSession,privateSessionLease,createPrivateVisibilityGuard} from '../lib/private-session';
import { exportBackup, importBackup } from '../lib/backup';
import {presentRegion,type NameQualityCatalog} from '../lib/region-presentation';
import {useAppearance} from '../lib/use-appearance';
import {Monitor,Sun,Moon,PanelLeftClose,PanelLeftOpen,Search,Trash2,FolderOpen,Keyboard} from 'lucide-react';
import {useMapPanels} from '../lib/use-map-panels';
import {desktopBridge} from '../lib/runtime';

type Tab='earth'|'memories'|'wishlist'|'collection';
type Toast={text:string;undo?:()=>Promise<void>;error?:boolean};
const badgeIcons={spark:Sparkles,compass:Compass,globe:Earth,repeat:RotateCcw,camera:Camera,home:Home};

export default function AtlasApp({userId}:{userId:string}) {
  const appearance=useAppearance();
  const {panels,setPanel}=useMapPanels();
  const desktop=desktopBridge();
  const [storedVisits,setVisits]=useState<Visit[]>([]);
  const [sessionInvalid,setSessionInvalid]=useState(false);
  const [sessionChecking,setSessionChecking]=useState(false);
  const [sessionCheckFailed,setSessionCheckFailed]=useState(false);
  const verifySessionRef=useRef<()=>void>(()=>{});
  const privateRootRef=useRef<HTMLElement>(null);
  const curtainRef=useRef<HTMLDivElement>(null);
  const [nameCatalog,setNameCatalog]=useState<NameQualityCatalog>({regions:{}});
  const visits=useMemo(()=>storedVisits.map(v=>({...v,region:presentRegion(v.region,nameCatalog)})),[storedVisits,nameCatalog]);
  useEffect(()=>{let active=true;void atlasResources().read<NameQualityCatalog>('/data/name-quality.json').then(catalog=>{if(active&&catalog?.regions)setNameCatalog(catalog);}).catch(()=>{});return()=>{active=false;};},[]);
  const [loaded,setLoaded]=useState(false);
  const [loadError,setLoadError]=useState('');
  const [mapError,setMapError]=useState('');
  const [attributionHeight,setAttributionHeight]=useState(24);
  const [regions,setRegions]=useState<Region[]>([]);
  const [coverage,setCoverage]=useState<Coverage[]>([]);
  const [selected,setSelected]=useState<Region|null>(null);
  const displaySelected=useMemo(()=>selected?presentRegion(selected,nameCatalog):null,[selected,nameCatalog]);
  const [drawer,setDrawer]=useState<Region|null>(null);
  const [editing,setEditing]=useState<Visit|null>(null);
  const [tab,setTab]=useState<Tab>('earth');
  const [mode,setMode]=useState<'browse'|'light'>('browse');
  const [projection,setProjection]=useState<'globe'|'mercator'>('globe');
  const [year,setYear]=useState('all');
  const [status,setStatus]=useState('all');
  const [listLimit,setListLimit]=useState(30);
  const [toast,setToast]=useState<Toast|null>(null);
  const toastRef=useRef<Toast|null>(null);
  const [undoBusy,setUndoBusy]=useState(false);
  const undoing=useRef(false);
  const [pendingDelete,setPendingDelete]=useState<Visit|null>(null);
  const [settings,setSettings]=useState(false);
  const [about,setAbout]=useState(false);
  const [shortcuts,setShortcuts]=useState(false);
  const [operation,setOperation]=useState('');
  const [mobileSidebar,setMobileSidebar]=useState(false);
  const map=useRef<MapController|null>(null);
  const search=useRef<HTMLInputElement>(null);
  const importInput=useRef<HTMLInputElement>(null);
  const saving=useRef(new Set<string>());
  const pendingLights=useRef(new Map<string,string>());
  const toastTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  useEffect(()=>{
    // An on-device atlas has one owner and no session that could change under the page.
    if(desktop)return bindPrivateSession(userId,()=>{});
    const hidePrivate=()=>{const root=privateRootRef.current;if(root){root.style.visibility='hidden';root.inert=true;root.setAttribute('aria-hidden','true');}const mask=curtainRef.current;if(mask){mask.style.visibility='visible';mask.style.pointerEvents='auto';mask.setAttribute('aria-hidden','false');}setSessionChecking(true);setSessionCheckFailed(false);};
    const dispose=bindPrivateSession(userId,()=>{
      hidePrivate();
      setSessionInvalid(true);setVisits([]);setLoaded(false);setDrawer(null);setEditing(null);setSelected(null);
      setPendingDelete(null);setToast(null);toastRef.current=null;setSettings(false);setOperation('');
      if(toastTimer.current)clearTimeout(toastTimer.current);
      pendingLights.current.clear();saving.current.clear();
      try{for(let i=sessionStorage.length-1;i>=0;i--){const key=sessionStorage.key(i);if(key&&(key.startsWith(`atlas-draft:${userId}:`)||key.startsWith(`atlas-light:${userId}:`)))sessionStorage.removeItem(key);}}catch{/* Optional browser drafts. */}
      window.location.replace('/');
    });
    const curtain=createPrivateVisibilityGuard({
      hide:hidePrivate,
      show:()=>{const root=privateRootRef.current;if(root){root.style.visibility='visible';root.inert=false;root.removeAttribute('aria-hidden');}const mask=curtainRef.current;if(mask){mask.style.visibility='hidden';mask.style.pointerEvents='none';mask.setAttribute('aria-hidden','true');}setSessionChecking(false);setSessionCheckFailed(false);},
      failed:()=>setSessionCheckFailed(true),
      canShow:()=>document.visibilityState!=='hidden'&&document.hasFocus(),
      verify:()=>verifyPrivateSession(),
    });
    const visibility=()=>{if(document.visibilityState==='hidden')curtain.hide();else curtain.check();};
    verifySessionRef.current=curtain.check;
    window.addEventListener('blur',curtain.hide);window.addEventListener('pagehide',curtain.hide);window.addEventListener('focus',curtain.check);window.addEventListener('pageshow',curtain.check);document.addEventListener('visibilitychange',visibility);
    return()=>{curtain.dispose();dispose();window.removeEventListener('blur',curtain.hide);window.removeEventListener('pagehide',curtain.hide);window.removeEventListener('focus',curtain.check);window.removeEventListener('pageshow',curtain.check);document.removeEventListener('visibilitychange',visibility);};
  },[userId,desktop]);
  // Getting-started tips are for an empty atlas; once there are records only loading and error messages remain.
  const hintsVisible=panels.hints&&loaded&&storedVisits.length===0;
  const stats=getStats(visits);
  const years=getYears(visits);
  const badges=getBadges(visits);
  const filtered=useMemo(()=>filterVisits(visits,year,status),[visits,year,status]);
  const visibleVisits=useMemo(()=>tab==='wishlist'?filtered.filter(v=>v.status==='wishlist'):filtered,[filtered,tab]);
  useEffect(()=>setListLimit(30),[tab,year,status]);
  const records=filtered.filter(v=>tab==='wishlist'?v.status==='wishlist':v.status!=='wishlist').sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));

  const clearToast=useCallback(()=>{if(toastTimer.current)clearTimeout(toastTimer.current);toastRef.current=null;setToast(null);},[]);
  const notify=useCallback((text:string,undo?:()=>Promise<void>,duration?:number,error=false)=>{
    if(toastTimer.current)clearTimeout(toastTimer.current);
    const entry={text,undo,error};toastRef.current=entry;setToast(entry);toastTimer.current=setTimeout(()=>{if(toastRef.current===entry){toastRef.current=null;setToast(null);}},duration??(undo?14000:6500));
  },[]);
  async function undoToast(){const entry=toastRef.current;if(!entry?.undo||undoing.current)return;undoing.current=true;setUndoBusy(true);if(toastTimer.current)clearTimeout(toastTimer.current);try{await entry.undo();if(toastRef.current===entry)clearToast();}catch(e){if(toastRef.current===entry)notify(e instanceof Error?`撤销失败：${e.message}`:'撤销失败，请重试',entry.undo,30000,true);}finally{undoing.current=false;setUndoBusy(false);}}
  const closeDrawer=useCallback(()=>{setDrawer(null);setEditing(null);},[]);
  const reload=useCallback(async()=>{
    let lease:ReturnType<typeof privateSessionLease>|undefined;
    try{lease=privateSessionLease(userId);setLoadError('');const result=await api<{visits:Visit[]}>('/api/visits');lease.assert();setVisits(result.visits);setLoaded(true);}
    catch(e){try{if(!lease)return;lease.assert();}catch{return;}setLoadError(e instanceof Error?e.message:'无法读取旅行记录');}
  },[userId]);
  useEffect(()=>{void reload();Promise.all([atlasResources().read('/data/coverage.json'),atlasResources().read('/data/geometry-alignment.json').catch(()=>null)]).then(([data,raw])=>{if(!Array.isArray(data))return;const aligned=raw as {countries?:Record<string,{renderCount:number;source?:string;sourceUrl?:string;license?:string;sourceYear?:string}>}|null;setCoverage((data as Coverage[]).map(c=>{const a=aligned?.countries?.[c.code];return a?{...c,displayCount:a.renderCount,source:a.source||c.source,sourceUrl:a.sourceUrl||c.sourceUrl,license:a.license||c.license,year:a.sourceYear||c.year,coverageNote:c.code==='HKG'?'香港官方18区边界，结合OSM实际海岸线显示陆地；保留原区域ID。2026年下载快照，原始区划日期以官方来源为准。':c.coverageNote}:c;}));}).catch(()=>{});return()=>{if(toastTimer.current)clearTimeout(toastTimer.current);};},[reload]);
  const showSearch=useCallback(()=>{setPanel('search',true);requestAnimationFrame(()=>search.current?.focus());},[setPanel]);
  const resetView=useCallback(()=>{setSelected(null);closeDrawer();map.current?.reset();},[closeDrawer]);
  // Map shortcuts follow Google Earth on the web; lib/map-shortcuts.ts decides which key does what.
  const runShortcut=useCallback((action:ShortcutAction)=>{
    if(action==='help'){setShortcuts(open=>!open);return;}
    if(action==='zoom-in')map.current?.zoomBy(ZOOM_STEP);
    else if(action==='zoom-out')map.current?.zoomBy(-ZOOM_STEP);
    else if(action==='altitude-up')map.current?.zoomBy(-ALTITUDE_STEP);
    else if(action==='altitude-down')map.current?.zoomBy(ALTITUDE_STEP);
    else if(action==='reset')resetView();
    else if(action==='projection')setProjection(current=>current==='globe'?'mercator':'globe');
    else if(action==='stop')map.current?.stop();
  },[resetView]);
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if(pendingDelete||operation)return;if(e.key==='Escape'){setSettings(false);setAbout(false);setShortcuts(false);}if(e.key==='/'&&!(e.target instanceof HTMLInputElement)&&!(e.target instanceof HTMLTextAreaElement)){e.preventDefault();showSearch();}
    const action=shortcutFor(e,shortcutTarget(e.target));
    // A dialog over the map keeps the map still; only ? (which toggles the list) gets through.
    if(!action||(about&&action!=='help')||(shortcuts&&action!=='help'))return;
    e.preventDefault();if(action==='move')map.current?.keyboardMove(e);else runShortcut(action);};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[showSearch,pendingDelete,operation,about,shortcuts,runShortcut]);

  function merge(v:Visit){setVisits(previous=>[v,...previous.filter(x=>x.id!==v.id)]);}
  const undoCreated=useCallback(async(v:Visit)=>{await api(`/api/visits/${v.id}`,{method:'DELETE'});setVisits(previous=>previous.filter(x=>x.id!==v.id));},[]);
  const selectRegion=useCallback((region:Region)=>{const existing=latestRegionVisit(storedVisits,region.id);const target=existing?presentRegion(existing.region,nameCatalog):region;map.current?.flyTo(target);setSelected(target);setDrawer(target);setEditing(existing);setMobileSidebar(false);},[storedVisits,nameCatalog]);
  const clickRegion=useCallback(async(region:Region)=>{
    setSelected(region);
    if(mode==='light'&&region.level==='local'&&loaded){
      // Each place saves independently, so quick successive clicks on neighbours all light up.
      if(saving.current.has(region.id))return;
      if(visits.some(v=>v.region.id===region.id&&(v.status==='visited'||v.status==='lived'))){map.current?.reveal(region);setDrawer(region);setEditing(null);return;}
      saving.current.add(region.id);
      const key=`atlas-light:${userId}:${region.id}`;
      let id=pendingLights.current.get(region.id);
      try{const stored=sessionStorage.getItem(key);if(!id&&stored&&/^[\w-]{1,100}$/.test(stored))id=stored;}catch{/* Device storage is optional. */}
      id??=crypto.randomUUID();pendingLights.current.set(region.id,id);
      try{sessionStorage.setItem(key,id);}catch{/* The in-memory ID still makes retries safe. */}
      try{
        let visit:Visit;
        try{visit=(await api<{visit:Visit}>('/api/visits',{method:'POST',body:JSON.stringify({id,region,status:'visited',visitedOn:'',title:'',notes:'',tripName:'',photos:[]})})).visit;}
        catch(error){
          if(!(error instanceof ApiError&&error.status===409))throw error;
          const result=await api<{visits:Visit[]}>('/api/visits');
          const existing=result.visits.find(v=>v.id===id);if(!existing)throw error;visit=existing;
        }
        pendingLights.current.delete(region.id);try{sessionStorage.removeItem(key);}catch{/* Server success is authoritative. */}
        map.current?.pulse(visit.region.id);setVisits(prev=>[visit,...prev.filter(v=>v.id!==visit.id)]);notify(`${region.name}，已加入你的世界`,()=>undoCreated(visit));
      }
      catch(e){notify(e instanceof Error?e.message:'保存失败，请重试');}
      finally{saving.current.delete(region.id);}
    }else{map.current?.reveal(region);setDrawer(region);setEditing(null);setMobileSidebar(false);}
  },[mode,loaded,visits,notify,undoCreated,userId]);
  function saved(v:Visit){if(!editing||editing.status!==v.status)map.current?.pulse(v.region.id);merge(v);closeDrawer();notify(editing?'回忆已更新':v.status==='wishlist'?'已收进愿望清单':'又一段回忆，留在了地球上',editing?undefined:()=>undoCreated(v));}
  function requestDelete(v:Visit){const original=storedVisits.find(x=>x.id===v.id);if(!original){notify('这条回忆已不在当前列表，请刷新后查看');return;}setSettings(false);setPendingDelete(original);}
  async function deleteVisit(v:Visit){
    const remaining=storedVisits.filter(other=>other.id!==v.id&&other.region.id===v.region.id).length;
    await deleteMemory(v,{remove:id=>api(`/api/visits/${id}`,{method:'DELETE'}),onDeleted:id=>{
      setVisits(previous=>previous.filter(x=>x.id!==id));
      try{sessionStorage.removeItem(`atlas-draft:${userId}:${id}`);}catch{/* Optional device draft. */}
      if(drawer?.id===v.region.id)closeDrawer();
      setSelected(current=>current?.id===v.region.id?null:current);
      setPendingDelete(null);
    }});
    notify(remaining?`这段回忆已删除 · 该地区还保留 ${remaining} 条回忆`:'这段回忆已删除',undefined,3000);
  }
  function edit(v:Visit){const shown=presentRegion(v.region,nameCatalog);const original=storedVisits.find(x=>x.id===v.id)??v;map.current?.flyTo(shown);setSelected(shown);setDrawer(shown);setEditing(original);setMobileSidebar(false);}
  function country(code:string){const r=regions.find(x=>x.countryCode===code&&x.level==='country');if(r)selectRegion(r);else notify('地图正在准备中，请稍候');}
  async function backup(){setSettings(false);setOperation('正在准备备份…');try{await exportBackup(year==='all'?storedVisits:filterVisits(storedVisits,year,'all'),setOperation);notify('备份已下载，包含旅行记录和照片');}catch(e){notify(e instanceof Error?e.message:'备份失败');}finally{setOperation('');}}
  async function restore(file?:File){if(!file)return;setSettings(false);setOperation('正在检查备份…');try{const count=await importBackup(file,storedVisits,setOperation);await reload();notify(`恢复了 ${count} 条回忆，已有记录保留不变`);}catch(e){await reload();notify(e instanceof Error?e.message:'导入失败');}finally{setOperation('');if(importInput.current)importInput.current.value='';}}
  function changeTab(value:Tab){if(value!=='earth')setPanel('sidebar',true);setTab(value);setStatus('all');setMobileSidebar(value!=='earth');closeDrawer();}
  const mapReady=useCallback((controller:MapController)=>{map.current=controller;setMapError('');},[]);

  if(sessionInvalid)return <main className="session-ended" role="status"><p>登录状态已变化，正在重新登录…</p></main>;

  return <><main ref={privateRootRef} inert={sessionChecking} aria-hidden={sessionChecking||undefined} style={{visibility:sessionChecking?'hidden':undefined,'--attribution-floor':`${Math.max(44,attributionHeight+20)}px`} as CSSProperties} data-projection={projection} data-sidebar-visible={panels.sidebar} data-timeline-visible={panels.timeline} data-search-visible={panels.search} data-hints-visible={hintsVisible} className={`atlas-shell ${drawer?'has-drawer':''}`}>
    <header className="app-header">
      <button className="brand" onClick={()=>{changeTab('earth');map.current?.reset();}} aria-label="点亮地球首页"><span className="brand-mark"><Earth size={25} strokeWidth={1.1}/><i/></span><span>点亮地球<small>A WORLD OF YOUR OWN</small></span></button>
      <nav className="main-nav" aria-label="主导航">{([{id:'earth',name:'探索地球',Icon:Earth},{id:'memories',name:'我的足迹',Icon:MapPin},{id:'wishlist',name:'心愿地图',Icon:Heart},{id:'collection',name:'旅行护照',Icon:Stamp}] as const).map(({id,name,Icon})=><button key={id} className={tab===id?'active':''} onClick={()=>changeTab(id)} data-delete-focus-fallback={tab===id?'true':undefined} aria-current={tab===id?'page':undefined}><Icon size={16}/><span>{name}</span>{id==='wishlist'&&stats.wishes>0&&<i className="nav-count">{stats.wishes}</i>}</button>)}</nav>
      <div className="header-tools"><span className="private-label"><LockKeyhole size={12}/>{desktop?'保存在本机':'私人珍藏'}</span><div className="settings-wrap"><button className={`icon-button settings-trigger ${settings?'active':''}`} aria-label="备份与设置" aria-expanded={settings} onClick={()=>setSettings(!settings)}><Settings2 size={19}/></button>{settings&&<div className="settings-menu"><span className="menu-title">好好保存，每一段旅程</span><div className="appearance-settings"><span>外观</span><div role="radiogroup" aria-label="外观模式">{([{value:'system',label:'跟随系统',Icon:Monitor},{value:'light',label:'白天',Icon:Sun},{value:'dark',label:'夜晚',Icon:Moon}] as const).map(({value,label,Icon})=><button key={value} role="radio" aria-checked={appearance.preference===value} className={appearance.preference===value?'active':''} onClick={()=>appearance.setPreference(value)}><Icon size={14}/>{label}</button>)}</div></div><div className="map-panel-settings"><span>地图面板</span>{([{key:'search',label:'搜索框'},{key:'timeline',label:'时间轴'},{key:'sidebar',label:'桌面左侧栏'},{key:'hints',label:'地图提示'}]as const).map(({key,label})=><button role="switch" aria-checked={panels[key]} key={key} onClick={()=>setPanel(key,!panels[key])}><span>{label}</span><span className={`panel-switch ${panels[key]?'is-on':''}`} aria-hidden="true"/></button>)}</div><button onClick={()=>void backup()} disabled={!loaded||!!operation}><ArrowDownToLine size={16}/>{year==='all'?'导出全部备份':`导出 ${year==='unknown'?'日期未记':year} 的备份`}</button><button onClick={()=>importInput.current?.click()} disabled={!loaded||!!operation}><Upload size={16}/>导入旅行备份</button><button onClick={()=>{setShortcuts(true);setSettings(false);}}><Keyboard size={16}/>键盘快捷键<kbd className="menu-shortcut">?</kbd></button><button onClick={()=>{setAbout(true);setSettings(false);}}><Info size={16}/>地图数据与隐私</button>{desktop?<button onClick={()=>{setSettings(false);void desktop.revealData();}}><FolderOpen size={16}/>打开数据文件夹</button>:<a href="/signout-with-chatgpt?return_to=/" target="_top"><LockKeyhole size={16}/>退出账号</a>}</div>}</div></div>
    </header>
    <div className="map-stage">
      <EarthMap theme={appearance.resolved} onAttributionHeight={setAttributionHeight} sidebarVisible={panels.sidebar} showHints={hintsVisible} timelineVisible={panels.timeline} onHideHints={()=>setPanel('hints',false)} visits={visibleVisits} selectedRegion={displaySelected} mode={mode} projection={projection} onRegionClick={clickRegion} onRegionsChange={setRegions} onReady={mapReady} onError={setMapError}/>
      <div className="toolbar-edge"/>
      <div className="map-panel-controls" role="toolbar" aria-label="地图面板">
        <button className="panel-tool sidebar-toggle" aria-label={panels.sidebar?'收起左侧栏':'展开左侧栏'} title={panels.sidebar?'收起左侧栏':'展开左侧栏'} aria-expanded={panels.sidebar} aria-controls="travel-sidebar" onClick={()=>setPanel('sidebar',!panels.sidebar)}>{panels.sidebar?<PanelLeftClose size={19}/>:<PanelLeftOpen size={19}/>}</button>
        {!panels.search&&<button className="panel-tool" aria-label="显示搜索框" title="显示搜索框 /" onClick={showSearch}><Search size={19}/></button>}
      </div>
      {(!panels.timeline||!panels.hints)&&<div className="map-restore" role="toolbar" aria-label="已隐藏的地图面板">
        {!panels.timeline&&<button className="panel-tool timeline-restore" aria-label="显示时间轴" title={`显示时间轴${year!=='all'?` · 筛选：${year==='unknown'?'日期未记':year}`:''}`} aria-controls="travel-timeline" onClick={()=>setPanel('timeline',true)}><Route size={19}/>{year!=='all'&&<span>{year==='unknown'?'未记':year}</span>}</button>}
        {!panels.hints&&<button className="panel-tool" aria-label="显示地图提示" title="显示地图提示" onClick={()=>setPanel('hints',true)}><Info size={19}/></button>}
      </div>}
      <PlaceSearch ref={search} hidden={!panels.search} regions={regions} onSelect={selectRegion}/>
      <button className="mobile-summary" onClick={()=>setMobileSidebar(!mobileSidebar)}><MapPin size={16}/>{stats.places} 个地方 · {stats.countries} 个国家/地区<ChevronDown size={15}/></button>
      <aside id="travel-sidebar" inert={!panels.sidebar&&!mobileSidebar} className={`travel-sidebar ${mobileSidebar?'is-open':''}`}>
        <div className="sidebar-mobile-heading"><span>你的旅行收藏</span><button className="icon-button" aria-label="收起旅行收藏" onClick={()=>setMobileSidebar(false)}><X size={18}/></button></div>
        <div className="sidebar-scroll">
        <div className={`intro-block ${loaded&&storedVisits.length>0?'is-compact':''}`}><div className="eyebrow"><span className="tiny-star">✦</span> EVERY PLACE, A STORY</div><h1>{tab==='wishlist'?<>下一站，<br/><em>心之所向。</em></>:tab==='collection'?<>把世界，<br/><em>收进护照。</em></>:tab==='memories'?<>走过的路，<br/><em>都有回声。</em></>:<>世界很大，<br/><em>慢慢点亮。</em></>}</h1><p>{tab==='wishlist'?'那些还没出发、却已在心里的地方。':tab==='collection'?'每一枚印章，都是你与世界的相遇。':tab==='memories'?'回到某个地方，也回到那时的自己。':'一颗属于你的地球，收藏每一次出发。'}</p></div>
        <div className="travel-stats"><div><strong>{stats.countries.toString().padStart(2,'0')}</strong><span>国家 / 地区</span></div><div><strong>{stats.places.toString().padStart(2,'0')}</strong><span>地方足迹</span></div><div><strong>{stats.memories.toString().padStart(2,'0')}</strong><span>到访回忆</span></div></div>
        {loadError?<div className="load-error" role="alert"><p>{loadError}</p><button className="text-link" onClick={()=>void reload()}>重新读取 <RotateCcw size={14}/></button></div>:!loaded?<div className="quiet-loading"><LoaderCircle className="spin" size={16}/>正在打开你的旅行收藏…</div>:tab==='collection'?<div className="passport-content"><div className="section-label">旅行印章 <span>{badges.filter(b=>b.unlocked).length} / {badges.length}</span></div><div className="badge-grid">{badges.map(b=>{const Icon=badgeIcons[b.icon as keyof typeof badgeIcons];return <div className={`travel-badge ${b.unlocked?'unlocked':''}`} key={b.id}><div className="stamp-ring"><Icon size={25} strokeWidth={1.2}/></div><strong>{b.title}</strong><p>{b.subtitle}</p><span>{b.unlocked?'已收藏':`${b.progress} / ${b.total}`}</span></div>;})}</div></div>:<>
          <div className="section-label">{tab==='wishlist'?'心愿清单':tab==='memories'?'我的旅行档案':'最近的回忆'}<span>{tab==='earth'?<button className="text-link" onClick={()=>changeTab('memories')}>全部 <ArrowUpRight size={13}/></button>:`${records.length} 段`}</span></div>
          {tab==='memories'&&<div className="record-filter"><button className={status==='all'?'active':''} onClick={()=>setStatus('all')}>全部</button><button className={status==='visited'?'active':''} onClick={()=>setStatus('visited')}>到访</button><button className={status==='lived'?'active':''} onClick={()=>setStatus('lived')}>居住</button><button className={status==='passed'?'active':''} onClick={()=>setStatus('passed')}>途经</button></div>}
          {records.length>0?<div className="memory-list">{records.slice(0,tab==='earth'?3:listLimit).map(v=><article className="memory-card memory-card-actions" key={v.id}><button className="memory-card-open" onClick={()=>edit(v)}>{v.photos[0]?<img src={v.photos[0].url} alt=""/>:<div className={`memory-placeholder ${v.status}`}><MapPin size={21} strokeWidth={1}/></div>}<span className="memory-card-text"><strong>{v.title||v.region.name}</strong><span>{[v.region.parentName,v.region.countryName].filter(Boolean).join(' · ')}{v.region.year?` · 边界 ${v.region.year}`:''}</span><small>{v.visitedOn||'日期未记'} <i/> {STATUS_LABEL[v.status]}</small></span><ArrowUpRight size={15}/></button><button className="memory-card-delete" aria-label={`删除回忆：${v.title||v.region.name}`} title="删除这段回忆" onClick={()=>requestDelete(v)}><Trash2 size={16}/></button></article>)}{tab!=='earth'&&records.length>listLimit&&<button className="outline-button" onClick={()=>setListLimit(n=>n+30)}>加载更多 · 还有 {records.length-listLimit} 段</button>}</div>:<div className="empty-collection"><div className="empty-orbit"><span/><MapPin size={24} strokeWidth={1}/><i>✦</i></div><h3>{tab==='wishlist'?'把想去的地方，先收藏起来':year!=='all'?'这一年，还没有留下记录':'你的第一束光，会在哪里？'}</h3><p>{tab==='wishlist'?'搜索一个目的地，在详情里选择「想去」。':year!=='all'?'可以切回全部时间，或为旧旅行补上年份。':'搜索一个熟悉的地方，或在地球上轻轻一点。'}</p><button className="outline-button" onClick={()=>{setMobileSidebar(false);showSearch();}}><Plus size={16}/> {tab==='wishlist'?'收藏一个心愿':'添加第一段回忆'}<ArrowRight size={15}/></button></div>}
        </>}
        {tab==='earth'&&<div className="explore-countries"><div className="section-label">从这里开始探索<button className="text-link" onClick={()=>setAbout(true)}>全球覆盖 <ArrowUpRight size={12}/></button></div><div className="country-chips"><button onClick={()=>country('CHN')}><span>中</span>中国<ArrowUpRight size={12}/></button><button onClick={()=>country('JPN')}><span>日</span>日本<ArrowUpRight size={12}/></button><button onClick={()=>country('USA')}><span>美</span>美国<ArrowUpRight size={12}/></button></div><button className="coverage-entry" onClick={()=>setAbout(true)}>已接入 {coverage.length || "…"} 个国家与地区的行政区 <ArrowRight size={13}/></button></div>}
        <div className="sidebar-bottom"><LockKeyhole size={12}/><span>{desktop?'只属于你。记录保存在这台电脑上。':'只属于你。记录按账号私密保存。'}</span><button aria-label="查看数据与隐私" onClick={()=>setAbout(true)}><Info size={13}/></button></div>
        </div>
      </aside>
      <div className="map-mode-controls"><div className="segmented"><button className={mode==='browse'?'active':''} onClick={()=>setMode('browse')} aria-pressed={mode==='browse'}><Compass size={15}/>自由探索</button><button className={mode==='light'?'active gold':''} onClick={()=>{setMode('light');notify('点亮模式已开启：放大到地方行政区，点击即可记录到访');}} aria-pressed={mode==='light'}><Sparkles size={15}/>点亮模式</button></div></div>
      <div className="map-actions"><button className="icon-button" aria-label="放大地图" onClick={()=>map.current?.zoomIn()}><Plus size={19}/></button><button className="icon-button" aria-label="缩小地图" onClick={()=>map.current?.zoomOut()}><Minus size={19}/></button><span/><button className="icon-button" aria-label="返回地球全景" title="返回地球全景 R" onClick={resetView}><Compass size={19}/></button></div>
      <div className="map-style-control"><button className={projection==='globe'?'active':''} title="地球 · 按 O 切换" onClick={()=>setProjection('globe')}><Earth size={14}/>地球</button><button className={projection==='mercator'?'active':''} title="平面 · 按 O 切换" onClick={()=>setProjection('mercator')}><Layers size={14}/>平面</button></div>
      <div className="map-legend"><span><i className="visited"/>到访</span><span><i className="lived"/>居住</span><span><i className="passed"/>途经</span><span><i className="wish"/>想去</span></div>
      <div id="travel-timeline" hidden={!panels.timeline} className="time-bar"><span className="time-icon"><Route size={17}/></span><span className="time-label">我的时间轴</span><div className="year-buttons"><button className={year==='all'?'active':''} onClick={()=>setYear('all')}>全部时间</button>{years.map(y=><button key={y} className={year===y?'active':''} onClick={()=>setYear(y)}>{y}</button>)}{visits.some(v=>!v.visitedOn.match(/(?:19|20)\d{2}/))&&<button className={year==='unknown'?'active':''} onClick={()=>setYear('unknown')}>日期未记</button>}</div>{!visits.length&&<span className="timeline-empty">每一次出发，都会留在这里</span>}<span className="time-count">{visibleVisits.length} 段记录</span><button className="panel-close" aria-label="隐藏时间轴" title="隐藏时间轴" onClick={()=>setPanel('timeline',false)}><X size={17}/></button></div>
      {mapError&&panels.hints&&<div className="map-error" role="status"><Info size={18}/><span>{mapError}</span><button className="panel-close" aria-label="关闭地图提示" title="关闭地图提示" onClick={()=>setPanel('hints',false)}><X size={17}/></button></div>}
    </div>
    {drawer&&<MemoryEditor key={`${drawer.id}:${editing?.id??'new'}`} userId={userId} region={presentRegion(drawer,nameCatalog)} visit={editing} visits={visits} coverage={coverage.find(c=>c.code===drawer.countryCode)} onClose={closeDrawer} onNew={()=>setEditing(null)} onSaved={saved} onDelete={requestDelete} onEdit={edit} onExplore={()=>{map.current?.flyTo(drawer,false);closeDrawer();}}/>}
    {pendingDelete&&<DeleteMemoryDialog remainingCount={storedVisits.filter(v=>v.id!==pendingDelete.id&&v.region.id===pendingDelete.region.id).length} visit={{...pendingDelete,region:presentRegion(pendingDelete.region,nameCatalog)}} onCancel={()=>setPendingDelete(null)} onConfirm={()=>deleteVisit(pendingDelete)}/>}
    {toast&&<div className={`toast ${toast.error?'toast-error':''}`} role="status">{toast.error?<Info size={16}/>:<Check size={16}/>}<span>{toast.text}</span>{toast.undo&&<button disabled={undoBusy} onClick={()=>void undoToast()}>{undoBusy?<><LoaderCircle size={14} className="spin"/>正在撤销…</>:toast.error?'重试撤销':'撤销'}</button>}<button className="toast-close" aria-label="关闭提示" onClick={clearToast}><X size={14}/></button></div>}
    {operation&&<div className="operation-overlay" role="status"><LoaderCircle size={24} className="spin"/><strong>{operation}</strong><span>请保持页面打开</span></div>}
    <input className="sr-only" ref={importInput} type="file" accept=".zip,application/zip" onChange={e=>void restore(e.target.files?.[0])} tabIndex={-1}/>
    {shortcuts&&<ShortcutsDialog onClose={()=>setShortcuts(false)}/>}
    {about&&<CoverageDialog coverage={coverage} regions={regions} onClose={()=>setAbout(false)} onExplore={code=>{setAbout(false);country(code);}}/>}
  </main><div ref={curtainRef} role="status" aria-hidden={!sessionChecking} style={{visibility:sessionChecking?'visible':'hidden',pointerEvents:sessionChecking?'auto':'none',position:'fixed',inset:0,zIndex:10000,display:'grid',placeContent:'center',textAlign:'center',background:'var(--panel)',color:'var(--ink)'}}><p>{sessionCheckFailed?'暂时无法核对登录状态，私人地图已隐藏。':'正在核对登录状态…'}</p>{sessionCheckFailed&&<button type="button" className="outline-button" onClick={()=>verifySessionRef.current()}>重试核对</button>}</div></>;
}
