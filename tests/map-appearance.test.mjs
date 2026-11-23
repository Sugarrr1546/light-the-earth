import test from 'node:test';import assert from 'node:assert/strict';
import {mapPalette} from '../lib/map-appearance.ts';
const lum=hex=>hex.slice(1).match(/../g).map(x=>parseInt(x,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
test('day and night oceans have strong contrast against separate space backgrounds',()=>{
 for(const theme of ['light','dark']){const p=mapPalette(theme);assert.ok(p.space,'space palette');assert.ok((lum(p.ocean)+.05)/(lum(p.space)+.05)>=2.5,theme+' globe/space contrast');}
});
