import test from 'node:test';import assert from 'node:assert/strict';
import {mapPalette,themedMapPaint,footprintCountries,footprintTints,countryFillColor,FOOTPRINT_TINT_ZOOM} from '../lib/map-appearance.ts';
import {localFocusZoom,drawerRevealShift,claimPulses,LOCAL_FOCUS_MAX_ZOOM,mapPadding,overviewDiameter} from '../lib/map-view-controls.ts';
const lab=hex=>{const [r,g,b]=hex.slice(1).match(/../g).map(x=>parseInt(x,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);const f=v=>v>.008856?Math.cbrt(v):7.787*v+16/116;const X=f((r*.4124+g*.3576+b*.1805)/.95047),Y=f(r*.2126+g*.7152+b*.0722),Z=f((r*.0193+g*.1192+b*.9505)/1.08883);return [116*Y-16,500*(X-Y),200*(Y-Z)];};
const deltaE=(a,b)=>Math.hypot(...lab(a).map((v,i)=>v-lab(b)[i]));

test('the selection outline never reads as a lit-area border in either theme',()=>{
 for(const theme of ['light','dark']){const p=mapPalette(theme);
  assert.ok(deltaE(p.selection,p.areaBorder)>20,`${theme} selection vs lit border`);
  assert.ok(deltaE(p.selection,p.selectionCasing)>60,`${theme} selection core vs casing`);
  assert.equal(themedMapPaint('local-CHN-selection-casing',theme)['line-color'],p.selectionCasing);
  assert.equal(themedMapPaint('local-CHN-selection',theme)['line-color'],p.selection);
  assert.equal(themedMapPaint('country-selection-casing',theme)['line-color'],p.selectionCasing);
 }
});
test('visited and lived areas stay distinguishable by day and by night',()=>{
 for(const theme of ['light','dark']){const p=mapPalette(theme);assert.ok(deltaE(p.areaVisited,p.areaLived)>15,`${theme} visited vs lived`);}
});
test('wish areas keep an edge that separates them from the sea',()=>{
 for(const theme of ['light','dark']){const p=mapPalette(theme);assert.ok(deltaE(p.wishBorder,p.ocean)>20,`${theme} wish border vs ocean`);}
});
test('searched local places keep city context without dropping below the boundary zoom',()=>{
 assert.equal(localFocusZoom(12,3.45),LOCAL_FOCUS_MAX_ZOOM);
 assert.ok(Math.abs(localFocusZoom(10,3.45)-9.4)<1e-9);
 // A fit just above a dense country's threshold backs off only to the threshold.
 assert.ok(Math.abs(localFocusZoom(7,6.5)-6.6)<1e-9);
 // A large region whose fit is already below the threshold keeps its whole-region fit.
 assert.equal(localFocusZoom(5,5.5),5);
});
test('a map click pans only when the drawer would cover the place',()=>{
 assert.equal(drawerRevealShift(500,1440,410),0);
 assert.equal(drawerRevealShift(982,1440,410),0);
 assert.equal(drawerRevealShift(1300,1440,410),318);
});
test('only a save lights an area up; filters and tabs re-show areas quietly',()=>{
 const pending=new Map();
 // A timeline filter re-shows existing areas: nothing was requested, nothing pulses.
 assert.deepEqual(claimPulses(pending,['a','b'],1000),[]);
 // A save requests its region; it pulses once when its area is drawn, then never again.
 pending.set('b',1000);
 assert.deepEqual(claimPulses(pending,['a'],1100),[]);
 assert.deepEqual(claimPulses(pending,['a','b'],1200),['b']);
 assert.deepEqual(claimPulses(pending,['a','b'],1300),[]);
 // A request whose area never arrived expires instead of firing on a later filter change.
 pending.set('c',2000);
 assert.deepEqual(claimPulses(pending,['c'],2000+15001),[]);
});
const visit=(countryCode,level,status)=>({region:{countryCode,level},status});
test('a country with local footprints takes the strongest of their statuses, unless it is recorded as a whole',()=>{
 const countries=footprintCountries([visit('CHN','local','passed'),visit('CHN','local','lived'),visit('CHN','local','visited'),visit('USA','local','wishlist'),visit('THA','local','visited'),visit('THA','country','visited'),visit('ISL','country','wishlist')]);
 assert.deepEqual([...countries].sort(),[['CHN','lived'],['USA','wishlist']]);
});
test('the footprint tint reads as lit land, yet stays softer than a recorded area',()=>{
 for(const theme of ['light','dark']){const p=mapPalette(theme),tints=footprintTints(theme);
  for(const [status,full] of [['lived',p.areaLived],['visited',p.areaVisited],['passed',p.areaPassed],['wishlist',p.areaWish]]){
   assert.ok(deltaE(tints[status],p.land)>8,theme+' '+status+' tint vs plain land');
   assert.ok(deltaE(tints[status],full)>8,theme+' '+status+' tint vs recorded area');
  }
  assert.ok(deltaE(tints.wishlist,p.ocean)>15,theme+' wish tint vs ocean');
 }
});
test('the world view tints footprint countries and returns to plain land where local areas take over',()=>{
 const p=mapPalette('light'),tints=footprintTints('light');
 assert.equal(countryFillColor('light',new Map()),p.land);
 assert.deepEqual(countryFillColor('light',new Map([['JPN','visited'],['USA','wishlist'],['CHN','visited']])),
  ['interpolate',['linear'],['zoom'],FOOTPRINT_TINT_ZOOM[0],['match',['get','countryCode'],['CHN','JPN'],tints.visited,['USA'],tints.wishlist,p.land],FOOTPRINT_TINT_ZOOM[1],p.land]);
 // Local boundaries appear at zoom 3.45; the tint must be gone by then so real areas are not double-painted.
 assert.equal(FOOTPRINT_TINT_ZOOM[1],3.45);
});
test('the camera centres on the part of the map that no panel covers',()=>{
 assert.deepEqual(mapPadding(1440,true,160),{left:340,right:0,top:0,bottom:160});
 assert.deepEqual(mapPadding(1100,true,0),{left:310,right:0,top:0,bottom:0});
 // A collapsed sidebar or a narrow window leaves the full width; a hidden timeline leaves the full height.
 assert.deepEqual(mapPadding(1440,false,-4),{left:0,right:0,top:0,bottom:0});
 assert.deepEqual(mapPadding(390,true,131.6),{left:0,right:0,top:0,bottom:132});
 // The floating toolbar is kept clear in the same way.
 assert.deepEqual(mapPadding(1440,true,128,60),{left:340,right:0,top:60,bottom:128});
 assert.deepEqual(mapPadding(1440,true,0,-3),{left:340,right:0,top:0,bottom:0});
});
test('the overview globe fits above the timeline instead of sliding under it',()=>{
 const covered=overviewDiameter(1440,818,160),open=overviewDiameter(1440,818,0);
 assert.ok(covered<=818-160,'fits the free height');
 assert.ok(covered<open&&open<=600);
 assert.ok(overviewDiameter(390,700,130)<=390*0.88);
 assert.equal(overviewDiameter(1440,818,5000),0);
 // The toolbar strip counts as covered too.
 assert.ok(overviewDiameter(1440,818,128,60)<=818-128-60);
 assert.ok(overviewDiameter(1440,700,128,60)<overviewDiameter(1440,700,128));
});
