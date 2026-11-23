import type { Visit } from './model';
import { validateVisitInput, validateVisitTimestamps } from './validation.ts';

export function getStats(visits: Visit[]) {
  const visited = visits.filter(v => v.status === 'visited' || v.status === 'lived');
  return {
    countries: new Set(visited.map(v => v.region.countryCode)).size,
    places: new Set(visited.filter(v => v.region.level === 'local').map(v => v.region.id)).size,
    memories: visited.length,
    wishes: new Set(visits.filter(v => v.status === 'wishlist').map(v => v.region.id)).size,
  };
}

export function visitYear(visit: Visit): string {
  return visit.visitedOn.match(/(?:^|\D)((?:19|20)\d{2})(?:\D|$)/)?.[1] ?? 'unknown';
}

export function getYears(visits: Visit[]): string[] {
  return [...new Set(visits.map(visitYear).filter(y => y !== 'unknown'))].sort().reverse();
}

export function filterVisits(visits: Visit[], year: string, status: string): Visit[] {
  return visits.filter(v => (year === 'all' || visitYear(v) === year) && (status === 'all' || v.status === status));
}

export function getBadges(visits: Visit[]) {
  const real = visits.filter(v => v.status === 'visited' || v.status === 'lived');
  const stats = getStats(visits);
  return [
    { id: 'first', title: '第一束光', subtitle: '点亮第一个到访的地方', icon: 'spark', unlocked: real.length > 0, progress: Math.min(real.length,1), total: 1 },
    { id: 'ten', title: '渐行渐远', subtitle: '收藏 10 个地方行政区', icon: 'compass', unlocked: stats.places >= 10, progress: Math.min(stats.places,10), total: 10 },
    { id: 'world', title: '世界来信', subtitle: '在 3 个国家留下足迹', icon: 'globe', unlocked: stats.countries >= 3, progress: Math.min(stats.countries,3), total: 3 },
    { id: 'return', title: '故地重逢', subtitle: '为同一个地方记录两次到访', icon: 'repeat', unlocked: new Set(real.map(v => v.region.id)).size < real.length, progress: new Set(real.map(v=>v.region.id)).size < real.length ? 1 : 0, total: 1 },
    { id: 'photo', title: '留住一刻', subtitle: '为一段到访回忆添加照片', icon: 'camera', unlocked: real.some(v=>v.photos.length > 0), progress: real.some(v=>v.photos.length > 0) ? 1 : 0, total: 1 },
    { id: 'home', title: '他乡也是家', subtitle: '记录一个曾经居住的地方', icon: 'home', unlocked: real.some(v=>v.status==='lived'), progress: real.some(v=>v.status==='lived') ? 1 : 0, total: 1 },
  ];
}

export interface BackupPhoto { id: string; filename: string; archivePath: string; }
export interface BackupVisit extends Omit<Visit, 'photos'> { photos: BackupPhoto[]; }
export interface Backup { version: 1; exportedAt: string; visits: BackupVisit[]; }

export const BACKUP_JSON_LIMIT = 10_000_000;
export const BACKUP_RECORD_LIMIT = 5000;
export const BACKUP_ARCHIVE_LIMIT = 200 * 1024 * 1024;

export function stringifyBackup(value: Backup): string {
  if (value.visits.length > BACKUP_RECORD_LIMIT) throw new Error('记录过多，请按年份分别导出备份');
  const json = JSON.stringify(parseBackup(value), null, 2);
  if (new TextEncoder().encode(json).byteLength > BACKUP_JSON_LIMIT) throw new Error('文字记录较多，请按年份分别导出备份');
  return json;
}

export function parseBackup(value: unknown): Backup {
  if (!value || typeof value !== 'object') throw new Error('备份文件格式不正确');
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || !Array.isArray(raw.visits) || raw.visits.length > BACKUP_RECORD_LIMIT) throw new Error('不支持的备份版本或记录数量过多');
  const ids = new Set<string>();
  for (const v of raw.visits) {
    if (!v || typeof v !== 'object' || typeof v.id !== 'string' || !/^[\w-]{1,100}$/.test(v.id) || ids.has(v.id)) throw new Error('备份包含无效或重复的记录');
    ids.add(v.id);
    validateVisitInput(v);
    for (const field of ['createdAt','updatedAt']) {
      if(typeof v[field]!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v[field]) || !Number.isFinite(Date.parse(v[field]))) throw new Error('备份中的记录时间无效');
    }
    if(Date.parse(v.createdAt)>Date.parse(v.updatedAt)) throw new Error('备份中的记录时间顺序无效');
    validateVisitTimestamps(v);
    if (!v.region || typeof v.region.name !== 'string' || !v.region.name.trim() || !Array.isArray(v.region.center) || v.region.center.length !== 2 || !v.region.center.every(Number.isFinite)) throw new Error('备份中的地点无效');
    if (!['visited','lived','passed','wishlist'].includes(v.status)) throw new Error('备份中的到访状态无效');
    for (const field of ['visitedOn','title','notes','tripName']) if (typeof v[field] !== 'string') throw new Error('备份内容缺失');
    if (!Array.isArray(v.photos) || v.photos.length > 6) throw new Error('备份中的照片列表无效');
    for (const p of v.photos) {
      if (!p || typeof p.id !== 'string' || typeof p.filename !== 'string' || typeof p.archivePath !== 'string' || !/^photos\/[\w-]+\.(jpg|jpeg|png|webp)$/.test(p.archivePath)) throw new Error('备份中的照片路径不安全');
    }
  }
  return raw as unknown as Backup;
}
