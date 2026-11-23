import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {access} from 'node:fs/promises';
async function view(){const path=new URL('../lib/map-view-controls.ts',import.meta.url);await assert.doesNotReject(access(path),'map view controls must exist');return import(path.href);}
test('panel choices restore only valid booleans and tolerate missing or damaged device storage',async()=>{
 const {readMapPanels}=await view();assert.deepEqual(readMapPanels(null),{search:true,timeline:true,sidebar:true,hints:true});assert.deepEqual(readMapPanels('{bad'),readMapPanels(null));assert.deepEqual(readMapPanels('{"search":false,"timeline":0,"sidebar":false,"hints":null,"extra":true}'),{search:false,timeline:true,sidebar:false,hints:true});assert.deepEqual(readMapPanels('null'),readMapPanels(null));
});
test('camera-driven stars move smoothly across the date line in both directions and honor reduced motion',async()=>{
 const {advanceStarfield}=await view();let s={lng:179,lat:10,x:0,y:0};s=advanceStarfield(s,-179,12,false);assert.ok(Math.abs(s.x)<5);assert.notEqual(s.x,0);assert.notEqual(s.y,0);let back=advanceStarfield(s,179,10,false);assert.ok(Math.abs(back.x)<1e-9);assert.ok(Math.abs(back.y)<1e-9);let reduced=advanceStarfield(s,-150,20,true);assert.equal(reduced.x,s.x);assert.equal(reduced.y,s.y);assert.equal(reduced.lng,-150);
});
