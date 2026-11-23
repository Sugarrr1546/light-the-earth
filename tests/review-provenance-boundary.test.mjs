import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {readBoundaryAsset,fetchBoundaryBytes} from '../lib/boundary-assets.ts';
const body=Buffer.from('{"type":"FeatureCollection","features":[],"name":"海岸"}');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const url='/data/test.geojson';
const asset={url:url+'.gz',sha256:hash(body),decodedBytes:body.length,bytes:gzipSync(body).length};
test('single gzip verifies the decoded whole-file hash and versions its cache URL',async()=>{
 const seen=[];assert.deepEqual(await readBoundaryAsset(url,undefined,{[url]:asset},async p=>{seen.push(p);return new Response(gzipSync(body));}),JSON.parse(body));
 assert.deepEqual(seen,[asset.url+'?v='+hash(body)]);
 await assert.rejects(readBoundaryAsset(url,undefined,{[url]:asset},async()=>new Response(gzipSync(body.toString().replace('海岸','湖岸')))),/校验/);
});
test('browser auto-decoding has identical integrity semantics; worker receives decoded bytes',async()=>{
 for(const bytes of [body,gzipSync(body)])assert.deepEqual(Buffer.from(await fetchBoundaryBytes(url,undefined,{[url]:asset},async()=>new Response(bytes))),body);
 await assert.rejects(fetchBoundaryBytes(url,undefined,{[url]:{...asset,decodedBytes:1}},async()=>new Response(body)),/长度/);
});
test('part hashes alone cannot replace a mismatching whole-file decoded hash',async()=>{
 const packed=gzipSync(body);const half=Math.floor(packed.length/2);const chunks=[packed.subarray(0,half),packed.subarray(half)];
 const parts=chunks.map((b,i)=>({url:`/data/p${i}-${hash(b).slice(0,16)}.bin`,bytes:b.length,sha256:hash(b)}));
 const catalog={[url]:{...asset,parts,sha256:'0'.repeat(64)}};
 await assert.rejects(readBoundaryAsset(url,undefined,catalog,async p=>new Response(chunks[parts.findIndex(part=>part.url===p)])),/校验/);
});
test('different decoded content hashes cannot reuse a previous gzip cache key',async()=>{
 const seen=[];for(const content of [body,Buffer.from(body.toString().replace('海岸','湖岸'))])await readBoundaryAsset(url,undefined,{[url]:{...asset,sha256:hash(content)}},async p=>{seen.push(p);return new Response(content);});assert.notEqual(seen[0],seen[1]);
});
test('cancellation during whole-file hashing wins over a stale integrity result',async()=>{
 const controller=new AbortController();const original=crypto.subtle.digest;
 crypto.subtle.digest=async function(...args){const result=await original.apply(this,args);controller.abort();return result;};
 try{await assert.rejects(fetchBoundaryBytes(url,controller.signal,{[url]:{...asset,sha256:'0'.repeat(64)}},async()=>new Response(body)),{name:'AbortError'});}
 finally{crypto.subtle.digest=original;}
});
