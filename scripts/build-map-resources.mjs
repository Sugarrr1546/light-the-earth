import {readFile,writeFile,mkdir} from 'node:fs/promises';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';import {gzipSync} from 'node:zlib';
export async function buildMapResources(directory=resolve('dist/client')){
 const assets={};await mkdir(resolve(directory,'data/map-resources'),{recursive:true});
 for(const name of ['geometry-assets','geometry-partitions','coverage','geometry-alignment','name-quality']){
  const raw=await readFile(resolve(directory,`data/${name}.json`)),sha256=createHash('sha256').update(raw).digest('hex'),packed=gzipSync(raw,{level:9}),url=`/data/map-resources/${sha256}.json.gz`;
  await writeFile(resolve(directory,'.'+url),packed);assets[`/data/${name}.json`]={url,bytes:packed.length,decodedBytes:raw.length,sha256};
 }
 await writeFile(resolve(directory,'data/map-bootstrap.json'),JSON.stringify({version:1,assets})+'\n');
 // Both routes contain content hashes. Stable discovery paths are always revalidated.
 await writeFile(resolve(directory,'_headers'),'/data/geometry-partitions/*\n  Cache-Control: public, max-age=31536000, immutable\n/data/map-resources/*\n  Cache-Control: public, max-age=31536000, immutable\n/data/map-bootstrap.json\n  Cache-Control: no-cache\n');
 console.log('Versioned map metadata: 5 shared immutable resources.');return assets;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await buildMapResources();
