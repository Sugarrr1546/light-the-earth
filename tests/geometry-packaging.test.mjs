import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir,access} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {gunzipSync} from 'node:zlib';
import {packGeometry} from '../scripts/pack-geometry.mjs';
test('production geometry is losslessly packed and catalog URLs resolve the same exact bytes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'atlas-pack-'));
 try{await mkdir(join(dir,'data'));const bytes=Buffer.from('{"type":"FeatureCollection","features":[],"name":"海边"}\n');await writeFile(join(dir,'data/world.geojson'),bytes);await writeFile(join(dir,'data/coverage.json'),'[]');
 const report=await packGeometry(dir);assert.equal(report.assets['/data/world.geojson'].url,'/data/world.geojson.gz');
 assert.deepEqual(gunzipSync(await readFile(join(dir,'data/world.geojson.gz'))),bytes);await assert.rejects(access(join(dir,'data/world.geojson')));assert.equal(await readFile(join(dir,'data/coverage.json'),'utf8'),'[]');
 const catalog=JSON.parse(await readFile(join(dir,'data/geometry-assets.json'),'utf8'));assert.deepEqual(catalog.assets,report.assets);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('large county search indexes are also losslessly transported through the bounded asset catalog',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'atlas-index-pack-'));
 try{
  await mkdir(join(dir,'data/region-index'),{recursive:true});const bytes=Buffer.from('{"v":1,"fields":["name"],"rows":[["钱塘区"]]}');
  await writeFile(join(dir,'data/region-index/chn.json'),bytes);
  const report=await packGeometry(dir);assert.ok(report.assets['/data/region-index/chn.json']);
  assert.deepEqual(gunzipSync(await readFile(join(dir,report.assets['/data/region-index/chn.json'].url))),bytes);
  await assert.rejects(access(join(dir,'data/region-index/chn.json')));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('large compressed geometry splits into bounded immutable parts without losing coordinates',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'atlas-multipart-pack-'));
 try{
  await mkdir(join(dir,'data'));const bytes=Buffer.from(JSON.stringify({type:'FeatureCollection',features:[],names:Array.from({length:100},(_,i)=>`County-${i}-${i*i}`)}));await writeFile(join(dir,'data/large.geojson'),bytes);
  const report=await packGeometry(dir,{singleFileLimit:100,partBytes:80});const a=report.assets['/data/large.geojson'];assert.ok(a.parts?.length>1);
  const chunks=[];for(const p of a.parts){const b=await readFile(join(dir,p.url));assert.equal(b.length,p.bytes);assert.ok(b.length<=80);chunks.push(b);}
  assert.deepEqual(gunzipSync(Buffer.concat(chunks)),bytes);await assert.rejects(access(join(dir,'data/large.geojson.gz')));
  const {fetchBoundaryBytes}=await import('../lib/boundary-assets.ts');
  const transported=await fetchBoundaryBytes('/data/large.geojson',undefined,report.assets,async path=>new Response(await readFile(join(dir,String(path).split('?')[0]))));
  assert.deepEqual(Buffer.from(transported),bytes);
 }finally{await rm(dir,{recursive:true,force:true});}
});
