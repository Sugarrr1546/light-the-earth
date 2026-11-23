import{readFile,writeFile,unlink,access}from'node:fs/promises';
import{resolve}from'node:path';import{pathToFileURL}from'node:url';
import{gunzipSync}from'node:zlib';import{isDeepStrictEqual}from'node:util';
import{readPackedBoundary}from'./boundary-transport.mjs';
/** Keep source archives in Git. A production snapshot may be omitted only after
 * every feature is proved identical in the current cumulative historical mesh.
 * All runtime geometry dependencies remain independently protected.
 */
export async function pruneHistoricalSupersets(clientDirectory){
 const dir=resolve(clientDirectory);const read=p=>readFile(resolve(dir,'data',p),'utf8').then(JSON.parse);
 try{await access(resolve(dir,'data/current-central-china.json'));}catch{return{omitted:[]};}
 const catalog=await read('geometry-assets.json'),alignment=await read('geometry-alignment.json'),coverage=await read('coverage.json'),central=await read('current-central-china.json'),meshes=await read('display-meshes.json');
 const currentUrl=alignment.countries.CHN.localUrl;if(currentUrl!==central.alignment.localUrl)throw Error('Latest cumulative China mesh is not selected');
 const load=async url=>{if(!catalog.assets[url])throw Error('Missing packed historical mesh: '+url);return JSON.parse(gunzipSync(await readPackedBoundary(dir,catalog.assets[url]),{maxOutputLength:64*1024*1024}));};
 const current=await load(currentUrl),byId=new Map(current.features.map(f=>[String(f.id),f]));if(byId.size!==current.features.length)throw Error('Duplicate current feature IDs');
 const protectedUrls=new Set();
 for(const a of Object.values(alignment.countries))for(const key of ['localUrl','landUrl','fallbackUrl','countryUrl','legacyPaintUrl'])if(a[key])protectedUrls.add(a[key]);
 for(const c of coverage)for(const key of ['localUrl','paintUrl'])if(c[key])protectedUrls.add(c[key]);
 for(const mesh of Object.values(meshes.countries))if(mesh.url)protectedUrls.add(mesh.url);
 for(const [url,a]of Object.entries(catalog.assets))if(url.startsWith('/data/region-index/')&&url.endsWith('.json')){const index=await load(url);if(index.geometry)protectedUrls.add(index.geometry);}
 const omitted=[];
 for(const name of ['current-zhejiang.json','current-east-china.json']){
  let previous;try{previous=await read(name);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  const url=previous.alignment.localUrl;if(url===currentUrl||!catalog.assets[url])continue;
  if(protectedUrls.has(url))throw Error('Cannot omit runtime geometry dependency: '+url);
  const old=await load(url);for(const f of old.features)if(!isDeepStrictEqual(byId.get(String(f.id)),f))throw Error('Historical object changed or missing: '+f.id);
  omitted.push({url,retainedIn:currentUrl,preservedFeatureCount:old.features.length,packedBytes:catalog.assets[url].bytes,sourceManifest:name});
 }
 // Validate every candidate before any production file is removed.
 const physical=a=>a.parts?a.parts.map(p=>p.url):[a.url];
 const remove=omitted.flatMap(o=>physical(catalog.assets[o.url]));for(const o of omitted)delete catalog.assets[o.url];
 const retainedPhysical=new Set(Object.values(catalog.assets).flatMap(physical));
 for(const url of new Set(remove)){if(retainedPhysical.has(url))continue;if(!url.startsWith('/data/')||url.includes('..'))throw Error('Invalid packed asset path');await unlink(resolve(dir,'.'+url));}
 for(const c of coverage)if(c.legacyUrls)c.legacyUrls=c.legacyUrls.filter(url=>!omitted.some(o=>o.url===url));
 const report={version:1,policy:'Original snapshot files remain in the source repository. Every omitted production snapshot feature is retained byte-value-identical under its original ID in the current cumulative mesh. No travel record is migrated.',omitted};
 await writeFile(resolve(dir,'data/geometry-assets.json'),JSON.stringify(catalog)+'\n');
 await writeFile(resolve(dir,'data/coverage.json'),JSON.stringify(coverage)+'\n');
 await writeFile(resolve(dir,'data/runtime-geometry-retention.json'),JSON.stringify(report)+'\n');
 console.log(`Verified historical production deduplication: ${omitted.length} redundant snapshots, ${(omitted.reduce((s,o)=>s+o.packedBytes,0)/2**20).toFixed(2)} MiB; all original features retained.`);return report;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await pruneHistoricalSupersets(resolve('dist/client'));
