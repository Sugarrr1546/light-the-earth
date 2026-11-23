import test from 'node:test';
import assert from 'node:assert/strict';
import {createVisitedAreaLoader} from '../lib/visited-areas.ts';
const feature=(id,bend=0)=>({type:'Feature',id,properties:{id},geometry:{type:'Polygon',coordinates:[[[0,0],[1,bend],[1,1],[0,0]]]}});
const visit=id=>({region:{id,countryCode:'CHN',level:'local',name:id,center:[0,0]},status:'visited'});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('saved loader requests only wanted IDs and cancels a superseded same-country subset',async()=>{
 const pending=[];let areas;const loader=createVisitedAreaLoader({load:(code,signal,ids)=>new Promise(resolve=>pending.push({code,signal,ids,resolve})),publish:data=>{areas=data;}});
 loader.setVisits([visit('a')]);assert.deepEqual(pending[0].ids,['a']);
 loader.setVisits([visit('b')]);assert.equal(pending[0].signal.aborted,true);assert.deepEqual(pending[1].ids,['b']);
 pending[0].resolve({type:'FeatureCollection',features:[feature('a')]});pending[1].resolve({type:'FeatureCollection',features:[feature('b')]});await tick();
 assert.deepEqual(areas.features.map(f=>f.id),['b']);loader.dispose();
});
test('display priming paints immediately and is replaced by the primary response',async()=>{
 let finish,areas;const loader=createVisitedAreaLoader({load:()=>new Promise(resolve=>{finish=resolve;}),publish:data=>{areas=data;}});
 loader.setVisits([visit('a')]);const display=feature('a',.2),primary=feature('a',.4);loader.prime([display],'display');
 assert.deepEqual(areas.features[0].geometry,display.geometry);finish({type:'FeatureCollection',features:[primary]});await tick();
 assert.deepEqual(areas.features[0].geometry,primary.geometry);loader.prime([display],'display');assert.deepEqual(areas.features[0].geometry,primary.geometry);loader.dispose();
});
