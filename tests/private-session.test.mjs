import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {existsSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
registerHooks({resolve(specifier,context,next){if(specifier.startsWith('.')&&context.parentURL?.startsWith('file:')){const p=fileURLToPath(new URL(specifier,context.parentURL));if(existsSync(p+'.ts'))return {url:pathToFileURL(p+'.ts').href,shortCircuit:true};}return next(specifier,context);}});
const {bindPrivateSession,privateSessionLease,verifyPrivateSession}=await import('../lib/private-session.ts');
const {api}=await import('../lib/client-api.ts');

test('changing private scope invalidates old in-flight response and binds the actor header',async()=>{
 let resolve;const old=globalThis.fetch;globalThis.fetch=async(_url,options)=>{assert.equal(new Headers(options.headers).get('x-atlas-actor'),'alice');return new Promise(r=>{resolve=r;});};
 const disposeA=bindPrivateSession('alice',()=>{});const pending=api('/api/visits');
 const disposeB=bindPrivateSession('bob',()=>{});resolve(Response.json({visits:[{notes:'Alice secret'}]}));
 try{await assert.rejects(pending,error=>error.code==='ACCOUNT_CHANGED');}finally{disposeA();disposeB();globalThis.fetch=old;}
});
test('401 immediately invalidates scope and prevents further old-scope writes',async()=>{
 let invalidations=0,requests=0;const old=globalThis.fetch;globalThis.fetch=async()=>{requests++;return Response.json({error:'expired'},{status:401});};const dispose=bindPrivateSession('alice',()=>invalidations++);
 try{await assert.rejects(api('/api/visits'));assert.equal(invalidations,1);await assert.rejects(api('/api/visits',{method:'POST',body:'{}'}));assert.equal(requests,1);}finally{dispose();globalThis.fetch=old;}
});
test('actor mismatch response invalidates UI before returning private response',async()=>{
 let invalidations=0;const old=globalThis.fetch;globalThis.fetch=async()=>Response.json({code:'ACCOUNT_CHANGED'},{status:403});const dispose=bindPrivateSession('alice',()=>invalidations++);
 try{await assert.rejects(api('/api/visits'),error=>error.code==='ACCOUNT_CHANGED');assert.equal(invalidations,1);}finally{dispose();globalThis.fetch=old;}
});
test('identity checks use only the lightweight endpoint and invalidate a different account',async()=>{
 let invalidations=0;const dispose=bindPrivateSession('alice',()=>invalidations++);
 await verifyPrivateSession(async url=>{assert.equal(url,'/api/session');return Response.json({userId:'bob'});});assert.equal(invalidations,1);dispose();
});
test('network failures on a focus check do not manufacture an account switch',async()=>{
 let invalidations=0;const dispose=bindPrivateSession('alice',()=>invalidations++);await verifyPrivateSession(async()=>{throw Error('offline');});assert.equal(invalidations,0);privateSessionLease('alice').assert();dispose();
});
test('old export/upload lease cannot be reused for the next account',()=>{
 const disposeA=bindPrivateSession('alice',()=>{});const lease=privateSessionLease('alice');const disposeB=bindPrivateSession('bob',()=>{});assert.throws(()=>lease.assert(),error=>error.code==='ACCOUNT_CHANGED');assert.throws(()=>privateSessionLease('alice'),error=>error.code==='ACCOUNT_CHANGED');disposeA();disposeB();
});

test('a private photo fetch directly invalidates on an old actor response',async()=>{
 const {privateFetch}=await import('../lib/client-api.ts');let invalidations=0;const old=globalThis.fetch;globalThis.fetch=async()=>Response.json({code:'ACCOUNT_CHANGED'},{status:403});const dispose=bindPrivateSession('alice',()=>invalidations++);
 try{await assert.rejects(privateFetch('/api/photos/photo-1'),e=>e.code==='ACCOUNT_CHANGED');assert.equal(invalidations,1);}finally{dispose();globalThis.fetch=old;}
});
test('zero-photo ZIP export rechecks current identity and cannot download after account switch',async()=>{
 const {exportBackup}=await import('../lib/backup.ts');const JSZip=(await import('jszip')).default;
 const originalGenerate=JSZip.prototype.generateAsync,oldFetch=globalThis.fetch;
 let finish,downloaded=0;
 JSZip.prototype.generateAsync=function(){return new Promise(resolve=>{finish=resolve;});};
 globalThis.fetch=async url=>{assert.equal(url,'/api/session');return Response.json({userId:'bob'});};
 const oldDocument=globalThis.document;globalThis.document={createElement:()=>({click(){downloaded++;}})};
 const dispose=bindPrivateSession('alice',()=>{});
 try{const pending=exportBackup([{id:'one',region:{id:'test',name:'Test',countryCode:'TST',countryName:'Test',level:'local',center:[0,0]},status:'visited',visitedOn:'',title:'Alice private',notes:'secret',tripName:'',photos:[],createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'}],()=>{});finish(new Blob(['zip']));await assert.rejects(pending);assert.equal(downloaded,0);}finally{dispose();JSZip.prototype.generateAsync=originalGenerate;globalThis.fetch=oldFetch;globalThis.document=oldDocument;}
});
test('zero-photo ZIP export also fails closed when identity cannot be checked',async()=>{
 const {exportBackup}=await import('../lib/backup.ts');const JSZip=(await import('jszip')).default;
 const originalGenerate=JSZip.prototype.generateAsync,oldFetch=globalThis.fetch;
 JSZip.prototype.generateAsync=async()=>new Blob(['zip']);globalThis.fetch=async()=>new Response('',{status:503});
 const dispose=bindPrivateSession('alice',()=>{});
 try{await assert.rejects(exportBackup([],()=>{}),/备份未下载/);privateSessionLease('alice').assert();}finally{dispose();JSZip.prototype.generateAsync=originalGenerate;globalThis.fetch=oldFetch;}
});

test('BFCache curtain hides synchronously and ignores an older in-flight success',async()=>{
 const {createPrivateVisibilityGuard}=await import('../lib/private-session.ts');
 let hidden=false,shown=0,focused=true,requests=0;const resolvers=[];
 const guard=createPrivateVisibilityGuard({hide(){hidden=true;},show(){hidden=false;shown++;},failed(){},canShow:()=>focused,verify:()=>{requests++;return new Promise(resolve=>resolvers.push(resolve));}});
 guard.check();assert.equal(hidden,true);assert.equal(requests,1);
 focused=false;guard.hide();assert.equal(hidden,true);
 focused=true;guard.check();assert.equal(requests,1);
 resolvers[0](true);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(shown,0);assert.equal(hidden,true);assert.equal(requests,2);
 resolvers[1](true);await new Promise(resolve=>setImmediate(resolve));assert.equal(hidden,false);assert.equal(shown,1);guard.dispose();
});
test('an unavailable identity probe keeps curtain up and supports an explicit retry',async()=>{
 const {createPrivateVisibilityGuard}=await import('../lib/private-session.ts');let hidden=false,failed=0,valid=false,probes=0;
 const guard=createPrivateVisibilityGuard({hide(){hidden=true;},show(){hidden=false;},failed(){failed++;},canShow:()=>true,verify:async()=>{probes++;return valid;}});
 guard.check();await new Promise(resolve=>setImmediate(resolve));assert.equal(hidden,true);assert.equal(failed,1);assert.equal(probes,1);
 valid=true;guard.check();await new Promise(resolve=>setImmediate(resolve));assert.equal(hidden,false);assert.equal(probes,2);guard.dispose();
});
