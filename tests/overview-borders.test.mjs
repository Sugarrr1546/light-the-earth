import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readdirSync,readFileSync} from 'node:fs';
import {countyRenderPolicy} from '../lib/county-render-policy.ts';
import {themedMapPaint,mapPalette} from '../lib/map-appearance.ts';

const read=url=>readFileSync(new URL('../public'+url,import.meta.url));
const manifest=JSON.parse(read('/data/overview-borders.json'));
const alignment=JSON.parse(read('/data/geometry-alignment.json')).countries;
// A minimal Mapbox vector tile reader: layers, features and line geometry only.
function decodeTile(buffer){
 let pos=0;const varint=bytes=>{let result=0,shift=0,byte;do{byte=bytes.buf[bytes.pos++];result+=(byte&0x7f)*2**shift;shift+=7;}while(byte&0x80);return result;};
 const message=(buf,start,end,onField)=>{const r={buf,pos:start};while(r.pos<end){const key=varint(r);const num=key>>3,type=key&7;if(type===0)onField(num,varint(r));else if(type===2){const len=varint(r);onField(num,null,r.pos,r.pos+len);r.pos+=len;}else throw Error('wire type '+type);}};
 const packed=(buf,start,end)=>{const r={buf,pos:start},out=[];while(r.pos<end)out.push(varint(r));return out;};
 const text=(buf,s,e)=>Buffer.from(buf.subarray(s,e)).toString();
 const layers=[];
 message(buffer,0,buffer.length,(num,_,s,e)=>{if(num!==3)return;const layer={features:[],keys:[],values:[]};
  message(buffer,s,e,(n,v,a,b)=>{if(n===1)layer.name=text(buffer,a,b);else if(n===5)layer.extent=v;else if(n===3)layer.keys.push(text(buffer,a,b));
   else if(n===4)message(buffer,a,b,(vn,_v,va,vb)=>{if(vn===1)layer.values.push(text(buffer,va,vb));});
   else if(n===2){const f={};message(buffer,a,b,(fn,fv,fa,fb)=>{if(fn===2)f.tags=packed(buffer,fa,fb);else if(fn===3)f.type=fv;else if(fn===4)f.geometry=packed(buffer,fa,fb);});layer.features.push(f);}});
  layers.push(layer);});
 return layers;
}
// Line geometry commands to point lists, checking every command.
function lines(geometry){
 const out=[];let x=0,y=0,i=0;const unzig=n=>(n>>>1)^-(n&1);
 while(i<geometry.length){const command=geometry[i]&7,count=geometry[i++]>>3;
  if(command===1){assert.equal(count,1);x+=unzig(geometry[i++]);y+=unzig(geometry[i++]);out.push([[x,y]]);}
  else if(command===2){assert.ok(out.length&&count>=1);for(let k=0;k<count;k++){x+=unzig(geometry[i++]);y+=unzig(geometry[i++]);out.at(-1).push([x,y]);}}
  else assert.fail('unexpected command '+command);}
 return out;
}
const tileDir=new URL('../public'+manifest.tiles.url.split('/{z}')[0]+'/',import.meta.url);
const tiles=readdirSync(tileDir,{recursive:true}).filter(name=>name.endsWith('.pbf')).map(name=>{const [z,x,y]=name.replace('.pbf','').split('/').map(Number);return {z,x,y,raw:readFileSync(new URL(name,tileDir))};});

