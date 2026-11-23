import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { gzipSync } from 'node:zlib';
import { boxesOverlap } from '../lib/county-layer.ts';
const source=readFileSync(new URL('../lib/boundary-detail.worker.ts',import.meta.url),'utf8');
function worker(){
 const messages=[];const self={postMessage:message=>messages.push(message)};
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(code,{self,exports:{},require:()=>({boxesOverlap}),Map,ArrayBuffer,Uint8Array,Blob,Response,DecompressionStream,TextDecoder});
 return {messages,send:body=>self.onmessage({data:body})};
}
const feature={type:'Feature',id:'a',properties:{bbox:[100,20,101,21]},geometry:{type:'Polygon',coordinates:[[[100,20],[101,20],[101,21],[100,20]]]}};
const bytes=Buffer.from(JSON.stringify({type:'FeatureCollection',features:[feature]}));
const buffer=b=>b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('an evicted country cannot reappear in the detail worker after a late decode',async()=>{
 const w=worker();w.send({type:'load',id:1,key:'A',buffer:buffer(bytes)});w.send({type:'drop',id:2,key:'A'});await settle();
 w.send({type:'view',id:3,key:'A',view:[99,19,102,22]});await settle();
 assert.equal(w.messages.find(m=>m.id===3)?.type,'error');
});
test('the detail worker decodes the gzip asset shipped by production',async()=>{
 const w=worker();w.send({type:'load',id:1,key:'A',buffer:buffer(gzipSync(bytes))});
 for(let i=0;i<40&&!w.messages.length;i++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(w.messages[0]?.type,'loaded');w.send({type:'view',id:2,key:'A',view:[99,19,102,22]});await settle();
 assert.equal(w.messages.find(m=>m.id===2)?.features[0]?.id,'a');
});
