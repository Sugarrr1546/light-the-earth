import type{GeometryPersistentCache}from'./geometry-partitions';
/** Only content-hashed public geography; private APIs and records never enter this cache. */
export function createGeometryDiskCache(storage:CacheStorage|undefined=typeof caches==='undefined'?undefined:caches):GeometryPersistentCache|undefined{
 if(!storage)return;
 let opened:Promise<Cache|null>|undefined;let writes=0;let pruning=false;
 const open=()=>opened??=storage.open('atlas-boundary-sha256-v1').catch(()=>null);
 const allowed=(url:string)=>!url.includes('..')&&(/^\/data\/(?:geometry-partitions|map-resources)\/[a-f0-9]{64}\.json\.gz$/.test(url)||/^\/data\/[a-zA-Z0-9_./-]+\.(?:json|geojson)\.gz\?v=[a-f0-9]{64}$/.test(url)||/^\/data\/[a-zA-Z0-9_./-]+\.gz\.part-\d{3}-[a-f0-9]{16}\.bin$/.test(url));
 async function prune(cache:Cache){if(pruning)return;pruning=true;try{const keys=await cache.keys();for(const key of keys.slice(0,Math.max(0,keys.length-4096)))await cache.delete(key);}catch{/* Browser owns storage quota. */}finally{pruning=false;}}
 return {
  async match(url){if(!allowed(url))return;try{return await(await open())?.match(url);}catch{return;}},
  async put(url,response){if(!allowed(url))return;try{const cache=await open();if(!cache)return;await cache.put(url,response);if(++writes%32===0)void prune(cache);}catch{/* Cache/quota failure never blocks the map. */}},
  async delete(url){if(allowed(url))try{await(await open())?.delete(url);}catch{/* Optional cache. */}},
 };
}

let shared:ReturnType<typeof createGeometryDiskCache>;
export function getGeometryDiskCache(){return shared??=createGeometryDiskCache();}
