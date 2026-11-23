#!/usr/bin/env python3
"""Build same-source administrative land silhouettes, preserving all visit IDs.

Runtime uses only same-origin static GeoJSON. Run with the existing geodata venv.
Full geoBoundaries inputs are pinned to the existing sources.json commit. The
ignored cache retains the exact HAD and OSM snapshot; hashes are in the manifest.
"""
import json, pathlib, hashlib, datetime, math, urllib.request, subprocess
import osmium
from shapely.geometry import shape, mapping, Polygon, MultiPolygon, LineString, Point, box
from shapely.ops import unary_union, polygonize
from shapely import make_valid, STRtree, union_all
ROOT=pathlib.Path(__file__).resolve().parents[1]; DATA=ROOT/'public/data'; OUT=DATA/'aligned'; CACHE=ROOT/'outputs/aligned-geodata-cache'

def read(p): return json.loads(p.read_text())
def write(p,v):
 p.parent.mkdir(parents=True,exist_ok=True);tmp=p.with_suffix(p.suffix+'.tmp');tmp.write_text(json.dumps(v,ensure_ascii=False,separators=(',',':'),allow_nan=False)+'\n');tmp.replace(p)
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def parts(g):
 if g.geom_type=='Polygon':return [g]
 return [p for c in getattr(g,'geoms',[]) for p in parts(c)]
def valid(g):
 if not g.is_valid:g=make_valid(g)
 ps=parts(g)
 if not ps:raise ValueError('No polygon area')
 return ps[0] if len(ps)==1 else MultiPolygon(ps)
def feature(f,g):
 f={**f,'properties':{**f['properties']},'geometry':mapping(g)};p=g.representative_point();f['properties'].update(center=[p.x,p.y],bbox=list(g.bounds));return f

def hk_land(territory):
 dest=CACHE/'HKG-coast-land.geojson'
 if dest.exists():return shape(read(dest)['geometry'])
 class Coast(osmium.SimpleHandler):
  def __init__(self):super().__init__();self.lines=[]
  def way(self,w):
   if w.tags.get('natural')=='coastline':
    try:self.lines.append(LineString([(n.lon,n.lat) for n in w.nodes]))
    except osmium.InvalidLocationError:raise ValueError('Incomplete OSM coastline node cache')
 h=Coast();h.apply_file(str(CACHE/'HKG.osm.pbf'),locations=True,idx='flex_mem')
 bounds=territory
 lines=[g.intersection(bounds) for g in h.lines if g.intersects(bounds)]
 cells=list(polygonize(union_all([bounds.boundary,*lines],grid_size=0.0000001)))
 tree=STRtree(cells);votes=[[0.,0.] for _ in cells]
 # OSM coastline has land on its left. Select polygonized faces with actual
 # directed coastline evidence, never use a coarse map to guess tiny islands.
 for line in h.lines:
  cs=list(line.coords)
  for a,b in zip(cs,cs[1:]):
   dx=b[0]-a[0];dy=b[1]-a[1];n=math.hypot(dx,dy)
   if not n:continue
   eps=min(0.000001,n/10)
   p=Point((a[0]+b[0])/2-dy/n*eps,(a[1]+b[1])/2+dx/n*eps)
   if bounds.contains(p):
    for i in tree.query(p,predicate='within'):votes[int(i)][0]+=n
   q=Point((a[0]+b[0])/2+dy/n*eps,(a[1]+b[1])/2-dx/n*eps)
   if bounds.contains(q):
    for i in tree.query(q,predicate='within'):votes[int(i)][1]+=n
 land={i for i,(left,right) in enumerate(votes) if left>right}
 result=valid(unary_union([cells[i] for i in sorted(land)]))
 # Fixed geographic controls: Chek Lap Kok airport, Hong Kong Island,
 # Kowloon, Lantau are land; Victoria Harbour and east offshore are water.
 for xy in [(113.922,22.308),(114.159,22.277),(114.172,22.318),(113.953,22.255)]:assert result.covers(Point(*xy)),('missing land',xy)
 for xy in [(114.165,22.290),(114.45,22.30)]:assert not result.covers(Point(*xy)),('sea filled',xy)
 write(dest,{'type':'Feature','properties':{'source':'© OpenStreetMap contributors; Geofabrik HKG snapshot','coastWays':len(h.lines),'polygonizedFaces':len(cells),'landFaces':len(land)},'geometry':mapping(result)})
 return result

