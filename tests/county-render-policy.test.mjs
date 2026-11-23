import test from 'node:test';
import assert from 'node:assert/strict';
import {countyRenderPolicy,countyViewKey} from '../lib/county-render-policy.ts';
test('large countries keep viewport rendering after preloading; small sources stay resident',()=>{
 for(const [bytes,count] of [[49401124,2843],[9496044,1742],[38522441,34881]])assert.equal(countyRenderPolicy(bytes,count).viewport,true);
 assert.deepEqual(countyRenderPolicy(1000000,300),{viewport:false,minZoom:3.45});
 assert.equal(countyRenderPolicy(38522441,34881).minZoom,6.5);
 assert.equal(countyRenderPolicy(49401124,2843).minZoom,5.5);
});
test('overview has one stable empty source key and detail changes on actual viewport movement',()=>{
 const p=countyRenderPolicy(49401124,2843),a=[100,20,105,25],b=[110,20,115,25];
 assert.equal(countyViewKey(p,4,a),countyViewKey(p,5,b));
 assert.notEqual(countyViewKey(p,6,a),countyViewKey(p,6,b));
 assert.notEqual(countyViewKey(p,20,[120,30,120.00001,30.00001]),countyViewKey(p,20,[120.00002,30,120.00003,30.00001]));
 assert.notEqual(countyViewKey(p,5,a),countyViewKey(p,6,a));
 assert.notEqual(countyViewKey(p,6,[170,0,190,10]),countyViewKey(p,6,[-10,0,10,10]));
});

test('unchanged padded views reuse rendered geometry while real changes and refreshed names republish',async()=>{
 const {sameCountyView}=await import('../lib/county-render-policy.ts');
 const geometry={type:'Polygon',coordinates:[]},properties={name:'A'},a=[{id:'a',geometry,properties}];
 assert.equal(sameCountyView(undefined,a),false);
 assert.equal(sameCountyView(a,[{id:'a',geometry,properties}]),true);
 assert.equal(sameCountyView(a,[{id:'a',geometry:{...geometry},properties}]),false);
 assert.equal(sameCountyView(a,[{id:'a',geometry,properties:{name:'B'}}]),false);
 assert.equal(sameCountyView(a,[]),false);
 assert.equal(sameCountyView([],[]),true);
});

test('render overscan scales with the screen, including tiny city views and dateline crossing',async()=>{
 const {countyRenderView}=await import('../lib/county-render-policy.ts');
 const tiny=countyRenderView(120,30,120.01,30.01);
 assert.ok(tiny[0]<120&&tiny[2]>120.01);
 assert.ok(tiny[2]-tiny[0]<0.02,'city viewport must not expand by fixed 0.8 degrees');
 const date=countyRenderView(179,-10,-179,-8);
 assert.ok(date[2]-date[0]<3);
 assert.ok(date[0]<179&&date[2]>181);
});
