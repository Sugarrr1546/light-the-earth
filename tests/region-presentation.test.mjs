import test from 'node:test';import assert from 'node:assert/strict';
import {isUsableRegionName,presentRegion,canLabelRegion} from '../lib/region-presentation.ts';
const r={id:'GB-tokyo-1234567890',name:'?????',originalName:'?????',aliases:['?????'],countryCode:'JPN',countryName:'日本',level:'local',center:[139.971,35.67],year:'2017'};
test('literal question marks, replacement glyphs and source placeholders never become map labels',()=>{
 for(const s of ['?????','???A','�','未命名区域 · 123','undefined','Null','NULL','Unknown','UNNAMED','N/A',''])assert.equal(isUsableRegionName(s),false,s);
 const shown=presentRegion(r,{regions:{}});assert.equal(canLabelRegion(shown),false);assert.match(shown.name,/待核实/);assert.ok(!shown.name.includes('?'));assert.equal(shown.originalName,'');assert.deepEqual(r.name,'?????');
});
test('real Nan place names and native scripts remain valid',()=>{
 for(const s of ["Nan'an City",'Nan County','Nan','さいたま市西区','Łódź','الجزائر'])assert.equal(isUsableRegionName(s),true,s);
});
test('verified repairs preserve geometry year and stable IDs while explaining unassigned land',()=>{
 const shown=presentRegion(r,{regions:{[r.id]:{name:'千叶县所属未定地',aliases:['所属未定地'],parentName:'千叶县',status:'boundary-undetermined',note:'官方未归属市区町村',evidenceURLs:['https://nlftp.mlit.go.jp/ksj/']}}});
 assert.equal(shown.name,'千叶县所属未定地');assert.equal(shown.id,r.id);assert.equal(shown.year,'2017');assert.deepEqual(shown.center,r.center);assert.equal(shown.nameStatus,'boundary-undetermined');assert.equal(canLabelRegion(shown),true);assert.equal(shown.nameSourceUrl,'https://nlftp.mlit.go.jp/ksj/');assert.ok(!shown.aliases.includes('?????'));
});
test('a valid imported identifier cannot accidentally read inherited dictionary properties',()=>{
 const region={...r,id:'constructor',name:'Original place',originalName:'Original place'};assert.equal(presentRegion(region,{regions:{}}).name,'Original place');
});

test('historical status is displayed without rewriting stored region metadata',()=>{
 const original={id:'OLD-COUNTY',name:'Old County',countryCode:'GBR',countryName:'英国',level:'local',center:[0,51],year:'2013'};
 const snapshot=structuredClone(original);
 const shown=presentRegion(original,{regions:{'OLD-COUNTY':{boundaryStatus:'historical',note:'原始历史边界保留，不自动迁移。'}}});
 assert.equal(shown.boundaryStatus,'historical');assert.equal(shown.year,'2013');assert.equal(shown.id,'OLD-COUNTY');assert.deepEqual(original,snapshot);
});
