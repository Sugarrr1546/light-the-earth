import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalApi, LOCAL_USER_ID } from '../lib/local-api.ts';
import { openFileStore } from '../desktop/file-store.ts';

const ORIGIN = 'atlas://app';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1]);
const region = { id: 'CHN-330106', name: '西湖区', countryCode: 'CHN', countryName: '中国', level: 'local', center: [120.13, 30.26] };
const visitBody = (id, extra = {}) => ({ id, region, status: 'visited', visitedOn: '2024', title: '', notes: '', tripName: '', photos: [], ...extra });

async function open() {
  const directory = await mkdtemp(path.join(tmpdir(), 'atlas-store-'));
  let tick = 0;
  const start = async () => {
    const store = await openFileStore(directory);
    const api = createLocalApi(store, { now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString() });
    const call = async (method, url, body, headers = {}) => {
      const init = { method, headers: { origin: ORIGIN, ...headers } };
      if (body instanceof FormData) init.body = body;
      else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
      const response = await api.handle(new Request(ORIGIN + url, init));
      return { status: response.status, response, data: response.headers.get('content-type')?.includes('json') ? await response.clone().json() : null };
    };
    return { store, api, call };
  };
  return { directory, start, close: () => rm(directory, { recursive: true, force: true }) };
}
async function upload(call, name = 'trip.jpg') {
  const form = new FormData();
  form.set('file', new File([JPEG], name, { type: 'image/jpeg' }));
  const result = await call('POST', '/api/photos', form);
  assert.equal(result.status, 201);
  return result.data.photo;
}

test('an on-device atlas starts empty, needs no sign-in, and keeps records across restarts', async () => {
  const atlas = await open();
  try {
    let { call } = await atlas.start();
    assert.deepEqual((await call('GET', '/api/session')).data, { userId: LOCAL_USER_ID });
    assert.deepEqual((await call('GET', '/api/visits')).data, { visits: [] });

    const created = await call('POST', '/api/visits', visitBody('v1', { title: '初到杭州' }));
    assert.equal(created.status, 201);
    assert.equal(created.data.visit.createdAt, created.data.visit.updatedAt);
    const duplicate = await call('POST', '/api/visits', visitBody('v1'));
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.data.code, 'VISIT_ALREADY_EXISTS');
    await call('POST', '/api/visits', visitBody('v2', { status: 'wishlist' }));

    const patched = await call('PATCH', '/api/visits/v1', { status: 'lived' });
    assert.equal(patched.data.visit.status, 'lived');
    assert.equal(patched.data.visit.title, '初到杭州');
    assert.equal(patched.data.visit.createdAt, created.data.visit.createdAt);
    assert.ok(patched.data.visit.updatedAt > created.data.visit.updatedAt);
    assert.equal((await call('PATCH', '/api/visits/v1', { id: 'other' })).status, 400);
    assert.equal((await call('PATCH', '/api/visits/missing', { status: 'lived' })).status, 404);

    // A new process reads the same folder; the most recently changed record comes first.
    ({ call } = await atlas.start());
    assert.deepEqual((await call('GET', '/api/visits')).data.visits.map((visit) => [visit.id, visit.status]), [['v1', 'lived'], ['v2', 'wishlist']]);
    assert.equal((await call('DELETE', '/api/visits/v2')).status, 200);
    assert.equal((await call('DELETE', '/api/visits/v2')).status, 404);
    assert.equal(JSON.parse(await readFile(path.join(atlas.directory, 'atlas.json'), 'utf8')).visits.length, 1);
  } finally { await atlas.close(); }
});

test('photos are plain files that a record must reference before they can be relied on', async () => {
  const atlas = await open();
  try {
    let { call, api } = await atlas.start();
    const photo = await upload(call, '../../西湖.jpg');
    assert.equal(photo.filename, '西湖.jpg');
    assert.deepEqual(await readdir(path.join(atlas.directory, 'photos')), [`${photo.id}.jpg`]);

    const stale = await call('POST', '/api/visits', visitBody('v1', { photos: [{ id: 'gone' }] }));
    assert.equal(stale.status, 400);
    assert.equal(stale.data.code, 'STALE_PHOTO_REFERENCE');
    const saved = await call('POST', '/api/visits', visitBody('v1', { photos: [{ id: photo.id }] }));
    assert.deepEqual(saved.data.visit.photos, [{ id: photo.id, filename: '西湖.jpg', url: `/api/photos/${photo.id}` }]);

    const served = await call('GET', `/api/photos/${photo.id}`);
    assert.equal(served.response.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(new Uint8Array(await served.response.arrayBuffer()), JPEG);
    assert.equal((await call('DELETE', `/api/photos/${photo.id}`)).status, 409);

    // An upload from an abandoned draft is cleared once it is old; attached photos never are.
    const abandoned = await upload(call);
    assert.equal(await api.pruneUnusedPhotos(60 * 60 * 1000), 0);
    assert.equal(await api.pruneUnusedPhotos(0), 1);
    assert.equal((await call('GET', `/api/photos/${abandoned.id}`)).status, 404);
    assert.equal((await call('GET', `/api/photos/${photo.id}`)).status, 200);

    ({ call } = await atlas.start());
    assert.equal((await call('GET', `/api/photos/${photo.id}`)).status, 200);
    await call('DELETE', '/api/visits/v1');
    assert.equal((await call('DELETE', `/api/photos/${photo.id}`)).status, 200);
    assert.deepEqual(await readdir(path.join(atlas.directory, 'photos')), []);
  } finally { await atlas.close(); }
});

test('uploads and records are validated exactly as on the hosted site', async () => {
  const atlas = await open();
  try {
    const { call } = await atlas.start();
    const form = new FormData();
    form.set('file', new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])], 'note.jpg', { type: 'image/jpeg' }));
    assert.equal((await call('POST', '/api/photos', form)).status, 415);
    assert.equal((await call('POST', '/api/visits', visitBody('v1', { status: 'unknown' }))).status, 400);
    assert.equal((await call('POST', '/api/visits', visitBody('bad id'))).status, 400);
    assert.equal((await call('POST', '/api/visits', visitBody('v1'), { origin: 'https://elsewhere.example' })).status, 403);
    assert.equal((await call('GET', '/api/unknown')).status, 404);
    assert.deepEqual((await call('GET', '/api/visits')).data, { visits: [] });
  } finally { await atlas.close(); }
});

test('paths outside the private API are left to the static file handler', async () => {
  const atlas = await open();
  try {
    const { api } = await atlas.start();
    assert.equal(await api.handle(new Request(ORIGIN + '/data/coverage.json')), undefined);
  } finally { await atlas.close(); }
});

test('a damaged atlas file falls back to the last good copy without touching photos', async () => {
  const atlas = await open();
  try {
    let { call } = await atlas.start();
    const photo = await upload(call);
    await call('POST', '/api/visits', visitBody('v1', { photos: [{ id: photo.id }] }));
    await call('POST', '/api/visits', visitBody('v2'));
    await writeFile(path.join(atlas.directory, 'atlas.json'), '{"version":1,"visits":[', 'utf8');

    let store;
    ({ call, store } = await atlas.start());
    assert.equal(store.recovered, 'backup');
    // The backup predates the last write, so the newest record is the only loss.
    assert.deepEqual((await call('GET', '/api/visits')).data.visits.map((visit) => visit.id), ['v1']);
    assert.equal((await call('GET', `/api/photos/${photo.id}`)).status, 200);
    assert.ok((await readdir(atlas.directory)).some((name) => name.startsWith('atlas.unreadable-')));
  } finally { await atlas.close(); }
});
