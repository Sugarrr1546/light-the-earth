import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fields = ['id', 'name', 'originalName', 'aliases', 'parentName', 'countryCode', 'countryName', 'level', 'adminLevel', 'center', 'bbox', 'year', 'source'];
const coverage = JSON.parse(readFileSync(resolve(root, 'public/data/coverage.json'), 'utf8'));
const alignment = JSON.parse(readFileSync(resolve(root, 'public/data/geometry-alignment.json'), 'utf8'));
const meshes=JSON.parse(readFileSync(resolve(root,'public/data/display-meshes.json'),'utf8'));
const outDir = resolve(root, 'public/data/region-index');
mkdirSync(outDir, { recursive: true });

let bytes = 0;
for (const item of coverage) {
  const localUrl = alignment.countries[item.code]?.localUrl || item.localUrl;
  const raw=readFileSync(resolve(root,'public',localUrl.slice(1)));
  const local=JSON.parse(raw);
  const mesh=meshes.countries[item.code];
  if(!mesh||mesh.primaryUrl!==localUrl||mesh.primarySha256!==createHash('sha256').update(raw).digest('hex'))throw Error(`Stale current display mesh for ${item.code}; regenerate prepare-display-meshes.py`);
  const sources=[...new Set(local.features.map(f=>f.properties?.source).filter(Boolean))];
  const rows=local.features.map(feature=>fields.map(field=>{
    if(field==='source')return feature.properties?.source?sources.indexOf(feature.properties.source):'';
    if(field==='id')return String(feature.id??feature.properties?.id??'');
    const value=feature.properties?.[field];return value==null||value===''||(Array.isArray(value)&&!value.length)?'':value;
  }));
  const payload={v:1,fields,rows,sources,geometry:mesh.url,primarySha256:mesh.primarySha256};
  const path = resolve(outDir, `${item.code.toLowerCase()}.json`);
  const text = JSON.stringify(payload);
  writeFileSync(path, text);
  bytes += text.length;

}
console.log(`region indexes ${coverage.length} files, ${(bytes / 1e6).toFixed(1)} MB`);
