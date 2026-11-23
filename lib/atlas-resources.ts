import {readBoundaryAsset,type BoundaryAsset} from './boundary-assets.ts';
import {getGeometryDiskCache} from './geometry-disk-cache.ts';
import type {GeometryPersistentCache} from './geometry-partitions';
const allowed=new Set(['/data/geometry-assets.json','/data/geometry-partitions.json','/data/coverage.json','/data/geometry-alignment.json','/data/name-quality.json']);
interface Bootstrap{version:number;assets:Record<string,BoundaryAsset>;}
interface Options{fetcher?:typeof fetch;persistentCache?:GeometryPersistentCache;}
/** One shared version check per page; independently requested metadata never waits for names. */
export function createAtlasResources({fetcher=fetch,persistentCache=getGeometryDiskCache()}:Options={}){
 let bootstrap:Promise<Bootstrap|null>|undefined;const jobs=new Map<string,Promise<unknown>>();
 function manifest(){return bootstrap??=(async()=>{const r=await fetcher('/data/map-bootstrap.json',{cache:'no-cache'});if(r.status===404)return null;if(!r.ok)throw Error(`HTTP ${r.status}`);const data=await r.json() as Bootstrap;if(data.version!==1||!data.assets)throw Error('地图资源目录无效');return data;})().catch(e=>{bootstrap=undefined;throw e;});}
 return{read<T=unknown>(path:string):Promise<T>{if(!allowed.has(path))return Promise.reject(Error('地图资源路径无效'));let job=jobs.get(path);if(!job){job=(async()=>{const ref=(await manifest())?.assets[path];if(ref)return readBoundaryAsset(path,undefined,{[path]:ref},fetcher,persistentCache);const r=await fetcher(path);if(!r.ok)throw Error(`HTTP ${r.status}`);return r.json();})().catch(e=>{jobs.delete(path);throw e;});jobs.set(path,job);}return job as Promise<T>;}};
}
let shared:ReturnType<typeof createAtlasResources>|undefined;
export function atlasResources(){return shared??=createAtlasResources();}
