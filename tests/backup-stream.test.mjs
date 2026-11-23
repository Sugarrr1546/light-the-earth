import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {readBounded} from '../lib/archive.ts';

test('ZIP data is capped while decompressing, before materializing oversized content',async()=>{
  const source=new JSZip();source.file('bomb.txt','a'.repeat(2_000_000));
  const bytes=await source.generateAsync({type:'uint8array',compression:'DEFLATE'});
  assert.ok(bytes.byteLength<10000);
  const zip=await JSZip.loadAsync(bytes);
  await assert.rejects(readBounded(zip.file('bomb.txt'),10000),/超过/);
});
test('bounded ZIP reader preserves exact photo or text bytes',async()=>{
  const source=new JSZip();source.file('note.txt','点亮地球');
  const zip=await JSZip.loadAsync(await source.generateAsync({type:'uint8array'}));
  const bytes=await readBounded(zip.file('note.txt'),1000);
  assert.equal(new TextDecoder().decode(bytes),'点亮地球');
});
