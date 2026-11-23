import test from 'node:test';import assert from 'node:assert/strict';
import{chooseMapFeature,replacedWorldIds,polygonContainsPoint}from'../lib/map-interaction.ts';
const hit=(id,layer,level='local')=>({id,layer:{id:layer},properties:{id,level}});
test('a visible historical local memory wins over covering current county polygons',()=>{const old=hit('old-xiacheng','saved-area-fill'),current=hit('new-gongshu','local-CHN-fill');assert.equal(chooseMapFeature([current,old]),old);});
test('a whole-country memory does not block current local picking',()=>{const country=hit('country','saved-area-fill','country'),current=hit('county','local-CHN-fill');assert.equal(chooseMapFeature([country,current]),current);});
test('empty replacement metadata still hides world outlines except explicit retained pieces',()=>{assert.deepEqual(replacedWorldIds({replaceWorldIds:[],retainedWorldIds:[]},['NE-CHN']),['NE-CHN']);assert.deepEqual(replacedWorldIds({replaceWorldIds:[],retainedWorldIds:['remote']},['main','remote']),['main']);assert.deepEqual(replacedWorldIds({replaceWorldIds:['main']},['main','remote']),['main']);});
test('exact picking respects polygon holes, edges, multipolygons and longitude wrapping',()=>{
 const g={type:'Polygon',coordinates:[[[0,0],[4,0],[4,4],[0,4],[0,0]],[[1,1],[1,2],[2,2],[2,1],[1,1]]]};assert.equal(polygonContainsPoint(g,[.5,.5]),true);assert.equal(polygonContainsPoint(g,[1.5,1.5]),false);assert.equal(polygonContainsPoint(g,[4,2]),true);
 assert.equal(polygonContainsPoint({type:'MultiPolygon',coordinates:[[[[179,-2],[181,-2],[181,2],[179,2],[179,-2]]]]},[-179.5,0]),true);
});
test('resident viewport geometry replaces the previous view instead of accumulating a country',async()=>{
 const{replaceResidentCountyShapes}=await import('../lib/map-interaction.ts');const country={id:'country',geometry:{}};const resident=new Map([['country',country]]);let ids=new Set();
 for(let view=0;view<20;view++){const fs=Array.from({length:5},(_,i)=>({id:`view${view}-${i}`,geometry:{coordinates:[view,i]}}));ids=replaceResidentCountyShapes(resident,ids,fs);assert.equal(resident.size,6);assert.equal(resident.get('country'),country);}
 assert.equal(resident.has('view0-0'),false);assert.equal(resident.has('view19-0'),true);
});
test('a pointer in space beside the globe is not on any place',async()=>{
 const{pointerOnSurface}=await import('../lib/map-interaction.ts');
 // A globe of radius 300 centred at (500,400): places beyond the limb unproject to the nearest point on it.
 const globe={unproject:([x,y])=>{const dx=x-500,dy=y-400,d=Math.hypot(dx,dy),k=d>300?300/d:1;return{lng:dx*k,lat:dy*k};},project:([lng,lat])=>({x:500+lng,y:400+lat})};
 assert.equal(pointerOnSurface(globe,{x:500,y:400}),true);
 assert.equal(pointerOnSurface(globe,{x:700,y:560}),true);
 assert.equal(pointerOnSurface(globe,{x:40,y:400}),false);
 assert.equal(pointerOnSurface(globe,{x:500,y:95}),false);
 // Just past the limb counts as space; within the tolerance of it still counts as the surface.
 assert.equal(pointerOnSurface(globe,{x:197,y:400}),false);
 assert.equal(pointerOnSurface(globe,{x:199,y:400}),true);
 // A flat map projects every pointer back onto itself.
 const flat={unproject:([x,y])=>({lng:x/10,lat:y/10}),project:([lng,lat])=>({x:lng*10,y:lat*10})};
 assert.equal(pointerOnSurface(flat,{x:3,y:790}),true);
});
