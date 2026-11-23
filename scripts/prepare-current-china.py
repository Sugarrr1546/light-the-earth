#!/usr/bin/env python3
"""Build a pinned, licensed 2026 Zhejiang replacement within the historical CHN layer.
No shared catalog mutations: merge current-china.json coveragePatch/alignment separately.
"""
import json,pathlib,hashlib,datetime,gzip,argparse,collections,subprocess,re
import osmium
from shapely import make_valid,STRtree
from shapely.geometry import shape,mapping,MultiPolygon,Point
from shapely.ops import unary_union
ROOT=pathlib.Path(__file__).resolve().parents[1];DATA=ROOT/'public/data';CACHE=ROOT/'outputs/current-china-cache';OUT=DATA/'precision'
FACTORY=osmium.geom.GeoJSONFactory()
def read(p):return json.loads(p.read_text())
def write(p,v,pretty=False):
 p.parent.mkdir(parents=True,exist_ok=True);b=(json.dumps(v,ensure_ascii=False,allow_nan=False,indent=2 if pretty else None,separators=None if pretty else(',',':'))+'\n').encode();p.write_bytes(b);return b
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def parts(g):
 if g.geom_type=='Polygon':return[g]
 return[p for c in getattr(g,'geoms',[])for p in parts(c)]
def valid(g):
 if not g.is_valid:g=make_valid(g)
 ps=parts(g)
 if not ps:raise ValueError('Empty polygon')
 g=ps[0]if len(ps)==1 else MultiPolygon(ps)
 assert g.is_valid and not g.is_empty;return g
class Extract(osmium.SimpleHandler):
 def __init__(self):super().__init__();self.rows=[];self.errors=[]
 def area(self,a):
  t=dict(a.tags)
  if a.from_way()or t.get('boundary')!='administrative'or t.get('admin_level')not in['4','5','6']:return
  try:
   g=valid(shape(json.loads(FACTORY.create_multipolygon(a))));self.rows.append({'type':'Feature','id':a.orig_id(),'properties':{'tags':t,'timestamp':str(a.timestamp)},'geometry':mapping(g)})
  except Exception as e:self.errors.append({'id':a.orig_id(),'name':t.get('name'),'error':str(e)})
def extract():
 p=CACHE/'zhejiang-latest.osm.pbf';dest=CACHE/'all-admin.geojson'
 if not dest.exists():
  h=Extract();h.apply_file(str(p),locations=True,idx='flex_mem');write(dest,{'type':'FeatureCollection','features':h.rows});write(CACHE/'extraction-errors.json',h.errors,True);print('extracted',len(h.rows),h.errors,flush=True)
 return read(dest)
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--extract-only',action='store_true');args=parser.parse_args();CACHE.mkdir(parents=True,exist_ok=True);fc=extract();print(collections.Counter(f['properties']['tags']['admin_level']for f in fc['features']))
