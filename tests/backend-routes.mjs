// Real SQLite executes Drizzle's D1 SQL. Only the Cloudflare bindings and trusted
// gateway headers are substituted, so ownership predicates are exercised.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const storage = new Map();
let sqlite;
let beforeStatement;
globalThis.__backendHeaders = new Headers();
globalThis.__backendEnv = {
  DB: {
    prepare(sql) {
      let params = [];
      return {
        bind(...values) { params = values; return this; },
        async raw() { await beforeStatement?.(sql); const stmt = sqlite.prepare(sql); stmt.setReturnArrays(true); return stmt.all(...params); },
        async all() { await beforeStatement?.(sql); return { results: sqlite.prepare(sql).all(...params), success: true }; },
        async run() { await beforeStatement?.(sql); return { meta: sqlite.prepare(sql).run(...params), success: true }; },
      };
    },
  },
  BUCKET: {
    async put(key, value, options) { storage.set(key, { value: new Uint8Array(value), options }); },
    async get(key) {
      const object = storage.get(key);
      return object ? { body: object.value, size: object.value.length,
        httpMetadata: object.options?.httpMetadata, httpEtag: '"test-etag"' } : null;
    },
    async delete(key) { storage.delete(key); },
  },
};
const sources = {
  'cloudflare:workers': 'export const env = globalThis.__backendEnv;',
  'next/headers': 'export async function headers() { return globalThis.__backendHeaders; }',
  'next/navigation': 'export function redirect() { throw new Error("Unexpected redirect"); }',
};
registerHooks({ resolve(specifier, context, nextResolve) {
  if (sources[specifier]) return { url: `data:text/javascript,${encodeURIComponent(sources[specifier])}`, shortCircuit: true };
  if (specifier.startsWith('@/') || (specifier.startsWith('.') && context.parentURL?.startsWith(pathToFileURL(root).href))) {
    const raw = specifier.startsWith('@/') ? path.join(root, specifier.slice(2)) : fileURLToPath(new URL(specifier, context.parentURL));
    for (const candidate of [raw, `${raw}.ts`, path.join(raw, 'index.ts')]) {
      if (candidate.endsWith('.ts') && existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
} });

const visitRoutes = await import('../app/api/visits/route.ts');
const visitRoute = await import('../app/api/visits/[id]/route.ts');
const photoRoutes = await import('../app/api/photos/route.ts');
const photoRoute = await import('../app/api/photos/[id]/route.ts');

beforeEach(() => {
  sqlite?.close();
  sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync(path.join(root, 'drizzle')).filter((name) => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(path.join(root, 'drizzle', file), 'utf8'));
  }
  storage.clear();
  beforeStatement = undefined;
});

const payload = (patch = {}) => ({ id: 'visit-1', region: { id: 'CHN:110000', name: '北京', countryCode: 'CHN',
  countryName: '中国', level: 'local', center: [116.4, 39.9] }, status: 'visited', visitedOn: '2018年夏天',
  title: '私人记忆', notes: '仅自己可见', tripName: '', photos: [], ...patch });

async function call(handler, { owner = 'alice', method = 'GET', body, id, headers = {} } = {}) {
  globalThis.__backendHeaders = new Headers(owner ? { 'oai-authenticated-user-id': owner,
    'oai-authenticated-user-email': `${owner}@example.test` } : {});
  const request = new Request(`https://earth.test/api/${id ?? ''}`, { method,
    headers: { ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body) });
  return handler(request, { params: Promise.resolve({ id }) });
}

async function upload(owner = 'alice') {
  const form = new FormData();
  form.set('file', new File([new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 0])], '旅行.jpg', { type: 'image/jpeg' }));
  const response = await call(photoRoutes.POST, { owner, method: 'POST', body: form });
  assert.equal(response.status, 201);
  return (await response.json()).photo;
}

test('anonymous calls are rejected on every visit and photo method', async () => {
  for (const [handler, method, id] of [[visitRoutes.GET, 'GET'], [visitRoutes.POST, 'POST'],
    [visitRoute.PATCH, 'PATCH', 'visit-1'], [visitRoute.DELETE, 'DELETE', 'visit-1'],
    [photoRoutes.POST, 'POST'], [photoRoute.GET, 'GET', 'photo-1'], [photoRoute.DELETE, 'DELETE', 'photo-1']]) {
    const response = await call(handler, { owner: null, method, id });
    assert.equal(response.status, 401);
    assert.equal(typeof (await response.json()).error, 'string');
  }
});