def ensure_inputs():
 """Fetch public build inputs only; refuse moved snapshots after first release."""
 CACHE.mkdir(parents=True,exist_ok=True)
 pinned=read(DATA/'geometry-alignment.json')['countries'] if (DATA/'geometry-alignment.json').exists() else {}
 sources=read(DATA/'sources.json')['locals']
 def get(url,path,expected=None):
  if not path.exists():
   req=urllib.request.Request(url,headers={'User-Agent':'LightTheEarth/1.0 boundary preparation'})
   with urllib.request.urlopen(req,timeout=180) as r:path.write_bytes(r.read())
  if expected and sha(path)!=expected:raise ValueError(f'Pinned source changed: {path}; audit a new snapshot explicitly')
 for code in ['CHN','JPN','USA']:
  url=sources[code]['gjDownloadURL'].replace('https://github.com/wmgeolab/geoBoundaries/raw/','https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/')
  full=CACHE/f'{code}-full.geojson';get(url,full,pinned.get(code,{}).get('sourceSHA256'))
  detail=CACHE/f'{code}-detail.geojson'
  if not detail.exists():
   option={'CHN':'12%','JPN':'interval=15','USA':'interval=25'}[code]
   subprocess.run(['npx','--yes','mapshaper@0.7.95',str(full),'-simplify',option,'keep-shapes','-o','precision=0.000001',str(detail)],check=True)
 get('https://www.had.gov.hk/psi/hong-kong-administrative-boundaries/hksar_18_district_boundary.json',CACHE/'HKG-official-full.geojson',pinned.get('HKG',{}).get('sourceSHA256'))
 get('https://download.geofabrik.de/asia/china/hong-kong-latest.osm.pbf',CACHE/'HKG.osm.pbf',pinned.get('HKG',{}).get('coastlineSHA256'))

