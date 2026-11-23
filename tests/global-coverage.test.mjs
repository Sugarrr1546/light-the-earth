import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateVisitInput} from '../lib/validation.ts';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const coverage=JSON.parse(fs.readFileSync(path.join(root,'public/data/coverage.json'),'utf8'));

test('local boundary coverage extends beyond the original three countries across all continents',()=>{
  assert.ok(coverage.length>=180,`Only ${coverage.length} countries/territories have subdivisions`);
  for(const code of ['FRA','DEU','GBR','ESP','ITA','BRA','MEX','ARG','ZAF','KEN','EGY','IND','IDN','THA','KOR','AUS','NZL','CAN'])assert.ok(coverage.some(c=>c.code===code),code);
  assert.equal(new Set(coverage.map(c=>c.code)).size,coverage.length);
});
test('every advertised country has a bounded local file and regions accepted by the save API',()=>{
  const ids=new Set();
  for(const item of coverage){
    assert.match(item.localUrl,/^\/data\/[a-z0-9/.-]+\.geojson$/);
    assert.ok(!item.localUrl.includes('..'));
    const file=path.join(root,'public',item.localUrl);
    assert.ok(fs.statSync(file).size<=256*1024*1024,`${item.code} decoded file too large`);
    if(item.gzipParts){for(const p of item.gzipParts)assert.ok(fs.statSync(path.join(root,'public',p.url)).size<10_000_000,`${item.code} part too large`);}
    else if(item.gzipUrl)assert.ok(fs.statSync(path.join(root,'public',item.gzipUrl)).size<10_000_000,`${item.code} packed file too large`);else assert.ok(fs.statSync(file).size<=10*1024*1024,`${item.code} file too large`);
    const data=JSON.parse(fs.readFileSync(file,'utf8'));
    assert.equal(data.type,'FeatureCollection');
    assert.equal(data.features.length,item.count,item.code);
    assert.ok(item.count>0&&item.year&&item.source&&item.license&&item.coverageNote,item.code);
    for(const feature of data.features){
      const p=feature.properties;
      assert.equal(feature.id,p.id);assert.ok(!ids.has(p.id),p.id);ids.add(p.id);
      assert.equal(p.countryCode,item.code);assert.equal(p.adminLevel,item.adminLevel);
      assert.ok(['Polygon','MultiPolygon'].includes(feature.geometry.type));
      validateVisitInput({id:'test-visit',region:p,status:'visited',visitedOn:'',title:'',notes:'',tripName:'',photos:[]});
    }
    assert.ok(['local','regional'].includes(item.detailTier),item.code);
  }
});
test('existing saved Chinese, Japanese and US region identities remain present',()=>{
  const known={CHN:['GB-62558664B9496053300630','GB-62558664B82614955491445']};
  for(const code of ['CHN','JPN','USA']){
    const item=coverage.find(c=>c.code===code);
    assert.ok([item.localUrl,...item.legacyUrls??[]].includes(`/data/${code.toLowerCase()}.geojson`));
    const features=JSON.parse(fs.readFileSync(path.join(root,'public',item.localUrl),'utf8')).features;
    for(const id of known[code]??[])assert.ok(features.some(f=>f.id===id),id);
  }
});

test('a tiny collapsed Indian polygon does not downgrade the country to state boundaries',()=>{
  const item=coverage.find(c=>c.code==='IND');
  assert.equal(item.adminLevel,'ADM3');
  const data=JSON.parse(fs.readFileSync(path.join(root,'public',item.localUrl),'utf8'));
  const restored=data.features.find(f=>f.id==='GB-7132399B45581084631453');
  assert.equal(restored?.properties.name,'Longmai');
  assert.ok(restored.geometry.coordinates.length>0);
  const sources=JSON.parse(fs.readFileSync(path.join(root,'public/data/sources-global.json'),'utf8'));
  const source=sources.datasets.find(d=>d.coverage.code==='IND');
  assert.equal(data.features.length,source.sourceCount);
  assert.ok(source.restoredSourceGeometryIDs.includes('7132399B45581084631453'));
});

test('the gap repair adds real municipal and parish layers and respects local ADM1 semantics',()=>{
 for(const [code,min] of [['HKG',18],['ALA',16],['NCL',33],['PYF',48],['MDA',982],['MNE',25],['MHL',152],['IMN',24],['JEY',12],['FRO',29]]){
  const c=coverage.find(c=>c.code===code);assert.ok(c,code);assert.ok(c.count>=min,`${code}: ${c.count}`);assert.equal(c.detailTier,'local',code);
 }
 for(const code of ['AND','LIE','MLT','NIU','NRU','SMR'])assert.equal(coverage.find(c=>c.code===code).detailTier,'local',code);
});
test('every country retains legacy paint IDs and resolves current regions through primary geometry',()=>{
 for(const item of coverage){
  assert.ok(item.paintUrl,item.code);const pathName=path.join(root,'public',item.paintUrl);
  assert.ok(fs.statSync(pathName).size<=10*1024*1024);
  const areas=JSON.parse(fs.readFileSync(pathName,'utf8'));const ids=new Set(areas.features.map(f=>f.id));
  // Current shapes take precedence at runtime; legacy-only records are retained
  // in the lightweight paint package rather than losing old travel memories.
  const current=JSON.parse(fs.readFileSync(path.join(root,'public',item.localUrl),'utf8'));
  for(const f of current.features)ids.add(f.id);
  for(const url of [item.localUrl,...item.legacyUrls??[]]){
   const original=JSON.parse(fs.readFileSync(path.join(root,'public',url),'utf8'));
   for(const f of original.features)assert.ok(ids.has(f.id),`${item.code} paint missing ${f.id}`);
  }
 }
});
test('all original 58 gaps have an explicit outcome and territory-wide memories have real outlines',()=>{
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'public/data/sources-supplements.json'),'utf8'));
 assert.equal(manifest.audit.length,58);assert.equal(new Set(manifest.audit.map(r=>r.code)).size,58);
 for(const item of manifest.audit)assert.ok(item.note&&item.result&&item.evidenceURLs.length,item.code);
 assert.equal(coverage.find(c=>c.code==='TTO').count,15);
 for(const code of ['GUF','GLP','MTQ','MYT','REU']){
  const c=coverage.find(c=>c.code===code);const paint=JSON.parse(fs.readFileSync(path.join(root,'public',c.paintUrl),'utf8'));
  assert.ok(paint.features.some(f=>f.id===`coverage-${code}`&&['Polygon','MultiPolygon'].includes(f.geometry.type)),code);
 }
});
