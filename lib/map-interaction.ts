import type{Polygon,MultiPolygon}from'geojson';
interface Hit{layer:{id:string};properties?:Record<string,unknown>|null;}
/** Saved local polygons remain selectable even when their old boundary is suppressed in the current atlas. */
export function chooseMapFeature<T extends Hit>(features:T[]):T|undefined{
 return features.find(f=>f.layer.id==='footprint-ring')
  ??features.find(f=>f.layer.id==='saved-area-fill'&&f.properties?.level==='local')
  ??features.find(f=>f.layer.id.startsWith('local-'))
  ??features.find(f=>f.layer.id==='saved-area-fill')??features[0];
}
export function replacedWorldIds(a:{replaceWorldIds?:string[];retainedWorldIds?:string[]}|undefined,worldIds:string[]):string[]{
 const retained=new Set(a?.retainedWorldIds??[]);
 return(a?.replaceWorldIds?.length?a.replaceWorldIds:worldIds).filter(id=>!retained.has(id));
}
function ringHit(ring:number[][],point:[number,number]):'inside'|'edge'|'outside'{
 let inside=false;const[x,y]=point;
 for(let i=0,j=ring.length-1;i<ring.length;j=i++){
  const[ax,ay]=ring[j],[bx,by]=ring[i];const cross=(x-ax)*(by-ay)-(y-ay)*(bx-ax);
  if(Math.abs(cross)<1e-12&&x>=Math.min(ax,bx)&&x<=Math.max(ax,bx)&&y>=Math.min(ay,by)&&y<=Math.max(ay,by))return'edge';
  if((ay>y)!==(by>y)&&x<(bx-ax)*(y-ay)/(by-ay)+ax)inside=!inside;
 }return inside?'inside':'outside';
}
export function polygonContainsPoint(geometry:Polygon|MultiPolygon,point:[number,number]):boolean{
 point=[((point[0]+180)%360+360)%360-180,point[1]];
 const polygons=geometry.type==='Polygon'?[geometry.coordinates]:geometry.coordinates;
 return polygons.some(rings=>[-360,0,360].some(offset=>{const p:[number,number]=[point[0]+offset,point[1]],outer=ringHit(rings[0],p);return outer==='edge'||outer==='inside'&&!rings.slice(1).some(h=>ringHit(h,p)==='inside');}));
}
/** The exploration cache holds only the current viewport; saved shapes have their own cache. */
export function replaceResidentCountyShapes<T extends{id?:string|number}>(resident:Map<string,T>,previous:Set<string>,next:T[]):Set<string>{
 for(const id of previous)resident.delete(id);
 const ids=new Set<string>();for(const f of next){if(f.id==null)continue;const id=String(f.id);resident.set(id,f);ids.add(id);}return ids;
}
interface Projector{unproject(point:[number,number]):{lng:number;lat:number};project(location:[number,number]):{x:number;y:number};}
/** On the globe, a pointer out in space still maps to a place on the limb, and a feature query there can return
 * a country from the far side. Only a pointer whose place projects back under itself is on the visible surface. */
export function pointerOnSurface(map:Projector,point:{x:number;y:number},tolerance=2):boolean{
 const location=map.unproject([point.x,point.y]),back=map.project([location.lng,location.lat]);
 return Math.hypot(back.x-point.x,back.y-point.y)<=tolerance;
}
