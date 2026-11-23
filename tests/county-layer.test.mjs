import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boxesOverlap, countyFeatures, isRegionIndex, regionsFromIndex } from '../lib/county-layer.ts';

const read = (url) => JSON.parse(readFileSync(new URL('../public' + url, import.meta.url)));

test('view boxes overlap across the antimeridian and reject distant counties', () => {
  assert.equal(boxesOverlap([100, 20, 110, 30], [105, 22, 120, 40]), true);
  assert.equal(boxesOverlap([10, 10, 12, 12], [20, 20, 22, 22]), false);
  assert.equal(boxesOverlap([170, 0, -170, 10], [-175, 1, -160, 8]), true);
});

test('coarse county geometry keeps current ids, including districts missing from the old paint file', () => {
  const index = read('/data/region-index/chn.json');
  const paint = read(index.geometry);
  assert.equal(isRegionIndex(index), true);
  assert.equal(index.geometry,read('/data/display-meshes.json').countries.CHN.url);
  const regions = regionsFromIndex(index);
  const layer = countyFeatures(regions, paint, index.extras ?? []);
  assert.equal(layer.features.length, regions.length);
  assert.ok(layer.features.some((feature) => feature.properties.originalName === 'Qiantang District'));
  assert.equal(layer.features.find((feature) => feature.id === 'GB-62558664B82614955491445').properties.name, '西湖区');
});

test('France uses the same-id simplified communes instead of the old arrondissement paint', () => {
  const index = read('/data/region-index/fra.json');
  assert.equal(index.geometry,read('/data/display-meshes.json').countries.FRA.url);
  assert.equal(index.rows.length, 35010);
});

test('unwrapped map views still contain counties on the opposite longitude notation',()=>{
 assert.equal(boxesOverlap([-179.8,-17.2,-179.2,-16.8],[178.3,-17.85,181.7,-16.15]),true);
 assert.equal(boxesOverlap([178,-17.2,179,-16.8],[-182.5,-18,-180.5,-16]),true);
});

test('detailed layer excludes suppressed polygons even when a historical record registered the id',async()=>{
 const { detailedCountyFeatures }=await import('../lib/county-layer.ts');
 const index=read('/data/region-index/chn.json');
 const regions=regionsFromIndex(index);
 const primary=read(read('/data/geometry-alignment.json').countries.CHN.localUrl);
 const suppressed=new Set(read('/data/geometry-alignment.json').countries.CHN.suppressedIds);
 const layer=detailedCountyFeatures(primary.features,new Map(regions.map(r=>[r.id,r])),suppressed);
 assert.equal(layer.features.some(f=>suppressed.has(f.id)),false);
 assert.ok(layer.features.some(f=>f.properties.originalName==='Qiantang District'));
});
