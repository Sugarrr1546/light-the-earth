#!/usr/bin/env python3
"""Rebuild selected local layers from pinned full gbOpen geometry.

Keeps all current IDs and attributes (only center/bbox are recomputed), builds
shared topology using mapshaper@0.7.95 and derives country land by exact union.
Run using outputs/geodata-venv/bin/python. Public immutable sources are cached;
manifest source hashes are enforced on later runs. No original layer is edited.
"""
import argparse, concurrent.futures, datetime, gzip, hashlib, json, pathlib, subprocess, urllib.request, time
from shapely import make_valid
from shapely.geometry import shape, mapping, MultiPolygon
from shapely.ops import unary_union
ROOT=pathlib.Path(__file__).resolve().parents[1]
DATA=ROOT/'public/data'; CACHE=ROOT/'outputs/precision-cache'; OUT=DATA/'precision'
COMMIT='9469f09592ced973a3448cf66b6100b741b64c0d'
CODES='GBR DEU ITA ESP PRT NLD CHE AUT GRC SWE NOR FIN IRL CAN AUS NZL KOR THA VNM MYS IDN TUR ZAF BRA'.split()
LIMIT=20_000_000

def read(p):return json.loads(p.read_text())
def encode(v):return (json.dumps(v,ensure_ascii=False,separators=(',',':'),allow_nan=False)+'\n').encode()
def write(p,v):
 p.parent.mkdir(parents=True,exist_ok=True);tmp=p.with_suffix(p.suffix+'.tmp');tmp.write_bytes(encode(v));tmp.replace(p)
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def vertex_count(g):
 if isinstance(g,dict):return vertex_count(g.get('coordinates',[]))
 if not g:return 0
 if isinstance(g[0],(int,float)):return 1
 return sum(vertex_count(x) for x in g)
def parts(g):
 if g.geom_type=='Polygon':return [g]
 return [p for c in getattr(g,'geoms',[]) for p in parts(c)]
def valid(g):
 if not g.is_valid:g=make_valid(g)
 ps=parts(g)
 if not ps:raise ValueError('No polygon area')
 g=ps[0] if len(ps)==1 else MultiPolygon(ps)
 if not g.is_valid:g=unary_union(ps)
 assert g.is_valid and not g.is_empty
 return g

def assets(path,fc):
 write(path,fc);z=path.with_suffix(path.suffix+'.gz');z.write_bytes(gzip.compress(path.read_bytes(),compresslevel=9,mtime=0))
 assert path.stat().st_size<LIMIT,(path,path.stat().st_size)
 assert z.stat().st_size<10_000_000,(z,z.stat().st_size)
 return {'bytes':path.stat().st_size,'gzipBytes':z.stat().st_size,'sha256':sha(path),'gzipSHA256':sha(z)}

def _download(code,c,meta,prior):
 path=CACHE/f'{code}-full.geojson'
 url=meta['gjDownloadURL'].replace('/raw/9469f09/','/raw/'+COMMIT+'/').replace('/raw/90a1d52/','/raw/90a1d5290ede3adc147c5a2351472fd000412e72/').replace('https://github.com/wmgeolab/geoBoundaries/raw/','https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/')
 assert any(commit in url for commit in [COMMIT,'90a1d5290ede3adc147c5a2351472fd000412e72']),('Unresolved source commit',code,url)
 if not path.exists():
  tmp=path.with_suffix('.download')
  head=urllib.request.Request(url,headers={'User-Agent':'LightTheEarth/1.0 public boundary build'},method='HEAD')
  with urllib.request.urlopen(head,timeout=90) as response: total=int(response.headers['Content-Length'])
  prefix=tmp.stat().st_size if tmp.exists() else 0
  assert prefix<=total
  # Immutable public media supports ranges. Resume complete prefix bytes and
  # parallelize the rest, retaining individually verified range lengths.
  spans=[(a,min(total,a+8_000_000)-1) for a in range(prefix,total,8_000_000)]
  def get_span(span):
   a,b=span;part=CACHE/f'{code}-range-{a}-{b}.part'
   if not part.exists() or part.stat().st_size!=b-a+1:
    req=urllib.request.Request(url,headers={'User-Agent':'LightTheEarth/1.0 public boundary build','Range':f'bytes={a}-{b}'})
    with urllib.request.urlopen(req,timeout=240) as response:
     assert response.status==206,(code,response.status)
     with part.open('wb') as dest:
      while chunk:=response.read(1024*1024):dest.write(chunk)
    assert part.stat().st_size==b-a+1
   return part
  with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ranges:
   pieces=list(ranges.map(get_span,spans))
  with tmp.open('ab') as dest:
   for part in pieces:
    with part.open('rb') as source:
     while chunk:=source.read(1024*1024):dest.write(chunk)
  assert tmp.stat().st_size==total
  tmp.replace(path)
  for part in pieces:part.unlink()
 expected=prior.get(code,{}).get('sourceSHA256')
 if expected:assert sha(path)==expected,('Pinned input hash changed',code)
 print('Downloaded',code,path.stat().st_size,flush=True)
 return path,url

