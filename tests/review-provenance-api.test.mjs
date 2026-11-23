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


test('duplicate visit and stale photo race have distinct machine-readable codes', async () => {
  await call(visitRoutes.POST, { method: 'POST', body: payload() });
  const duplicate = await call(visitRoutes.POST, { method: 'POST', body: payload() });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).code, 'VISIT_ALREADY_EXISTS');
  const photo = await upload();
  beforeStatement = async sql => {
    if (!/^insert into "visits"/i.test(sql)) return;
    beforeStatement = undefined;
    await call(photoRoute.DELETE, { method: 'DELETE', id: photo.id });
  };
  const stale = await call(visitRoutes.POST, { method: 'POST', body: payload({id:'visit-2',photos:[photo]}) });
  assert.equal(stale.status, 400);
  assert.equal((await stale.json()).code, 'STALE_PHOTO_REFERENCE');
  assert.equal((await (await call(visitRoutes.GET)).json()).visits.length, 1);
});
test('private photo responses explicitly reject embedding from another origin', async () => {
  const photo = await upload();
  const response = await call(photoRoute.GET, {id:photo.id});
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
});

test('import cleanup preserves an upload attached by a concurrent duplicate-ID writer', async () => {
  const JSZip = (await import('jszip')).default;
  const {importBackup} = await import('../lib/backup.ts');
  const {bindPrivateSession}=await import('../lib/private-session.ts');
  const dispose=bindPrivateSession('alice',()=>{});
  const zip = new JSZip();
  zip.file('atlas.json',JSON.stringify({version:1,visits:[payload({createdAt:'2020-01-01T00:00:00Z',updatedAt:'2020-01-01T00:00:00Z',photos:[{id:'old-photo',filename:'photo.jpg',archivePath:'photos/old-photo.jpg'}]})]}));
  zip.file('photos/old-photo.jpg',new Uint8Array([255,216,255,224,0,16,74,70,73,70,0,0]));
  const originalFetch = globalThis.fetch;
  let concurrent = false;
  globalThis.fetch = async (url,options) => {
    const headers=Object.fromEntries(new Headers(options.headers));assert.equal(headers['x-atlas-actor'],'alice');
    if(url==='/api/photos')return call(photoRoutes.POST,{method:'POST',body:options.body,headers});
    if(url==='/api/visits'){
      const body=JSON.parse(options.body);
      beforeStatement=async sql=>{
        if(!/^insert into "visits"/i.test(sql))return;
        beforeStatement=undefined;
        assert.equal((await call(visitRoutes.POST,{method:'POST',body})).status,201);
        concurrent=true;
      };
      return call(visitRoutes.POST,{method:'POST',body,headers});
    }
    return call(photoRoute.DELETE,{method:'DELETE',id:url.split('/').at(-1),headers});
  };
  try {
    assert.equal(await importBackup(await zip.generateAsync({type:'nodebuffer'}),[],()=>{}),0);
    assert.ok(concurrent);
    assert.equal(storage.size,1);
    const saved=(await (await call(visitRoutes.GET)).json()).visits;
    assert.equal(saved.length,1);
    assert.equal((await call(photoRoute.GET,{id:saved[0].photos[0].id})).status,200);
  } finally {dispose();globalThis.fetch=originalFetch;}
});
