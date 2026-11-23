import type {Feature,FeatureCollection,Polygon,MultiPolygon} from 'geojson';
type Area=Feature<Polygon|MultiPolygon>;
export type GeometryBBox=[number,number,number,number];
export interface GeometryPartitionAsset {url:string;bytes:number;decodedBytes:number;sha256:string;}
export interface GeometryPartitionCatalog {version:1;maximumShardDecodedBytes:number;countries:Record<string,{primary:string;legacy:string[]}>;sources:Record<string,GeometryPartitionAsset>;omittedLegacySources?:{url:string;reason:string}[];}
export interface GeometryPersistentCache {match:(url:string)=>Promise<Response|undefined>;put:(url:string,response:Response)=>Promise<unknown>;delete:(url:string)=>Promise<unknown>;}
interface SourceManifest {version:1;source:string;sourceSha256:string;rows:[string,number,GeometryBBox][];shards:GeometryPartitionAsset[];}
interface Options {catalog:GeometryPartitionCatalog;fetcher?:typeof fetch;maxReadBytes?:number;maxReadShards?:number;cacheBytes?:number;manifestCacheBytes?:number;concurrency?:number;keepInFlight?:boolean;persistentCache?:GeometryPersistentCache;}
interface Budget {bytes:number;shards:Set<string>;}
const MAX_SHARD=2*1024*1024,MAX_MANIFEST=8*1024*1024;
const empty=():FeatureCollection<Polygon|MultiPolygon>=>({type:'FeatureCollection',features:[]});
function checkAbort(signal?:AbortSignal){if(signal?.aborted)throw signal.reason??new DOMException('Aborted','AbortError');}
function intersects(a:GeometryBBox,b:GeometryBBox){return a[0]<=b[2]&&a[2]>=b[0]&&a[3]>=b[1]&&a[1]<=b[3];}
function viewBoxes(bbox:GeometryBBox):GeometryBBox[]{
 if(!Array.isArray(bbox)||bbox.length!==4||!bbox.every(Number.isFinite)||bbox[1]>bbox[3])throw Error('Invalid geometry viewport');
 const width=bbox[2]>=bbox[0]?bbox[2]-bbox[0]:bbox[2]+360-bbox[0];
 if(width<0)throw Error('Invalid geometry viewport');if(width>=360)return [[-180,bbox[1],180,bbox[3]]];
 const west=((bbox[0]+180)%360+360)%360-180,east=west+width;
 return east<=180?[[west,bbox[1],east,bbox[3]]]:[[west,bbox[1],180,bbox[3]],[-180,bbox[1],east-360,bbox[3]]];
}
function validBox(b:unknown):b is GeometryBBox{return Array.isArray(b)&&b.length===4&&b.every(Number.isFinite)&&b[0]<=b[2]&&b[1]<=b[3];}
function validateRef(asset:GeometryPartitionAsset,limit:number){
 if(!asset||!/^\/data\/geometry-partitions\/[a-f0-9]{64}\.json\.gz$/.test(asset.url)||!Number.isSafeInteger(asset.bytes)||asset.bytes<1||asset.bytes>limit||!Number.isSafeInteger(asset.decodedBytes)||asset.decodedBytes<1||asset.decodedBytes>limit||!/^[a-f0-9]{64}$/.test(asset.sha256)||!asset.url.includes(asset.sha256))throw Error('Geometry partition budget or reference invalid');
}
async function bounded(stream:ReadableStream<Uint8Array>,limit:number,signal?:AbortSignal){
 const reader=stream.getReader(),chunks:Uint8Array[]=[];let size=0;const cancel=()=>{void reader.cancel(signal?.reason).catch(()=>{});};signal?.addEventListener('abort',cancel,{once:true});
 try{while(true){checkAbort(signal);const {value,done}=await reader.read();checkAbort(signal);if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw Error('Geometry partition decode budget exceeded');}chunks.push(value);}const result=new Uint8Array(size);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return result;
 }finally{signal?.removeEventListener('abort',cancel);reader.releaseLock();}
}
function waitFor<T>(promise:Promise<T>,signal?:AbortSignal):Promise<T>{
 checkAbort(signal);if(!signal)return promise;
 return new Promise((resolve,reject)=>{const abort=()=>{cleanup();reject(signal.reason??new DOMException('Aborted','AbortError'));};const cleanup=()=>signal.removeEventListener('abort',abort);signal.addEventListener('abort',abort,{once:true});promise.then(value=>{cleanup();if(signal.aborted)abort();else resolve(value);},error=>{cleanup();reject(error);});});
}
/** Exact original polygons with shared foreground-priority reads and optional immutable disk cache. */
export function createGeometryPartitionReader({catalog,fetcher=fetch,maxReadBytes=16*1024*1024,maxReadShards=64,cacheBytes=8*1024*1024,manifestCacheBytes=12*1024*1024,concurrency=1,keepInFlight=false,persistentCache}:Options){
 if(catalog.version!==1||catalog.maximumShardDecodedBytes>MAX_SHARD)throw Error('Unsupported geometry partition catalog');
 concurrency=Math.max(1,Math.min(8,Math.floor(concurrency)));
 const manifests=new Map<string,{value:SourceManifest;bytes:number}>(),shapes=new Map<string,{value:FeatureCollection<Polygon|MultiPolygon>;bytes:number}>();
 type Job={key:string;background:boolean;running:boolean;controller:AbortController;promise:Promise<unknown>;resolve:(v:unknown)=>void;reject:(e:unknown)=>void;load:(signal:AbortSignal)=>Promise<unknown>};
 const jobs=new Map<string,Job>();const queue:Job[]=[];let running=0,backgroundRunning=0;
 function pump(){
  while(running<concurrency){const i=queue.findIndex(j=>!j.background);const index=i>=0?i:backgroundRunning<Math.min(2,concurrency)?queue.findIndex(j=>j.background):-1;if(index<0)return;
   const job=queue.splice(index,1)[0];job.running=true;running++;if(job.background)backgroundRunning++;
   void(async()=>{try{checkAbort(job.controller.signal);job.resolve(await job.load(job.controller.signal));}catch(error){job.reject(error);}finally{running--;if(job.background)backgroundRunning--;if(jobs.get(job.key)===job)jobs.delete(job.key);pump();}})();
  }
 }
 function shared<T>(key:string,load:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal,background=false):Promise<T>{
  checkAbort(signal);let job=jobs.get(key);
  if(!job){let resolve!:(v:unknown)=>void,reject!:(e:unknown)=>void;const promise=new Promise<unknown>((a,b)=>{resolve=a;reject=b;});void promise.catch(()=>{});job={key,background,running:false,controller:new AbortController(),promise,resolve,reject,load};jobs.set(key,job);queue.push(job);pump();}
  else if(!background&&job.background&&!job.running){job.background=false;pump();}
  return waitFor(job.promise as Promise<T>,signal);
 }
 function cached<T>(cache:Map<string,{value:T;bytes:number}>,key:string){const entry=cache.get(key);if(entry){cache.delete(key);cache.set(key,entry);}return entry?.value;}
 function retain<T>(cache:Map<string,{value:T;bytes:number}>,key:string,value:T,bytes:number,limit:number){if(bytes>limit)return;cache.delete(key);cache.set(key,{value,bytes});let total=0;for(const x of cache.values())total+=x.bytes;while(total>limit){const oldest=cache.keys().next().value!;total-=cache.get(oldest)!.bytes;cache.delete(oldest);}}
 async function read(asset:GeometryPartitionAsset,limit:number,signal?:AbortSignal){
  checkAbort(signal);validateRef(asset,limit);let stored:Response|undefined;try{stored=await persistentCache?.match(asset.url);}catch{/* Optional storage. */}checkAbort(signal);
  async function decode(response:Response,save:boolean){
   checkAbort(signal);if(!response.ok)throw Error(`HTTP ${response.status}`);if(!response.body)throw Error('Empty geometry partition');
   const wire=await bounded(response.body,limit,signal);let bytes=wire;
   if(bytes[0]===0x1f&&bytes[1]===0x8b){if(bytes.length!==asset.bytes)throw Error('Geometry partition integrity length mismatch');const copy=Uint8Array.from(bytes);const stream=new ReadableStream<BufferSource>({start(controller){controller.enqueue(copy);controller.close();}});bytes=await bounded(stream.pipeThrough(new DecompressionStream('gzip')),asset.decodedBytes,signal);}
   if(bytes.length!==asset.decodedBytes)throw Error('Geometry partition integrity decoded length mismatch');
   const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(bytes)))).map(x=>x.toString(16).padStart(2,'0')).join('');checkAbort(signal);if(hash!==asset.sha256)throw Error('Geometry partition integrity SHA-256 mismatch');
   const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));checkAbort(signal);
   if(save&&persistentCache)void persistentCache.put(asset.url,new Response(Uint8Array.from(wire),{headers:{'Content-Type':'application/octet-stream'}})).catch(()=>{});
   return value;
  }
  if(stored){try{return await decode(stored,false);}catch(error){checkAbort(signal);try{await persistentCache?.delete(asset.url);}catch{/* Network still works. */}}}
  return decode(await fetcher(asset.url,{signal}),true);
 }
 async function manifest(url:string,signal?:AbortSignal,background=false):Promise<SourceManifest>{
  checkAbort(signal);const ref=catalog.sources[url];if(!ref)throw Error(`Missing partitioned geometry source: ${url}`);const prior=cached(manifests,ref.url);if(prior)return prior;
  const load=async(innerSignal?:AbortSignal)=>{
   const again=cached(manifests,ref.url);if(again)return again;
   const value=await read(ref,MAX_MANIFEST,innerSignal) as SourceManifest;
   if(value.version!==1||value.source!==url||!Array.isArray(value.rows)||!Array.isArray(value.shards))throw Error('Invalid geometry source manifest');
   for(const shard of value.shards)validateRef(shard,MAX_SHARD);
   const ids=new Set<string>();for(const row of value.rows){if(!Array.isArray(row)||row.length!==3||typeof row[0]!=='string'||ids.has(row[0])||!Number.isSafeInteger(row[1])||row[1]<0||row[1]>=value.shards.length||!validBox(row[2]))throw Error('Invalid geometry ID index');ids.add(row[0]);}
   checkAbort(innerSignal);retain(manifests,ref.url,value,ref.decodedBytes,manifestCacheBytes);return value;
  };
  return keepInFlight?shared(ref.url,load,signal,background):load(signal);
 }
 async function shard(ref:GeometryPartitionAsset,signal?:AbortSignal,background=false):Promise<FeatureCollection<Polygon|MultiPolygon>>{
  checkAbort(signal);const prior=cached(shapes,ref.url);if(prior)return prior;
  const load=async(innerSignal?:AbortSignal)=>{const again=cached(shapes,ref.url);if(again)return again;const data=await read(ref,MAX_SHARD,innerSignal)as FeatureCollection<Polygon|MultiPolygon>;if(data.type!=='FeatureCollection'||!Array.isArray(data.features)||data.features.some(f=>f.type!=='Feature'||!['Polygon','MultiPolygon'].includes(f.geometry?.type)))throw Error('Invalid geometry shard');checkAbort(innerSignal);retain(shapes,ref.url,data,ref.decodedBytes,cacheBytes);return data;};
  return keepInFlight?shared(ref.url,load,signal,background):load(signal);
 }
 async function sourceRows(url:string,predicate:(row:SourceManifest['rows'][number])=>boolean,budget:Budget,signal?:AbortSignal){
  const index=await manifest(url,signal);checkAbort(signal);const selected=index.rows.filter(predicate);if(!selected.length)return empty();const indices=[...new Set(selected.map(row=>row[1]))];
  let newBytes=0,newShards=0;for(const i of indices){const ref=index.shards[i];if(!budget.shards.has(ref.url)){newBytes+=ref.decodedBytes;newShards++;}}
  if(budget.bytes+newBytes>maxReadBytes||budget.shards.size+newShards>maxReadShards)throw Error('Geometry request budget exceeded');
  for(const i of indices){const ref=index.shards[i];if(!budget.shards.has(ref.url)){budget.shards.add(ref.url);budget.bytes+=ref.decodedBytes;}}
  const assigned=new Map<number,Set<string>>();for(const [id,i]of selected){const ids=assigned.get(i)??new Set<string>();ids.add(id);assigned.set(i,ids);}
  const groups:Area[][]=new Array(indices.length);let next=0;
  await Promise.all(Array.from({length:Math.min(concurrency,indices.length)},async()=>{while(next<indices.length){checkAbort(signal);const n=next++,i=indices[n],data=await shard(index.shards[i],signal);const wanted=new Set(assigned.get(i));const features:Area[]=[];for(const feature of data.features){const id=String(feature.id??feature.properties?.id??'');if(wanted.delete(id))features.push(feature);}if(wanted.size)throw Error('Geometry shard missing indexed IDs');groups[n]=features;}}));
  checkAbort(signal);return {type:'FeatureCollection' as const,features:groups.flat()};
 }
 function country(code:string){const value=catalog.countries[code];if(!value)throw Error(`Missing geometry country: ${code}`);return value;}
 const freshBudget=():Budget=>({bytes:0,shards:new Set()});
 return {
  async readIDs(code:string,ids:readonly string[],signal?:AbortSignal){checkAbort(signal);if(!ids.length)return empty();const entry=country(code),wanted=new Set(ids),result=empty(),budget=freshBudget();
   for(const url of [entry.primary,...entry.legacy]){const data=await sourceRows(url,row=>wanted.has(row[0]),budget,signal);for(const feature of data.features){result.features.push(feature);wanted.delete(String(feature.id??feature.properties?.id));}if(!wanted.size)break;}return result;
  },
  async readSourceIDs(url:string,ids:readonly string[],signal?:AbortSignal){checkAbort(signal);const wanted=new Set(ids);return wanted.size?sourceRows(url,row=>wanted.has(row[0]),freshBudget(),signal):empty();},
  async readView(code:string,bbox:GeometryBBox,signal?:AbortSignal){const boxes=viewBoxes(bbox);return sourceRows(country(code).primary,row=>boxes.some(box=>intersects(row[2],box)),freshBudget(),signal);},
  async readPoint(code:string,point:[number,number],signal?:AbortSignal){if(!point.every(Number.isFinite))throw Error('Invalid geometry point');const x=((point[0]+180)%360+360)%360-180,y=point[1];return sourceRows(country(code).primary,row=>intersects(row[2],[x,y,x,y]),freshBudget(),signal);},
  isCountryReady(code:string){const entry=country(code),ref=catalog.sources[entry.primary];const index=ref?manifests.get(ref.url)?.value:undefined;return !!index&&index.shards.every(s=>shapes.has(s.url));},
  async preloadCountry(code:string,{signal,onProgress}:{signal?:AbortSignal;onProgress?:(done:number,total:number)=>void}={}){
   const index=await manifest(country(code).primary,signal,true);let next=0,done=0;onProgress?.(0,index.shards.length);
   await Promise.all(Array.from({length:Math.min(2,index.shards.length)},async()=>{while(next<index.shards.length){checkAbort(signal);const ref=index.shards[next++];await shard(ref,signal,true);done++;onProgress?.(done,index.shards.length);}}));checkAbort(signal);
  },
  /** Drop decoded geometry held in memory; reads still in flight finish, and the disk cache stays. */
  releaseMemory(){manifests.clear();shapes.clear();},
  clear(){for(const job of jobs.values()){job.controller.abort(new DOMException('Reader cleared','AbortError'));job.reject(job.controller.signal.reason);}jobs.clear();queue.length=0;manifests.clear();shapes.clear();},
 };
}
