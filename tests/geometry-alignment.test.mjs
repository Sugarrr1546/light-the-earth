import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {readPackedBoundary} from '../scripts/boundary-transport.mjs';
import {fileURLToPath} from 'node:url';
const root=new URL('../public',import.meta.url);
const read=url=>JSON.parse(readFileSync(new URL('.'+url,root+'/')));
const coverage=read('/data/coverage.json');
const manifest=read('/data/geometry-alignment.json');
test('all covered countries have versioned same-source land and local assets within the hosting limit',async()=>{
 assert.deepEqual(Object.keys(manifest.countries).sort(),coverage.map(c=>c.code).sort());
 for(const [code,c] of Object.entries(manifest.countries))for(const kind of ['local','land',...(c.fallbackUrl?['fallback']:[]),...(c.countryUrl?['country']:[])]){
  assert.ok(c[kind+'Url'].startsWith('/data/'));
  const bytes=readFileSync(new URL('.'+c[kind+'Url'],root+'/'));
  assert.equal(bytes.length,c[kind+'Bytes'],code+' '+kind);
  assert.ok(bytes.length<64*1024*1024,code+' decoded limit');
  if(c[kind+'GzipParts']){const parts=c[kind+'GzipParts'];for(const p of parts){assert.ok(p.bytes<10_000_000,code);assert.equal(readFileSync(new URL('.'+p.url,root+'/')).length,p.bytes);}const packed=await readPackedBoundary(fileURLToPath(root),{url:c[kind+'GzipUrl'],parts,bytes:c[kind+'GzipBytes']});assert.deepEqual(gunzipSync(packed),bytes,code+' multipart exactness');}
  else if(c[kind+'GzipUrl']){const packed=readFileSync(new URL('.'+c[kind+'GzipUrl'],root+'/'));assert.ok(packed.length<10_000_000,code+' hosting limit');assert.equal(packed.length,c[kind+'GzipBytes']);}else assert.ok(bytes.length<10_000_000,code+' hosting limit');
  assert.equal(createHash('sha256').update(bytes).digest('hex'),c.sha256[kind],code+' '+kind);
 }
});
test('enhanced assets retain every existing region ID and suppress only aliased duplicate displays',()=>{
 for(const code of ['CHN','JPN','USA','HKG']){
  const c=manifest.countries[code],original=coverage.find(c=>c.code===code),data=read(c.localUrl);
  assert.deepEqual(data.features.map(f=>f.id).sort(),read(original.localUrl).features.map(f=>f.id).sort(),code);
  const ids=new Set(data.features.map(f=>f.id));
  assert.equal(data.features.length,c.count);assert.equal(c.count-c.suppressedIds.length,c.renderCount);
  for(const id of c.suppressedIds){assert.ok(ids.has(id));assert.ok(c.legacyAliases[id]);}
 }
 assert.equal(manifest.countries.CHN.suppressedIds.length,read('/data/current-central-china.json').alignment.suppressedIds.length);
});
test('Hong Kong retains 18 official districts and searchable simplified Chinese aliases',()=>{
 const hk=read(manifest.countries.HKG.localUrl);
 assert.equal(hk.features.length,18);
 const wanChai=hk.features.find(f=>f.properties.originalName==='Wan Chai');
 assert.ok(wanChai.properties.aliases.includes('湾仔'));assert.ok(wanChai.properties.officialDistrictCode);
 assert.match(manifest.countries.HKG.license,/DATA.GOV.HK/);
});
test('France municipal source and legacy color mapping keep actual complete communes',()=>{
 const f=manifest.countries.FRA,primary=read(f.localUrl);assert.equal(f.renderCount,34881);assert.equal(f.count,35010);assert.equal(f.suppressedIds.length,129);
 const legacy=read('/data/precision-france-legacy.json');const shapes=read(f.legacyPaintUrl);assert.equal(shapes.features.length,320);
 assert.equal(legacy.runtime,false);assert.deepEqual(shapes.features,read('/data/global/fra-adm3.geojson').features);assert.equal(Object.keys(legacy.communeToLegacyId).length,34878);
 const oldIds=new Set(read('/data/global/fra-adm3.geojson').features.map(f=>f.id));assert.deepEqual(new Set(shapes.features.map(f=>f.id)),oldIds);
 assert.ok(primary.features.some(f=>f.properties.name==='Paris 1er Arrondissement'));
});
test('additional country upgrades retain old IDs and improve precision by at least twofold',()=>{
 const report=read('/data/precision-countries.json');assert.equal(Object.keys(report.countries).length,24);
 for(const [code,c] of Object.entries(report.countries)){
  assert.ok(c.vertexRatio>=2,code);const base=coverage.find(c=>c.code===code);const active=manifest.countries[code];const historyUrl=active.localUrl!==c.localUrl?active.legacyPaintUrl:base.localUrl;assert.ok(historyUrl,code);assert.deepEqual(new Set(read(historyUrl).features.map(f=>f.id)),new Set(read(c.localUrl).features.map(f=>f.id)),code);
  assert.equal(c.checks.landSymmetricDifferenceAreaDeg2,0,code);
 }
 assert.equal(report.countries.AUS.replaceWorldIds.length,3);assert.ok(report.countries.NOR.fallbackUrl);
});
