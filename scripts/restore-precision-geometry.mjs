import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {readPackedBoundary,MAX_BOUNDARY_BYTES} from './boundary-transport.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const catalog=JSON.parse(await readFile(resolve(root,'public/data/geometry-assets.json'),'utf8'));
let restored=0;
for(const [url,a] of Object.entries(catalog.assets)){
 if(!url.startsWith('/data/precision/')||url.includes('..')||a.url!==url+'.gz')throw Error('Invalid precision source path');
 const dest=resolve(root,'public',url.slice(1));
 if(a.parts)await readPackedBoundary(resolve(root,'public'),a); // Validate every stored part even when raw cache exists.
 try{const bytes=await readFile(dest);if(createHash('sha256').update(bytes).digest('hex')===a.sha256)continue;}catch{/* Rehydrate the exact source from tracked gzip. */}
 const raw=gunzipSync(await readPackedBoundary(resolve(root,'public'),a),{maxOutputLength:MAX_BOUNDARY_BYTES});
 if(raw.length!==a.decodedBytes||createHash('sha256').update(raw).digest('hex')!==a.sha256)throw Error(`Precision source integrity failed: ${url}`);
 await mkdir(dirname(dest),{recursive:true});await writeFile(dest,raw);restored++;
}
console.log(`Precision source integrity checked; ${restored} raw files restored losslessly.`);
