import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {presentRegion,canLabelRegion} from '../lib/region-presentation.ts';
const read=url=>JSON.parse(readFileSync(new URL('../public'+url,import.meta.url)));
const aligned=read('/data/geometry-alignment.json').countries;
function ringContains(point,ring){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const[x,y]=point,[ax,ay]=ring[i],[bx,by]=ring[j];if((ay>y)!==(by>y)&&x<(bx-ax)*(y-ay)/(by-ay)+ax)inside=!inside;}return inside;}
function contains(g,p){return(g.type==='Polygon'?[g.coordinates]:g.coordinates).some(r=>ringContains(p,r[0])&&!r.slice(1).some(h=>ringContains(p,h)));}
test('Jiangsu and Shanghai official county rosters join Zhejiang without reactivating archived source objects',()=>{
 const m=read('/data/current-east-china.json');assert.deepEqual(Object.fromEntries(Object.entries(m.currentRegionsByProvince).map(([k,v])=>[k,v.length])),{'江苏省':95,'上海市':16,'浙江省':90});
 const f=read(aligned.CHN.localUrl).features;const ids=new Set(f.map(f=>f.id));
 for(const r of m.currentRegions)assert.ok(ids.has(r.id)&&!aligned.CHN.suppressedIds.includes(r.id),r.name);
 assert.equal(f.filter(f=>f.id.startsWith('GB-')).length,2864);
 assert.equal(m.audit.allOriginalObjectsRetainedUnchanged,true);assert.equal(m.audit.allZhejiangRenderObjectsRetainedUnchanged,true);
});
test('updated East China fills preserve real cities and islands while excluding verified offshore water',()=>{
 const m=read('/data/current-east-china.json');
 for(const kind of ['landUrl','countryUrl'])for(const check of m.audit.coastlineFixtureChecks)assert.equal(contains(read(aligned.CHN[kind]).features[0].geometry,check.coordinates),check.expectedLand,kind+' '+check.name);
 const names=read('/data/name-quality.json');const current=read(aligned.CHN.localUrl).features.filter(f=>!aligned.CHN.suppressedIds.includes(f.id));
 const hit=current.find(f=>contains(f.geometry,[119.78,31.36]));assert.equal(presentRegion(hit.properties,names).name,'宜兴市');assert.equal(canLabelRegion(presentRegion(hit.properties,names)),true);
});
test('current Australian LGAs and New Zealand territorial authorities stay separate from historical IDs and neutral areas',()=>{
 const m=read('/data/current-pacific.json');
 for(const [code,count]of [['AUS',542],['NZL',67]]){
  const a=aligned[code];const current=read(a.localUrl).features;const oldIds=new Set(read(a.legacyPaintUrl).features.map(f=>f.id));assert.equal(current.length,count);
  assert.ok(current.every(f=>!oldIds.has(f.id)));assert.ok(current.every(f=>!/unincorporated|area outside/i.test(f.properties.name)));
  assert.ok(m.countries[code].sourceEvidence.referenceDate.startsWith('2026'));
 }
 const nz=read(aligned.NZL.localUrl).features;assert.ok(nz.some(f=>f.properties.name==='Auckland'));assert.ok(nz.some(f=>/Chatham Islands/.test(f.properties.name)));
});