def main():
 ensure_inputs();OUT.mkdir(exist_ok=True);coverage=read(DATA/'coverage.json');world=read(DATA/'world.geojson');sources=read(DATA/'sources.json');improved={};source_meta={};aliases={};suppressed=[]
 for code in ['CHN','JPN','USA']:
  raw=read(CACHE/f'{code}-detail.geojson');old=read(DATA/f'{code.lower()}.geojson');by_id={f['id']:f for f in old['features']}
  assert {f['properties']['shapeID'] for f in raw['features']}=={i[3:] for i in by_id}
  fs=[feature(by_id['GB-'+f['properties']['shapeID']],valid(shape(f['geometry']))) for f in raw['features']]
  improved[code]={'type':'FeatureCollection','features':fs}
  full=CACHE/f'{code}-full.geojson';meta=sources['locals'][code]
  source_meta[code]={'source':f"geoBoundaries gbOpen · {meta['boundarySource']}",'sourceUrl':meta['gjDownloadURL'],'sourceSHA256':sha(full),'license':meta['boundaryLicense'],'sourceYear':meta['boundaryYearRepresented'],'preparation':'shared-topology mapshaper@0.7.95; CHN 12% of full source, JPN 15m, USA 25m; precision 0.000001°'}
 official=read(CACHE/'HKG-official-full.geojson');old_hk=read(DATA/'supplements/hkg.geojson');hk_by_name={f['properties']['originalName']:f for f in old_hk['features']};territory=valid(unary_union([valid(shape(f['geometry'])) for f in official['features']]))
 coast=hk_land(territory);hk=[];hk_names={}
 for f in official['features']:
  n=f['properties']['District'].removesuffix(' District');old=hk_by_name[n];g=valid(shape(f['geometry']).intersection(coast));x=feature(old,g)
  x['properties'].update(name=f['properties']['地區'],originalName=n,aliases=list(dict.fromkeys([*x['properties'].get('aliases',[]),x['properties']['name'],n,n+' District'])),source='香港特别行政区政府民政事务总署 / DATA.GOV.HK；© OpenStreetMap contributors',year='2026（下载快照）',officialDistrictCode=f['properties']['地區號碼']);hk.append(x);hk_names[n+' District']=x
 improved['HKG']={'type':'FeatureCollection','features':hk}
 source_meta['HKG']={'source':'香港特别行政区政府民政事务总署 / DATA.GOV.HK；© OpenStreetMap contributors / Geofabrik','sourceUrl':'https://www.had.gov.hk/psi/hong-kong-administrative-boundaries/hksar_18_district_boundary.json','sourceSHA256':sha(CACHE/'HKG-official-full.geojson'),'coastlineSourceUrl':'https://download.geofabrik.de/asia/china/hong-kong.html','coastlineSHA256':sha(CACHE/'HKG.osm.pbf'),'license':'© 香港特别行政区政府、民政事务总署、DATA.GOV.HK (source redistribution with attribution); © OpenStreetMap contributors (ODbL 1.0)','licenseUrl':'https://data.gov.hk/en/terms-and-conditions','coastlineLicenseUrl':'https://www.openstreetmap.org/copyright','sourceYear':'2026（下载快照）','crs':'WGS84 longitude/latitude per HAD data specification','preparation':'18 official districts intersected with polygonized OSM coastline land, land-on-left orientation; existing NE1 IDs retained by exact English district name'}
 mac=read(DATA/'supplements/mac.geojson')['features'];mac_by_id={f['id']:f for f in mac};mac_targets={'聖方濟各堂區 São Francisco Xavier':'OSM-MAC-relation-5758866','路氹填海區 Zona de Aterro entre Taipa e Coloane':'OSM-MAC-relation-5758867','嘉模堂區 Nossa Senhora do Carmo':'OSM-MAC-relation-5758865'};mac_u=valid(unary_union([shape(f['geometry']) for f in mac]));mask=unary_union([territory,mac_u]);clip_audit=[]
 for i,f in enumerate(improved['CHN']['features']):
  n=f['properties'].get('originalName') or f['properties']['name'];g=shape(f['geometry'])
  if n in hk_names:
   target=hk_names[n];aliases[f['id']]=target['id'];suppressed.append(f['id']);improved['CHN']['features'][i]=feature(f,shape(target['geometry']));continue
  if n in mac_targets or n=='Macau':
   target=mac_by_id[mac_targets[n]] if n in mac_targets else None;aliases[f['id']]=target['id'] if target else 'NE-1159320475';suppressed.append(f['id']);improved['CHN']['features'][i]=feature(f,shape(target['geometry']) if target else mac_u);continue
  if g.intersects(mask):
   cut=g.difference(mask)
   if cut.is_empty:
    target=max(mac,key=lambda x:g.intersection(shape(x['geometry'])).area);aliases[f['id']]=target['id'];suppressed.append(f['id']);improved['CHN']['features'][i]=feature(f,shape(target['geometry']));continue
   if g.intersection(mask).area>1e-12:clip_audit.append({'id':f['id'],'name':n,'removedAreaDeg2':g.intersection(mask).area})
   improved['CHN']['features'][i]=feature(f,valid(cut))
 report={'version':1,'generatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'contract':'For loaded code hide coarse ADM0 fill and stroke. Render landUrl below localUrl, both derived from the same polygons. Skip suppressedIds for boundaries and picking; retained IDs use legacyAliases for historical saved fills. No change to existing visit storage.','countries':{},'checks':{},'limitations':['Historical geoBoundaries source years and uneven local coverage remain; aligned land describes source administrative coverage, not a global survey-quality coastline.','Administrative sources may include inland waters or maritime areas. Hong Kong specifically clips official districts to current OSM coastal land.','Unresolved ambiguous source overlaps within other countries are retained; no automatic disputed-boundary adjudication.']}
 for c in coverage:
  code=c['code'];fc=improved.get(code) or read(ROOT/'public'/c['localUrl'].lstrip('/'));skip=set(suppressed if code=='CHN' else []);geoms=[valid(shape(f['geometry'])) for f in fc['features'] if f['id'] not in skip];u=valid(unary_union(geoms));land_path=OUT/(code.lower()+'-land.geojson');write(land_path,{'type':'FeatureCollection','features':[{'type':'Feature','id':'aligned-land-'+code,'properties':{'countryCode':code,'derivedFrom':'union of unsuppressed local polygons'},'geometry':mapping(u)}]})
  local_url=c['localUrl']
  if code in improved:
   path=OUT/(code.lower()+'.geojson');write(path,fc);local_url='/data/aligned/'+path.name
  local_path=ROOT/'public'/local_url.lstrip('/');assert local_path.stat().st_size<10_000_000,(code,'local',local_path.stat().st_size);assert land_path.stat().st_size<10_000_000,(code,'land',land_path.stat().st_size)
  record={'localUrl':local_url,'landUrl':'/data/aligned/'+land_path.name,'count':len(fc['features']),'renderCount':len(geoms),'suppressedIds':sorted(skip),'legacyAliases':aliases if code=='CHN' else {},'localBytes':local_path.stat().st_size,'landBytes':land_path.stat().st_size,'sha256':{'local':sha(local_path),'land':sha(land_path)},**source_meta.get(code,{'source':c.get('source'),'sourceUrl':c.get('sourceUrl'),'license':c.get('license'),'preparation':'exact unary union of current local geometry; validity repaired only if required'})}
  if c.get('partial'):
   ws=[f for f in world['features'] if f['properties']['countryCode']==code]
   fallback=[]
   if ws:
    g=shape(ws[0]['geometry']).difference(u)
    if not g.is_empty and parts(g):fallback=[feature(ws[0],valid(g))]
   path=OUT/(code.lower()+'-fallback.geojson');write(path,{'type':'FeatureCollection','features':fallback})
   record.update(fallbackUrl='/data/aligned/'+path.name,fallbackBytes=path.stat().st_size)
   record['sha256']['fallback']=sha(path)
   complete=valid(unary_union([u,*[shape(f['geometry']) for f in fallback]]))
   path=OUT/(code.lower()+'-country.geojson');write(path,{'type':'FeatureCollection','features':[{'type':'Feature','id':'aligned-country-'+code,'properties':{'countryCode':code,'derivedFrom':'local union plus uncovered overview land for partial source'},'geometry':mapping(complete)}]})
   record.update(countryUrl='/data/aligned/'+path.name,countryBytes=path.stat().st_size)
   record['sha256']['country']=sha(path)

  report['countries'][code]=record
  assert u.symmetric_difference(unary_union(geoms)).area<1e-9,code
  print(code,record['count'],record['localBytes'],record['landBytes'],flush=True)
 visible_chn=unary_union([shape(f['geometry']) for f in improved['CHN']['features'] if f['id'] not in suppressed]);hku=unary_union([shape(f['geometry']) for f in hk]);overlap=visible_chn.intersection(hku).area
 assert len(hk)==18 and len(aliases)>=10 and overlap<1e-12
 for code,fc in improved.items():
  original=read(DATA/({'HKG':'supplements/hkg'}.get(code,code.lower())+'.geojson'))
  assert {f['id'] for f in fc['features']}=={f['id'] for f in original['features']}
 report['checks']={'countries':len(report['countries']),'sameSourceLandUnion':'pass for every country; symmetric-difference area < 1e-9 deg²','allOriginalEnhancedIdsRetained':True,'hongKongDistrictCount':18,'chinaHongKongDuplicateRecordsSuppressed':sum(target.startswith('NE1-') for target in aliases.values()),'chinaMacauDuplicateRecordsSuppressed':sum(not target.startswith('NE1-') for target in aliases.values()),'chinaHongKongLandOverlapDeg2':overlap,'chinaClippedByOfficialHongKongAndMacau':clip_audit,'hongKongLandFixtureChecks':'4 land and 2 sea controls passed','maxAssetBytes':max(max(x['localBytes'],x['landBytes']) for x in report['countries'].values())}
 write(DATA/'geometry-alignment.json',report)
 print('DONE',report['checks'],flush=True)
if __name__=='__main__':main()
