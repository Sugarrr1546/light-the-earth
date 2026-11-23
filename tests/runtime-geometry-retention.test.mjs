import test from 'node:test';import assert from 'node:assert/strict';
import{mkdtemp,mkdir,writeFile,readFile,rm,access}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{gunzipSync}from'node:zlib';
import{packGeometry}from'../scripts/pack-geometry.mjs';
const f={type:'Feature',id:'history-1',properties:{id:'history-1',name:'旧记录'},geometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[0,1],[0,0]]]}};
async function fixture({changed=false,liveOld=false}={}){
 const dir=await mkdtemp(join(tmpdir(),'atlas-retention-'));await mkdir(join(dir,'data/precision'),{recursive:true});
 const put=(p,v)=>writeFile(join(dir,'data',p),JSON.stringify(v));const old='/data/precision/chn-zhejiang-current.geojson',current='/data/precision/chn-central-current.geojson';
 await put('precision/chn-zhejiang-current.geojson',{type:'FeatureCollection',features:[f]});
 await put('precision/chn-central-current.geojson',{type:'FeatureCollection',features:[changed?{...f,properties:{...f.properties,name:'silently changed'}}:f,{...f,id:'new-1',properties:{...f.properties,id:'new-1'}}]});
 await put('current-zhejiang.json',{alignment:{localUrl:old}});await put('current-central-china.json',{alignment:{localUrl:current}});
 await put('geometry-alignment.json',{countries:{CHN:{localUrl:current,...(liveOld?{legacyPaintUrl:old}:{})}}});
 await put('display-meshes.json',{countries:{CHN:{url:current}}});await put('coverage.json',[{code:'CHN',localUrl:current,legacyUrls:[old]}]);await packGeometry(dir);return{dir,old,current};
}
test('redundant snapshots leave production only when every historical object survives exactly in the current mesh',async()=>{
 const {pruneHistoricalSupersets}=await import('../scripts/prune-historical-supersets.mjs');
 const {dir,old,current}=await fixture();try{
 const result=await pruneHistoricalSupersets(dir);assert.equal(result.omitted.length,1);assert.equal(result.omitted[0].preservedFeatureCount,1);
 const catalog=JSON.parse(await readFile(join(dir,'data/geometry-assets.json')));assert.ok(catalog.assets[current]);assert.equal(catalog.assets[old],undefined);
 await assert.rejects(access(join(dir,old+'.gz')));const live=JSON.parse(gunzipSync(await readFile(join(dir,current+'.gz'))));assert.deepEqual(live.features[0],f);
 assert.deepEqual(JSON.parse(await readFile(join(dir,'data/coverage.json')))[0].legacyUrls,[]);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('history pruning rejects changed objects and runtime dependencies without deleting their snapshots',async()=>{
 const {pruneHistoricalSupersets}=await import('../scripts/prune-historical-supersets.mjs');
 for(const options of [{changed:true},{liveOld:true}]){const{dir,old}=await fixture(options);try{await assert.rejects(pruneHistoricalSupersets(dir));await access(join(dir,old+'.gz'));}finally{await rm(dir,{recursive:true,force:true});}}
});
