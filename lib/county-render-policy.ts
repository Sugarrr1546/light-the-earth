import type {GeoJSONSourceSpecification} from 'maplibre-gl';
/** Keep exact large-country geometry warm in RAM without cloning it all into the renderer. */
export interface CountyRenderPolicy {viewport:boolean;minZoom:number;}
export function countyRenderPolicy(bytes:number,count:number,countryCode?:string):CountyRenderPolicy {
 const viewport=bytes>=8*1024*1024||count>=1500;
 // Measured dense IND/BRA views need the next zoom level; all exact shards still preload.
 const denseLimit=countryCode==='IND'||countryCode==='BRA'?5000:10000;
 return {viewport,minZoom:viewport?(count>=denseLimit?6.5:5.5):3.45};
}
/** Overview changes need no setData; retain sub-degree precision for city pans. */
export function countyViewKey(policy:CountyRenderPolicy,zoom:number,view:[number,number,number,number],selectedId?:string):string {
 return zoom<policy.minZoom?(selectedId?`selection:${selectedId}`:'overview'):view.map(value=>value.toFixed(6)).join(',');
}

type DisplayFeature={id?:string|number;geometry:unknown;properties:unknown};
/** Shared decoded shapes are immutable; keep the worker source when its exact view did not change. */
export function sameCountyView(previous:readonly DisplayFeature[]|undefined,next:readonly DisplayFeature[]):boolean {
 return !!previous&&previous.length===next.length&&previous.every((feature,i)=>feature.id===next[i].id&&feature.geometry===next[i].geometry&&feature.properties===next[i].properties);
}

/** Rendering needs modest overscan; whole-country preload already supplies the memory cushion. */
export function countyRenderView(west:number,south:number,east:number,north:number):[number,number,number,number] {
 const width=east>=west?east-west:east+360-west;
 const x=Math.max(width*0.15,0.000001),y=Math.max((north-south)*0.15,0.000001);
 return [west-x,Math.max(-85,south-y),west+width+x,Math.min(85,north+y)];
}

/** Preserve the canonical region identity when MapLibre serializes GeoJSON into integer-ID tiles. */
export function countySourceSpecification(data:NonNullable<GeoJSONSourceSpecification['data']>,attribution?:string):GeoJSONSourceSpecification {
 return {type:'geojson',data,promoteId:'id',tolerance:0.1,maxzoom:14,attribution};
}
