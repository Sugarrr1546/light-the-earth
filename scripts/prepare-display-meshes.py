#!/usr/bin/env python3
"""Derive overview meshes from primary polygons, preserving shared edges and exact land.

Never simplify counties independently. A source that is not a valid coverage is
shown exactly; simplification cannot hide existing source defects. This is an
offline asset step, with raw copies restored from tracked gzip at normal builds.
"""
import argparse,datetime,gzip,hashlib,json,pathlib,time
import shapely
from shapely.geometry import shape,mapping
from shapely.ops import unary_union
ROOT=pathlib.Path(__file__).resolve().parents[1];D=ROOT/'public/data';P=D/'precision'
def read(path):return json.loads(path.read_text())
def sha(raw):return hashlib.sha256(raw).hexdigest()
def encode(value):return (json.dumps(value,ensure_ascii=False,separators=(',',':'))+'\n').encode()
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--codes',nargs='*');args=parser.parse_args()
 alignment=read(D/'geometry-alignment.json')['countries'];catalog=read(D/'geometry-assets.json');dest=D/'display-meshes.json'
 result=read(dest) if args.codes and dest.exists() else {'version':1,'contract':'Current primary source only. Shared internal edges simplify together; exterior boundaries stay exact. Invalid coverages use exact primary geometry.','countries':{}}
 for code,a in alignment.items():
  if args.codes and code not in args.codes:continue
  t=time.monotonic();path=ROOT/('public'+a['localUrl']);raw=path.read_bytes();source_sha=sha(raw);data=json.loads(raw);suppressed=set(a.get('suppressedIds',[]));features=[f for f in data['features'] if str(f.get('id') or f['properties']['id']) not in suppressed]
  entry={'url':a['localUrl'],'primaryUrl':a['localUrl'],'primarySha256':source_sha,'method':'exact-primary','count':len(features),'unionSymmetricDifferenceArea':0,'introducedOverlapArea':0}
  # Small countries already have bounded geometry. Large invalid sources retain
  # exact geometry rather than making independently simplified seams worse.
  if len(raw)>300000 and len(features)>1:
   geoms=[shape(f['geometry']) for f in features]
   valid=all(g.is_valid and not g.is_empty for g in geoms)
   coverage=valid and bool(shapely.coverage_is_valid(geoms));entry['sourceCoverageValid']=coverage
   if coverage:
    simple=list(shapely.coverage_simplify(geoms,0.004,simplify_boundary=False))
    good=all(g.is_valid and not g.is_empty for g in simple) and bool(shapely.coverage_is_valid(simple))
    if good:
     delta=unary_union(geoms).symmetric_difference(unary_union(simple)).area
     if delta==0:
      payload={'type':'FeatureCollection','features':[{'type':'Feature','id':f['id'],'properties':{'id':f['id']},'geometry':mapping(g)} for f,g in zip(features,simple)]}
      out=encode(payload);packed=gzip.compress(out,compresslevel=9,mtime=0)
      if len(out)<len(raw) and len(packed)<=250000:
       url='/data/precision/display-'+code.lower()+'.geojson';(ROOT/('public'+url)).write_bytes(out);(ROOT/('public'+url+'.gz')).write_bytes(packed)
       entry.update(url=url,method='shared-edge-simplification',bytes=len(out),gzipBytes=len(packed),sha256=sha(out),toleranceDegrees=0.004,exteriorBoundary='unchanged')
       catalog['assets'][url]={'url':url+'.gz','bytes':len(packed),'decodedBytes':len(out),'sha256':sha(out)}
  result['countries'][code]=entry
  print(code,entry['method'],len(features),round(time.monotonic()-t,2),flush=True)
 result['generatedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat();dest.write_bytes(encode(result));(D/'geometry-assets.json').write_bytes(encode(catalog))
 print('meshes',len(result['countries']),'shared',sum(x['method']=='shared-edge-simplification' for x in result['countries'].values()),flush=True)
if __name__=='__main__':main()
