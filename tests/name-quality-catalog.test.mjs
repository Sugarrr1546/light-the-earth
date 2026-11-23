import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {validateVisitInput} from '../lib/validation.ts';
import {presentRegion,isUsableRegionName,canLabelRegion} from '../lib/region-presentation.ts';
const read=url=>JSON.parse(readFileSync(new URL('../public'+url,import.meta.url)));
const names=read('/data/name-quality.json'),aligned=read('/data/geometry-alignment.json');
test('Tokyo Bay and Fujiyoshida no longer expose corrupt source names',()=>{
 const jpn=read(aligned.countries.JPN.localUrl).features;
 const bay=presentRegion(jpn.find(f=>f.id==='GB-22064153B42729341445185').properties,names);
 assert.equal(bay.name,'千葉県所属未定地');assert.equal(bay.nameStatus,'boundary-undetermined');assert.match(bay.nameNote,/未归属/);assert.equal(bay.year,'2017');
 const city=presentRegion(jpn.find(f=>f.id==='GB-22064153B45156088025009').properties,names);assert.equal(city.name,'富士吉田市');assert.equal(city.nameStatus,'verified');
});
test('source mojibake has reversible repair evidence and normal Nan names stay intact',()=>{
 const repair=Object.values(names.regions).find(r=>r.encodingEvidence?.originalName==='Cap-PelÃ©');assert.equal(repair.name,'Cap-Pelé');assert.ok(repair.encodingEvidence.reversible);
 const original={id:'real-place',name:"Nan'an City",countryCode:'CHN',countryName:'中国',level:'local',center:[118,25]};assert.equal(presentRegion(original,names).name,original.name);
});
test('every map-visible label in every current layer has usable text without changing stable identities',()=>{
 let count=0;
 for(const a of Object.values(aligned.countries))for(const f of read(a.localUrl).features){const before=f.properties,shown=presentRegion(before,names);assert.equal(shown.id,before.id);assert.equal(shown.year,before.year);assert.deepEqual(shown.bbox,before.bbox);if(canLabelRegion(shown)){assert.ok(isUsableRegionName(shown.name));assert.ok(!/[?�]/.test(shown.name),shown.name);}else{assert.equal(shown.nameStatus,'unresolved');assert.match(shown.name,/待核实/);}count++;}
 assert.ok(count>140000);
});
test('new country batch preserves all levels and IDs, uses exact land unions and improves actual geometry',()=>{
 const m=read('/data/precision-remaining.json');assert.equal(Object.keys(m.countries).length,35);const c=read('/data/coverage.json');
 for(const [code,a]of Object.entries(m.countries)){assert.ok(a.vertexRatio>=1.5,code);assert.equal(a.checks.landSymmetricDifferenceAreaDeg2,0);const active=aligned.countries[code];const baselineUrl=active.localUrl===a.localUrl?c.find(x=>x.code===code).localUrl:active.legacyPaintUrl;assert.ok(baselineUrl,code);const original=read(baselineUrl).features;const current=read(a.localUrl).features;assert.deepEqual(new Set(current.map(f=>f.id)),new Set(original.map(f=>f.id)),code);assert.equal(current[0].properties.adminLevel,original[0].properties.adminLevel);for(const f of current)validateVisitInput({id:'geometry-api-check',region:presentRegion(f.properties,names),status:'visited',visitedOn:'',title:'',notes:'',tripName:'',photos:[]});}
});
test('Taiwan townships show their Chinese names and counties, matched by location from Wikidata',()=>{
 const twn=read(aligned.countries.TWN.localUrl).features;assert.equal(twn.length,368);
 const shown=twn.map(f=>presentRegion(f.properties,names));
 for(const region of shown){assert.match(region.name,/^[一-鿿]+$/,region.name);assert.match(region.parentName??'',/[市縣]$/,region.name);assert.equal(region.nameStatus,'verified');}
 assert.equal(new Set(shown.map(r=>r.parentName)).size,22,'all 22 counties and cities');
 const find=name=>shown.find(r=>r.aliases.includes(name));
 assert.equal(find('Dayuan District').name,'大園區');assert.equal(find('Dayuan District').parentName,'桃園市');
 assert.ok(find('大园区'),'simplified spelling finds it too');
 // The source spells 新營 as Xiaying (下營); location decides, and the repair does not add that spelling as an alias.
 const xinying=shown.filter(r=>r.name==='新營區');assert.equal(xinying.length,1);
 const repairs=read('/data/taiwan-name-repairs.json').repairs;assert.ok(!repairs[xinying[0].id].aliases.includes('Xiaying'));assert.equal(Object.keys(repairs).length,368);
 assert.equal(shown.filter(r=>r.name==='東區').length,4,'four East Districts, told apart by county');
 assert.equal(read('/data/coverage.json').find(c=>c.code==='TWN').label,'乡镇市区');
});
test('China county areas left in English or as placeholders get Chinese names from Wikidata',()=>{
 const chn=aligned.countries.CHN,hidden=new Set(chn.suppressedIds??[]);
 const shown=read(chn.localUrl).features.filter(f=>!hidden.has(f.properties.id)).map(f=>presentRegion(f.properties,names));
 const byId=id=>shown.find(r=>r.id===id);
 // 沙湾县 became 沙湾市 in 2021: same place, current name, the 2017 English name kept for search.
 const shawan=byId('GB-62558664B21461190508374');assert.equal(shawan.name,'沙湾市');assert.equal(shawan.parentName,'塔城地区');assert.ok(shawan.aliases.includes('Shawan County'));
 assert.equal(shown.find(r=>r.aliases.includes('Usu City')).name,'乌苏市');
 // Merged after 2017: the name it had then.
 assert.equal(byId('GB-62558664B59240387459246').name,'带岭区');
 // Only two areas remain without a verifiable Chinese name.
 const left=shown.filter(r=>r.nameStatus==='unresolved'||!/[一-鿿]/.test(r.name)).map(r=>r.id).sort();
 assert.deepEqual(left,['GB-62558664B28924499867484','GB-62558664B66684701290083']);
 assert.equal(Object.keys(read('/data/china-county-name-repairs.json').repairs).length,153);
});
