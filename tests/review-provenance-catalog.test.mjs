import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const dataRoot=process.env.LTE_PROVENANCE_DATA_DIR;
const source=url=>dataRoot?dataRoot+url.replace(/^\/data/,''):new URL('../public'+url,import.meta.url);
const read=url=>JSON.parse(readFileSync(source(url)));
const alignment=()=>read('/data/geometry-alignment.json').countries;
const coverage=()=>read('/data/coverage.json');
test('all 320 saved French district shapes including Lorient retain their exact original geometry',()=>{
 const a=alignment().FRA;assert.equal(a.legacyPaintUrl,'/data/global/fra-adm3.geojson');
 const original=read('/data/global/fra-adm3.geojson');const displayed=read(a.legacyPaintUrl);
 assert.equal(original.features.length,320);const byId=new Map(displayed.features.map(f=>[f.id,f]));
 for(const f of original.features)assert.deepEqual(byId.get(f.id).geometry,f.geometry,f.id);
 assert.equal(byId.get('GB-44848369B63496737996980').properties.originalName,'Lorient');
 assert.equal(createHash('sha256').update(readFileSync(source('/data/global/fra-adm3.geojson'))).digest('hex'),'d64ccd0c705fa6bfafe648e7d82970b018e86b7153e1c4851eb3d99fb59ba73e');
 const derived=read('/data/precision-france-legacy.json');assert.equal(derived.runtime,false);assert.equal(derived.legacyAlignedUrl,'/data/precision/fra-legacy-aligned.geojson');
});
test('coverage metadata follows each actual aligned source and preserves its distinct source year',()=>{
 const a=alignment();for(const c of coverage()){
  const actual=a[c.code];if(!actual)continue;
  assert.equal(c.localUrl,actual.localUrl,c.code+' URL');assert.equal(c.bytes,actual.localBytes,c.code+' bytes');
  assert.equal(c.source,actual.source,c.code+' source');assert.equal(c.license,actual.license,c.code+' license');
  if(actual.sourceYear)assert.equal(c.year,actual.sourceYear,c.code+' year');
 }
 const hk=coverage().find(c=>c.code==='HKG');assert.match(hk.source,/民政事务总署/);assert.match(hk.license,/ODbL/);assert.match(hk.year,/2026/);
 assert.match(coverage().find(c=>c.code==='SWE').year,/2017/);assert.match(coverage().find(c=>c.code==='FRA').year,/2020/);
});
test('mixed China geometry visibly preserves attribution for both database source families',()=>{
 const c=alignment().CHN;assert.match(c.license,/CC BY 4\.0/);assert.match(c.license,/ODbL/);assert.match(c.sourceAttribution,/CC BY 4\.0/);assert.match(c.sourceAttribution,/ODbL/);assert.match(c.sourceYear,/2017/);
});
