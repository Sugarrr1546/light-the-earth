import test from 'node:test';
import assert from 'node:assert/strict';
import {createGeometryRenderData} from '../lib/geometry-render-data.ts';
const data=()=>({type:'FeatureCollection',features:[{type:'Feature',id:'GB-islands',properties:{id:'GB-islands',name:'岛屿与海岸'},geometry:{type:'Polygon',coordinates:[[[179.123456789,10],[-179.987654321,10],[-179.987654321,12],[179.123456789,10]]]}}]});
test('worker-readable memory URL preserves full coordinates, properties and IDs through source reuse',async()=>{
 const pool=createGeometryRenderData(),original=data(),url=pool.source(original);
 assert.equal(typeof url,'string');assert.equal(pool.source(original),url);
 assert.deepEqual(await(await fetch(url)).json(),original);
 assert.deepEqual(await(await fetch(url)).json(),original,'keep the current URL alive for worker/source reload');
 pool.dispose();await assert.rejects(fetch(url));
});
test('immutable objects encode once and every held URL is released exactly once on country removal',()=>{
 const created=[],revoked=[],pool=createGeometryRenderData({createURL:blob=>{const url='blob:land-'+created.length;created.push({url,blob});return url;},revokeURL:url=>revoked.push(url)}),a=data(),b=data();
 const one=pool.source(a);assert.equal(pool.source(a),one);const two=pool.source(b);
 assert.notEqual(one,two);assert.equal(created.length,2);assert.deepEqual(revoked,[]);
 pool.dispose();pool.dispose();assert.deepEqual(revoked,[one,two]);assert.throws(()=>pool.source(a),/disposed/i);
});
test('missing or failing Blob URL support retains the existing object source without mutating it',()=>{
 for(const createURL of [null,()=>{throw Error('URL unavailable');}]){
  const revoked=[],pool=createGeometryRenderData({createURL,revokeURL:url=>revoked.push(url)}),original=data(),snapshot=structuredClone(original);
  assert.equal(pool.source(original),original);assert.equal(pool.source(original),original);assert.deepEqual(original,snapshot);
  pool.dispose();assert.deepEqual(revoked,[]);
 }
});

test('recovery snapshots can retain URL ownership through country eviction until references disappear',async()=>{
 const pool=createGeometryRenderData(),original=data(),url=pool.source(original);
 assert.equal(pool.disposeUnlessReferenced([url]),false,'saved recovery style still owns the URL');
 assert.deepEqual(await(await fetch(url)).json(),original);
 assert.equal(pool.disposeUnlessReferenced(['blob:unrelated-country']),true,'worker decoded the snapshot or its source was removed');
 await assert.rejects(fetch(url));
});

test('a worker URL read failure can recover the exact original object until disposal',()=>{
 const pool=createGeometryRenderData(),original=data(),url=pool.source(original);
 assert.equal(pool.original(url),original);
 assert.equal(pool.original('blob:another-source'),undefined);
 pool.dispose();assert.equal(pool.original(url),undefined);
});

test('the US-neighbor optimization preserves direct land objects for other countries',async()=>{
 const {countryLandSource}=await import('../lib/geometry-render-data.ts');
 const pool=createGeometryRenderData(),original=data();
 for(const code of ['USA','CHN','JPN','FRA','RUS','IND','BRA'])assert.equal(countryLandSource(code,original,pool),original);
 const url=countryLandSource('CAN',original,pool);assert.equal(typeof url,'string');assert.deepEqual(await(await fetch(url)).json(),original);pool.dispose();
});
