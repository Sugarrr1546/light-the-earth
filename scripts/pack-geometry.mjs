import {readdir,readFile,writeFile,unlink} from 'node:fs/promises';
import {resolve,relative,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {writeBoundaryTransport} from './boundary-transport.mjs';
const MAX_RAW=64*1024*1024,MAX_PACKED=10_000_000;
async function files(directory){const result=[];for(const entry of await readdir(directory,{withFileTypes:true})){const path=resolve(directory,entry.name);if(entry.isDirectory())result.push(...await files(path));else if(entry.isFile()&&(entry.name.endsWith('.geojson')||(entry.name.endsWith('.json')&&path.split(sep).includes('region-index'))))result.push(path);}return result;}
export async function packGeometry(clientDirectory,options={}){
 const directory=resolve(clientDirectory),assets={};let originalBytes=0,packedBytes=0,existing={};
 try{existing=JSON.parse(await readFile(resolve(directory,'data/geometry-assets.json'),'utf8')).assets??{};}catch{}
 for(const path of (await files(resolve(directory,'data'))).sort()){
  const bytes=await readFile(path);if(bytes.length>MAX_RAW)throw Error(`Decoded geometry exceeds64MiB: ${path}`);
  const url='/'+relative(directory,path).split(sep).join('/');
  const a=await writeBoundaryTransport(directory,url,bytes,{...options,existing:existing[url]});assets[url]=a;
  originalBytes+=bytes.length;packedBytes+=a.bytes;await unlink(path);
 }
 const report={version:1,codec:'gzip',maximumDecodedBytes:MAX_RAW,assets};
 await writeFile(resolve(directory,'data/geometry-assets.json'),JSON.stringify(report)+'\n');
 console.log(`Packed ${Object.keys(assets).length} boundary/index assets losslessly: ${(originalBytes/2**20).toFixed(1)} → ${(packedBytes/2**20).toFixed(1)} MiB.`);
 return report;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await packGeometry(fileURLToPath(new URL('../dist/client/',import.meta.url)));
