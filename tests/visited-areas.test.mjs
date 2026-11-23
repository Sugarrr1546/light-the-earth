import test from 'node:test';
import assert from 'node:assert/strict';
import {createVisitedAreaLoader} from '../lib/visited-areas.ts';
const feature=(id)=>({type:'Feature',id,properties:{id},geometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,0]]]}});
const visit=(id,code='FRA',status='visited')=>({region:{id,countryCode:code,level:'local',name:id,center:[0,0]},status});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('saved regions publish polygon geometry and status at overview zoom without resident country layers',async()=>{
 let areas;let loads=0;
 const loader=createVisitedAreaLoader({load:async()=>{loads++;return {type:'FeatureCollection',features:[feature('a'),feature('b')]};},publish:data=>{areas=data;}});
 loader.setVisits([visit('a')]);await tick();
 assert.equal(areas.features[0].geometry.type,'Polygon');assert.equal(areas.features[0].properties.status,'visited');
 loader.setVisits([visit('a','FRA','lived')]);await tick();
 assert.equal(areas.features[0].properties.status,'lived');assert.equal(loads,1);
 loader.setVisits([]);assert.equal(areas.features.length,0);loader.dispose();
});
test('old slow area responses cannot recolor removed visits or another filter',async()=>{
 const pending=[];let areas;
 const loader=createVisitedAreaLoader({load:(code,signal)=>new Promise(resolve=>pending.push({code,signal,resolve})),publish:data=>{areas=data;}});
 loader.setVisits([visit('a')]);loader.setVisits([visit('b','DEU')]);
 assert.equal(pending[0].signal.aborted,true);
 pending[0].resolve({type:'FeatureCollection',features:[feature('a')]});await tick();
 const b=pending.find(p=>p.code==='DEU');b.resolve({type:'FeatureCollection',features:[feature('b')]});await tick();
 assert.deepEqual(areas.features.map(f=>f.id),['b']);loader.dispose();
});
test('saved area downloads are bounded and country geometry needs no network',async()=>{
 const pending=[];let areas;const countries=[{...feature('nation'),properties:{id:'nation'}}];
 const loader=createVisitedAreaLoader({countries,load:(code,signal)=>new Promise(resolve=>pending.push({code,signal,resolve})),publish:data=>{areas=data;}});
 loader.setVisits([{...visit('nation'),region:{...visit('nation').region,level:'country'}},visit('a','FRA'),visit('b','DEU'),visit('c','IND')]);
 assert.equal(pending.length,2);assert.ok(areas.features.some(f=>f.id==='nation'));
 pending[0].resolve({type:'FeatureCollection',features:[feature('a')]});await tick();assert.equal(pending.length,3);
 loader.dispose();assert.ok(pending.slice(1).every(p=>p.signal.aborted));
});
test('repeat visits use the strongest status and keep source geometries unmodified',async()=>{
 let areas;const original=feature('a');const loader=createVisitedAreaLoader({load:async()=>({type:'FeatureCollection',features:[original]}),publish:data=>{areas=data;}});
 loader.setVisits([visit('a','FRA','wishlist'),visit('a','FRA','lived'),visit('a','FRA','visited')]);await tick();
 assert.equal(areas.features.length,1);assert.equal(areas.features[0].properties.status,'lived');assert.equal(original.properties.status,undefined);loader.dispose();
});
test('detailed geometry stays aligned and a late overview response cannot replace it',async()=>{
 let finish;let areas;const loader=createVisitedAreaLoader({load:()=>new Promise(resolve=>{finish=resolve;}),publish:data=>{areas=data;}});
 loader.setVisits([visit('a')]);const exact=feature('a');exact.geometry.coordinates[0].splice(1,0,[.5,.1]);
 loader.prime([exact]);assert.deepEqual(areas.features[0].geometry,exact.geometry);
 finish({type:'FeatureCollection',features:[feature('a')]});await tick();assert.deepEqual(areas.features[0].geometry,exact.geometry);
 loader.setVisits([visit('a')]);assert.deepEqual(areas.features[0].geometry,exact.geometry);loader.dispose();
});
test('a legacy province is painted before a finer saved district regardless of record order',async()=>{
 let areas;const province=feature('province');province.geometry.coordinates=[[[0,0],[10,0],[10,10],[0,0]]];
 const loader=createVisitedAreaLoader({load:async()=>({type:'FeatureCollection',features:[feature('county'),province]}),publish:data=>{areas=data;}});
 loader.setVisits([visit('county','ARE','wishlist'),visit('province','ARE','lived')]);await tick();
 assert.deepEqual(areas.features.map(f=>f.id),['province','county']);assert.ok(areas.features[1].properties.paintOrder>areas.features[0].properties.paintOrder);loader.dispose();
});
test('a country absent from the world layer can use its same-origin coverage outline',async()=>{
 let areas;let requested;
 const loader=createVisitedAreaLoader({load:async code=>{requested=code;return {type:'FeatureCollection',features:[feature('coverage-GUF')]};},publish:data=>{areas=data;}});
 loader.setVisits([{...visit('coverage-GUF','GUF'),region:{...visit('coverage-GUF','GUF').region,level:'country'}}]);await tick();
 assert.equal(requested,'GUF');assert.deepEqual(areas.features.map(f=>f.id),['coverage-GUF']);loader.dispose();
});
test('country memories refine their coarse overview outline and retain the aligned coast',async()=>{
 let areas,loads=0;const coarse=feature('nation'),precise=feature('nation');precise.geometry.coordinates[0].splice(1,0,[0.4,0.2]);
 const loader=createVisitedAreaLoader({countries:[coarse],refineCountryIds:new Set(['nation']),load:async()=>{loads++;return {type:'FeatureCollection',features:[precise]};},publish:data=>{areas=data;}});
 const record={...visit('nation'),region:{...visit('nation').region,level:'country'}};
 loader.setVisits([record]);assert.deepEqual(areas.features[0].geometry,coarse.geometry);await tick();assert.deepEqual(areas.features[0].geometry,precise.geometry);
 loader.setVisits([record]);await tick();assert.equal(loads,1);loader.dispose();
});
test('many memories in one country load in bounded batches and publish every exact saved region',async()=>{
 let areas;const batches=[];const loader=createVisitedAreaLoader({load:async(code,signal,ids)=>{assert.ok(ids.length<=8);batches.push(ids);return{type:'FeatureCollection',features:ids.map(feature)};},publish:data=>{areas=data;}});
 loader.setVisits(Array.from({length:40},(_,i)=>visit('many-'+i,'CHN')));
 for(let i=0;i<12;i++)await tick();
 assert.equal(areas.features.length,40);assert.equal(batches.length,5);loader.dispose();
});
