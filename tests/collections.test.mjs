import test from 'node:test';
import assert from 'node:assert/strict';
import { getStats, getYears, filterVisits, getBadges, parseBackup } from '../lib/collections.ts';

const region = {id:'CHN:1',name:'西湖区',countryCode:'CHN',countryName:'中国',level:'local',center:[120,30]};
const visit = (id, overrides={}) => ({id,region,status:'visited',visitedOn:'2024-05-01',title:'旅行',notes:'',tripName:'',photos:[],createdAt:'2024-05-01T00:00:00Z',updatedAt:'2024-05-01T00:00:00Z',...overrides});

test('repeat visits count as memories but not duplicate places; wishes and passing excluded', () => {
  assert.deepEqual(getStats([visit('1'),visit('2'),visit('3',{status:'wishlist',region:{...region,id:'JPN:2',countryCode:'JPN'}}),visit('4',{status:'passed'})]),{countries:1,places:1,memories:2,wishes:1});
});
test('approximate dates can be filtered by their recorded year and unknown dates remain available', () => {
  const values=[visit('1',{visitedOn:'2018年夏天'}),visit('2',{visitedOn:''}),visit('3')];
  assert.deepEqual(getYears(values),['2024','2018']);
  assert.equal(filterVisits(values,'2018','all').length,1);
  assert.equal(filterVisits(values,'unknown','all').length,1);
  assert.equal(filterVisits(values,'all','all').length,3);
});
test('a wishlist alone cannot unlock first journey', () => {
  assert.equal(getBadges([visit('1',{status:'wishlist'})])[0].unlocked,false);
  assert.equal(getBadges([visit('1')])[0].unlocked,true);
});
test('backup validation rejects unsupported formats and unsafe photo paths before any mutation', () => {
  assert.throws(()=>parseBackup({version:99,visits:[]}));
  assert.throws(()=>parseBackup({version:1,visits:[visit('1',{photos:[{id:'x',filename:'../secret',archivePath:'../secret'}]})]}));
  assert.equal(parseBackup({version:1,visits:[visit('1')]}).visits.length,1);
});

test('every backup record is checked with the same coordinate and text bounds as the server', () => {
  assert.throws(()=>parseBackup({version:1,visits:[visit('1'),visit('2',{region:{...region,center:[190,30]}})]}));
  assert.throws(()=>parseBackup({version:1,visits:[visit('1',{notes:'x'.repeat(10001)})]}));
});
test('backup preserves valid timestamps but rejects impossible or reversed times', () => {
  assert.equal(parseBackup({version:1,visits:[visit('1')]}).visits[0].createdAt,'2024-05-01T00:00:00Z');
  assert.throws(()=>parseBackup({version:1,visits:[visit('1',{createdAt:'tomorrow'})]}));
  assert.throws(()=>parseBackup({version:1,visits:[visit('1',{createdAt:'2025-05-01T00:00:00Z'})]}));
});

test('export rejects otherwise valid Chinese memories that exceed the import JSON byte limit', async () => {
  const { stringifyBackup } = await import('../lib/collections.ts');
  const data={version:1,exportedAt:'2026-10-24T00:00:00Z',visits:Array.from({length:350},(_,i)=>visit(String(i),{notes:'旅'.repeat(10000)}))};
  assert.throws(()=>stringifyBackup(data),/按年份/);
  const text=stringifyBackup({...data,visits:data.visits.slice(0,2)});
  assert.equal(parseBackup(JSON.parse(text)).visits.length,2);
});
test('export rejects a record count that import cannot restore', async () => {
  const { stringifyBackup } = await import('../lib/collections.ts');
  assert.throws(()=>stringifyBackup({version:1,exportedAt:'2026-10-24T00:00:00Z',visits:Array.from({length:5001},(_,i)=>visit(String(i)))}),/按年份/);
});