test('new users have no seed records; private visits remain isolated across list/update/delete', async () => {
  assert.deepEqual(await (await call(visitRoutes.GET)).json(), { visits: [] });
  const created = await call(visitRoutes.POST, { method: 'POST', body: payload() });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).visit.ownerId, undefined);
  assert.deepEqual(await (await call(visitRoutes.GET, { owner: 'bob' })).json(), { visits: [] });
  for (const [handler, method] of [[visitRoute.PATCH, 'PATCH'], [visitRoute.DELETE, 'DELETE']]) {
    assert.equal((await call(handler, { owner: 'bob', method, id: 'visit-1', body: method === 'PATCH' ? { notes: 'stolen' } : undefined })).status, 404);
  }
  const own = await (await call(visitRoutes.GET)).json();
  assert.equal(own.visits[0].notes, '仅自己可见');
  assert.equal(own.visits[0].visitedOn, '2018年夏天');
  assert.equal((await call(visitRoute.PATCH, { method: 'PATCH', id: 'visit-1', body: { notes: '更新' } })).status, 200);
  assert.equal((await call(visitRoute.DELETE, { method: 'DELETE', id: 'visit-1' })).status, 200);
  assert.deepEqual(await (await call(visitRoutes.GET)).json(), { visits: [] });
});

test('the same imported ID can exist under different users without overwrite', async () => {
  assert.equal((await call(visitRoutes.POST, { method: 'POST', body: payload() })).status, 201);
  assert.equal((await call(visitRoutes.POST, { owner: 'bob', method: 'POST', body: payload({ notes: 'Bob' }) })).status, 201);
  assert.equal((await call(visitRoutes.POST, { method: 'POST', body: payload({ notes: 'replace?' }) })).status, 409);
  assert.equal((await (await call(visitRoutes.GET)).json()).visits[0].notes, '仅自己可见');
});

test('private photo download, attachment and deletion all enforce ownership', async () => {
  const photo = await upload();
  assert.match(photo.url, /^\/api\/photos\/[a-f0-9-]+$/);
  const own = await call(photoRoute.GET, { id: photo.id });
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('content-type'), 'image/jpeg');
  assert.match(own.headers.get('cache-control'), /private.*no-store/);
  assert.equal((await call(photoRoute.GET, { owner: 'bob', id: photo.id })).status, 404);
  assert.equal((await call(photoRoute.DELETE, { owner: 'bob', method: 'DELETE', id: photo.id })).status, 404);
  assert.equal((await call(visitRoutes.POST, { owner: 'bob', method: 'POST', body: payload({ photos: [photo] }) })).status, 400);
  const created = await call(visitRoutes.POST, { method: 'POST', body: payload({ photos: [{ ...photo, url: 'https://evil.test/leak', filename: 'spoof.html' }] }) });
  assert.equal(created.status, 201);
  assert.deepEqual((await created.json()).visit.photos, [photo]);
  assert.equal((await call(photoRoute.DELETE, { method: 'DELETE', id: photo.id })).status, 409);
  await call(visitRoute.DELETE, { method: 'DELETE', id: 'visit-1' });
  assert.equal((await call(photoRoute.DELETE, { method: 'DELETE', id: photo.id })).status, 200);
  assert.equal((await call(photoRoute.GET, { id: photo.id })).status, 404);
});

test('foreign-origin writes and forged image uploads are rejected before persistence', async () => {
  const cross = await call(visitRoutes.POST, { method: 'POST', body: payload(), headers: { origin: 'https://evil.test' } });
  assert.equal(cross.status, 403);
  const form = new FormData();
  form.set('file', new File(['<html><script>alert(1)</script></html>'], 'fake.jpg', { type: 'image/jpeg' }));
  assert.equal((await call(photoRoutes.POST, { method: 'POST', body: form })).status, 415);
  assert.equal(storage.size, 0);
  assert.deepEqual(await (await call(visitRoutes.GET)).json(), { visits: [] });
});

