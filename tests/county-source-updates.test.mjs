import test from 'node:test';
import assert from 'node:assert/strict';
import {createCountySourceUpdates,usesCountySourceUpdates} from '../lib/county-source-updates.ts';
const feature=i=>({type:'Feature',id:`FRA-${i}`,properties:{id:`FRA-${i}`,name:`市镇${i}`,center:[2,48]},geometry:{type:'Polygon',coordinates:[[[2.123456789,48],[2.234567891,48],[2.123456789,48.234567891],[2.123456789,48]]]}});
const collection=features=>({type:'FeatureCollection',features});
function setup(options={}){const actual=new Map(),batches=[],yielded=[];const updater=createCountySourceUpdates({limit:128,apply:async diff=>{batches.push(diff);for(const id of diff.remove)actual.delete(id);for(const f of diff.add)actual.set(f.id,f);},yieldTask:async()=>{yielded.push(true);},...options});return{updater,actual,batches,yielded};}
test('complete exact geometry and string IDs reach the renderer in bounded batches with yields',async()=>{
 const data=collection(Array.from({length:2501},(_,i)=>feature(i))),snapshot=structuredClone(data),{updater,actual,batches,yielded}=setup();
 await updater.update(data);assert.equal(actual.size,2501);assert.deepEqual([...actual.values()],data.features);assert.deepEqual(data,snapshot);
 assert.ok(batches.every(b=>b.add.length+b.remove.length<=128));assert.ok(yielded.length>=19);
});
test('unchanged immutable features transfer once; changed properties and removals converge exactly',async()=>{
 const a=feature(0),b=feature(1),c=feature(2),{updater,actual,batches}=setup();await updater.update(collection([a,b]));const n=batches.length;
 await updater.update(collection([a,b]));assert.equal(batches.length,n);
 const renamed={...a,properties:{...a.properties,name:'新名称'}};await updater.update(collection([renamed,c]));assert.deepEqual([...actual.values()],[renamed,c]);
});
test('a rapid viewport replacement stops obsolete batches and converges to the newest IDs',async()=>{
 let release,started;const gate=new Promise(r=>release=r),entered=new Promise(r=>started=r),actual=new Map(),batches=[];
 const updater=createCountySourceUpdates({limit:2,yieldTask:async()=>{},apply:async d=>{batches.push(d);if(batches.length===1){started();await gate;}for(const id of d.remove)actual.delete(id);for(const f of d.add)actual.set(f.id,f);}});
 const first=updater.update(collection(Array.from({length:20},(_,i)=>feature(i))));await entered;
 const last=collection([feature(101),feature(102),feature(103)]),second=updater.update(last);release();await Promise.all([first,second]);
 assert.deepEqual([...actual.values()],last.features);assert.ok(batches.length<8,'obsolete 20-feature viewport must not finish first');
});
test('clearing a large view removes all stale IDs using the same batch bound',async()=>{
 const {updater,actual,batches}=setup();await updater.update(collection(Array.from({length:513},(_,i)=>feature(i))));await updater.update(collection([]));assert.equal(actual.size,0);assert.ok(batches.every(b=>b.add.length+b.remove.length<=128));
});
test('unloading during an in-flight update schedules no further source work',async()=>{
 let release;const gate=new Promise(r=>release=r);let calls=0;const updater=createCountySourceUpdates({limit:2,apply:async()=>{calls++;await gate;},yieldTask:async()=>{}});
 const pending=updater.update(collection(Array.from({length:10},(_,i)=>feature(i))));await Promise.resolve();updater.dispose();release();await pending;await updater.update(collection([feature(99)]));assert.equal(calls,1);
});
test('a partial source failure falls back to the latest full view and does not retry stale batches',async()=>{
 let release;const gate=new Promise(r=>release=r),fallback=[],updater=createCountySourceUpdates({limit:2,apply:async()=>{await gate;throw Error('worker failed');},onError:(e,data)=>fallback.push(data),yieldTask:async()=>{}});
 const pending=updater.update(collection([feature(1),feature(2),feature(3)])),latest=collection([feature(99)]);updater.update(latest);release();await pending;assert.equal(fallback[0],latest);
 const next=collection([feature(100)]);await updater.update(next);assert.equal(fallback[1],next);
});
test('incremental commune delivery remains scoped to France',()=>{assert.equal(usesCountySourceUpdates('FRA'),true);for(const code of ['CAN','USA','CHN','JPN','RUS','IND','BRA'])assert.equal(usesCountySourceUpdates(code),false);});
test('an empty/no-op view followed immediately by a new view cannot strand the newest update',async()=>{
 const {updater,actual}=setup();const a=updater.update(collection([])),b=updater.update(collection([feature(5)]));await Promise.all([a,b]);assert.equal(actual.size,1);
});
test('a recovered source snapshot seeds acknowledged IDs, including removals of stale snapshot features',async()=>{
 const a=feature(1),b=feature(2),actual=new Map([[a.id,a],[b.id,b]]),batches=[];const updater=createCountySourceUpdates({initial:collection([a,b]),apply:async d=>{batches.push(d);for(const id of d.remove)actual.delete(id);for(const f of d.add)actual.set(f.id,f);},yieldTask:async()=>{}});
 await updater.update(collection([b]));assert.deepEqual([...actual.values()],[b]);assert.deepEqual(batches,[{remove:[a.id],add:[]}]);
});
test('independent polygon and label recovery snapshots converge even when their batches completed separately',async()=>{
 const a=feature(1),b=feature(2),shapes=new Map([[a.id,a],[b.id,b]]),points=new Map([[a.id,a]]);
 function recovered(actual){return createCountySourceUpdates({initial:collection([...actual.values()]),apply:async d=>{for(const id of d.remove)actual.delete(id);for(const f of d.add)actual.set(f.id,f);},yieldTask:async()=>{}});}
 await Promise.all([recovered(shapes).update(collection([b])),recovered(points).update(collection([b]))]);assert.deepEqual([...shapes.values()],[b]);assert.deepEqual([...points.values()],[b]);
});
test('a view queued between a no-op run and its completion callback is still fully applied',async()=>{
 const {updater,actual}=setup();const first=updater.update(collection([]));await Promise.resolve();const next=updater.update(collection([feature(55)]));await Promise.all([first,next]);assert.equal(actual.size,1);
});
test('MapLibre source error events trigger fallback even when updateData resolves instead of rejecting',async()=>{
 const latest=collection([feature(1),feature(2),feature(3)]),fallback=[];let updater;updater=createCountySourceUpdates({limit:1,apply:async()=>{updater.fail(Error('source error event'));},onError:(_e,data)=>fallback.push(data),yieldTask:async()=>{}});
 await updater.update(latest);assert.deepEqual(fallback,[latest]);assert.equal(updater.fail(Error('fallback error')),false,'a failure of the direct fallback must reach normal map error reporting');
 updater.dispose();assert.equal(updater.fail(Error('removed')),false);
});
