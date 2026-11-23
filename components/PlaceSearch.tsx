'use client';
import { forwardRef, useMemo, useState } from 'react';
import { Search, MapPin, ArrowUpRight, X } from 'lucide-react';
import type { Region } from '../lib/model';
import {buildPlaceIndex,findPlaces} from '../lib/place-search';

interface Props {regions:Region[];onSelect:(r:Region)=>void;hidden?:boolean;}


const PlaceSearch=forwardRef<HTMLInputElement,Props>(function PlaceSearch({regions,onSelect,hidden},ref) {
  const [query,setQuery]=useState('');const [open,setOpen]=useState(false);const [active,setActive]=useState(0);
  const index=useMemo(()=>buildPlaceIndex(regions),[regions]);
  const results=useMemo(()=>query.trim()?findPlaces(index,query):regions.filter(r=>r.level==='country'&&['CHN','JPN','USA','FRA','ITA','NZL'].includes(r.countryCode)),[index,regions,query]);
  function select(r:Region) {onSelect(r);setQuery('');setOpen(false);}
  return <div className="search-wrap" hidden={hidden} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget))setOpen(false);}}>
    <div className={`search-bar ${open?'is-open':''}`}><Search size={18}/><input ref={ref} value={query} role="combobox" aria-expanded={open} aria-controls="place-results" aria-autocomplete="list" aria-label="搜索国家或地方行政区" placeholder="搜索一个你去过的地方" onFocus={()=>setOpen(true)} onChange={e=>{setQuery(e.target.value);setActive(0);setOpen(true);}} onKeyDown={e=>{if(e.key==='Escape'){setOpen(false);e.currentTarget.blur();}if(e.key==='ArrowDown'){e.preventDefault();setActive(n=>Math.min(n+1,results.length-1));}if(e.key==='ArrowUp'){e.preventDefault();setActive(n=>Math.max(n-1,0));}if(e.key==='Enter'&&open&&results[active]){e.preventDefault();select(results[active]);}}}/>{query?<button className="icon-button" onClick={()=>setQuery('')} aria-label="清空搜索"><X size={15}/></button>:null}</div>
    {open && <div className="search-results" id="place-results" role="listbox"><div className="search-hint">{query?'匹配的地点':'从这些地方开始探索'}</div>{results.length?results.map((r,i)=><button role="option" aria-selected={i===active} key={r.id} className={i===active?'active':''} onMouseDown={e=>e.preventDefault()} onClick={()=>select(r)}><MapPin size={16}/><span>{r.name}<small>{r.level==='country'?`国家 / 地区${r.year?` · ${r.boundaryStatus==='historical'?'历史边界':'边界'} ${r.year}`:''}`:`${r.parentName || '地方行政区'} · ${r.countryName}${r.year?` · ${r.boundaryStatus==='historical'?'历史边界':'边界'} ${r.year}`:''}`}{r.originalName && r.originalName!==r.name?` · ${r.originalName}`:''}</small></span><ArrowUpRight size={14}/></button>):<div className="search-empty">暂时没有找到。可以尝试中文、当地名称或英文，也可以先搜索所属国家。</div>}<div className="search-footnote">先打开国家或放大地图，地方行政区才会进入搜索。年份是边界代表年份，不是旅行日期。</div></div>}
  </div>;
});
export default PlaceSearch;
