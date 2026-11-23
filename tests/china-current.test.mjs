import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=url=>JSON.parse(readFileSync(new URL('../public'+url,import.meta.url)));
function ringContains(point,ring){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const[x,y]=point,[ax,ay]=ring[i],[bx,by]=ring[j];if((ay>y)!==(by>y)&&x<(bx-ax)*(y-ay)/(by-ay)+ax)inside=!inside;}return inside;}
function contains(g,p){return(g.type==='Polygon'?[g.coordinates]:g.coordinates).some(r=>ringContains(p,r[0])&&!r.slice(1).some(h=>ringContains(p,h)));}
const manifest=read('/data/current-china.json');
const data=read(manifest.alignment.localUrl);
const byId=new Map(data.features.map(f=>[f.id,f]));
const suppressed=new Set(manifest.alignment.suppressedIds);

test('China selects the national current-boundary manifest',()=>{
 const current=read('/data/geometry-alignment.json').countries.CHN;
 assert.equal(current.localUrl,manifest.alignment.localUrl);
 assert.equal(current.sha256.local,manifest.alignment.sha256.local);
 const c=read('/data/coverage.json').find(x=>x.code==='CHN');
 assert.equal(c.localUrl,current.localUrl);assert.equal(c.count,data.features.length);
});

test('all 31 mainland provinces carry current county-level units',()=>{
 const provinces=Object.keys(manifest.currentRegionsByProvince);
 assert.equal(provinces.length,31);
 for(const [province,rows] of Object.entries(manifest.currentRegionsByProvince)){
  assert.ok(rows.length>=10,province);
  for(const r of rows){const f=byId.get(r.id);assert.ok(f,r.name);assert.ok(!suppressed.has(r.id),r.name);assert.equal(f.properties.name,r.name);assert.equal(f.properties.provinceName??province,province);}
 }
});

test('every earlier object survives unchanged and every 2017 county inside a current province is historical',()=>{
 const earlier=read('/data/current-central-china.json');
 for(const f of read(earlier.alignment.localUrl).features)assert.deepEqual(byId.get(f.id),f,f.id);
 const history=read('/data/boundary-history.json').regions;
 for(const id of Object.keys(manifest.retiredRegions))assert.equal(history[id]?.boundaryStatus,'historical',id);
 const active2017=data.features.filter(f=>f.id.startsWith('GB-')&&!suppressed.has(f.id));
 assert.equal(active2017.length,manifest.audit.untouched2017Count);
});

test('county lookups land in the right current county',()=>{
 const active=data.features.filter(f=>!suppressed.has(f.id)&&f.id.startsWith('OSM-CHN-'));
 for(const [point,name] of [[[116.397,39.909],'东城区'],[[114.06,22.54],'福田区'],[[104.0436,30.6656],'青羊区'],[[87.62,43.8],'天山区'],[[113.75,23.02],'东莞市'],[[110.33,20.04],'龙华区']]){
  const hits=active.filter(f=>contains(f.geometry,point)).map(f=>f.properties.name);
  assert.deepEqual(hits,[name],name);
 }
});

test('coastal land stops at the coastline and the sea stays open',()=>{
 const land=read(manifest.alignment.landUrl).features[0].geometry;
 for(const [point,expected,label] of [[[121.47,31.23],true,'Shanghai'],[[113.26,23.13],true,'Guangzhou'],[[110.35,20.02],true,'Haikou'],[[119.3,26.08],true,'Fuzhou'],
  [[121.0,38.6],false,'Bohai Strait'],[[114.3,22.0],false,'South China Sea off Hong Kong'],[[120.5,25.0],false,'Taiwan Strait']])
  assert.equal(contains(land,point),expected,label);
});
