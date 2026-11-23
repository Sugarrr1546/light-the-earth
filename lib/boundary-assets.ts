import {getGeometryDiskCache} from './geometry-disk-cache.ts';
import type {GeometryPersistentCache} from './geometry-partitions';
import type {FeatureCollection,Polygon,MultiPolygon} from 'geojson';
export interface BoundaryAsset {url:string;bytes?:number;decodedBytes?:number;sha256?:string;parts?:{url:string;bytes:number;sha256?:string}[];}
export type BoundaryAssetCatalog=Record<string,BoundaryAsset>;
interface DecodeOptions {signal?:AbortSignal;maxBytes?:number;}
const MAX_BYTES=256*1024*1024; // matches scripts/boundary-transport.mjs
function checkAbort(signal?:AbortSignal){if(signal?.aborted)throw signal.reason??new DOMException('Aborted','AbortError');}
async function boundedBytes(stream:ReadableStream<Uint8Array>,limit:number,signal?:AbortSignal){
 const reader=stream.getReader();const chunks:Uint8Array[]=[];let size=0;
 const abort=()=>{void reader.cancel(signal?.reason);};signal?.addEventListener('abort',abort,{once:true});
 try{
  while(true){checkAbort(signal);const {done,value}=await reader.read();checkAbort(signal);if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new Error('边界文件超过解压大小限制');}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
 }finally{signal?.removeEventListener('abort',abort);reader.releaseLock();}
}
async function decodedBytes(bytes:Uint8Array,{signal,maxBytes=MAX_BYTES}:DecodeOptions={}){
 checkAbort(signal);
 // Fetch may already have decoded Content-Encoding. Detect gzip by its bytes.
 if(bytes[0]===0x1f&&bytes[1]===0x8b){
  const input=Uint8Array.from(bytes);
  const compressed=new ReadableStream<BufferSource>({start(controller){controller.enqueue(input);controller.close();}});
  bytes=await boundedBytes(compressed.pipeThrough(new DecompressionStream('gzip')),maxBytes,signal);
 }else if(bytes.byteLength>maxBytes)throw new Error('边界文件超过解压大小限制');
 checkAbort(signal);return bytes;
}
function parseBoundaryBytes(bytes:Uint8Array){return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;}
export async function decodeBoundaryResponse(response:Response,{signal,maxBytes=MAX_BYTES}:DecodeOptions={}){
 checkAbort(signal);if(!response.ok)throw new Error(`HTTP ${response.status}`);if(!response.body)throw new Error('边界文件为空');
 const bytes=await boundedBytes(response.body,Math.max(maxBytes,10*1024*1024),signal);
 return parseBoundaryBytes(await decodedBytes(bytes,{signal,maxBytes}));
}
function assetPath(value:string){if(!/^\/data\/[a-zA-Z0-9_./-]+$/.test(value)||value.includes('..'))throw new Error('边界文件路径无效');return value;}
function versionedPath(path:string,hash?:string){
 const safe=assetPath(path);if(!hash)return safe;
 if(!/^[a-f0-9]{64}$/.test(hash))throw new Error('边界文件校验目录无效');
 // Multipart names already carry their content hash and are immutable.
 return safe.includes(hash.slice(0,16))?safe:`${safe}?v=${hash}`;
}
async function verifyHash(bytes:Uint8Array,expected:string,signal?:AbortSignal){
 checkAbort(signal);
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(bytes)))).map(x=>x.toString(16).padStart(2,'0')).join('');
 checkAbort(signal);if(hash!==expected)throw new Error('边界文件校验失败');
}
export async function readBoundaryAsset(url:string,signal?:AbortSignal,catalog:BoundaryAssetCatalog={},fetcher:typeof fetch=fetch,persistentCache:GeometryPersistentCache|undefined=getGeometryDiskCache()){
 return parseBoundaryBytes(await fetchBoundaryBytes(url,signal,catalog,fetcher,persistentCache));
}
/** Return verified decoded bytes, ready to transfer to the detail worker. */
export async function fetchBoundaryBytes(url:string,signal?:AbortSignal,catalog:BoundaryAssetCatalog={},fetcher:typeof fetch=fetch,persistentCache:GeometryPersistentCache|undefined=getGeometryDiskCache()){
 const asset=catalog[url];checkAbort(signal);
 const paths=asset?.parts;
 if(paths&&(!paths.length||paths.length>16))throw new Error('边界分片目录无效');
 const refs=(paths??[{url:asset?.url??url,bytes:0}]).map(part=>({...part,path:versionedPath(part.url,paths?part.sha256:asset?.sha256)}));
 async function attempt(useCache:boolean):Promise<Uint8Array>{
  const chunks:Uint8Array[]=[],writes:{path:string;bytes:Uint8Array}[]=[];let total=0,fromCache=false;
  try{
   for(const part of refs){
    checkAbort(signal);
    if(paths&&(!Number.isSafeInteger(part.bytes)||part.bytes<1||part.bytes>=10_000_000))throw new Error('边界分片大小无效');
    let response:Response|undefined;
    if(useCache&&asset?.sha256)try{response=await persistentCache?.match(part.path);if(response)fromCache=true;}catch{/* Optional cache. */}
    if(!response){response=await fetcher(part.path,{signal});}
    checkAbort(signal);if(!response.ok)throw new Error(`HTTP ${response.status}`);if(!response.body)throw new Error('边界文件为空');
    const bytes=await boundedBytes(response.body,MAX_BYTES-total,signal);
    if(paths&&bytes.byteLength!==part.bytes)throw new Error('边界分片长度不符');
    if(paths&&part.sha256)await verifyHash(bytes,part.sha256,signal);
    total+=bytes.byteLength;if(total>MAX_BYTES)throw new Error('边界文件超过解压大小限制');chunks.push(bytes);writes.push({path:part.path,bytes});
   }
   if(paths&&asset?.bytes!=null&&asset.bytes!==total)throw new Error('边界分片总长度不符');
   const result=new Uint8Array(total);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}
   const decoded=await decodedBytes(result,{signal});
   if(asset?.decodedBytes!=null&&decoded.byteLength!==asset.decodedBytes)throw new Error('边界文件解压长度不符');
   if(asset?.sha256)await verifyHash(decoded,asset.sha256,signal);
   checkAbort(signal);
   if(asset?.sha256&&persistentCache&&!fromCache)for(const item of writes)try{await persistentCache.put(item.path,new Response(Uint8Array.from(item.bytes),{headers:{'Content-Type':'application/octet-stream'}}));}catch{/* Quota failure never blocks geography. */}
   return decoded;
  }catch(error){checkAbort(signal);if(!fromCache)throw error;for(const part of refs)try{await persistentCache?.delete(part.path);}catch{}return attempt(false);}
 }
 return attempt(true);
}
export function mergeAreaAssets(legacy:FeatureCollection<Polygon|MultiPolygon>,primary:FeatureCollection<Polygon|MultiPolygon>):FeatureCollection<Polygon|MultiPolygon>{
 const shapes=new Map<string,FeatureCollection<Polygon|MultiPolygon>['features'][number]>();
 for(const f of [...legacy.features,...primary.features]){const id=String(f.id??f.properties?.id??'');if(id&&['Polygon','MultiPolygon'].includes(f.geometry?.type))shapes.set(id,f);}
 return {type:'FeatureCollection',features:[...shapes.values()]};
}
