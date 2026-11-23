import { copyFile, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { AtlasStore, StoredPhoto, StoredVisit } from '../lib/local-api.ts';

interface AtlasFile { version: 1; visits: StoredVisit[]; photos: StoredPhoto[] }

const FILE = 'atlas.json';
const BACKUP = 'atlas.backup.json';
const SAFE_ID = /^[\w-]{1,100}$/;

function parse(text: string): AtlasFile {
  const data = JSON.parse(text) as Partial<AtlasFile>;
  if (data?.version !== 1 || !Array.isArray(data.visits) || !Array.isArray(data.photos)) throw new Error('Unrecognised atlas file');
  return { version: 1, visits: data.visits, photos: data.photos };
}

/**
 * One folder holds the whole atlas: `atlas.json` for records and photo details,
 * `photos/` for the image files. The previous good `atlas.json` is kept beside it.
 */
export async function openFileStore(directory: string): Promise<AtlasStore & { directory: string; recovered: 'backup' | 'empty' | null }> {
  const photoDirectory = path.join(directory, 'photos');
  await mkdir(photoDirectory, { recursive: true });
  const file = path.join(directory, FILE), backup = path.join(directory, BACKUP);

  let state: AtlasFile = { version: 1, visits: [], photos: [] };
  let recovered: 'backup' | 'empty' | null = null;
  const primary = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (primary !== null) {
    try { state = parse(primary); }
    catch {
      // Keep the unreadable file for inspection and fall back to the last good copy.
      await copyFile(file, path.join(directory, `atlas.unreadable-${Date.now()}.json`));
      try { state = parse(await readFile(backup, 'utf8')); recovered = 'backup'; }
      catch { recovered = 'empty'; }
    }
  } else {
    // A crash between the two renames in `persist` leaves only the backup.
    try { state = parse(await readFile(backup, 'utf8')); recovered = 'backup'; } catch { /* First run. */ }
  }

  async function persist(next: AtlasFile): Promise<void> {
    const temporary = `${file}.${process.pid}.tmp`;
    const handle = await open(temporary, 'w');
    try { await handle.writeFile(JSON.stringify(next, null, 1) + '\n', 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await copyFile(file, backup).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    await rename(temporary, file);
    state = next;
  }

  const photoPath = (photo: StoredPhoto) => {
    if (!SAFE_ID.test(photo.id) || !/^[a-z0-9]{1,5}$/.test(photo.extension)) throw new Error('Unsafe photo name');
    return path.join(photoDirectory, `${photo.id}.${photo.extension}`);
  };

  // Image files written just before a crash may have no entry; they are never referenced, so remove them.
  // After a recovery the list of photos may be out of date, so every image file is left in place.
  if (recovered === null) {
    const known = new Set(state.photos.map((photo) => `${photo.id}.${photo.extension}`));
    for (const name of await readdir(photoDirectory)) if (!known.has(name)) await rm(path.join(photoDirectory, name), { force: true });
  }

  return {
    directory, recovered,
    async listVisits() { return state.visits; },
    async saveVisits(visits) { await persist({ ...state, visits }); },
    async listPhotos() { return state.photos; },
    async putPhoto(photo, bytes) {
      const target = photoPath(photo), temporary = `${target}.tmp`;
      const handle = await open(temporary, 'w');
      try { await handle.writeFile(bytes); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, target);
      await persist({ ...state, photos: [...state.photos.filter((item) => item.id !== photo.id), photo] });
    },
    async readPhoto(id) {
      const photo = state.photos.find((item) => item.id === id);
      if (!photo) return undefined;
      try { return { photo, bytes: new Uint8Array(await readFile(photoPath(photo))) }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    },
    async deletePhoto(id) {
      const photo = state.photos.find((item) => item.id === id);
      if (!photo) return;
      await persist({ ...state, photos: state.photos.filter((item) => item.id !== id) });
      await rm(photoPath(photo), { force: true });
    },
  };
}
