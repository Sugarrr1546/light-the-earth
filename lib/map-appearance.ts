import type {ResolvedAppearance} from './appearance';
import type {Visit,VisitStatus} from './model';
// Blue water and neutral land, close to the system Maps app. The area colours are mirrored by the --c-* tokens in app/globals.css.
export const mapPalette=(theme:ResolvedAppearance)=>theme==='light'?{
 space:'#071321',ocean:'#8ec5ea',land:'#f2f0e8',border:'#7f8f99',line:'#77848f',text:'#3d4c58',halo:'#f8f7f1',hover:'#6faad6',selection:'#fffaf0',selectionCasing:'#1c2b3a',sky:'#071321',horizon:'#cfe9fb',fog:'#8ec5ea',grid:'#6fa3c8',point:'#f8f7f1',goldBorder:'#8a5a12',areaVisited:'#f3ba4f',areaLived:'#e9812c',areaPassed:'#8fcdaa',areaWish:'#b7a6ee',areaBorder:'#b2761a',wishBorder:'#6a52c8',passedBorder:'#4c9a77'
}:{space:'#030711',ocean:'#1f5a86',land:'#2a2e36',border:'#66727f',line:'#93a0b0',text:'#b6bfca',halo:'#1d2127',hover:'#8fb6d8',selection:'#fffaf0',selectionCasing:'#02060b',sky:'#030711',horizon:'#7bb8e0',fog:'#1f5a86',grid:'#6f93b3',point:'#1a1d23',goldBorder:'#6b4a10',areaVisited:'#e6aa45',areaLived:'#ff8a3d',areaPassed:'#62b08c',areaWish:'#6f62c4',areaBorder:'#ffdf9e',wishBorder:'#c3b8ff',passedBorder:'#b5e6cf'};
export function themedMapPaint(id:string,theme:ResolvedAppearance):Record<string,unknown>{
 const p=mapPalette(theme);
 if(id==='ocean')return {'background-color':p.ocean};
 if(id==='grid')return {'line-color':p.grid};
 if(id==='country-fill')return {'fill-color':['match',['feature-state','status'],'lived',p.areaLived,'visited',p.areaVisited,'passed',p.areaPassed,'wishlist',p.areaWish,p.land]};
 if(id==='country-border')return {'line-color':p.border};
 if(id==='country-hover'||id.endsWith('-hover'))return {'fill-color':p.hover};
 // The selection is an ivory core on a dark casing, so it never reads as a lit-area border.
 if(id.endsWith('-selection-casing')||id.endsWith('-outline-casing'))return {'line-color':p.selectionCasing};
 if(id==='country-selection'||id.endsWith('-selection')||id.endsWith('-outline'))return {'line-color':p.selection};
 if(id==='saved-area-fill')return {'fill-color':['match',['get','status'],'lived',p.areaLived,'visited',p.areaVisited,'passed',p.areaPassed,'wishlist',p.areaWish,p.areaVisited]};
 if(id==='saved-area-border')return {'line-color':['match',['get','status'],'wishlist',p.wishBorder,'passed',p.passedBorder,p.areaBorder]};
 if(id==='footprint-ring')return {'circle-color':p.point};
 if(id==='country-name'||(id.startsWith('local-')&&id.endsWith('-name')))return {'text-color':p.text,'text-halo-color':p.halo};
 if(id.startsWith('local-')&&(id.endsWith('-fill')||id.endsWith('-fallback')))return {'fill-color':p.land};
 if(id.startsWith('local-')&&id.endsWith('-border'))return {'line-color':p.line};
 if(id==='overview-border'||id.startsWith('overview-border-'))return {'line-color':p.line};
 if(id==='border-seam-fill')return {'fill-color':p.land};
 return {};
}
const STATUS_STRENGTH:Record<VisitStatus,number>={wishlist:0,passed:1,visited:2,lived:3};
/** Countries that hold local footprints but no record of their own, with the strongest status among those footprints. */
export function footprintCountries(visits:Pick<Visit,'region'|'status'>[]):Map<string,VisitStatus>{
 const result=new Map<string,VisitStatus>(),recorded=new Set<string>();
 for(const {region,status} of visits){
  if(region.level==='country'){recorded.add(region.countryCode);continue;}
  const current=result.get(region.countryCode);
  if(!current||STATUS_STRENGTH[status]>STATUS_STRENGTH[current])result.set(region.countryCode,status);
 }
 // A country recorded as a whole is already painted in full by its saved area.
 for(const code of recorded)result.delete(code);
 return result;
}
const mix=(from:string,to:string,amount:number)=>'#'+[1,3,5].map(i=>Math.round(parseInt(from.slice(i,i+2),16)*(1-amount)+parseInt(to.slice(i,i+2),16)*amount).toString(16).padStart(2,'0')).join('');
/** The tint is full across the world view and gone by the zoom where local areas take over. */
export const FOOTPRINT_TINT_ZOOM=[2.6,3.45] as const;
export function footprintTints(theme:ResolvedAppearance):Record<VisitStatus,string>{
 const p=mapPalette(theme);
 return {lived:mix(p.land,p.areaLived,0.5),visited:mix(p.land,p.areaVisited,0.5),passed:mix(p.land,p.areaPassed,0.45),wishlist:mix(p.land,p.areaWish,0.4)};
}
/** World-view land colour: countries with local footprints glow softly from afar and give way to the real areas on approach. */
export function countryFillColor(theme:ResolvedAppearance,footprints:Map<string,VisitStatus>):unknown{
 const p=mapPalette(theme),tints=footprintTints(theme);
 const groups=(['lived','visited','passed','wishlist'] as const).flatMap(status=>{const codes=[...footprints].filter(([,value])=>value===status).map(([code])=>code).sort();return codes.length?[codes,tints[status]]:[];});
 if(!groups.length)return p.land;
 return ['interpolate',['linear'],['zoom'],FOOTPRINT_TINT_ZOOM[0],['match',['get','countryCode'],...groups,p.land],FOOTPRINT_TINT_ZOOM[1],p.land];
}