test('PATCH also rejects foreign photos and cannot change the record ID', async () => {
  const photo = await upload('bob');
  await call(visitRoutes.POST, { method: 'POST', body: payload() });
  assert.equal((await call(visitRoute.PATCH, { method: 'PATCH', id: 'visit-1', body: { photos: [photo] } })).status, 400);
  assert.equal((await call(visitRoute.PATCH, { method: 'PATCH', id: 'visit-1', body: { id: 'new-id' } })).status, 400);
  assert.deepEqual((await (await call(visitRoutes.GET)).json()).visits[0].photos, []);
});

test('request limits apply to streamed bytes even without a content-length header', async () => {
  globalThis.__backendHeaders = new Headers({ 'oai-authenticated-user-id': 'alice', 'oai-authenticated-user-email': 'a@test' });
  const response = await visitRoutes.POST(new Request('https://earth.test/api/visits', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload({ notes: 'x'.repeat(70000) })),
  }));
  assert.equal(response.status, 413);
  assert.deepEqual(await (await call(visitRoutes.GET)).json(), { visits: [] });
});

test('invalid JSON is reported as a client error without creating a record', async () => {
  globalThis.__backendHeaders = new Headers({ 'oai-authenticated-user-id': 'alice', 'oai-authenticated-user-email': 'a@test' });
  const response = await visitRoutes.POST(new Request('https://earth.test/api/visits', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{invalid',
  }));
  assert.equal(response.status, 400);
  assert.deepEqual(await (await call(visitRoutes.GET)).json(), { visits: [] });
});

test('failed database calls return a generic error without revealing database internals', async () => {
  sqlite.exec('DROP TABLE visits');
  const original = console.error;
  const logged = [];
  console.error = (...values) => logged.push(values.join(' '));
  try {
    const response = await call(visitRoutes.GET);
    assert.equal(response.status, 500);
    const result = await response.json();
    assert.equal(typeof result.error, 'string');
    assert.doesNotMatch(result.error, /SQL|select|table|visits|owner_id/);
    assert.deepEqual(logged, ['Private storage request failed']);
  } finally { console.error = original; }
});

test('POST preserves imported timestamps and therefore the original newest-first order', async () => {
  for (const [id, date] of [['newer', '2023-07-01T12:00:00.000Z'], ['older', '2018-07-01T12:00:00.000Z']]) {
    const response = await call(visitRoutes.POST, { method: 'POST', body: payload({ id, createdAt: date, updatedAt: date }) });
    assert.equal(response.status, 201);
    const { visit } = await response.json();
    assert.equal(visit.createdAt, date);
    assert.equal(visit.updatedAt, date);
  }
  const { visits } = await (await call(visitRoutes.GET)).json();
  assert.deepEqual(visits.map(({ id }) => id), ['newer', 'older']);
});

test('POST rejects invalid or reversed timestamps and defaults missing dates to server time', async () => {
  for (const timestamps of [
    { createdAt: '2018年夏天' }, { updatedAt: '2023-02-30T12:00:00Z' },
    { createdAt: '2023-07-02T12:00:00Z', updatedAt: '2023-07-01T12:00:00Z' },
  ]) {
    assert.equal((await call(visitRoutes.POST, { method: 'POST', body: payload(timestamps) })).status, 400);
  }
  const before = Date.now();
  const { visit } = await (await call(visitRoutes.POST, { method: 'POST', body: payload() })).json();
  assert.ok(Date.parse(visit.createdAt) >= before && Date.parse(visit.createdAt) <= Date.now());
  assert.equal(visit.createdAt, visit.updatedAt);
});

test('PATCH preserves createdAt and always uses server updatedAt despite supplied imported dates', async () => {
  const original = '2018-07-01T12:00:00.000Z';
  await call(visitRoutes.POST, { method: 'POST', body: payload({ createdAt: original, updatedAt: original }) });
  const before = Date.now();
  const response = await call(visitRoute.PATCH, { method: 'PATCH', id: 'visit-1', body: { notes: '新游记',
    createdAt: '2000-01-01T00:00:00.000Z', updatedAt: '2001-01-01T00:00:00.000Z' } });
  assert.equal(response.status, 200);
  const { visit } = await response.json();
  assert.equal(visit.createdAt, original);
  assert.ok(Date.parse(visit.updatedAt) >= before && Date.parse(visit.updatedAt) <= Date.now());
});

