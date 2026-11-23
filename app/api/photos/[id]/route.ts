import { env } from 'cloudflare:workers';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { photos, visits } from '@/db/schema';
import { validateId } from '@/lib/validation';
import { json, PRIVATE_HEADERS, withUser } from '../../_shared';
import type { RouteContext } from '../../_shared';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return withUser(request, async (user) => {
    const id = validateId((await context.params).id);
    const [photo] = await getDb().select().from(photos).where(and(eq(photos.ownerId, user.userId), eq(photos.id, id))).limit(1);
    if (!photo) return json({ error: '照片不存在' }, 404);
    if (!env.BUCKET) throw new Error('Photo storage binding is unavailable');
    const object = await env.BUCKET.get(photo.objectKey);
    if (!object) return json({ error: '照片不存在' }, 404);
    return new Response(object.body, { headers: {
      ...PRIVATE_HEADERS, 'Content-Type': photo.contentType, 'Content-Length': String(photo.size),
      'Content-Disposition': `inline; filename="photo"; filename*=UTF-8''${encodeURIComponent(photo.filename)}`,
      'Content-Security-Policy': "default-src 'none'; sandbox",
    } });
  });
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  return withUser(request, async (user) => {
    const id = validateId((await context.params).id);
    const scope = and(eq(photos.ownerId, user.userId), eq(photos.id, id));
    const db = getDb();
    const [photo] = await db.select().from(photos).where(scope).limit(1);
    if (!photo) return json({ error: '照片不存在' }, 404);
    // Check the JSON reference in the DELETE statement itself to avoid deleting
    // an image that became attached between a separate check and the delete.
    const deleted = await db.delete(photos).where(and(scope, sql`NOT EXISTS (
      SELECT 1 FROM ${visits}, json_each(${visits.photos}) AS attached
      WHERE ${visits.ownerId} = ${user.userId} AND json_extract(attached.value, '$.id') = ${id}
    )`)).returning({ id: photos.id });
    if (!deleted.length) return json({ error: '照片仍在足迹中使用，请先从记录移除' }, 409);
    if (!env.BUCKET) throw new Error('Photo storage binding is unavailable');
    await env.BUCKET.delete(photo.objectKey);
    return json({ ok: true });
  });
}
