import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {countyRenderPolicy,countyRenderView} from '../lib/county-render-policy.ts';
import {regionsFromIndex,detailedCountyFeatures,boxesOverlap} from '../lib/county-layer.ts';
const read=url=>JSON.parse(readFileSync(new URL('../public'+url,import.meta.url)));
const alignment=read('/data/geometry-alignment.json').countries;
for(const code of ['USA','RUS','IND','BRA'])test(`${code}: large country stays viewport-rendered and exact county identity survives display`,()=>{
 const aligned=alignment[code],index=read(`/data/region-index/${code.toLowerCase()}.json`),regions=regionsFromIndex(index);
 const policy=countyRenderPolicy(aligned.localBytes,regions.length,code);
 assert.equal(policy.viewport,true);
 assert.equal(policy.minZoom,{USA:5.5,RUS:5.5,IND:6.5,BRA:6.5}[code]);
 const exact=read(aligned.localUrl),suppressed=new Set(aligned.suppressedIds??[]);
 const layer=detailedCountyFeatures(exact.features,new Map(regions.map(r=>[r.id,r])),suppressed);
 assert.equal(layer.features.length,aligned.renderCount);
 const original=new Map(exact.features.map(f=>[String(f.id??f.properties.id),f.geometry]));
 for(const feature of layer.features){
  assert.equal(feature.geometry,original.get(feature.id));
  assert.equal(feature.properties.id,feature.id);
  assert.equal(feature.properties.countryCode,code);
  assert.equal(suppressed.has(feature.id),false);
 }
});
test('US and Russian dateline views retain nearby islands without requesting the whole world',()=>{
 const west=countyRenderView(178,51,-178,69),east=countyRenderView(-182,51,-178,69);
 assert.ok(Math.abs((west[2]-west[0])-(east[2]-east[0]))<1e-9);
 assert.ok(west[2]-west[0]<6);
 for(const view of [west,east]){
  assert.equal(boxesOverlap([-176,64,-173,67],view),false);
  assert.equal(boxesOverlap([-179,64,-178,67],view),true);
  assert.equal(boxesOverlap([170,51,179.8,56],view),true);
 }
});

test('the focused dense-country tuning preserves other countries existing overview detail',()=>{
 for(const code of ['CAN','CZE','ESP','ITA']){
  const index=read(`/data/region-index/${code.toLowerCase()}.json`);
  assert.equal(countyRenderPolicy(alignment[code].localBytes,index.rows.length,code).minZoom,5.5);
 }
});
test('a selected oversized county retains its own source identity below the normal detail zoom',async()=>{
 const {countyViewKey}=await import('../lib/county-render-policy.ts');
 const p=countyRenderPolicy(alignment.BRA.localBytes,5570,'BRA'),view=[-56,-10,-51,-2];
 assert.equal(countyViewKey(p,6.1,view,'altamira'),'selection:altamira');
 assert.notEqual(countyViewKey(p,6.1,view,'altamira'),countyViewKey(p,6.1,view,'tapaua'));
 assert.equal(countyViewKey(p,6.1,view),'overview');
 assert.equal(countyViewKey(p,7,view,'altamira'),countyViewKey(p,7,view));
});

test('county selection keeps the original string identity after MapLibre vector-tile encoding',async()=>{
 const {countySourceSpecification}=await import('../lib/county-render-policy.ts');
 const {fromGeojsonVt}=await import('@maplibre/vt-pbf');
 const {VectorTile}=await import('@mapbox/vector-tile');
 const {PbfReader}=await import('pbf');
 const id='GB-56859067B40794450496810';
 const bytes=fromGeojsonVt({county:{features:[{id,type:3,geometry:[[[0,0],[100,0],[100,100],[0,100],[0,0]]],tags:{id,name:'Altamira'}}]}});
 const feature=new VectorTile(new PbfReader(bytes)).layers.county.feature(0);
 const spec=countySourceSpecification({type:'FeatureCollection',features:[]});
 const renderID=typeof spec.promoteId==='string'?feature.properties[spec.promoteId]:feature.id;
 assert.notEqual(feature.id,id,'PBF native identity alone loses the original GB string');
 assert.equal(renderID,id,'selected and hovered feature state must still address the original county');
});
