import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {presentRegion} from '../lib/region-presentation.ts';
const read=path=>JSON.parse(readFileSync(new URL('../'+path,import.meta.url)));
const rows=code=>{const index=read(`public/data/region-index/${code}.json`);return index.rows.map(row=>Object.fromEntries(index.fields.map((field,i)=>[field,row[i]])));};
const names=read('public/data/name-quality.json');

test('areas outside China get Wikidata Chinese names and Chinese parents, source names stay searchable',()=>{
 const dong=rows('tha').find(r=>r.originalName==='Dong Charoen');
 assert.equal(dong.name,'东乍伦县');assert.equal(dong.parentName,'披集府');assert.ok(dong.aliases.includes('Dong Charoen'));
 const shown=presentRegion({...dong,level:'local',countryCode:'THA',countryName:'泰国'},names);
 assert.equal(shown.name,'东乍伦县');assert.ok(shown.aliases.includes('Dong Charoen'));
});

test('a Chinese index name outranks a repaired Latin source name',()=>{
 const r=rows('can').find(x=>x.id==='GB-43193130B65436749937431');
 assert.match(names.regions[r.id].name,/Mékinac/);
 const shown=presentRegion({...r,level:'local',countryCode:'CAN',countryName:'加拿大'},names);
 assert.equal(shown.name,'圣罗奇德梅基纳克');assert.ok(shown.aliases.includes(names.regions[r.id].name));
});

test('the name overlay never invents a name: each entry is a Chinese label or empty, with a Chinese parent',()=>{
 const overlay=read('data/foreign-names.json');
 assert.ok(!overlay.countries.CHN&&!overlay.countries.TWN);
 for(const [code,v] of Object.entries(overlay.countries)){
  for(const p of v.parents)assert.match(p,/[㐀-鿿]/,code+' parent '+p);
  for(const [id,[name,parent]] of Object.entries(v.regions)){
   if(name!==null)assert.match(name,/[㐀-鿿]/,code+' '+id);
   assert.ok(name!==null||parent!==null,id);
  }
 }
});
