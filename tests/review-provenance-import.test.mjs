import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import JSZip from 'jszip';
registerHooks({resolve(s,c,next){if(s.startsWith('.')&&c.parentURL?.includes('/lib/')){const p=fileURLToPath(new URL(s,c.parentURL))+'.ts';if(existsSync(p))return {url:pathToFileURL(p).href,shortCircuit:true};}return next(s,c);}});
const {importBackup}=await import('../lib/backup.ts');
const {bindPrivateSession}=await import('../lib/private-session.ts');
const photo={id:'uploaded',filename:'photo.jpg',url:'/api/photos/uploaded'};
const entry=id=>({id,region:{id:'place',name:'地方',countryCode:'FRA',countryName:'法国',level:'local',center:[0,0]},status:'visited',visitedOn:'',title:'',notes:'',tripName:'',createdAt:'2020-01-01T00:00:00Z',updatedAt:'2020-01-01T00:00:00Z',photos:[{id:'original',filename:'photo.jpg',archivePath:'photos/original.jpg'}]});
async function archive(ids){const zip=new JSZip();zip.file('atlas.json',JSON.stringify({version:1,visits:ids.map(entry)}));zip.file('photos/original.jpg',new Uint8Array([255,216,255,224,0,16,74,70,73,70,0,0]));return zip.generateAsync({type:'nodebuffer'});}
async function simulate(ids,create){const dispose=bindPrivateSession('alice',()=>{});const original=globalThis.fetch;const calls=[];globalThis.fetch=async(path,options)=>{assert.equal(new Headers(options.headers).get('x-atlas-actor'),'alice');calls.push([path,options.method]);if(path==='/api/photos')return Response.json({photo},{status:201});if(path==='/api/visits')return create(JSON.parse(options.body));if(path==='/api/photos/uploaded')return Response.json({ok:true});throw Error('Unexpected URL');};try{return {count:await importBackup(await archive(ids),[],()=>{}),calls};}catch(error){error.calls=calls;throw error;}finally{dispose();globalThis.fetch=original;}}
test('a stale photo 409 is a failed restore and its unreferenced upload is reclaimed',async()=>{
 await assert.rejects(simulate(['one'],()=>Response.json({error:'stale',code:'STALE_PHOTO_REFERENCE'},{status:409})),error=>{assert.match(error.message,/已恢复 0 条/);assert.ok(error.calls.some(([p,m])=>p==='/api/photos/uploaded'&&m==='DELETE'));return true;});
});
test('only an explicit duplicate code is skipped and duplicate-only uploads are reclaimed',async()=>{
 const result=await simulate(['one'],()=>Response.json({error:'duplicate',code:'VISIT_ALREADY_EXISTS'},{status:409}));assert.equal(result.count,0);assert.ok(result.calls.some(([p,m])=>p==='/api/photos/uploaded'&&m==='DELETE'));
 await assert.rejects(simulate(['one'],()=>Response.json({error:'unknown conflict'},{status:409})),/已恢复 0 条/);
});
test('a shared upload attached by a completed restore survives a later failure',async()=>{
 let created=0;await assert.rejects(simulate(['one','two'],()=>++created===1?Response.json({visit:{}},{status:201}):Response.json({error:'unavailable'},{status:500})),error=>{assert.match(error.message,/已恢复 1 条/);assert.ok(!error.calls.some(([,m])=>m==='DELETE'));return true;});
});