test('the overview mesh ships as content-named vector tiles',()=>{
 assert.equal(manifest.version,2);
 assert.match(manifest.tiles.url,/^\/data\/overview\/tiles-[0-9a-f]{16}\/\{z\}\/\{x\}\/\{y\}\.pbf$/);
 assert.equal(tiles.length,manifest.tiles.count);
 assert.equal(tiles.reduce((sum,t)=>sum+t.raw.length,0),manifest.tiles.bytes);
 const sorted=[...tiles].sort((a,b)=>a.z-b.z||a.x-b.x||a.y-b.y);
 const sha256=createHash('sha256').update(Buffer.concat(sorted.flatMap(t=>[Buffer.from(`${t.z}/${t.x}/${t.y}`),t.raw]))).digest('hex');
 assert.equal(sha256,manifest.tiles.sha256);assert.ok(manifest.tiles.url.includes(sha256.slice(0,16)));
 assert.deepEqual([...new Set(tiles.map(t=>t.z))].sort(),[3,4,5,6]);
 for(const t of tiles)assert.ok(t.raw.length<2_000_000,`${t.z}/${t.x}/${t.y} stays small`);
});
test('every country whose exact boundaries wait for a closer zoom has lines from afar',()=>{
 const meshed=new Set(manifest.tiles.countries);
 for(const code of meshed)assert.ok(alignment[code],code+' is a covered country');
 const waiting=Object.entries(alignment).filter(([code,c])=>countyRenderPolicy(c.localBytes??0,c.renderCount,code).minZoom>3.45).map(([code])=>code);
 assert.ok(waiting.includes('CHN')&&waiting.includes('FRA')&&waiting.includes('IND'));
 for(const code of waiting)assert.ok(meshed.has(code),code);
 // Countries with a single local unit have no internal boundary to draw.
 for(const [code,c] of Object.entries(alignment))if(c.renderCount>=20)assert.ok(meshed.has(code),code);
});
test('tiles are valid and keep every mesh point at the finest zoom',()=>{
 let finest=0;const seen=new Set();
 for(const t of tiles){
  const [layer]=decodeTile(t.raw);assert.equal(layer.name,manifest.tiles.layer);assert.equal(layer.extent,4096);assert.deepEqual(layer.keys,['countryCode']);
  for(const f of layer.features){
   assert.equal(f.type,2);const code=layer.values[f.tags[1]];assert.ok(manifest.tiles.countries.includes(code));seen.add(code);
   for(const line of lines(f.geometry)){assert.ok(line.length>=2);for(const [x,y] of line)assert.ok(x>=-64&&x<=4160&&y>=-64&&y<=4160);if(t.z===6)finest+=line.length;}
  }
 }
 assert.equal(seen.size,manifest.tiles.countries.length);
 // A zoom 6 tile unit (0.0014 degrees) is far finer than the mesh grid, so no point is merged away;
 // clipping at tile edges only adds points.
 assert.ok(finest>=manifest.vertices,`${finest} points at zoom 6 for ${manifest.vertices} in the mesh`);
 // Grids stay at about a screen pixel where each country's exact detail takes over.
 for(const [code,c] of Object.entries(alignment)){const zoom=countyRenderPolicy(c.localBytes??0,c.renderCount,code).minZoom,pixel=360/(512*2**zoom);if(pixel<0.05)assert.ok(manifest.grids[String(zoom)]<=pixel*1.4,code);}
 // Chengdu's tile at zoom 6 carries China's lines.
 const x=Math.floor((104.07+180)/360*64),y=Math.floor((1-Math.asinh(Math.tan(30.67*Math.PI/180))/Math.PI)/2*64);
 const chengdu=tiles.find(t=>t.z===6&&t.x===x&&t.y===y);assert.ok(chengdu);assert.ok(decodeTile(chengdu.raw)[0].values.includes('CHN'));
});
test('mesh lines follow the theme like exact local borders',()=>{
 for(const theme of ['light','dark'])assert.deepEqual(themedMapPaint('overview-border',theme),{'line-color':mapPalette(theme).line});
});
test('the border seam fill is a verified land strip that follows the theme',()=>{
 const seams=manifest.seams,raw=read(seams.url);
 assert.match(seams.url,/^\/data\/overview\/seams-[0-9a-f]{16}\.json$/);
 assert.equal(raw.length,seams.bytes);assert.ok(raw.length<10_000_000);
 assert.equal(createHash('sha256').update(raw).digest('hex'),seams.sha256);
 const polygons=JSON.parse(raw).features.map(feature=>{assert.equal(feature.geometry.type,'Polygon');return feature.geometry.coordinates;});
 assert.ok(seams.borders>250,'covers the world\'s land borders');
 // Wide water stays open: the closing is far narrower than a great lake or a sea strait.
 assert.ok(seams.closesGapsUpToDegrees<=0.12);
 const inside=([x,y],ring)=>{let hit=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const [x1,y1]=ring[i],[x2,y2]=ring[j];if((y1>y)!==(y2>y)&&x<(x2-x1)*(y-y1)/(y2-y1)+x1)hit=!hit;}return hit;};
 const covered=point=>polygons.some(([outer,...holes])=>inside(point,outer)&&!holes.some(hole=>inside(point,hole)));
 // On the Poland–Ukraine border the two sources leave a gap several kilometres wide.
 assert.ok(covered([24.0,50.6]),'Poland–Ukraine border');
 // Open water is never painted as land: mid Lake Superior, the Strait of Gibraltar, the Gulf of Finland,
 // and the French half of Lake Geneva, on a border whose two sources agree well.
 for(const point of [[-87.5,47.5],[-5.6,35.95],[26.5,59.9],[6.55,46.45]])assert.ok(!covered(point),String(point));
 // Narrow water beside a border is still water: Hong Kong's Rambler Channel, Tolo Harbour and Deep Bay,
 // Lake Skadar between Albania and Montenegro, and the Vistula Lagoon between Poland and Russia.
 for(const point of [[114.113,22.352],[114.23,22.44],[113.96,22.48],[19.3,42.2],[19.65,54.42]])assert.ok(!covered(point),String(point));
 for(const theme of ['light','dark'])assert.deepEqual(themedMapPaint('border-seam-fill',theme),{'fill-color':mapPalette(theme).land});
});
