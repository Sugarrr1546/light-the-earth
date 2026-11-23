import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoundaryLoader, prioritizeCountries } from '../lib/boundary-loading.ts';

const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(options = {}) {
  const requests = [], mounted = [], unmounted = [], errors = [];
  const loader = createBoundaryLoader({
    capacity: 6, concurrency: 2,
    load(code, signal) { return new Promise((resolve, reject) => requests.push({ code, signal, resolve, reject })); },
    mount(code, data) { mounted.push([code, data]); },
    unmount(code) { unmounted.push(code); },
    onError(code, error) { errors.push([code, error]); },
    ...options,
  });
  return { loader, requests, mounted, unmounted, errors };
}

test('viewport country ordering is unique, center first, and limited to four', () => {
  assert.deepEqual(prioritizeCountries([
    { code: 'B', distance: 50 }, { code: 'C', distance: 2 }, { code: 'B', distance: 10 },
    { code: 'D', distance: 3 }, { code: 'E', distance: 4 }, { code: 'F', distance: 5 },
  ], 'B'), ['B', 'C', 'D', 'E']);
});

test('only two country downloads run concurrently; queued requests start as slots become free', async () => {
  const h = harness();
  h.loader.setTargets(['A', 'B', 'C', 'D']);
  assert.deepEqual(h.requests.map(r => r.code), ['A', 'B']);
  h.requests[0].resolve('a'); await flush();
  assert.deepEqual(h.requests.map(r => r.code), ['A', 'B', 'C']);
  h.requests[1].resolve('b'); await flush();
  assert.deepEqual(h.requests.map(r => r.code), ['A', 'B', 'C', 'D']);
  assert.deepEqual(h.mounted, [['A', 'a'], ['B', 'b']]);
  h.loader.dispose();
});

test('fast continent changes cancel stale work and never mount late responses', async () => {
  const h = harness();
  h.loader.setTargets(['A', 'B', 'C', 'D']);
  const pending = h.loader.request('A');
  h.loader.setTargets(['X', 'Y']);
  assert.equal(h.requests[0].signal.aborted, true);
  assert.equal(h.requests[1].signal.aborted, true);
  assert.equal(await pending, false);
  h.requests[0].resolve('stale A'); h.requests[1].resolve('stale B'); await flush();
  assert.deepEqual(h.requests.map(r => r.code), ['A', 'B', 'X', 'Y']);
  assert.deepEqual(h.mounted, []);
  h.requests[2].resolve('x'); h.requests[3].resolve('y'); await flush();
  assert.deepEqual(h.mounted, [['X', 'x'], ['Y', 'y']]);
  assert.deepEqual(h.errors, []);
  h.loader.dispose();
});

test('six resident countries use LRU eviction; a return reloads the country', async () => {
  const h = harness();
  for (const code of ['A', 'B', 'C', 'D', 'E', 'F']) {
    h.loader.setTargets([code]); h.requests.at(-1).resolve(code); await flush();
  }
  assert.deepEqual(h.unmounted, []);
  assert.equal(await h.loader.request('A'), true);
  h.loader.setTargets(['G']); h.requests.at(-1).resolve('G'); await flush();
  assert.deepEqual(h.unmounted, ['B']);
  h.loader.setTargets(['B']); h.requests.at(-1).resolve('B again'); await flush();
  assert.deepEqual(h.unmounted, ['B', 'C']);
  assert.deepEqual(h.mounted.at(-1), ['B', 'B again']);
  h.loader.dispose();
});

test('unchanged viewport neither refetches residents nor retries failed countries in a loop', async () => {
  const h = harness();
  h.loader.setTargets(['A', 'B']);
  h.requests[0].resolve('a'); h.requests[1].reject(new Error('offline')); await flush();
  for (let i = 0; i < 20; i++) h.loader.setTargets(['A', 'B']);
  assert.equal(h.requests.length, 2);
  assert.equal(h.errors.length, 1);
  const retry = h.loader.request('B');
  assert.equal(h.requests.length, 3);
  h.requests[2].resolve('b'); await flush();
  assert.equal(await retry, true);
  assert.deepEqual(h.mounted, [['A', 'a'], ['B', 'b']]);
  h.loader.dispose();
});

test('duplicate explicit requests share one download and dispose settles them safely', async () => {
  const h = harness();
  const a = h.loader.request('A'), b = h.loader.request('A');
  assert.equal(h.requests.length, 1);
  h.loader.dispose();
  assert.equal(await a, false); assert.equal(await b, false);
  h.requests[0].resolve('late'); await flush();
  assert.deepEqual(h.mounted, []);
});

test('complete country sources respect a byte-weight budget as well as the country count',async()=>{
 const h=harness({capacity:12,maxWeight:7,weight:data=>data.bytes});
 for(const code of ['A','B','C']){h.loader.setTargets([code]);h.requests.at(-1).resolve({bytes:3});await flush();}
 assert.deepEqual(h.unmounted,['A']);const n=h.requests.length;assert.equal(await h.loader.request('B'),true);assert.equal(h.requests.length,n);h.loader.dispose();
});
test('countries on screen together all show even when they exceed the byte budget',async()=>{
 const h=harness({capacity:12,maxWeight:7,weight:data=>data.bytes});
 h.loader.setTargets(['A','B']);await flush();
 for(const request of h.requests.splice(0))request.resolve({bytes:5});await flush();
 assert.deepEqual(h.mounted.map(([code])=>code).sort(),['A','B']);assert.deepEqual(h.unmounted,[]);h.loader.dispose();
});
test('releasing at the globe unmounts every resident country except current targets, then reloads on return', async () => {
  const { loader, requests, mounted, unmounted } = harness();
  loader.setTargets(['A', 'B']); await flush();
  for (const request of requests.splice(0)) request.resolve(request.code); await flush();
  loader.setTargets(['C']); await flush();
  requests.shift().resolve('C'); await flush();
  assert.deepEqual(mounted.map(([code]) => code), ['A', 'B', 'C']);
  // The globe view keeps C (say, a focused place) as its only target.
  assert.deepEqual(loader.release().sort(), ['A', 'B']);
  assert.deepEqual(unmounted.sort(), ['A', 'B']);
  assert.deepEqual(loader.release(), [], 'nothing left to release');
  loader.setTargets(['A']); await flush();
  assert.equal(requests.length, 1, 'a released country loads again on return');
  assert.equal(requests[0].code, 'A');
});
