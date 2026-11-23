import { and, eq, inArray, sql } from 'drizzle-orm';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import type { ChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { photos } from '@/db/schema';
import type { Visit } from '@/lib/model';
import { assertSameOrigin, authorizePhotoReferences, MAX_JSON_BYTES, ValidationError } from '@/lib/validation';

export const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
  Vary: 'Cookie, OAI-Authenticated-User-ID',
};

export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: PRIVATE_HEADERS });
}

export async function withUser(request: Request, operation: (user: ChatGPTUser) => Promise<Response>): Promise<Response> {
  try {
    const user = await getChatGPTUser();
    if (!user) return json({ error: '请先登录后查看或保存个人足迹' }, 401);
    const actor=request.headers.get('x-atlas-actor');
    if(actor&&actor!==user.userId)return json({error:'登录账号已变化，请重新打开页面。',code:'ACCOUNT_CHANGED'},403);
    if (!['GET', 'HEAD'].includes(request.method)) assertSameOrigin(request);
    return await operation(user);
  } catch (error) {
    if (error instanceof ValidationError) return json({ error: error.message, ...(error instanceof PhotoReferenceError ? {code: error.code} : {}) }, error.status);
    // Database and storage failures must not expose queries, object keys or data.
    console.error('Private storage request failed');
    return json({ error: '服务暂时不可用，请稍后重试' }, 500);
  }
}

export async function readBody(request: Request, maximum: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = request.headers.get('content-length');
  if (declared && Number(declared) > maximum) throw new ValidationError('请求内容过大', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new ValidationError('请求内容不能为空');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new ValidationError('请求内容过大', 413);
    }
    chunks.push(value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

export async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new ValidationError('请使用 JSON 格式提交记录', 415);
  }
  const bytes = await readBody(request, MAX_JSON_BYTES);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ValidationError('JSON 格式不正确'); }
}

class PhotoReferenceError extends ValidationError {
  readonly code = 'STALE_PHOTO_REFERENCE';
}

export async function ownedPhotos(ownerId: string, requested: Visit['photos']): Promise<Visit['photos']> {
  if (!requested.length) return [];
  const rows = await getDb().select().from(photos)
    .where(and(eq(photos.ownerId, ownerId), inArray(photos.id, requested.map((photo) => photo.id))));
  try { return authorizePhotoReferences(ownerId, requested, rows); }
  catch (error) {
    if (error instanceof ValidationError) throw new PhotoReferenceError(error.message, error.status);
    throw error;
  }
}

export function photosStillOwned(ownerId: string, requested: Visit['photos']) {
  if (!requested.length) return sql`1 = 1`;
  // Re-check inside the mutation statement: a preceding metadata lookup alone
  // cannot prevent an intervening photo deletion from leaving a dangling ID.
  return sql`(SELECT COUNT(*) FROM ${photos} WHERE ${photos.ownerId} = ${ownerId}
    AND ${inArray(photos.id, requested.map(({ id }) => id))}) = ${requested.length}`;
}

export function publicVisit(record: Visit & { ownerId: string }): Visit {
  return {
    id: record.id, region: record.region, status: record.status, visitedOn: record.visitedOn,
    title: record.title, notes: record.notes, tripName: record.tripName,
    photos: record.photos.map(({ id, filename }) => ({ id, filename, url: `/api/photos/${encodeURIComponent(id)}` })),
    createdAt: record.createdAt, updatedAt: record.updatedAt,
  };
}

export type RouteContext = { params: Promise<{ id: string }> };