test('POST cannot attach a photo deleted after ownership lookup but before INSERT', async () => {
  const photo = await upload();
  let interleaved = false;
  beforeStatement = async (sql) => {
    if (!/^insert into "visits"/i.test(sql)) return;
    beforeStatement = undefined;
    assert.equal((await call(photoRoute.DELETE, { method: 'DELETE', id: photo.id })).status, 200);
    interleaved = true;
  };
  const response = await call(visitRoutes.POST, { method: 'POST', body: payload({ photos: [photo] }) });
  assert.ok(interleaved);
  assert.equal(response.status, 400);
  assert.deepEqual(await (await call(visitRoutes.GET)).json(), { visits: [] });
});

test('PATCH cannot attach a photo deleted after ownership lookup but before UPDATE', async () => {
  await call(visitRoutes.POST, { method: 'POST', body: payload() });
  const photo = await upload();
  let interleaved = false;
  beforeStatement = async (sql) => {
    if (!/^update "visits"/i.test(sql)) return;
    beforeStatement = undefined;
    assert.equal((await call(photoRoute.DELETE, { method: 'DELETE', id: photo.id })).status, 200);
    interleaved = true;
  };
  const response = await call(visitRoute.PATCH, { method: 'PATCH', id: 'visit-1', body: { photos: [photo], notes: 'should not save' } });
  assert.ok(interleaved);
  assert.equal(response.status, 400);
  const { visits } = await (await call(visitRoutes.GET)).json();
  assert.deepEqual(visits[0].photos, []);
  assert.equal(visits[0].notes, '仅自己可见');
});

test('photo DELETE cannot remove a photo attached after its lookup but before DELETE', async () => {
  const photo = await upload();
  let interleaved = false;
  beforeStatement = async (sql) => {
    if (!/^delete from "photos"/i.test(sql)) return;
    beforeStatement = undefined;
    assert.equal((await call(visitRoutes.POST, { method: 'POST', body: payload({ photos: [photo] }) })).status, 201);
    interleaved = true;
  };
  const response = await call(photoRoute.DELETE, { method: 'DELETE', id: photo.id });
  assert.ok(interleaved);
  assert.equal(response.status, 409);
  assert.equal((await call(photoRoute.GET, { id: photo.id })).status, 200);
  assert.equal((await (await call(visitRoutes.GET)).json()).visits[0].photos[0].id, photo.id);
});

test('an old page actor cannot read, mutate or upload under a newly signed-in account',async()=>{
 await call(visitRoutes.POST,{method:'POST',body:payload()});
 for(const [handler,method,id] of [[visitRoutes.GET,'GET'],[visitRoutes.POST,'POST'],[visitRoute.PATCH,'PATCH','visit-1'],[visitRoute.DELETE,'DELETE','visit-1'],[photoRoutes.POST,'POST'],[photoRoute.GET,'GET','photo-1'],[photoRoute.DELETE,'DELETE','photo-1']]){
  const r=await call(handler,{owner:'bob',method,id,headers:{'x-atlas-actor':'alice'},...(method==='POST'||method==='PATCH'?{body:payload()}: {})});
  assert.equal(r.status,403);assert.equal((await r.json()).code,'ACCOUNT_CHANGED');
 }
 assert.equal((await(await call(visitRoutes.GET)).json()).visits[0].notes,'仅自己可见');
});
test('actor header never overrides the validated identity or owner supplied in JSON',async()=>{
 const r=await call(visitRoutes.POST,{owner:'bob',method:'POST',headers:{'x-atlas-actor':'bob'},body:payload({ownerId:'alice',owner_id:'alice'})});assert.equal(r.status,201);
 assert.deepEqual((await(await call(visitRoutes.GET,{owner:'alice'})).json()).visits,[]);
 assert.equal((await(await call(visitRoutes.GET,{owner:'bob'})).json()).visits.length,1);
});

test('identity probe exposes only the current opaque user ID with private cache policy',async()=>{
 const session=await import('../app/api/session/route.ts');
 const signed=await call(session.GET,{owner:'bob'});assert.deepEqual(await signed.json(),{userId:'bob'});assert.match(signed.headers.get('cache-control'),/private.*no-store/);
 assert.deepEqual(await(await call(session.GET,{owner:null})).json(),{userId:null});
});
