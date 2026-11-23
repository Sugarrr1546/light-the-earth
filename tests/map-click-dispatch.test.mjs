import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

// Execute the real map click handler with controlled asynchronous boundary reads.
function harness(mode='light'){
 const source=readFileSync(new URL('../components/EarthMap.tsx',import.meta.url),'utf8');
 const begin=source.indexOf("map.on('click', (event) => {");
 const end=source.indexOf("map.on('mousemove'",begin);
 assert.ok(begin>=0&&end>begin);
 const handler=source.slice(begin,end).trim();
 const compiled=ts.transpileModule(handler,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 const waiting=new Map(),saved=[],errors=[];
 let click;
 const context={map:{on:(_type,fn)=>{click=fn;},getZoom:()=>8},propsRef:{current:{mode,onRegionClick:region=>saved.push(region.id)}},
  getFeature:point=>({properties:{id:String(point.x),level:'local',countryCode:'TST'}}),regionForFeature:f=>f.properties,
  exactClickedRegion:feature=>new Promise(resolve=>waiting.set(feature.properties.id,()=>resolve(feature.properties))),
  reportError:message=>errors.push(message),abort:new AbortController(),loaded:new Set(['TST']),coverage:new Map(),boundaryLoader:{},LOCAL_MIN_ZOOM:3.45};
 const names=Object.keys(context);
 const control=new Function(...names,`let clickSequence=0,cameraRevision=0,disposed=false,focusCode=null;${compiled};return {move(){cameraRevision++},dispose(){disposed=true}}`)(...names.map(n=>context[n]));
 return {saved,errors,control,mode:value=>{context.propsRef.current.mode=value},click:id=>click({point:{x:id,y:0},lngLat:{lng:id,lat:0}}),resolve:async id=>{waiting.get(String(id))();await new Promise(r=>setImmediate(r));}};
}
test('slow exact reads preserve every rapid light-mode click even when they finish in reverse order',async()=>{
 const h=harness();h.click(1);h.click(2);await h.resolve(2);await h.resolve(1);assert.deepEqual(h.saved,['2','1']);
});
test('browse clicks still show only the latest selection',async()=>{
 const h=harness('browse');h.click(1);h.click(2);await h.resolve(2);await h.resolve(1);assert.deepEqual(h.saved,['2']);
});
test('moving the camera, leaving light mode, or disposing cancels pending light clicks',async()=>{
 for(const invalidate of [h=>h.control.move(),h=>h.mode('browse'),h=>h.control.dispose()]){
  const h=harness();h.click(1);invalidate(h);await h.resolve(1);assert.deepEqual(h.saved,[]);
 }
});