def download(*args):
 for attempt in range(3):
  try:return _download(*args)
  except Exception:
   if attempt==2:raise
   time.sleep(1+attempt)

def prepare(code,c,meta,source_path,source_url):
 old=read(ROOT/'public'/c['localUrl'].lstrip('/'));old_by={f['id']:f for f in old['features']}
 full=read(source_path);full_by={'GB-'+str(f['properties']['shapeID']):f for f in full['features']}
 assert set(old_by)<=set(full_by),(code,'missing full source IDs',set(old_by)-set(full_by))
 selected=[full_by[i] for i in old_by];filtered=CACHE/f'{code}-selected.geojson';write(filtered,{'type':'FeatureCollection','features':selected})
 old_vertices=sum(vertex_count(f['geometry']) for f in old['features']);full_vertices=sum(vertex_count(f['geometry']) for f in selected)
 # Adaptive retention targets 3x the old geometry. For dense sources the byte
 # budget takes priority; increase/decrease is measured after actual encoding.
 ratio=min(1.,max(.0001,old_vertices*3/full_vertices));attempts=[];best=None
 for attempt in range(6):
  candidate=CACHE/f'{code}-simplified.geojson'
  subprocess.run(['npx','--yes','mapshaper@0.7.95',str(filtered),'-simplify',f'{ratio*100:.7f}%','keep-shapes','-o','force','precision=0.000001',str(candidate)],check=True,stdout=subprocess.DEVNULL)
  simplified=read(candidate);by={'GB-'+str(f['properties']['shapeID']):f for f in simplified['features']};assert set(by)==set(old_by)
  fs=[];geoms=[];repaired=[];restored=[]
  for i,f in old_by.items():
   g=shape(by[i]['geometry']) if by[i].get('geometry') else shape(full_by[i]['geometry'])
   if g.is_empty: g=shape(full_by[i]['geometry']);restored.append(i)
   if not g.is_valid:repaired.append(i)
   g=valid(g);largest=max(parts(g),key=lambda p:p.area);p=largest.representative_point()
   props={**f['properties'],'center':[p.x,p.y],'bbox':list(g.bounds)}
   nf={**f,'properties':props,'geometry':mapping(g)}
   assert {k:v for k,v in props.items() if k not in ('center','bbox')}=={k:v for k,v in f['properties'].items() if k not in ('center','bbox')}
   fs.append(nf);geoms.append(g)
  fc={'type':'FeatureCollection','features':fs};size=len(encode(fc));vertices=sum(vertex_count(f['geometry']) for f in fs);attempts.append({'retainedPercentage':ratio*100,'bytes':size,'vertices':vertices})
  if size<LIMIT:
   best=(fc,geoms,repaired,restored,vertices,ratio)
   if vertices>=old_vertices*2.8 or ratio>=.99999 or attempt==5:break
   # Can raise retention only while a measured file-size estimate fits budget.
   next_ratio=min(1.,ratio*min(2.,old_vertices*3/vertices),ratio*(LIMIT*.92/size))
   if next_ratio<=ratio*1.05:break
   ratio=next_ratio
  else:
   ratio*=LIMIT*.87/size
 if best is None:raise ValueError(f'{code}: could not fit precision layer')
 fc,geoms,repaired,restored,vertices,ratio=best
 if vertices<old_vertices*1.5:raise ValueError(f'{code}: improvement below 1.5x ({vertices}/{old_vertices})')
 assert {f['id'] for f in fc['features']}==set(old_by)
 union=valid(unary_union(geoms));land={'type':'FeatureCollection','features':[{'type':'Feature','id':'precision-land-'+code,'properties':{'countryCode':code,'derivedFrom':'exact unary union of precision local polygons'},'geometry':mapping(union)}]}
 local_stats=assets(OUT/(code.lower()+'.geojson'),fc);land_stats=assets(OUT/(code.lower()+'-land.geojson'),land)
 land_read=shape(read(OUT/(code.lower()+'-land.geojson'))['features'][0]['geometry']);difference=land_read.symmetric_difference(unary_union(geoms)).area;assert difference<1e-9
 world=read(DATA/'world.geojson');coverage=[];replace=[];retain=[]
 for f in world['features']:
  if f['properties']['countryCode']!=code:continue
  g=valid(shape(f['geometry']));covered=g.intersection(union).area/g.area
  coverage.append({'id':f['id'],'fractionOfWorldLandCovered':covered})
  (replace if covered>=.95 else retain).append(f['id'])
 rec={'localUrl':f'/data/precision/{code.lower()}.geojson','localGzipUrl':f'/data/precision/{code.lower()}.geojson.gz','landUrl':f'/data/precision/{code.lower()}-land.geojson','landGzipUrl':f'/data/precision/{code.lower()}-land.geojson.gz','count':len(fc['features']),'renderCount':len(geoms),'suppressedIds':[],'legacyAliases':{},'replaceWorldIds':replace,'retainedWorldIds':retain,'worldCoverage':coverage,'localBytes':local_stats['bytes'],'localGzipBytes':local_stats['gzipBytes'],'landBytes':land_stats['bytes'],'landGzipBytes':land_stats['gzipBytes'],'sha256':{'local':local_stats['sha256'],'localGzip':local_stats['gzipSHA256'],'land':land_stats['sha256'],'landGzip':land_stats['gzipSHA256']},'originalVertexCount':old_vertices,'vertexCount':vertices,'vertexRatio':vertices/old_vertices,'fullSourceVertexCount':full_vertices,'source':c['source'],'sourceUrl':source_url,'sourceSHA256':sha(source_path),'sourceBytes':source_path.stat().st_size,'fullSourceCommit':source_url.split('/media/wmgeolab/geoBoundaries/')[1].split('/')[0],'sourceGeometry':'full','sourceYear':meta['boundaryYearRepresented'],'license':c['license'],'sourceMetadata':meta,'preparation':f'Selected exact existing source IDs; mapshaper@0.7.95 shared-topology weighted Visvalingam keep-shapes, {ratio*100:.7f}% full-source vertices retained; 0.000001 degree coordinates; Shapely polygonal make_valid as required; center from largest polygon internal point; land is exact unary union.','checks':{'sameIds':True,'samePropertiesExceptCenterBbox':True,'validNonemptyGeometries':True,'landSymmetricDifferenceAreaDeg2':difference,'repairedGeometryIds':repaired,'restoredFullSourceGeometryIds':restored,'sourceOnlyIdsNotPublished':sorted(set(full_by)-set(old_by))},'adaptiveAttempts':attempts}
 # Overview entities insufficiently represented in the source are restored
 # ONLY outside local union. This permits hiding their old coarse fills while
 # preserving Svalbard and Australia's independent island world features.
 worlds=[f for f in world['features'] if f['properties']['countryCode']==code]
 fallback_worlds=[f for f in worlds if f['id'] in retain]
 rec['worldIds']=[f['id'] for f in worlds]
 if fallback_worlds:
  missing=unary_union([valid(shape(f['geometry'])).difference(union) for f in fallback_worlds])
  if not missing.is_empty:
   fallback_g=valid(missing)
   fallback={'type':'FeatureCollection','features':[{'type':'Feature','id':'precision-fallback-'+code,'properties':{'countryCode':code,'derivedFrom':'Natural Earth overview land outside local union'},'geometry':mapping(fallback_g)}]}
   country_g=valid(unary_union([union,fallback_g]))
   country={'type':'FeatureCollection','features':[{'type':'Feature','id':'precision-country-'+code,'properties':{'countryCode':code,'derivedFrom':'local union plus uncovered Natural Earth overview land'},'geometry':mapping(country_g)}]}
   for kind,obj in [('fallback',fallback),('country',country)]:
    stats=assets(OUT/(code.lower()+'-'+kind+'.geojson'),obj)
    rec.update({kind+'Url':f'/data/precision/{code.lower()}-{kind}.geojson',kind+'GzipUrl':f'/data/precision/{code.lower()}-{kind}.geojson.gz',kind+'Bytes':stats['bytes'],kind+'GzipBytes':stats['gzipBytes']})
    rec['sha256'].update({kind:stats['sha256'],kind+'Gzip':stats['gzipSHA256']})
   fallback_ids=[f['id'] for f in fallback_worlds]
   rec.update(partialOverviewCoverage=True,fallbackWorldIds=fallback_ids,replaceWorldIds=list(dict.fromkeys([*replace,*fallback_ids])),retainedWorldIds=[],fallbackSource='Natural Earth 1:50m current world.geojson; source local union remains separate',fallbackSourceSHA256=sha(DATA/'world.geojson'))
   rec['checks'].update(countryUnionDifferenceAreaDeg2=country_g.symmetric_difference(unary_union([union,fallback_g])).area,fallbackLocalOverlapAreaDeg2=fallback_g.intersection(union).area)
 print('DONE',code,len(fs),'vertices',old_vertices,'->',vertices,'ratio',round(vertices/old_vertices,2),'bytes',local_stats['bytes'],'gzip',local_stats['gzipBytes'],flush=True)
 return rec

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--codes',nargs='*',default=CODES);parser.add_argument('--download-workers',type=int,default=4);args=parser.parse_args()
 CACHE.mkdir(parents=True,exist_ok=True);OUT.mkdir(parents=True,exist_ok=True)
 coverage={c['code']:c for c in read(DATA/'coverage.json')};catalog=read(DATA/'sources-global.json')['catalog'];meta={c:[m for m in catalog if m['boundaryISO']==c and m['boundaryType']==coverage[c]['adminLevel']][0] for c in args.codes}
 manifest_path=DATA/'precision-countries.json';prior=read(manifest_path) if manifest_path.exists() else {};countries=prior.get('countries',{}).copy()
 report={'version':1,'generatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'countries':countries,'sourceCommit':COMMIT,'sourceCommits':[COMMIT,'90a1d5290ede3adc147c5a2351472fd000412e72'],'contract':'Use gzip variants when supported. Local borders, picking and saved local fills use localUrl; landUrl is exact local union. Render fallbackUrl only outside local union when present; countryUrl combines local and fallback for country selection/saved country fills. Hide explicit replaceWorldIds and retain other overview features. IDs and properties except center/bbox are unchanged.','limitations':['Historical source years and boundaries are preserved; increased geometric fidelity does not assert current administrative coverage.','Source administrative areas can include water. Land is the local source union, not an independently surveyed coastline.','Overview entities with less than 95% source coverage use an explicit overview-minus-local fallback; their old full fills are replaced to avoid overlapping coarse edges.'],'skips':{}}
 with concurrent.futures.ThreadPoolExecutor(max_workers=args.download_workers) as pool:
  futures={pool.submit(download,code,coverage[code],meta[code],countries):code for code in args.codes}
  for future in concurrent.futures.as_completed(futures):
   code=futures[future]
   try:
    path,url=future.result();countries[code]=prepare(code,coverage[code],meta[code],path,url)
   except Exception as e:
    report['skips'][code]=repr(e);print('SKIP',code,repr(e),flush=True)
   for record in countries.values():record.setdefault('sourceGeometry','full')
   report['checks']={'countries':len(countries),'totalRegions':sum(c['count'] for c in countries.values()),'allIdsPreserved':all(c['checks']['sameIds'] for c in countries.values()),'minimumVertexRatio':min((c['vertexRatio'] for c in countries.values()),default=0),'maxDecodedLocalBytes':max((c['localBytes'] for c in countries.values()),default=0),'maxGzipAssetBytes':max((max(c.get(kind+'GzipBytes',0) for kind in ['local','land','fallback','country']) for c in countries.values()),default=0)}
   write(manifest_path,report)
 print('SUMMARY',report['checks'],'SKIPS',report['skips'],flush=True)
if __name__=='__main__':main()
