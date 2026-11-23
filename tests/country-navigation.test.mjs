import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { primaryCountryBounds } from '../lib/country-navigation.ts';

const world=JSON.parse(fs.readFileSync(new URL('../public/data/world.geojson',import.meta.url),'utf8'));
for(const [code,expected] of [
  ['FRA',[-6,41,9,52]],
  ['AUS',[112,-44,155,-10]],
  ['USA',[-126,24,-66,50]],
]) {
  test(`${code} navigation frames its mainland instead of distant territories`,()=>{
    const country=world.features.find(f=>f.properties.countryCode===code);
    const bounds=primaryCountryBounds(country.geometry,country.properties.center);
    assert.ok(bounds);
    assert.ok(bounds[0]>=expected[0]&&bounds[1]>=expected[1],`${code}: ${bounds}`);
    assert.ok(bounds[2]<=expected[2]&&bounds[3]<=expected[3],`${code}: ${bounds}`);
    const [lng,lat]=country.properties.center;
    assert.ok(bounds[0]<=lng&&lng<=bounds[2]&&bounds[1]<=lat&&lat<=bounds[3]);
  });
}

test('country navigation uses the polygon containing the supplied center',()=>{
  const geometry={type:'MultiPolygon',coordinates:[
    [[[0,0],[20,0],[20,20],[0,20],[0,0]]],
    [[[30,30],[32,30],[32,32],[30,32],[30,30]]],
  ]};
  assert.deepEqual(primaryCountryBounds(geometry,[31,31]),[30,30,32,32]);
});

test('unusable or antimeridian-spanning bounds retain the center-based fallback',()=>{
  assert.equal(primaryCountryBounds({type:'Polygon',coordinates:[]},[0,0]),undefined);
  assert.equal(primaryCountryBounds({type:'Polygon',coordinates:[[
    [-179,-10],[179,-10],[179,10],[-179,10],[-179,-10],
  ]]},[178,0]),undefined);
});
