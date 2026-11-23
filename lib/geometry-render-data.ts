import type {FeatureCollection} from 'geojson';
interface Options {
 createURL?:((blob:Blob)=>string)|null;
 revokeURL?:(url:string)=>void;
}
/** Immutable static land sources can be read by workers without recursively cloning coordinate arrays. */
export function createGeometryRenderData(options:Options={}){
 const create=options.createURL===null?null:options.createURL??(typeof URL.createObjectURL==='function'?(blob:Blob)=>URL.createObjectURL(blob):null);
 const revoke=options.revokeURL??((url:string)=>URL.revokeObjectURL(url));
 let disposed=false,cache=new WeakMap<FeatureCollection,string|FeatureCollection>();
 const urls=new Set<string>();
 const originals=new Map<string,FeatureCollection>();
 function dispose(){if(disposed)return;disposed=true;for(const url of urls)revoke(url);urls.clear();originals.clear();cache=new WeakMap();}
 return {
  source(data:FeatureCollection):string|FeatureCollection {
   if(disposed)throw Error('Geometry render data pool is disposed');
   const prior=cache.get(data);if(prior)return prior;
   let source:string|FeatureCollection=data;
   if(create&&typeof Blob==='function'){
    try{source=create(new Blob([JSON.stringify(data)],{type:'application/json'}));urls.add(source);originals.set(source,data);}
    catch{/* Preserve the existing direct-object path where Blob URLs are unavailable. */}
   }
   cache.set(data,source);return source;
  },
  // Call only after removing every map source using this country's URLs.
  dispose,
  original(url:string){return originals.get(url);},
  disposeUnlessReferenced(references:Iterable<string>){for(const url of references)if(urls.has(url))return false;dispose();return true;},
 };
}

/** Keep the measured optimization scoped to the expensive US-neighbor land source. */
export function countryLandSource(code:string,data:FeatureCollection,pool:ReturnType<typeof createGeometryRenderData>):string|FeatureCollection {
 return code==='CAN'?pool.source(data):data;
}
