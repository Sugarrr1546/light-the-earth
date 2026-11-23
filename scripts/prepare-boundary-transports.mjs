import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {writeBoundaryTransport,readPackedBoundary} from './boundary-transport.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));const publicRoot=resolve(root,'public');
const catalogPath=resolve(publicRoot,'data/geometry-assets.json');const catalog=JSON.parse(await readFile(catalogPath,'utf8'));
const files=process.argv.slice(2);if(!files.length)throw Error('Pass one or more audited current-boundary manifest paths');
for(const file of files){
 const path=resolve(root,file);const manifest=JSON.parse(await readFile(path,'utf8'));
 const records=[...(manifest.alignment?[manifest.alignment]:[]),...Object.values(manifest.countries??{}).map(v=>v.alignment).filter(Boolean)];
 for(const a of records)for(const kind of ['local','land','fallback','country']){
  const url=a[kind+'Url'];if(!url)continue;
  const raw=await readFile(resolve(publicRoot,'.'+url));
  const hash=createHash('sha256').update(raw).digest('hex');if(a.sha256?.[kind]&&hash!==a.sha256[kind])throw Error('Source changed before transport: '+url);
  const transport=await writeBoundaryTransport(publicRoot,url,raw,{existing:catalog.assets[url]??{url:a[kind+'GzipUrl']??url+'.gz',parts:a[kind+'GzipParts'],bytes:a[kind+'GzipBytes']}});
  catalog.assets[url]=transport;a[kind+'GzipUrl']=transport.url;a[kind+'GzipBytes']=transport.bytes;a[kind+'Bytes']=raw.length;
  if(transport.parts)a[kind+'GzipParts']=transport.parts;else delete a[kind+'GzipParts'];
  a.sha256??={};a.sha256[kind]=transport.sha256;a.sha256[kind+'Gzip']=createHash('sha256').update(await readPackedBoundary(publicRoot,transport)).digest('hex');
  console.log(url,transport.parts?`${transport.parts.length} immutable parts`:'single gzip',transport.bytes);
 }
 for(const archive of [manifest.currentAdministrative,manifest.currentSourceAdministrative,...manifest.sourceArchives??[]].filter(Boolean)){
  if(!archive.url?.startsWith('/data/precision/'))continue;
  const raw=await readFile(resolve(publicRoot,'.'+archive.url));const a=await writeBoundaryTransport(publicRoot,archive.url,raw,{existing:catalog.assets[archive.url]??{url:archive.gzipUrl,parts:archive.gzipParts,bytes:archive.gzipBytes}});
  if(archive.sha256&&archive.sha256!==a.sha256)throw Error('Administrative archive changed');
  catalog.assets[archive.url]=a;archive.gzipUrl=a.url;archive.gzipBytes=a.bytes;if(a.parts)archive.gzipParts=a.parts;else delete archive.gzipParts;
 }
 await writeFile(path,JSON.stringify(manifest)+'\n');
}
await writeFile(catalogPath,JSON.stringify(catalog)+'\n');
