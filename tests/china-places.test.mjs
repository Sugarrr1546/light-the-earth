import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {presentRegion} from '../lib/region-presentation.ts';

const read = url => JSON.parse(readFileSync(new URL('../public' + url, import.meta.url)));
const names = read('/data/name-quality.json');
const patch = read('/data/hangzhou-boundary-patch.json');
const aligned = read('/data/geometry-alignment.json').countries.CHN;
const features = read(aligned.localUrl).features;
const byId = new Map(features.map(feature => [feature.id, feature]));
const show = id => presentRegion(byId.get(id).properties, names);

test('saved Chinese places keep their IDs and gain a parent city', () => {
  assert.match(show('GB-62558664B82614955491445').name, /^西湖区/);
  assert.equal(show('GB-62558664B82614955491445').boundaryStatus,'historical');
  assert.equal(show('GB-62558664B82614955491445').parentName, '杭州市');
  assert.equal(show('GB-62558664B82614955491445').year, '2017');
  assert.equal(show('GB-62558664B9496053300630').name, '海淀区');
  assert.equal(show('GB-62558664B9496053300630').parentName, '北京市');
  const tianhe = features.find(feature => feature.properties.originalName === 'Tianhe District');
  assert.equal(show(tianhe.id).name, '天河区');
  assert.equal(show(tianhe.id).parentName, '广州市');
  assert.ok(show(tianhe.id).aliases.includes('天河'));
});

test('Hangzhou uses the 2021 districts and keeps abolished ones out of the map', () => {
  for (const item of patch.added) {
    assert.equal(show(item.id).name, item.name);
    assert.equal(byId.get(item.id).properties.parentName, '杭州市');
    assert.match(byId.get(item.id).properties.year,/2026/);
    assert.equal(aligned.suppressedIds.includes(item.id), false);
  }
  for (const item of patch.replaced) {
    assert.equal(show(item.id).name, item.name);
    assert.match(byId.get(item.id).properties.year,/2026/);
  }
  for (const item of patch.abolished) {
    assert.equal(aligned.suppressedIds.includes(item.id), true);
    assert.match(show(item.id).name, /已撤销/);
    assert.match(show(item.id).nameNote, /撤销/);
    assert.equal(show(item.id).year, '2017');
  }
  const xihu = byId.get(patch.unchangedHangzhouXihuId);
  assert.equal(xihu.properties.year, '2017');
  assert.match(show(xihu.id).name, /^西湖区/);
  assert.equal(aligned.renderCount, aligned.count - aligned.suppressedIds.length);
});
