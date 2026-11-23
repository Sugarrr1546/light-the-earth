import test from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';
const read=p=>JSON.parse(readFileSync(new URL('../public/data/'+p,import.meta.url)));
test('confirmed abolished identities remain historical source objects and leave current picking',()=>{
 const r=read('china-identity-review.json'),a=read('geometry-alignment.json').countries.CHN,history=read('boundary-history.json').regions;const fs=JSON.parse(readFileSync(new URL('../public'+a.localUrl,import.meta.url))).features;
 for(const id of r.suppressedIds){assert.ok(fs.some(f=>f.id===id));assert.ok(a.suppressedIds.includes(id));assert.equal(history[id].boundaryStatus,'historical');}
 assert.equal(a.renderCount,a.count-a.suppressedIds.length);assert.ok(a.replaceWorldIds.length>0);
});
