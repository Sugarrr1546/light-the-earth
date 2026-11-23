'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, LockKeyhole, Search, X } from 'lucide-react';
import type { Coverage, Region } from '../lib/model';

interface Props { coverage: Coverage[]; regions: Region[]; onClose: () => void; onExplore: (code: string) => void; }

export default function CoverageDialog({coverage,regions,onClose,onExplore}: Props) {
  const [query,setQuery]=useState('');
  const [limit,setLimit]=useState(24);
  const [gapReasons,setGapReasons]=useState<Record<string,string>>({});
  useEffect(()=>{const abort=new AbortController();fetch('/data/coverage-gaps.json',{signal:abort.signal}).then(r=>r.json()).then(data=>{if(data&&typeof data==='object'&&'unavailable' in data&&Array.isArray(data.unavailable))setGapReasons(Object.fromEntries(data.unavailable.map((r:{code:string;reasonZh?:string})=>[r.code,r.reasonZh||'暂未接入可核验的地方边界。'])));}).catch(()=>{});return()=>abort.abort();},[]);
  const countries=useMemo(()=>{const result=new Map<string,Region>();for(const r of regions)if(r.level==='country'&&!result.has(r.countryCode))result.set(r.countryCode,r);return result;},[regions]);
  const covered=new Set(coverage.map(c=>c.code));
  const missing=[...countries.values()].filter(r=>!covered.has(r.countryCode));
  const localCount=coverage.filter(c=>c.detailTier==='local'||(!c.detailTier&&c.adminLevel!=='ADM1')).length;
  const normalized=query.trim().toLocaleLowerCase();
  const matches=useMemo(()=>coverage.filter(c=>[c.name,c.code,countries.get(c.code)?.originalName,...countries.get(c.code)?.aliases??[]].join(' ').toLocaleLowerCase().includes(normalized)).sort((a,b)=>a.name.localeCompare(b.name,'zh-Hans-CN')),[coverage,countries,normalized]);
  return <div className="modal-backdrop" onClick={onClose}>
    <section role="dialog" aria-modal="true" aria-labelledby="coverage-title" className="about-modal coverage-dialog" onClick={e=>e.stopPropagation()}>
      <div className="drawer-heading"><span className="eyebrow">EXPLORE BEYOND BORDERS</span><button className="icon-button" aria-label="关闭数据说明" onClick={onClose}><X size={18}/></button></div>
      <h2 id="coverage-title">世界，正在变得更细。</h2>
      <p>先搜索或选择一个国家，再放大查看地方边界。点击区域即可记录旅行；不同国家采用实际可用的行政层级。</p>
      <div className="coverage-summary"><div><strong>{coverage.length}</strong><span>国家与地区已接入</span></div><div><strong>{localCount}</strong><span>县市、教区或基层单元</span></div><div><strong>{coverage.length-localCount}</strong><span>当前仅较粗细分</span></div></div>
      <label className="coverage-search"><Search size={16}/><input aria-label="搜索行政区覆盖国家" placeholder="查找国家或地区，例如法国、Thailand" value={query} onChange={e=>{setQuery(e.target.value);setLimit(24);}}/></label>
      <p className="coverage-result-count">{coverage.length?`找到 ${matches.length} 个国家与地区`:'正在读取覆盖目录…'}</p>
      <div className="coverage-list">{matches.slice(0,limit).map(c=><div key={c.code}>
        <strong>{c.name}<span>{(c.displayCount??c.count).toLocaleString()} 个区域</span></strong>
        <p>{c.label} · {c.adminLevel}{c.partial?' · 部分覆盖':''} · 代表年份 {c.year}</p>
        <small>{c.coverageNote}</small>
        <div className="coverage-row-actions"><button className="text-link" onClick={()=>onExplore(c.code)}>查看地方地图 <ArrowUpRight size={12}/></button><a href={c.sourceUrl||`https://www.geoboundaries.org/api/current/gbOpen/${c.code}/${c.adminLevel}/`} target="_blank" rel="noreferrer">数据来源 <ArrowUpRight size={12}/></a></div>
      </div>)}</div>
      {matches.length>limit&&<button className="outline-button coverage-more" onClick={()=>setLimit(n=>n+24)}>加载更多 · 还有 {matches.length-limit} 个</button>}
      {!!coverage.length&&!matches.length&&<p className="coverage-empty">当前覆盖目录没有匹配项。可以用中文名、英文名或三字母国家代码查找。</p>}
      <p className="fine-print">各地行政层级号不直接对应：一些地区的 ADM1 已是市镇、教区或村级。此处按真实单元分类，并标明历史年份与部分覆盖。部分地名保留原文，边界可能与现行区划不同。</p>
      {!!coverage.length&&missing.length>0&&<details className="coverage-missing"><summary>暂未接入地方边界的地区 · {missing.length}</summary>{missing.map(r=><p key={r.countryCode}><strong>{r.name}</strong>：{gapReasons[r.countryCode]||'暂未接入可核验的地方边界，可先整片记录。'}</p>)}<p>这些地区仍可保存国家／地区级回忆并整片着色。清单区分来源尚未核验、缺少可用矢量边界，以及不适合套用普通县市划分的地区。</p></details>}
      <div className="privacy-note"><LockKeyhole size={18}/><p>网站仅对你的账号开放。旅行记录和照片按账号隔离保存，可随时导出 ZIP 备份。地图不会向边界数据提供方发送你的旅行记录。<br/><a href="/data/name-quality.json" target="_blank" rel="noreferrer">地名核验与缺名说明</a> · <a href="/data/geometry-alignment.json" target="_blank" rel="noreferrer">当前精度与来源</a> · <a href="/data/sources-supplements.json" target="_blank" rel="noreferrer">本轮补齐与逐项说明</a> · <a href="/data/sources-global.json" target="_blank" rel="noreferrer">全球边界来源与许可</a> · <a href="/data/sources.json" target="_blank" rel="noreferrer">原有图层来源</a></p></div>
    </section>
  </div>;
}
