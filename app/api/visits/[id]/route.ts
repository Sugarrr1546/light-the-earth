import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { visits } from '@/db/schema';
import { validateId, validateVisitInput, ValidationError } from '@/lib/validation';
import { json, ownedPhotos, photosStillOwned, publicVisit, readJson, withUser } from '../../_shared';
import type { RouteContext } from '../../_shared';

export const dynamic = 'force-dynamic';

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  return withUser(request, async (user) => {
    const id = validateId((await context.params).id);
    const scope = and(eq(visits.ownerId, user.userId), eq(visits.id, id));
    const [previous] = await getDb().select().from(visits).where(scope).limit(1);
    if (!previous) return json({ error: '记录不存在' }, 404);
    const input = validateVisitInput(await readJson(request), publicVisit(previous));
    if (input.id !== id) throw new ValidationError('不能修改记录标识');
    input.photos = await ownedPhotos(user.userId, input.photos);
    const [record] = await getDb().update(visits).set({ ...input, updatedAt: new Date().toISOString() })
      .where(and(scope, photosStillOwned(user.userId, input.photos))).returning();
    if (!record) {
      await ownedPhotos(user.userId, input.photos);
      return json({ error: '记录不存在' }, 404);
    }
    return json({ visit: publicVisit(record) });
  });
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  return withUser(request, async (user) => {
    const id = validateId((await context.params).id);
    const rows = await getDb().delete(visits).where(and(eq(visits.ownerId, user.userId), eq(visits.id, id))).returning({ id: visits.id });
    if (!rows.length) return json({ error: '记录不存在' }, 404);
    return json({ ok: true });
  });
}
