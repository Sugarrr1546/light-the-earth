import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
const read=url=>JSON.parse(readFileSync(new URL('../public'+url,import.meta.url)));
test('every current display mesh is derived from its current primary polygons, never from legacy paint',()=>{
 assert.ok(existsSync(new URL('../public/data/display-meshes.json',import.meta.url)),'same-source display mesh manifest is missing');
 const manifest=read('/data/display-meshes.json');const alignment=read('/data/geometry-alignment.json');
 for(const [code,a]of Object.entries(alignment.countries)){
  const mesh=manifest.countries[code];assert.ok(mesh,code);
  const source=readFileSync(new URL('../public'+a.localUrl,import.meta.url));
  assert.equal(createHash('sha256').update(source).digest('hex'),mesh.primarySha256,code+' stale display');
  const index=read('/data/region-index/'+code.toLowerCase()+'.json');assert.equal(index.geometry,mesh.url,code);
  assert.equal(mesh.unionSymmetricDifferenceArea,0,code+' coastline changed');
  assert.ok(['shared-edge-simplification','exact-primary'].includes(mesh.method),code);
 }
});
