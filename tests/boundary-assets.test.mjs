import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {decodeBoundaryResponse,readBoundaryAsset,mergeAreaAssets} from '../lib/boundary-assets.ts';
const data={type:'FeatureCollection',features:[{type:'Feature',id:'county-a',properties:{name:'海边市'},geometry:{type:'Polygon',coordinates:[[[0,0],[2,0],[1,1],[0,0]]]}}]};
const body=JSON.stringify(data);
test('gzip and ordinary boundary assets decode to identical polygons and names',async()=>{
 assert.deepEqual(await decodeBoundaryResponse(new Response(gzipSync(body))),data);
 assert.deepEqual(await decodeBoundaryResponse(new Response(body)),data);
});
test('compressed expansion is stopped at the decoded byte limit',async()=>{
 await assert.rejects(decodeBoundaryResponse(new Response(gzipSync(' '.repeat(2**20))),{maxBytes:1024}),/边界文件.*限制/);
});
test('boundary decode rejects cancellation and HTTP failure',async()=>{
 const abort=new AbortController();abort.abort();await assert.rejects(decodeBoundaryResponse(new Response(body),{signal:abort.signal}),{name:'AbortError'});
 await assert.rejects(decodeBoundaryResponse(new Response('missing',{status:404})),/HTTP 404/);
});
test('asset manifest selects its packed same-origin path and never swallows a real download error',async()=>{
 const seen=[];const packed={'/data/a.geojson':{url:'/data/a.geojson.gz'}};
 const result=await readBoundaryAsset('/data/a.geojson',undefined,packed,async url=>{seen.push(url);return new Response(gzipSync(body));});
 assert.deepEqual(result,data);assert.deepEqual(seen,['/data/a.geojson.gz']);
 await assert.rejects(readBoundaryAsset('/data/a.geojson',undefined,packed,async()=>new Response('',{status:503})),/HTTP 503/);
});
test('current geometry replaces old paint while historical-only districts remain available',()=>{
 const current=data.features[0],old={...current,geometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,0]]]}},legacy={...old,id:'old-province'};
 const merged=mergeAreaAssets({type:'FeatureCollection',features:[old,legacy]},data);
 assert.equal(merged.features.find(f=>f.id==='county-a'),current);assert.ok(merged.features.some(f=>f.id==='old-province'));
});

test('multipart boundary transport reconstructs the exact gzip before decoding',async()=>{
 const packed=gzipSync(body);const half=Math.floor(packed.length/2);const chunks=[packed.subarray(0,half),packed.subarray(half)];
 const parts=chunks.map((b,i)=>({url:`/data/precision/a.geojson.gz.part-${i}.bin`,bytes:b.length}));
 const catalog={'/data/a.geojson':{url:'/data/a.geojson.gz',bytes:packed.length,parts}};
 const seen=[];const dataOut=await readBoundaryAsset('/data/a.geojson',undefined,catalog,async url=>{seen.push(url);const i=parts.findIndex(p=>p.url===url);return i<0?new Response('',{status:404}):new Response(chunks[i]);});
 assert.deepEqual(dataOut,data);assert.deepEqual(seen,parts.map(p=>p.url));
});
test('a missing or truncated multipart boundary cannot fall back to a partial polygon',async()=>{
 const catalog={'/data/a.geojson':{url:'/data/a.geojson.gz',bytes:10,parts:[{url:'/data/a.part.bin',bytes:10}]}};
 await assert.rejects(readBoundaryAsset('/data/a.geojson',undefined,catalog,async()=>new Response('',{status:404})),/HTTP 404/);
 await assert.rejects(readBoundaryAsset('/data/a.geojson',undefined,catalog,async()=>new Response('short')),/分片|长度/);
});
