import type { Photo, Visit } from './model';
import {
  MAX_IMAGE_BYTES, MAX_JSON_BYTES, ValidationError, authorizePhotoReferences,
  validateId, validateImage, validateVisitInput, validateVisitTimestamps,
} from './validation.ts';

/** The single owner of an on-device atlas. There is no account to sign in to. */
export const LOCAL_USER_ID = 'local';

export interface StoredPhoto {
  id: string;
  filename: string;
  contentType: string;
  extension: string;
  size: number;
  createdAt: string;
}

/** Visits are stored without photo URLs; the API adds them on the way out. */
export type StoredVisit = Omit<Visit, 'photos'> & { photos: Pick<Photo, 'id' | 'filename'>[] };

export interface AtlasStore {
  listVisits(): Promise<StoredVisit[]>;
  /** Replaces the whole collection in one durable write. */
  saveVisits(visits: StoredVisit[]): Promise<void>;
  listPhotos(): Promise<StoredPhoto[]>;
  putPhoto(photo: StoredPhoto, bytes: Uint8Array): Promise<void>;
  readPhoto(id: string): Promise<{ photo: StoredPhoto; bytes: Uint8Array } | undefined>;
  deletePhoto(id: string): Promise<void>;
}

const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: HEADERS });

class PhotoReferenceError extends ValidationError {
  readonly code = 'STALE_PHOTO_REFERENCE';
}

function publicVisit(record: StoredVisit): Visit {
  return {
    id: record.id, region: record.region, status: record.status, visitedOn: record.visitedOn,
    title: record.title, notes: record.notes, tripName: record.tripName,
    photos: record.photos.map(({ id, filename }) => ({ id, filename, url: `/api/photos/${encodeURIComponent(id)}` })),
    createdAt: record.createdAt, updatedAt: record.updatedAt,
  };
}

async function readBody(request: Request, maximum: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = request.headers.get('content-length');
  if (declared && Number(declared) > maximum) throw new ValidationError('请求内容过大', 413);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) throw new ValidationError('请求内容不能为空');
  if (bytes.length > maximum) throw new ValidationError('请求内容过大', 413);
  return bytes;
}

async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new ValidationError('请使用 JSON 格式提交记录', 415);
  }
  const bytes = await readBody(request, MAX_JSON_BYTES);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ValidationError('JSON 格式不正确'); }
}

/** App pages are the only expected caller; anything naming another origin is refused. */
function assertOwnOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  const url = new URL(request.url);
  if (origin !== null && origin !== `${url.protocol}//${url.host}`) throw new ValidationError('此请求来源不被允许', 403);
}

/**
 * The private API of the hosted site, served from one device's own store.
 * Paths, payloads and error codes match `app/api`, so the interface code is shared unchanged.
 * Returns undefined for paths outside `/api/`.
 */
