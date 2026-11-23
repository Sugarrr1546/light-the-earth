import {countryPresentation} from './place-search.ts';
import type {Region} from './model';
export interface RegionRepair {boundaryStatus?:'current'|'historical';name?:string;aliases?:string[];parentName?:string;center?:[number,number];status?:'verified'|'encoding-repaired'|'unresolved'|'boundary-undetermined';note?:string;evidenceURLs?:string[];}
export interface NameQualityCatalog {regions:Record<string,RegionRepair>;}
export function isUsableRegionName(value:unknown):value is string{
 if(typeof value!=='string'||!value.trim())return false;
 const text=value.trim();if(/^(?:undefined|null|n\/a)$/i.test(text)||/^(?:unknown|unnamed)(?:\b|$)/i.test(text)||/^(?:NaN|nan)$/.test(text))return false;
 return /[\p{L}\p{N}]/u.test(text)&&!/[?�\u0000-\u001f\u007f-\u009f]/u.test(text)&&!/(?:ï¿½|[ÃÂ][\u00a0-\u00bf])/.test(text)&&!/^(?:未命名区域|名称待核实|待核实地区|unknown(?:\s|$)|undefined$|null$|NaN$)/.test(text);
}
export function presentRegion(region:Region,catalog:NameQualityCatalog):Region{
 const repair=Object.prototype.hasOwnProperty.call(catalog.regions,region.id)?catalog.regions[region.id]:undefined;
 const name=isUsableRegionName(repair?.name)?repair.name:isUsableRegionName(region.name)?region.name:isUsableRegionName(region.originalName)?region.originalName:`待核实地区 · ${region.id.slice(-10)}`;
 const unresolved=!isUsableRegionName(name)||name.startsWith('待核实地区');
 const originalName=isUsableRegionName(region.originalName)?region.originalName:'';
 return countryPresentation({...region,boundaryStatus:repair?.boundaryStatus??region.boundaryStatus,name,originalName,aliases:[...new Set([...(region.aliases??[]),...(repair?.aliases??[]),originalName].filter(isUsableRegionName))],parentName:repair?.parentName??region.parentName,center:repair?.center??region.center,nameStatus:unresolved?'unresolved':repair?.status??'source',nameNote:repair?.note??(unresolved?'来源名称缺失或损坏，暂未核实；保留原始地区标识。':undefined),nameSourceUrl:repair?.evidenceURLs?.find(url=>/^https:\/\//.test(url))});
}
export function canLabelRegion(region:Region){return region.nameStatus!=='unresolved'&&isUsableRegionName(region.name);}
