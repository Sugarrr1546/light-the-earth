import type JSZip from 'jszip';
import type { JSZipObject } from 'jszip';

// JSZip 3.10.1 exposes ZipObject.internalStream at runtime; its bundled
// declaration omits that method. Keep the narrow adapter version-bound.
type StreamEntry=JSZipObject & {internalStream(type:'uint8array'):JSZip.JSZipStreamHelper<Uint8Array>};

export function readBounded(entry:JSZipObject, limit:number):Promise<Uint8Array> {
  return new Promise((resolve,reject)=>{
    const chunks:Uint8Array[]=[];let size=0;let ended=false;
    const stream=(entry as StreamEntry).internalStream('uint8array');
    stream.on('data',(chunk:Uint8Array)=>{
      if(ended)return;
      size+=chunk.byteLength;
      if(size>limit){ended=true;stream.pause();reject(new Error('备份解压后超过允许大小'));return;}
      chunks.push(chunk);
    }).on('error',reject).on('end',()=>{
      if(ended)return;
      const result=new Uint8Array(size);let offset=0;
      for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.byteLength;}
      resolve(result);
    }).resume();
  });
}
