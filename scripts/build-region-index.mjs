import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fields = ['id', 'name', 'originalName', 'aliases', 'parentName', 'countryCode', 'countryName', 'level', 'adminLevel', 'center', 'bbox', 'year', 'source'];
const coverage = JSON.parse(readFileSync(resolve(root, 'public/data/coverage.json'), 'utf8'));
const alignment = JSON.parse(readFileSync(resolve(root, 'public/data/geometry-alignment.json'), 'utf8'));
const meshes=JSON.parse(readFileSync(resolve(root,'public/data/display-meshes.json'),'utf8'));
const outDir = resolve(root, 'public/data/region-index');
// Chinese names and Chinese parent names for areas outside China (scripts/audit-foreign-names.py).
const foreignPath = resolve(root, 'data/foreign-names.json');
const foreign = existsSync(foreignPath) ? JSON.parse(readFileSync(foreignPath, 'utf8')).countries : {};
const HAN = /[\u3400-\u9fff]/;
const at = Object.fromEntries(fields.map((field, i) => [field, i]));
function applyForeign(row, overlay) {
  const entry = overlay?.regions[row[at.id]];
  if (!entry) return row;
  const [name, parent] = entry;
  if (name && !HAN.test(row[at.name])) {
    const source = row[at.name];
    if (!row[at.originalName]) row[at.originalName] = source;
    row[at.aliases] = [...new Set([...(row[at.aliases] || []), source].filter(Boolean))];
    row[at.name] = name;
  }
  if (parent != null && !HAN.test(row[at.parentName] || '')) row[at.parentName] = overlay.parents[parent];
  return row;
}
mkdirSync(outDir, { recursive: true });

let bytes = 0;
for (const item of coverage) {
  const localUrl = alignment.countries[item.code]?.localUrl || item.localUrl;
  const raw=readFileSync(resolve(root,'public',localUrl.slice(1)));
  const local=JSON.parse(raw);
  const mesh=meshes.countries[item.code];
  if(!mesh||mesh.primaryUrl!==localUrl||mesh.primarySha256!==createHash('sha256').update(raw).digest('hex'))throw Error(`Stale current display mesh for ${item.code}; regenerate prepare-display-meshes.py`);
  const sources=[...new Set(local.features.map(f=>f.properties?.source).filter(Boolean))];
  const rows=local.features.map(feature=>applyForeign(fields.map(field=>{
    if(field==='source')return feature.properties?.source?sources.indexOf(feature.properties.source):'';
    if(field==='id')return String(feature.id??feature.properties?.id??'');
    const value=feature.properties?.[field];return value==null||value===''||(Array.isArray(value)&&!value.length)?'':value;
  }),foreign[item.code]));
  const payload={v:1,fields,rows,sources,geometry:mesh.url,primarySha256:mesh.primarySha256};
  const path = resolve(outDir, `${item.code.toLowerCase()}.json`);
  const text = JSON.stringify(payload);
  writeFileSync(path, text);
  bytes += text.length;

}
console.log(`region indexes ${coverage.length} files, ${(bytes / 1e6).toFixed(1)} MB`);
