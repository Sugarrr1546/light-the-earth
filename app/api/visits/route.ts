import { desc, eq, getTableColumns, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { visits } from '@/db/schema';
import { validateVisitInput, validateVisitTimestamps } from '@/lib/validation';
import { json, ownedPhotos, photosStillOwned, publicVisit, readJson, withUser } from '../_shared';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return withUser(request, async (user) => {
    const rows = await getDb().select().from(visits).where(eq(visits.ownerId, user.userId)).orderBy(desc(visits.updatedAt));
    return json({ visits: rows.map(publicVisit) });
  });
}

export async function POST(request: Request): Promise<Response> {
  return withUser(request, async (user) => {
    const payload = await readJson(request);
    const input = validateVisitInput(payload);
    const timestamps = validateVisitTimestamps(payload);
    input.photos = await ownedPhotos(user.userId, input.photos);
    const values = { ...input, ownerId: user.userId, ...timestamps };
    const columns = getTableColumns(visits);
    const orderedValues = (Object.keys(columns) as (keyof typeof columns)[]).map((key) => sql.param(values[key], columns[key]));
    const [record] = await getDb().insert(visits)
      .select(sql`SELECT ${sql.join(orderedValues, sql`, `)} WHERE ${photosStillOwned(user.userId, input.photos)}`)
      .onConflictDoNothing({ target: [visits.ownerId, visits.id] }).returning();
    if (!record) {
      // An empty result can mean either a duplicate ID or a photo removed after
      // metadata lookup. Recheck photos so importers can distinguish the causes.
      await ownedPhotos(user.userId, input.photos);
      return json({ error: '此记录已存在，请刷新后修改', code: 'VISIT_ALREADY_EXISTS' }, 409);
    }
    return json({ visit: publicVisit(record) }, 201);
  });
}
