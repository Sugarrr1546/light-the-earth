#!/usr/bin/env python3
"""Apply audited boundary supplements, then build lightweight saved-area geometry.

Requires Shapely. Recipes and all source URLs/IDs/licenses are tracked in
public/data/sources-supplements.json. Downloads can use the ignored cache.
The original three country files and all previous layer assets are retained.
"""
import argparse, hashlib, importlib.util, json, pathlib, urllib.request, datetime
from shapely.geometry import shape, mapping
from shapely.ops import unary_union
ROOT=pathlib.Path(__file__).resolve().parents[1];DATA=ROOT/'public/data'
spec=importlib.util.spec_from_file_location('geodata',ROOT/'scripts/prepare-global-geodata.py');geo=importlib.util.module_from_spec(spec);spec.loader.exec_module(geo)
read=geo.read;write=geo.write

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def rounded(v):
 if isinstance(v,(tuple,list)):return [rounded(x) for x in v]
 if isinstance(v,float):return round(v,6)
 return v

def source(recipe,cache):
 p=cache/recipe['cacheFile']
 if not p.exists():
  if not recipe.get('downloadUrl'):raise RuntimeError(f"Missing prepared source {p}; follow extraction instructions in the recipe")
  geo.download(recipe['downloadUrl'],p)
 if sha(p)!=recipe['sourceSHA256']:raise RuntimeError(f"Source changed for {recipe['code']}; audit it before changing the pinned SHA")
 return read(p)

def selected(fc,r):
 fs=fc['features'];kind=r['format']
 if kind=='naturalEarth':fs=[f for f in fs if (f['properties'].get('adm0_a3')==r['code'] or f['properties'].get('gu_a3')==r['code'])]
 if r.get('osmLevel'):fs=[f for f in fs if f['properties'].get('admin_level')==r['osmLevel']]
 if r.get('sourceIds'):fs=[f for f in fs if str(f.get('id') or f['properties'].get('sourceId')) in r['sourceIds']]
 if len(fs)!=r['expectedCount']:raise ValueError(f"{r['code']}: expected {r['expectedCount']} features, got {len(fs)}")
 return fs

def normalize(fs,r):
 out=[]
 for f in fs:
  p=f['properties'];kind=r['format']
  if kind=='naturalEarth':sid=str(p.get('ne_id') or f.get('id'));rid='NE1-'+sid.replace('/','-');name=p.get('name_zh') or p.get('name_en') or p.get('name');original=p.get('name')
  elif kind=='geoBoundaries':sid=p['shapeID'];rid=('SUB-'+r['code']+'-' if r.get('alias') else '')+'GB-'+sid;name=p.get('shapeName');original=name
  elif kind=='frCommune':sid=p[r.get('idField','code')];rid='FR-COM-'+sid;name=p[r.get('nameField','nom')];original=name
  elif kind=='hdx':sid=p['ADM2_PCODE'];rid='HDX-'+r['code']+'-'+sid;name=p['ADM2_EN'];original=name
  elif kind=='osm':
   sid=str(p.get('sourceId') or f.get('id'));rid='OSM-'+r['code']+'-'+sid.replace('/','-').replace('OSM-','');tags=p.get('tags',p);name=tags.get('name:zh-Hans') or tags.get('name:zh') or p.get('name') or tags.get('name:en');original=p.get('originalName') or tags.get('name')
  else:raise ValueError(kind)
  if not name:name='未命名区域 · '+sid
  g=shape(f['geometry']);span=min(g.bounds[2]-g.bounds[0],g.bounds[3]-g.bounds[1])
  # High-detail inputs may contain millions of vertices. This is a display
  # simplification of the real polygon, bounded by its size, never a buffer.
  tol=min(.0003,max(.000001,span/1000))
  small=g.simplify(tol,preserve_topology=True)
  geometry,center,bbox,_,_=geo.normalized_geometry(mapping(small))
  props={'id':rid,'sourceRegionId':sid,'name':name,'originalName':original or name,'aliases':[],
    'countryCode':r['code'],'countryName':r['name'],'level':'local','adminLevel':r['adminLevel'],
    'center':center,'bbox':bbox,'source':r['source'],'year':r['year']}
  out.append({'type':'Feature','id':rid,'properties':props,'geometry':geometry})
 return {'type':'FeatureCollection','features':out}

