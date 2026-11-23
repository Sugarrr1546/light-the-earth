import type { Photo, Region, Visit, VisitStatus } from './model';

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_JSON_BYTES = 64 * 1024;
export const MAX_PHOTOS = 6;

export class ValidationError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ValidationError';
    this.status = status;
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${label}格式不正确`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, max: number, required = false): string {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new ValidationError(`${label}${required ? '不能为空，且' : ''}最多 ${max} 个字符`);
  }
  return value.trim();
}

export function validateId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value)) {
    throw new ValidationError('记录标识格式不正确');
  }
  return value;
}

function coordinate(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ValidationError('地理坐标超出有效范围');
  }
  return value;
}

function validateRegion(input: unknown): Region {
  const value = object(input, '地区');
  const code = string(value.countryCode, '国家代码', 3, true).toUpperCase();
  if (!/^[A-Z]{2,3}$/.test(code)) throw new ValidationError('国家代码格式不正确');
  if (value.level !== 'country' && value.level !== 'local') throw new ValidationError('地区层级不正确');
  if (!Array.isArray(value.center) || value.center.length !== 2) throw new ValidationError('地区中心坐标不正确');
  const region: Region = {
    id: validateId(value.id), name: string(value.name, '地区名称', 200, true),
    countryCode: code, countryName: string(value.countryName, '国家名称', 200, true),
    level: value.level,
    center: [coordinate(value.center[0], -180, 180), coordinate(value.center[1], -90, 90)],
  };
  if (value.bbox !== undefined) {
    if (!Array.isArray(value.bbox) || value.bbox.length !== 4) throw new ValidationError('地区边界格式不正确');
    region.bbox = [coordinate(value.bbox[0], -180, 180), coordinate(value.bbox[1], -90, 90),
      coordinate(value.bbox[2], -180, 180), coordinate(value.bbox[3], -90, 90)];
    if (region.bbox[1] > region.bbox[3]) throw new ValidationError('地区纬度边界顺序不正确');
  }
  for (const key of ['adminLevel', 'parentName', 'source', 'year'] as const) {
    if (value[key] !== undefined) region[key] = string(value[key], '地区附加信息', key === 'source' ? 1000 : 200);
  }
  return region;
}

export type VisitInput = Omit<Visit, 'createdAt' | 'updatedAt'>;

function isoTimestamp(value: unknown): string {
  if (typeof value !== 'string') throw new ValidationError('记录时间必须为有效的 ISO 日期时间');
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) throw new ValidationError('记录时间必须为含时区的 ISO 日期时间');
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = parts;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const daysInMonth = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const timestamp = Date.parse(value);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]
    || hour > 23 || minute > 59 || second > 59 || !Number.isFinite(timestamp)) {
    throw new ValidationError('记录时间必须为有效的 ISO 日期时间');
  }
  return new Date(timestamp).toISOString();
}

export function validateVisitTimestamps(input: unknown, now = new Date().toISOString()): Pick<Visit, 'createdAt' | 'updatedAt'> {
  const value = object(input, '记录');
  const createdAt = isoTimestamp(value.createdAt === undefined ? now : value.createdAt);
  const updatedAt = isoTimestamp(value.updatedAt === undefined ? now : value.updatedAt);
  if (Date.parse(createdAt) > Date.parse(updatedAt)) throw new ValidationError('创建时间不能晚于更新时间');
  return { createdAt, updatedAt };
}

export function validateVisitInput(input: unknown, previous?: Visit): VisitInput {
  const payload = object(input, '记录');
  const value = previous ? { ...previous, ...payload } : payload;
  const statuses: VisitStatus[] = ['visited', 'lived', 'passed', 'wishlist'];
  if (!statuses.includes(value.status as VisitStatus)) throw new ValidationError('请选择有效的足迹状态');
  const photoInput = value.photos ?? [];
  if (!Array.isArray(photoInput) || photoInput.length > MAX_PHOTOS) throw new ValidationError(`每条记录最多 ${MAX_PHOTOS} 张照片`);
  const photos = photoInput.map((item) => {
    const id = validateId(object(item, '照片').id);
    return { id, url: `/api/photos/${encodeURIComponent(id)}`, filename: '' };
  });
  if (new Set(photos.map((photo) => photo.id)).size !== photos.length) throw new ValidationError('请勿重复添加同一张照片');
  return {
    id: validateId(value.id), region: validateRegion(value.region), status: value.status as VisitStatus,
    visitedOn: string(value.visitedOn, '到访时间', 80), title: string(value.title, '标题', 160),
    notes: string(value.notes, '游记', 10000), tripName: string(value.tripName, '旅行名称', 120), photos,
  };
}

export function authorizePhotoReferences(
  ownerId: string,
  requested: Pick<Photo, 'id'>[],
  metadata: { id: string; ownerId: string; filename: string }[],
): Photo[] {
  const owned = new Map(metadata.filter((photo) => photo.ownerId === ownerId).map((photo) => [photo.id, photo]));
  return requested.map(({ id }) => {
    const photo = owned.get(id);
    if (!photo) throw new ValidationError('照片不存在或无权使用，请重新上传');
    return { id: photo.id, url: `/api/photos/${encodeURIComponent(photo.id)}`, filename: photo.filename };
  });
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== new URL(request.url).origin) {
    throw new ValidationError('此请求来源不被允许', 403);
  }
  if (request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new ValidationError('此请求来源不被允许', 403);
  }
}

export function validateImage(bytes: Uint8Array, declaredType: string): { contentType: string; extension: string } {
  if (!bytes.length) throw new ValidationError('照片不能为空');
  if (bytes.length > MAX_IMAGE_BYTES) throw new ValidationError('每张照片不能超过 4 MB', 413);
  let result: { contentType: string; extension: string } | undefined;
  if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    result = { contentType: 'image/jpeg', extension: 'jpg' };
  } else if (bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)
    && String.fromCharCode(...bytes.slice(12, 16)) === 'IHDR') {
    result = { contentType: 'image/png', extension: 'png' };
  } else if (bytes.length >= 16 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
    && ['VP8 ', 'VP8L', 'VP8X'].includes(String.fromCharCode(...bytes.slice(12, 16)))) {
    result = { contentType: 'image/webp', extension: 'webp' };
  }
  if (!result || (declaredType && declaredType !== result.contentType)) {
    throw new ValidationError('仅支持有效的 JPEG、PNG 或 WebP 图片', 415);
  }
  return result;
}
