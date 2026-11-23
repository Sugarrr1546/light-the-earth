import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { countyFeatures, regionsFromIndex } from '../lib/county-layer.ts';
const read = url => JSON.parse(readFileSync(new URL('../public' + url, import.meta.url)));
const patch = read('/data/hangzhou-boundary-patch.json');
const primary = read(read('/data/geometry-alignment.json').countries.CHN.localUrl);
const byId = new Map(primary.features.map(f=>[f.id,f]));

test('reformed districts keep historical saved IDs attached to their original footprints',()=>{
 const old = JSON.parse(execFileSync('git',['show','0548eb1:public/data/aligned/chn.geojson'],{maxBuffer:20*1024*1024}));
 for(const item of patch.replaced){
  const previous = old.features.find(f=>f.properties.originalName===item.originalName);
  assert.deepEqual(byId.get(previous.id).geometry, previous.geometry, `${item.name} historical footprint changed`);
  assert.notEqual(item.id,previous.id);
 }
});

test('county overview does not reuse pre-reform shapes for the current Hangzhou districts',()=>{
 const index=read('/data/region-index/chn.json');
 const layer=countyFeatures(regionsFromIndex(index),read(index.geometry),index.extras??[]);
 for(const item of [...patch.replaced,...patch.added]){
  assert.deepEqual(layer.features.find(f=>f.id===item.id)?.geometry,byId.get(item.id).geometry,`${item.name} overview differs from its current polygon`);
 }
});
