import {readdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
// Keep audited source documents readable in Git; ship the identical JSON values
// without formatting whitespace. Geometry bytes and their hashes stay intact.
const directory=resolve('dist/client/data');let saved=0;
for(const name of await readdir(directory)){
 if(!name.endsWith('.json'))continue;
 const path=resolve(directory,name),original=await readFile(path),compact=Buffer.from(JSON.stringify(JSON.parse(original.toString('utf8')))+'\n');
 if(compact.length<original.length){await writeFile(path,compact);saved+=original.length-compact.length;}
}
console.log(`Compacted source metadata: saved ${saved.toLocaleString()} bytes; geometry unchanged.`);
