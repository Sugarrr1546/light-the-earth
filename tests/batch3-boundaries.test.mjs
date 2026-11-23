import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=url=>JSON.parse(readFileSync(new URL('../public'+url,import.meta.url)));
test('active China entry selects the cumulative central provinces update',()=>{
 const current=read('/data/geometry-alignment.json').countries.CHN;
 assert.equal(current.localUrl,'/data/precision/chn-central-current.geojson');
 const m=read('/data/current-central-china.json');
 assert.equal(current.sha256.local,m.alignment.sha256.local);
 const c=read('/data/coverage.json').find(x=>x.code==='CHN');
 assert.equal(c.localUrl,current.localUrl);
 assert.equal(c.count,current.count);
});
function ringContains(point,ring){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const[x,y]=point,[ax,ay]=ring[i],[bx,by]=ring[j];if((ay>y)!==(by>y)&&x<(bx-ax)*(y-ay)/(by-ay)+ax)inside=!inside;}return inside;}
function contains(g,p){return(g.type==='Polygon'?[g.coordinates]:g.coordinates).some(r=>ringContains(p,r[0])&&!r.slice(1).some(h=>ringContains(p,h)));}
test('five current province rosters preserve previous objects and keep retired source IDs historical',()=>{
 const m=read('/data/current-central-china.json'),old=read('/data/current-east-china.json');
 const expected={'江苏省':95,'上海市':16,'浙江省':90,'安徽省':104,'江西省':100};
 assert.deepEqual(Object.fromEntries(Object.entries(m.currentRegionsByProvince).map(([k,v])=>[k,v.length])),expected);
 const fc=read(m.alignment.localUrl),byId=new Map(fc.features.map(f=>[f.id,f]));
 assert.equal(byId.size,fc.features.length);
 const suppressed=new Set(m.alignment.suppressedIds),history=read('/data/boundary-history.json').regions;
 for(const f of read(old.alignment.localUrl).features)assert.deepEqual(byId.get(f.id),f,f.id+' retained original object');
 for(const [province,rows]of Object.entries(m.currentRegionsByProvince)){
  assert.equal(new Set(rows.map(r=>r.code)).size,expected[province]);
  for(const r of rows){assert.ok(byId.has(r.id),r.name);assert.ok(!suppressed.has(r.id),r.name);assert.equal(byId.get(r.id).properties.name,r.name);}
 }
 for(const id of old.alignment.suppressedIds)assert.ok(suppressed.has(id),id+' remains suppressed');
 for(const id of Object.keys(m.retiredRegions))assert.equal(history[id]?.boundaryStatus,'historical',id);
});
test('China update retains verified offshore water and real city and island land',()=>{
 const m=read('/data/current-central-china.json'),old=read('/data/current-east-china.json');
 for(const kind of ['landUrl','countryUrl']){
  const g=read(m.alignment[kind]).features[0].geometry;
  for(const c of old.audit.coastlineFixtureChecks)assert.equal(contains(g,c.coordinates),c.expectedLand,kind+' '+c.name);
  for(const p of [[117.28,31.86],[115.86,28.68],[116.76633227,30.4230259]])assert.equal(contains(g,p),true,kind+' real inland city');
 }
 const active=read(m.alignment.localUrl).features.filter(f=>!m.alignment.suppressedIds.includes(f.id));
 const farm=active.filter(f=>contains(f.geometry,[116.76633227,30.4230259]));
 assert.equal(farm.length,1);assert.equal(farm[0].properties.name,'大观区');
});
test('the accumulated history keeps the older Norwegian source identities after border seam copies',()=>{
 const a=read('/data/geometry-alignment.json').countries.NOR;
 const history=read('/data/boundary-history.json').regions;
 for(const f of read(a.legacyPaintUrl).features)assert.equal(history[f.id]?.boundaryStatus,'historical',f.id);
 const nordic=read('/data/current-nordic.json');
 for(const code of ['SWE','NOR','RUS']){
  const r=nordic.countries[code];assert.equal(r.historyPolicy,'seam-copies-only');
  const f=read(r.alignment.localUrl).features;assert.equal(f.length,r.alignment.count);
  for(const id of Object.keys(r.history))assert.equal(history[id]?.boundaryStatus,'historical',id);
 }
});
test('Finland current municipalities exclude separate Aland and locate recent mergers with current polygons',()=>{
 const m=read('/data/current-nordic.json').countries.FIN,a=read('/data/geometry-alignment.json').countries.FIN;
 const fs=read(a.localUrl).features,old=read(a.legacyPaintUrl).features;
 assert.equal(fs.length,292);assert.equal(new Set(fs.map(f=>f.properties.officialCode)).size,292);
 assert.ok(fs.every(f=>f.properties.regionCode!=='21'));
 assert.ok(fs.every(f=>!old.some(o=>o.id===f.id)));
 const checks=m.audit.checks;
 for(const f of checks.historicalReformLocationControlPoints){const hits=fs.filter(u=>contains(u.geometry,f.point));assert.equal(hits.length,1,f.historicalName);assert.equal(hits[0].properties.officialCode,f.currentOfficialCode);}
 for(const kind of ['landUrl','countryUrl']){const g=read(a[kind]).features[0].geometry;for(const [name,c]of Object.entries(checks.physicalLandControlPoints))assert.equal(contains(g,c.point),c.expectedLand,kind+' '+name);}
});
test('neighbor seam copies retain all old objects and only retire the affected source identities',()=>{
 const m=read('/data/current-nordic.json'),history=read('/data/boundary-history.json').regions;
 for(const [code,count,seams]of [['SWE',290,4],['NOR',357,8],['RUS',2327,11]]){
  const r=m.countries[code],a=r.alignment,fs=read(a.localUrl).features,old=read(r.sourceEvidence.baselinePrimaryUrl).features;
  const byId=new Map(fs.map(f=>[f.id,f])),suppressed=new Set(a.suppressedIds),affected=new Set(Object.keys(r.history));
  assert.equal(a.renderCount,count);assert.equal(affected.size,seams);
  for(const f of old){assert.deepEqual(byId.get(f.id),f);if(affected.has(f.id)){assert.ok(suppressed.has(f.id));assert.equal(history[f.id].boundaryStatus,'historical');}else if(!suppressed.has(f.id)){assert.notEqual(history[f.id]?.boundaryStatus,'historical',f.id+' still active');}}
 }
});
test('each current Chinese county links to its own official province verification source',()=>{
 const m=read('/data/current-central-china.json'),names=read('/data/name-quality.json').regions;
 for(const rows of Object.values(m.currentRegionsByProvince))for(const r of rows)if(r.evidenceURL)assert.equal(names[r.id]?.evidenceURLs?.[0],r.evidenceURL,r.name);
});