export function createLocalApi(store: AtlasStore, options: { now?: () => string; uuid?: () => string } = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  // One writer at a time: every check-then-write below is atomic within this process.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  async function attach(requested: Pick<Photo, 'id'>[]): Promise<StoredVisit['photos']> {
    if (!requested.length) return [];
    const metadata = (await store.listPhotos()).map((photo) => ({ ...photo, ownerId: LOCAL_USER_ID }));
    try { return authorizePhotoReferences(LOCAL_USER_ID, requested, metadata).map(({ id, filename }) => ({ id, filename })); }
    catch (error) {
      if (error instanceof ValidationError) throw new PhotoReferenceError('照片不存在，请重新添加', error.status);
      throw error;
    }
  }

  async function route(request: Request, path: string): Promise<Response> {
    const method = request.method.toUpperCase();
    if (!['GET', 'HEAD'].includes(method)) assertOwnOrigin(request);
    if (path === '/api/session' && method === 'GET') return json({ userId: LOCAL_USER_ID });

    if (path === '/api/visits') {
      if (method === 'GET') {
        const visits = await store.listVisits();
        return json({ visits: [...visits].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(publicVisit) });
      }
      if (method === 'POST') {
        const payload = await readJson(request);
        const input = validateVisitInput(payload);
        const timestamps = validateVisitTimestamps(payload, now());
        return exclusive(async () => {
          const visits = await store.listVisits();
          const photos = await attach(input.photos);
          if (visits.some((visit) => visit.id === input.id)) return json({ error: '此记录已存在，请刷新后修改', code: 'VISIT_ALREADY_EXISTS' }, 409);
          const record: StoredVisit = { ...input, photos, ...timestamps };
          await store.saveVisits([...visits, record]);
          return json({ visit: publicVisit(record) }, 201);
        });
      }
    }

    const visit = /^\/api\/visits\/([^/]+)$/.exec(path);
    if (visit) {
      const id = validateId(decodeURIComponent(visit[1]));
      if (method === 'PATCH') {
        const payload = await readJson(request);
        return exclusive(async () => {
          const visits = await store.listVisits();
          const previous = visits.find((item) => item.id === id);
          if (!previous) return json({ error: '记录不存在' }, 404);
          const input = validateVisitInput(payload, publicVisit(previous));
          if (input.id !== id) throw new ValidationError('不能修改记录标识');
          const record: StoredVisit = { ...input, photos: await attach(input.photos), createdAt: previous.createdAt, updatedAt: now() };
          await store.saveVisits(visits.map((item) => item.id === id ? record : item));
          return json({ visit: publicVisit(record) });
        });
      }
      if (method === 'DELETE') {
        return exclusive(async () => {
          const visits = await store.listVisits();
          if (!visits.some((item) => item.id === id)) return json({ error: '记录不存在' }, 404);
          await store.saveVisits(visits.filter((item) => item.id !== id));
          return json({ ok: true });
        });
      }
    }

    if (path === '/api/photos' && method === 'POST') {
      const contentType = request.headers.get('content-type') ?? '';
      if (!contentType.toLowerCase().startsWith('multipart/form-data;')) throw new ValidationError('请使用文件上传格式', 415);
      const body = await readBody(request, MAX_IMAGE_BYTES + 64 * 1024);
      let form: FormData;
      try { form = await new Response(body, { headers: { 'content-type': contentType } }).formData(); }
      catch { throw new ValidationError('文件上传格式不正确'); }
      const file = form.get('file');
      if (!(file instanceof File) || form.getAll('file').length !== 1) throw new ValidationError('请上传一张照片');
      if (file.size > MAX_IMAGE_BYTES) throw new ValidationError('每张照片不能超过 4 MB', 413);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const image = validateImage(bytes, file.type);
      const id = uuid();
      const filename = file.name.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180) || `photo.${image.extension}`;
      await exclusive(() => store.putPhoto({ id, filename, contentType: image.contentType, extension: image.extension, size: bytes.length, createdAt: now() }, bytes));
      return json({ photo: { id, url: `/api/photos/${id}`, filename } }, 201);
    }

    const photo = /^\/api\/photos\/([^/]+)$/.exec(path);
    if (photo) {
      const id = validateId(decodeURIComponent(photo[1]));
      if (method === 'GET') {
        const stored = await store.readPhoto(id);
        if (!stored) return json({ error: '照片不存在' }, 404);
        return new Response(stored.bytes as Uint8Array<ArrayBuffer>, { headers: {
          ...HEADERS, 'Content-Type': stored.photo.contentType, 'Content-Length': String(stored.bytes.length),
          'Content-Disposition': `inline; filename="photo"; filename*=UTF-8''${encodeURIComponent(stored.photo.filename)}`,
          'Content-Security-Policy': "default-src 'none'; sandbox",
        } });
      }
      if (method === 'DELETE') {
        return exclusive(async () => {
          if (!(await store.listPhotos()).some((item) => item.id === id)) return json({ error: '照片不存在' }, 404);
          const used = (await store.listVisits()).some((item) => item.photos.some((attached) => attached.id === id));
          if (used) return json({ error: '照片仍在足迹中使用，请先从记录移除' }, 409);
          await store.deletePhoto(id);
          return json({ ok: true });
        });
      }
    }
    return json({ error: '接口不存在' }, 404);
  }

  const handle = async (request: Request): Promise<Response | undefined> => {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/api/')) return undefined;
    try { return await route(request, path); }
    catch (error) {
      if (error instanceof ValidationError) return json({ error: error.message, ...(error instanceof PhotoReferenceError ? { code: error.code } : {}) }, error.status);
      console.error('Local atlas request failed', error);
      return json({ error: '本机数据暂时无法读写，请稍后重试' }, 500);
    }
  };

  /** Removes photos no record uses once they are older than `olderThanMs`, such as uploads from an abandoned draft. */
  const pruneUnusedPhotos = (olderThanMs: number): Promise<number> => exclusive(async () => {
    const used = new Set((await store.listVisits()).flatMap((visit) => visit.photos.map((photo) => photo.id)));
    const limit = Date.parse(now()) - olderThanMs;
    let removed = 0;
    for (const photo of await store.listPhotos()) {
      if (used.has(photo.id) || !(Date.parse(photo.createdAt) < limit)) continue;
      await store.deletePhoto(photo.id);
      removed++;
    }
    return removed;
  });

  return { handle, pruneUnusedPhotos };
}
