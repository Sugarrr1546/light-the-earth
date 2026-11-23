import type {Region,Visit} from './model';
const common:Record<string,string[]>={CHN:['中国','China','PRC','zhongguo'],KOR:['韩国','South Korea','hanguo'],PRK:['朝鲜','North Korea','chaoxian'],USA:['美国','USA','US','United States','meiguo'],GBR:['英国','UK','Britain','United Kingdom','yingguo'],JPN:['日本','Japan','riben'],FRA:['法国','France','faguo'],RUS:['俄罗斯','Russia','eluosi'],NZL:['新西兰','New Zealand','xinxilan'],AUS:['澳大利亚','澳洲','Australia'],DEU:['德国','Germany'],ITA:['意大利','Italy']};
export const normalizePlace=(s:string)=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
interface Entry{region:Region;name:string;names:string[];context:string;}
const official:Record<string,string[]>={CHN:['中华人民共和国',"People's Republic of China"],KOR:['大韩民国'],PRK:['朝鲜民主主义人民共和国'],USA:['美利坚合众国','United States of America'],GBR:['大不列颠及北爱尔兰联合王国'],RUS:['俄罗斯联邦','Russian Federation']};
function countryAliases(region:Region):string[]{
 if(region.level!=='country')return[];
 const names=common[region.countryCode]??[];
 const own=[region.name,region.originalName].filter((s):s is string=>!!s).map(normalizePlace);
 return [...names,...official[region.countryCode]??[]].some(n=>own.includes(normalizePlace(n)))?names:[];
}
export function countryPresentation(region:Region):Region{
 const aliases=countryAliases(region);
 return aliases.length?{...region,name:aliases[0],aliases:[...new Set([...(region.aliases??[]),region.name,...aliases])]}:region;
}
export function buildPlaceIndex(regions:Region[]):Entry[]{return regions.map(region=>({region,name:normalizePlace(region.name),names:[region.name,region.originalName,...region.aliases??[],...countryAliases(region)].filter((s):s is string=>!!s).map(normalizePlace),context:normalizePlace([region.id,region.parentName,region.countryName,region.countryCode].filter(Boolean).join(' '))}));}
export function findPlaces(index:Entry[],query:string,limit=14):Region[]{
 const text=normalizePlace(query.trim());if(!text)return[];
 const best:{entry:Entry;rank:number}[]=[];
 const compare=(a:typeof best[number],b:typeof best[number])=>a.rank-b.rank||Number(a.entry.region.boundaryStatus==='historical')-Number(b.entry.region.boundaryStatus==='historical')||Number(b.entry.region.level==='country')-Number(a.entry.region.level==='country')||a.entry.region.id.localeCompare(b.entry.region.id);
 for(const entry of index){const rank=entry.names.some(n=>n===text)?0:entry.names.some(n=>n.startsWith(text))?1:entry.names.some(n=>n.includes(text))?2:entry.context.includes(text)?3:4;if(rank===4)continue;const hit={entry,rank};let lo=0,hi=best.length;while(lo<hi){const mid=(lo+hi)>>>1;if(compare(hit,best[mid])<0)hi=mid;else lo=mid+1;}if(lo<limit){best.splice(lo,0,hit);if(best.length>limit)best.pop();}}
 return best.map(x=>x.entry.region);
}
export function latestRegionVisit(visits:Visit[],regionId:string):Visit|null{let latest:Visit|null=null;for(const v of visits)if(v.region.id===regionId&&(!latest||v.updatedAt>latest.updatedAt||(v.updatedAt===latest.updatedAt&&v.id>latest.id)))latest=v;return latest;}
