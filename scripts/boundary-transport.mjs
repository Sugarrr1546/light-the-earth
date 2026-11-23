import {readFile,writeFile,unlink,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
export const MAX_BOUNDARY_BYTES=64*1024*1024;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function pathFor(root,url){if(!/^\/data\/[a-zA-Z0-9_./-]+$/.test(url)||url.includes('..'))throw Error('Invalid boundary path');return resolve(root,'.'+url);}
export async function readPackedBoundary(root,asset){
 if(!asset.parts)return readFile(pathFor(root,asset.url));
 if(!asset.parts.length||asset.parts.length>16)throw Error('Invalid boundary parts');
 const chunks=[];let total=0;
 for(const p of asset.parts){
  if(!Number.isSafeInteger(p.bytes)||p.bytes<1||p.bytes>=10_000_000)throw Error('Invalid boundary part size');
  const bytes=await readFile(pathFor(root,p.url));if(bytes.length!==p.bytes||(p.sha256&&sha(bytes)!==p.sha256))throw Error('Boundary part integrity failed');
  total+=bytes.length;if(total>MAX_BOUNDARY_BYTES)throw Error('Compressed boundary exceeds limit');chunks.push(bytes);
 }
 if(asset.bytes!=null&&total!==asset.bytes)throw Error('Boundary part total differs');
 return Buffer.concat(chunks);
}
/** A logical gzip can be transported in immutable bounded files. Its decoded bytes never change. */
export async function writeBoundaryTransport(root,url,raw,{singleFileLimit=10_000_000,partBytes=9_000_000,existing}={}){
 if(raw.length>MAX_BOUNDARY_BYTES)throw Error('Decoded boundary exceeds64MiB');
 if(partBytes<1||partBytes>=singleFileLimit)throw Error('Invalid boundary part budget');
 const dest=pathFor(root,url+'.gz');let packed;
 try{const prior=await readPackedBoundary(root,existing??{url:url+'.gz'});if(gunzipSync(prior,{maxOutputLength:MAX_BOUNDARY_BYTES}).equals(raw))packed=prior;}catch{/* A fresh lossless gzip is safe. */}
 packed??=gzipSync(raw,{level:9});
 const entry={url:url+'.gz',bytes:packed.length,decodedBytes:raw.length,sha256:sha(raw)};await mkdir(dirname(dest),{recursive:true});
 if(packed.length<singleFileLimit){await writeFile(dest,packed);return entry;}
 entry.parts=[];
 for(let offset=0,index=0;offset<packed.length;offset+=partBytes,index++){
  const chunk=packed.subarray(offset,Math.min(offset+partBytes,packed.length));const hash=sha(chunk);
  const partUrl=url+`.gz.part-${String(index).padStart(3,'0')}-${hash.slice(0,16)}.bin`;
  await writeFile(pathFor(root,partUrl),chunk);entry.parts.push({url:partUrl,bytes:chunk.length,sha256:hash});
 }
 await unlink(dest).catch(error=>{if(error.code!=='ENOENT')throw error;});return entry;
}
