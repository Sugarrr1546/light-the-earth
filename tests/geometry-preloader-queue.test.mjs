import test from'node:test';import assert from'node:assert/strict';
import{createGeometryPreloader}from'../lib/geometry-preload.ts';
import{createGeometryDiskCache}from'../lib/geometry-disk-cache.ts';
const tick=()=>new Promise(r=>setImmediate(r));
test('background queue favors the latest targets without throwing away a running country or repeating completed work',async()=>{
 const pending=[],states=[];const p=createGeometryPreloader({load:(code,signal,onProgress)=>new Promise((resolve,reject)=>pending.push({code,signal,onProgress,resolve,reject})),publish:s=>states.push(s)});p.setTargets(['CHN','FRA']);p.setTargets(['JPN','CHN','FRA']);assert.equal(pending[0].signal.aborted,false);pending[0].onProgress(3,10);pending[0].resolve();await tick();assert.deepEqual(pending.map(x=>x.code),['CHN','JPN']);pending[1].resolve();await tick();assert.deepEqual(pending.map(x=>x.code),['CHN','JPN','FRA']);pending[2].resolve();await tick();p.setTargets(['FRA','CHN','JPN']);assert.equal(pending.length,3);p.dispose();assert.deepEqual(states.find(Boolean),{code:'CHN',done:3,total:10});
});
test('background errors do not loop and dispose prevents late progress',async()=>{
 let reject,signal,publishCount=0;const p=createGeometryPreloader({load:(_code,s)=>{signal=s;return new Promise((_r,j)=>reject=j);},publish:()=>publishCount++});p.setTargets(['CHN']);reject(Error('offline'));await tick();const n=publishCount;p.setTargets(['CHN']);await tick();assert.equal(publishCount,n);p.setTargets(['JPN']);p.dispose();assert.equal(signal.aborted,true);reject(Error('late'));await tick();assert.equal(publishCount,n);
});
test('persistent cache accepts only immutable public geometry, never records or photos',async()=>{
 const requests=[],entries=new Map();const cache={async match(u){requests.push(['match',u]);return entries.get(u)?.clone();},async put(u,r){requests.push(['put',u]);entries.set(u,r);},async delete(u){entries.delete(u);},async keys(){return[];}};const storage={async open(){return cache;}};const disk=createGeometryDiskCache(storage);const url='/data/geometry-partitions/'+'a'.repeat(64)+'.json.gz';await disk.put('/api/visits',new Response('private'));await disk.put('/api/photos/test',new Response('private'));assert.equal(await disk.match('/api/visits'),undefined);assert.equal(requests.length,0);await disk.put(url,new Response('public'));assert.equal(await(await disk.match(url)).text(),'public');assert.equal(entries.size,1);
});
