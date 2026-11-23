import { env } from 'cloudflare:workers';
import { getDb } from '@/db';
import { photos } from '@/db/schema';
import { MAX_IMAGE_BYTES, validateImage, ValidationError } from '@/lib/validation';
import { json, readBody, withUser } from '../_shared';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return withUser(request, async (user) => {
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
    if (!env.BUCKET) throw new Error('Photo storage binding is unavailable');
    const id = crypto.randomUUID();
    const objectKey = `photos/${encodeURIComponent(user.userId)}/${id}.${image.extension}`;
    const filename = file.name.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180) || `photo.${image.extension}`;
    await env.BUCKET.put(objectKey, bytes, { httpMetadata: { contentType: image.contentType } });
    try {
      await getDb().insert(photos).values({ id, ownerId: user.userId, objectKey, filename,
        contentType: image.contentType, size: bytes.length, createdAt: new Date().toISOString() });
    } catch (error) {
      await env.BUCKET.delete(objectKey);
      throw error;
    }
    return json({ photo: { id, url: `/api/photos/${id}`, filename } }, 201);
  });
}
