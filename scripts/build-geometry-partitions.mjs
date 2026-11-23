import {readFile,writeFile,mkdir,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {readPackedBoundary} from './boundary-transport.mjs';
const SHA=bytes=>createHash('sha256').update(bytes).digest('hex');
const MAX_SHARD=2*1024*1024,MAX_MANIFEST=8*1024*1024;
const collection=features=>JSON.stringify({type:'FeatureCollection',features});
function safePath(root,url){if(!/^\/data\/[a-zA-Z0-9_./-]+$/.test(url)||url.includes('..'))throw Error('Invalid geometry path');return resolve(root,'.'+url);}
function bounds(geometry){
 const bbox=[Infinity,Infinity,-Infinity,-Infinity];
 const walk=value=>{if(typeof value[0]==='number'){bbox[0]=Math.min(bbox[0],value[0]);bbox[1]=Math.min(bbox[1],value[1]);bbox[2]=Math.max(bbox[2],value[0]);bbox[3]=Math.max(bbox[3],value[1]);}else for(const child of value)walk(child);};walk(geometry.coordinates);
 if(!bbox.every(Number.isFinite))throw Error('Empty geometry');return bbox;
}
// Morton ordering groups two-dimensional neighbours without altering their polygons.
function spatialKey(bbox){
 const x=Math.max(0,Math.min(65535,Math.floor(((bbox[0]+bbox[2])/2+180)/360*65535)));
 const y=Math.max(0,Math.min(65535,Math.floor(((bbox[1]+bbox[3])/2+90)/180*65535)));
 let key=0;for(let bit=0;bit<16;bit++){key+=((x>>>bit)&1)*2**(bit*2);key+=((y>>>bit)&1)*2**(bit*2+1);}return key;
}
/** Build-only: never modifies public source assets. Each feature and coordinate remains exact. */
export async function buildGeometryPartitions(clientDirectory,{targetShardBytes=512*1024,maxShardBytes=MAX_SHARD,removeOriginals=true}={}){
 const root=resolve(clientDirectory);if(!(targetShardBytes>0&&targetShardBytes<=maxShardBytes&&maxShardBytes<=MAX_SHARD))throw Error('Invalid shard budget');
 const coverage=JSON.parse(await readFile(safePath(root,'/data/coverage.json'),'utf8'));
 const alignment=JSON.parse(await readFile(safePath(root,'/data/geometry-alignment.json'),'utf8'));
 let transport={assets:{}};try{transport=JSON.parse(await readFile(safePath(root,'/data/geometry-assets.json'),'utf8'));}catch{}
 const catalog={version:1,maximumShardDecodedBytes:maxShardBytes,countries:{},sources:{},omittedLegacySources:[]};
 const urls=new Set();
 for(const item of coverage){const aligned=alignment.countries[item.code]??{};const primary=aligned.localUrl||item.localUrl;
  // The audited canonical legacy paint is authoritative for an old-only ID.
  const legacy=[...new Set([aligned.legacyPaintUrl,...(aligned.legacyUrls??[]),...(item.legacyUrls??[]),item.paintUrl].filter(url=>url&&url!==primary))];
  catalog.countries[item.code]={primary,legacy};for(const url of [primary,...legacy])urls.add(url);
 }
 await mkdir(safePath(root,'/data/geometry-partitions'),{recursive:true});
 const featureRefs=new Map(),written=new Map();let totalDecoded=0;
 async function writeObject(value,limit){const raw=Buffer.from(JSON.stringify(value));if(raw.length>limit)throw Error(`Geometry partition exceeds decoded budget: ${raw.length}`);
  const sha256=SHA(raw),url=`/data/geometry-partitions/${sha256}.json.gz`;let ref=written.get(url);if(!ref){const packed=gzipSync(raw,{level:9});ref={url,bytes:packed.length,decodedBytes:raw.length,sha256};await writeFile(safePath(root,url),packed);written.set(url,ref);totalDecoded+=raw.length;}return ref;
 }
 for(const url of urls){
  let raw;try{raw=await readFile(safePath(root,url));}catch(error){const asset=transport.assets[url];if(!asset){if([...Object.values(catalog.countries)].some(c=>c.primary===url)||error.code!=='ENOENT')throw error;catalog.omittedLegacySources.push({url,reason:'Source is absent from both raw files and transport catalog'});continue;}raw=gunzipSync(await readPackedBoundary(root,asset),{maxOutputLength:64*1024*1024});if(asset.sha256&&SHA(raw)!==asset.sha256)throw Error(`Source geometry integrity failed: ${url}`);}
  const data=JSON.parse(raw),rows=[],shards=[],shardIndices=new Map();let batch=[],size=Buffer.byteLength(collection([]));
  const addRef=ref=>{let i=shardIndices.get(ref.url);if(i===undefined){i=shards.length;shards.push(ref);shardIndices.set(ref.url,i);}return i;};
  async function flush(){if(!batch.length)return;const ref=await writeObject({type:'FeatureCollection',features:batch.map(x=>x.feature)},maxShardBytes);const index=addRef(ref);
   for(const x of batch){rows.push([x.id,index,x.bbox]);featureRefs.set(x.hash,ref);}batch=[];size=Buffer.byteLength(collection([]));
  }
  const features=data.features.map(feature=>{if(!['Polygon','MultiPolygon'].includes(feature.geometry?.type))throw Error(`Non-polygon source: ${url}`);const id=String(feature.id??feature.properties?.id??'');if(!id)throw Error(`Missing geometry ID: ${url}`);const text=JSON.stringify(feature);return {feature,id,text,hash:SHA(text),bbox:bounds(feature.geometry)};});
  features.sort((a,b)=>spatialKey(a.bbox)-spatialKey(b.bbox)||a.id.localeCompare(b.id));
  for(const x of features){const existing=featureRefs.get(x.hash);if(existing){rows.push([x.id,addRef(existing),x.bbox]);continue;}
   const bytes=Buffer.byteLength(x.text)+1;if(bytes+Buffer.byteLength(collection([]))>maxShardBytes)throw Error(`Single exact geometry exceeds shard budget: ${url} ${x.id}`);
   if(batch.length&&size+bytes>targetShardBytes)await flush();batch.push(x);size+=bytes;
  }await flush();rows.sort((a,b)=>a[0].localeCompare(b[0]));catalog.sources[url]=await writeObject({version:1,source:url,sourceSha256:SHA(raw),rows,shards},MAX_MANIFEST);
 }
 for(const item of Object.values(catalog.countries))item.legacy=item.legacy.filter(url=>catalog.sources[url]);
 if(removeOriginals){for(const url of Object.keys(catalog.sources)){
  const asset=transport.assets[url];for(const path of [url,...(asset?.parts?.map(p=>p.url)??[asset?.url??url+'.gz'])])await unlink(safePath(root,path)).catch(error=>{if(error.code!=='ENOENT')throw error;});delete transport.assets[url];
 }await writeFile(safePath(root,'/data/geometry-assets.json'),JSON.stringify(transport)+'\n');}
 await writeFile(safePath(root,'/data/geometry-partitions.json'),JSON.stringify(catalog)+'\n');
 console.log(`Geometry partitions: ${Object.keys(catalog.sources).length} sources, ${written.size} immutable files, ${(Array.from(written.values()).reduce((sum,x)=>sum+x.bytes,0)/2**20).toFixed(1)} MiB packed, ${(totalDecoded/2**20).toFixed(1)} MiB decoded.`);return catalog;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await buildGeometryPartitions(fileURLToPath(new URL('../dist/client/',import.meta.url)));
