import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const area=(id,x=0)=>({type:'Feature',id,properties:{id,bbox:[99,99,99,99]},geometry:{type:'Polygon',coordinates:[[[x,0],[x+1,0],[x+1,1],[x,0]]]}});
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'atlas-partitions-'));await mkdir(join(dir,'data'),{recursive:true});
 const primary={type:'FeatureCollection',features:[area('a'),area('b',5),area('c',10)]},legacy={type:'FeatureCollection',features:[area('old',20)]};
 await writeFile(join(dir,'data/current.geojson'),JSON.stringify(primary));await writeFile(join(dir,'data/old.geojson'),JSON.stringify(legacy));
 await writeFile(join(dir,'data/coverage.json'),JSON.stringify([{code:'CHN',localUrl:'/data/current.geojson',legacyUrls:['/data/old.geojson']}]));
 await writeFile(join(dir,'data/geometry-alignment.json'),JSON.stringify({countries:{CHN:{localUrl:'/data/current.geojson'}}}));
 return {dir,primary,legacy};
}
async function modules(){
 await assert.doesNotReject(access(new URL('../scripts/build-geometry-partitions.mjs',import.meta.url)),'partition builder must exist');
 const {buildGeometryPartitions}=await import('../scripts/build-geometry-partitions.mjs');
 const {createGeometryPartitionReader}=await import('../lib/geometry-partitions.ts');return {buildGeometryPartitions,createGeometryPartitionReader};
}
test('exact ID and viewport reads fetch bounded content-addressed shards, including original legacy IDs',async()=>{
 const {buildGeometryPartitions,createGeometryPartitionReader}=await modules();const {dir,primary,legacy}=await fixture();
 try{
  const catalog=await buildGeometryPartitions(dir,{targetShardBytes:250,maxShardBytes:2048,removeOriginals:false});const requests=[];
  const reader=createGeometryPartitionReader({catalog,fetcher:async(url,{signal}={})=>{assert.equal(signal?.aborted??false,false);requests.push(url);return new Response(await readFile(join(dir,url)));}});
  assert.deepEqual((await reader.readIDs('CHN',['a'])).features,[primary.features[0]]);assert.equal(requests.length,2);
  assert.ok(requests.every(url=>/\/data\/geometry-partitions\/[a-f0-9]{64}\.json\.gz$/.test(url)));
  assert.deepEqual((await reader.readView('CHN',[4.5,-1,6.5,2])).features,[primary.features[1]]);
  assert.deepEqual((await reader.readPoint('CHN',[10.1,.1])).features,[primary.features[2]]);
  assert.deepEqual((await reader.readIDs('CHN',['old'])).features,legacy.features);
  assert.deepEqual((await reader.readSourceIDs('/data/old.geojson',['old'])).features,legacy.features);
  assert.ok(requests.length<9,'only candidate shards are read, while manifests and earlier shards are cached');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('shard integrity, decode budget and abort apply before accepting geometry',async()=>{
 const {buildGeometryPartitions,createGeometryPartitionReader}=await modules();const {dir}=await fixture();
 try{
  const catalog=await buildGeometryPartitions(dir,{targetShardBytes:250,maxShardBytes:2048,removeOriginals:false});let calls=0;
  const reader=createGeometryPartitionReader({catalog,maxReadBytes:200,fetcher:async url=>{calls++;return new Response(await readFile(join(dir,url)));}});
  await assert.rejects(reader.readView('CHN',[-180,-90,180,90]),/budget|预算/);assert.equal(calls,1,'request budget checked after manifest, before fetching shards');
  const bad=createGeometryPartitionReader({catalog,fetcher:async()=>new Response('tampered')});await assert.rejects(bad.readIDs('CHN',['a']),/integrity|校验|长度/);
  const abort=new AbortController();abort.abort();await assert.rejects(reader.readIDs('CHN',['a'],abort.signal),{name:'AbortError'});
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('partition packaging replaces whole-resource transports and preserves the exact decoded source',async()=>{
 const {buildGeometryPartitions,createGeometryPartitionReader}=await modules();const {packGeometry}=await import('../scripts/pack-geometry.mjs');const {dir,primary}=await fixture();
 try{
  await packGeometry(dir);const catalog=await buildGeometryPartitions(dir,{targetShardBytes:250,maxShardBytes:2048});
  await assert.rejects(access(join(dir,'data/current.geojson.gz')));const transport=JSON.parse(await readFile(join(dir,'data/geometry-assets.json'),'utf8'));assert.equal(transport.assets['/data/current.geojson'],undefined);
  const reader=createGeometryPartitionReader({catalog,fetcher:async url=>new Response(await readFile(join(dir,url)))});
  const result=await reader.readIDs('CHN',['a','b','c']);assert.deepEqual(result.features.sort((a,b)=>a.id.localeCompare(b.id)),primary.features);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('cancellation interrupts an active body stream and keeps the cache free of partial geometry',async()=>{
 const {buildGeometryPartitions,createGeometryPartitionReader}=await modules();const {dir}=await fixture();
 try{
  const catalog=await buildGeometryPartitions(dir,{targetShardBytes:250,maxShardBytes:2048,removeOriginals:false});const abort=new AbortController();let cancelReason,fetchSignal;
  const reader=createGeometryPartitionReader({catalog,fetcher:async(url,{signal})=>{fetchSignal=signal;return new Response(new ReadableStream({start(){setImmediate(()=>abort.abort());},cancel(reason){cancelReason=reason;}}));}});
  await assert.rejects(reader.readIDs('CHN',['a'],abort.signal),{name:'AbortError'});assert.equal(fetchSignal,abort.signal);assert.equal(cancelReason,abort.signal.reason);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('nearby view candidates share spatial shards despite interleaved distant latitudes',async()=>{
 const {buildGeometryPartitions,createGeometryPartitionReader}=await modules();const {dir}=await fixture();
 try{
  const features=[];for(let i=0;i<10;i++)for(const y of [0,50]){const x=i*.01+(y===0?0:.005);features.push({type:'Feature',id:`${i}-${y}`,properties:{id:`${i}-${y}`},geometry:{type:'Polygon',coordinates:[[[x,y],[x+.001,y],[x+.001,y+.001],[x,y]]]}});}
  await writeFile(join(dir,'data/current.geojson'),JSON.stringify({type:'FeatureCollection',features}));
  const catalog=await buildGeometryPartitions(dir,{targetShardBytes:500,maxShardBytes:2048,removeOriginals:false});
  const reader=createGeometryPartitionReader({catalog,maxReadShards:6,fetcher:async url=>new Response(await readFile(join(dir,url)))});
  assert.equal((await reader.readView('CHN',[-1,-1,1,1])).features.length,10);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('wrapped and date-line-crossing viewports resolve the same exact candidates',async()=>{
 const {buildGeometryPartitions,createGeometryPartitionReader}=await modules();const {dir}=await fixture();
 try{
  const edge=area('edge',-179);await writeFile(join(dir,'data/current.geojson'),JSON.stringify({type:'FeatureCollection',features:[edge]}));
  const catalog=await buildGeometryPartitions(dir,{targetShardBytes:500,maxShardBytes:2048,removeOriginals:false});const reader=createGeometryPartitionReader({catalog,fetcher:async url=>new Response(await readFile(join(dir,url)))});
  assert.deepEqual((await reader.readView('CHN',[179,-1,182,2])).features,[edge]);
  assert.deepEqual((await reader.readView('CHN',[179,-1,-178,2])).features,[edge]);
  assert.deepEqual((await reader.readPoint('CHN',[181.5,.1])).features,[edge]);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('canonical legacy paint wins same-ID older derivatives and missing optional sources are audited',async()=>{
 const {buildGeometryPartitions,createGeometryPartitionReader}=await modules();const {dir}=await fixture();
 try{
  const canonical=area('old',30);await writeFile(join(dir,'data/canonical.geojson'),JSON.stringify({type:'FeatureCollection',features:[canonical]}));
  await writeFile(join(dir,'data/coverage.json'),JSON.stringify([{code:'CHN',localUrl:'/data/current.geojson',legacyUrls:['/data/old.geojson','/data/missing.geojson']}]));
  await writeFile(join(dir,'data/geometry-alignment.json'),JSON.stringify({countries:{CHN:{localUrl:'/data/current.geojson',legacyPaintUrl:'/data/canonical.geojson'}}}));
  const catalog=await buildGeometryPartitions(dir,{targetShardBytes:500,maxShardBytes:2048,removeOriginals:false});const reader=createGeometryPartitionReader({catalog,fetcher:async url=>new Response(await readFile(join(dir,url)))});
  assert.deepEqual((await reader.readIDs('CHN',['old'])).features,[canonical]);assert.ok(catalog.omittedLegacySources.some(entry=>entry.url==='/data/missing.geojson'));
  await rm(join(dir,'data/current.geojson'));await assert.rejects(buildGeometryPartitions(dir,{removeOriginals:false}),/ENOENT/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('a reused cross-source shard cannot supply a same-ID polygon assigned to another shard',async()=>{
 const {buildGeometryPartitions,createGeometryPartitionReader}=await modules();const {dir,primary}=await fixture();
 try{
  const changed=area('b',20),legacy={type:'FeatureCollection',features:[primary.features[0],changed]};await writeFile(join(dir,'data/old.geojson'),JSON.stringify(legacy));
  const catalog=await buildGeometryPartitions(dir,{targetShardBytes:2048,maxShardBytes:2048,removeOriginals:false});const reader=createGeometryPartitionReader({catalog,fetcher:async url=>new Response(await readFile(join(dir,url)))});
  assert.deepEqual((await reader.readSourceIDs('/data/old.geojson',['a','b'])).features,legacy.features);
 }finally{await rm(dir,{recursive:true,force:true});}
});