def paint(coverage):
 reports=[]
 world_codes={f['properties']['countryCode'] for f in read(DATA/'world.geojson')['features']}
 for item in coverage:
  features={}
  for url in [*item.get('legacyUrls',[]),item['localUrl']]:
   fc=read(ROOT/'public'/url.lstrip('/'))
   for f in fc['features']:
    g=shape(f['geometry']);b=g.bounds;tol=min(.01,max(.000001,min(b[2]-b[0],b[3]-b[1])/80))
    small=g.simplify(tol,preserve_topology=True);geometry=mapping(small);geometry['coordinates']=rounded(geometry['coordinates'])
    try:geometry,_,_,_,_=geo.normalized_geometry(geometry)
    except ValueError:geometry=f['geometry']
    features[f['id']]={'type':'Feature','id':f['id'],'properties':{'id':f['id']},'geometry':geometry}
  if item['code'] not in world_codes:
   # Overseas coverage-only entries lack an ADM0 world feature. Reuse the
   # actual union of their current local polygons, without inventing a box.
   current=read(ROOT/'public'/item['localUrl'].lstrip('/'))
   outline=unary_union([shape(f['geometry']) for f in current['features']]);outline=outline.simplify(.002,preserve_topology=True)
   geometry,_,_,_,_=geo.normalized_geometry(mapping(outline));rid='coverage-'+item['code']
   features[rid]={'type':'Feature','id':rid,'properties':{'id':rid},'geometry':geometry}
  path=DATA/'paint'/f"{item['code'].lower()}.geojson";write(path,{'type':'FeatureCollection','features':list(features.values())})
  item['paintUrl']='/data/paint/'+path.name
  assert path.stat().st_size<=10_000_000,(item['code'],path.stat().st_size)
  reports.append({'code':item['code'],'file':item['paintUrl'],'count':len(features),'bytes':path.stat().st_size,'sha256':sha(path)})
 return reports

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--cache-dir',type=pathlib.Path,default=ROOT/'outputs/boundary-supplements');parser.add_argument('--paint-only',action='store_true');args=parser.parse_args()
 manifest=read(DATA/'sources-supplements.json');coverage={c['code']:c for c in read(DATA/'coverage.json')};world={}
 for f in read(DATA/'world.geojson')['features']:world.setdefault(f['properties']['countryCode'],f['properties'])
 if not args.paint_only:
  for code,classification in manifest['classifications'].items():
   c=coverage[code];c.update(classification);c['coverageNote']=classification['coverageNote']
  for r in manifest['datasets']:
   data=normalize(selected(source(r,args.cache_dir),r),r);path=DATA/'supplements'/f"{r['code'].lower()}.geojson";write(path,data)
   if path.stat().st_size>10_000_000:raise ValueError(f"{r['code']} file too large")
   old=coverage.get(r['code'],{});legacy=list(dict.fromkeys([*old.get('legacyUrls',[]),*([old['localUrl']] if old.get('localUrl') and old['localUrl']!='/data/supplements/'+path.name else [])]))
   unnamed=sum(f['properties']['name'].startswith('未命名区域 · ') for f in data['features'])
   note=r['coverageNote']+(f'其中{unnamed}个源要素无名称，以稳定源ID标示。' if unnamed else '')
   bs=[f['properties']['bbox'] for f in data['features']];bbox=[min(b[0] for b in bs),min(b[1] for b in bs),max(b[2] for b in bs),max(b[3] for b in bs)]
   # Prefer the established country label point; tiny territories can use a true interior point.
   center=world.get(r['code'],{}).get('center') or data['features'][0]['properties']['center']
   coverage[r['code']]={'code':r['code'],'name':r['name'],'localUrl':'/data/supplements/'+path.name,'legacyUrls':legacy,
    'adminLevel':r['adminLevel'],'label':r['label'],'canonical':r['label'],'year':r['year'],'source':r['source'],
    'sourceUrl':r['sourceUrl'],'license':r['license'],'coverageNote':note,'count':len(data['features']),
    'center':center,'bbox':bbox,'detailTier':r['detailTier'],'partial':r.get('partial',False),'bytes':path.stat().st_size}
   r['outputSHA256']=sha(path);r['outputFile']='/data/supplements/'+path.name;r['outputBytes']=path.stat().st_size
   print(r['code'],len(data['features']),path.stat().st_size,flush=True)
 coverage=sorted(coverage.values(),key=lambda c:c['code']);paint_reports=paint(coverage);write(DATA/'coverage.json',coverage,True)
 gaps=read(DATA/'coverage-gaps.json');gaps['coveredCountriesAndTerritories']=len(coverage);gaps['regionalOnly']=[c['code'] for c in coverage if c.get('detailTier')=='regional'];gaps['unavailable']=[{**r,'reasonZh':manifest['remainingReasons'].get(r['code'],'暂未取得可核验且可再分发的地方边界；保留国家／地区级记录。')} for r in gaps['unavailable'] if r['code'] not in {c['code'] for c in coverage}];gaps['supplementAudit']=manifest['audit'];gaps['updatedAt']='2026-10-26';write(DATA/'coverage-gaps.json',gaps,True)
 write(DATA/'sources-supplements.json',manifest,True)
 write(DATA/'validation-paint.json',{'validatedAt':'2026-10-26','description':'Simplified real polygon geometry for saved regions, including retained previous-layer IDs. Same-origin assets; no travel records included.','files':paint_reports},True)
 checks=geo.validate();write(DATA/'validation-global.json',{'validatedAt':'2026-10-26','checks':['globally unique current IDs','valid nonempty polygons','coverage counts and administrative levels match','finite centers/bounds'],'files':checks},True)
 print(json.dumps({'countries':len(coverage),'units':sum(c['count'] for c in coverage),'regionalOnly':len(gaps['regionalOnly']),'unavailable':len(gaps['unavailable']),'paintBytes':sum(r['bytes'] for r in paint_reports)}))
if __name__=='__main__':main()
