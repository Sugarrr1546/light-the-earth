import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {presentRegion,canLabelRegion} from '../lib/region-presentation.ts';
const read=url=>JSON.parse(readFileSync(new URL('../public'+url,import.meta.url)));
const alignment=read('/data/geometry-alignment.json').countries;

test('current UK and Norway directories show reform-era local authorities while old regions remain available for history',()=>{
 for(const [code,count]of [['GBR',361],['NOR',357]]){
  const a=alignment[code];const current=read(a.localUrl).features.filter(f=>!a.suppressedIds.includes(f.id));const old=read(a.legacyPaintUrl).features;
  assert.equal(current.length,count);assert.equal(a.renderCount,count);
  assert.equal(current.some(f=>old.some(o=>o.id===f.id)),false);
  assert.ok(old.length>0);assert.ok(current.every(f=>f.properties.year.startsWith('2026')));
 }
 const uk=read(alignment.GBR.localUrl).features;
 for(const name of ['Cumberland','Westmorland and Furness','North Yorkshire','Somerset'])assert.ok(uk.some(f=>f.properties.name===name),name);
 const no=read(alignment.NOR.localUrl).features;
 assert.ok(no.some(f=>f.properties.name==='Haram'));assert.ok(no.some(f=>f.properties.name==='Indre Østfold'));
});

test('Zhejiang current county roster is complete and old GB identities are preserved separately',()=>{
 const z=read('/data/current-zhejiang.json');const fs=read(alignment.CHN.localUrl).features;
 assert.equal(z.currentRegions.length,90);assert.equal(z.audit.officialRosterExactMatch,true);
 const currentIds=new Set(z.currentRegions.map(r=>r.id));assert.equal(currentIds.size,90);
 assert.equal(fs.filter(f=>currentIds.has(f.id)).length,90);
 assert.equal(fs.filter(f=>f.id.startsWith('GB-')).length,2864);
 assert.ok(z.seamRegions.every(r=>fs.some(f=>f.id===r.id)&&alignment.CHN.suppressedIds.includes(r.legacyId)));
});

test('a questionable outside source label cannot become verified through a cartographic seam repair',()=>{
 const id='SEAM-CHN-GB-62558664B17826471634468-ZJ20261025';
 const f=read(alignment.CHN.localUrl).features.find(f=>f.id===id);assert.ok(f);
 const shown=presentRegion(f.properties,read('/data/name-quality.json'));
 assert.equal(shown.nameStatus,'unresolved');assert.equal(canLabelRegion(shown),false);assert.match(shown.nameNote,/名称.*核实/);assert.match(shown.name,/待核实/);
});

function inRing(point,ring){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){
 const [x,y]=point,[ax,ay]=ring[i],[bx,by]=ring[j];
 if((ay>y)!==(by>y)&&x<(bx-ax)*(y-ay)/(by-ay)+ax)inside=!inside;
}return inside;}
function contains(geometry,point){const polygons=geometry.type==='Polygon'?[geometry.coordinates]:geometry.coordinates;return polygons.some(rings=>inRing(point,rings[0])&&!rings.slice(1).some(ring=>inRing(point,ring)));}
test('real Zhejiang coastal land remains visible while bay and offshore sea stay outside land and country fills',()=>{
 const checks=read('/data/current-zhejiang.json').audit.coastlineFixtureChecks;
 for(const kind of ['landUrl','countryUrl']){
  const geometry=read(alignment.CHN[kind]).features[0].geometry;
  for(const item of checks)assert.equal(contains(geometry,item.coordinates),item.expectedLand,kind+' '+item.name);
 }
});
