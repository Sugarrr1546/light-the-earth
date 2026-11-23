#!/usr/bin/env python3
"""Bounded next-country precision batch; preserves the current level and IDs.

Uses the existing topology/union/fallback pipeline. Immutable full downloads
larger than --max-full-bytes use the existing hash-pinned provider-simplified
snapshot, only if its measured output still improves vertices by at least 1.5x.
Owns precision-remaining.json only; merging into the application is separate.
"""
import argparse, concurrent.futures, datetime, gzip, importlib.util, json, pathlib, re, urllib.request
from shapely.geometry import shape, Point
from shapely.ops import unary_union

ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('precision_common',ROOT/'scripts/prepare-precision-countries.py')
common=importlib.util.module_from_spec(spec);spec.loader.exec_module(common)
DATA=common.DATA;CACHE=common.CACHE;OUT=common.OUT
MANIFEST=DATA/'precision-remaining.json'
COMMITS={'9469f09':common.COMMIT,'90a1d52':'90a1d5290ede3adc147c5a2351472fd000412e72','f549eab':'f549eab25a258603ea32c9dc6cb11b7657796478','905b0ba':'905b0baf5f4fb3b9ccf45293647dcacdb2b799d4'}
CODES='MEX IND RUS POL CZE HUN ROU SVK BEL BGR HRV SVN CYP LVA ARG CHL COL ECU BOL PRY EGY KEN PHL BGD LKA NPL PAK IRN MNG DZA UKR VEN GTM HND SLV'.split()

def pinned(url):
 url=url.replace('https://github.com/wmgeolab/geoBoundaries/raw/','https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/')
 marker='/media/wmgeolab/geoBoundaries/';ref=url.split(marker)[1].split('/')[0]
 commit=COMMITS.get(ref,ref)
 assert re.fullmatch('[0-9a-f]{40}',commit),('Unresolved immutable source',url)
 return url.replace(marker+ref+'/',marker+commit+'/')

def source(code,c,meta,prior,datasets,max_full):
 url=pinned(meta['gjDownloadURL']);path=CACHE/f'{code}-full.geojson'
 req=urllib.request.Request(url,headers={'User-Agent':'LightTheEarth/1.0 public boundary build'},method='HEAD')
 with urllib.request.urlopen(req,timeout=60) as r:
  size=int(r.headers['Content-Length']);etag=r.headers.get('ETag','').strip('"')
 audit={'fullSourceUrl':url,'fullSourceBytes':size,'fullSourceETag':etag}
 if size>max_full:
  original=datasets[code];path=ROOT/f"outputs/global-geodata-cache/{code}-{c['adminLevel']}-source.geojson"
  assert common.sha(path)==original['sourceSHA256'],('Cached provider source hash changed',code)
  url=pinned(meta['simplifiedGeometryGeoJSON']);kind='provider-simplified'
  audit['selectionReason']=f'Full immutable source {size} bytes exceeds bounded batch limit {max_full}; cached provider simplified input hash matches sources-global.json.'
 else:
  kind='full'
  if not path.exists():
   # The common downloader supports its original two commits. Use its proven
   # resumable range pipeline, with a local equivalent for other pinned refs.
   if common.COMMIT in url or COMMITS['90a1d52'] in url:
    path,actual=common.download(code,c,meta,prior);assert actual==url
   else:
    tmp=path.with_suffix('.download');tmp.unlink(missing_ok=True)
    with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'LightTheEarth/1.0 public boundary build'}),timeout=180) as r, tmp.open('wb') as dest:
     while chunk:=r.read(1024*1024):dest.write(chunk)
    assert tmp.stat().st_size==size;tmp.replace(path)
  assert path.stat().st_size==size,(code,'full size mismatch')
  if re.fullmatch('[0-9a-f]{64}',etag):assert common.sha(path)==etag,(code,'public media ETag hash mismatch')
  audit['publicMediaSHA256Matches']=bool(re.fullmatch('[0-9a-f]{64}',etag))
 expected=prior.get(code,{}).get('sourceSHA256')
 if expected:assert common.sha(path)==expected,('Pinned input changed',code)
 print('SOURCE',code,kind,path.stat().st_size,flush=True)
 return path,url,kind,audit

def validate_record(code,r,coverage):
 assert re.fullmatch('[0-9a-f]{40}',r['fullSourceCommit']) and r['fullSourceCommit'] in r['sourceUrl']
 source_path=(ROOT/f"outputs/global-geodata-cache/{code}-{coverage[code]['adminLevel']}-source.geojson") if r['sourceGeometry']=='provider-simplified' else CACHE/f'{code}-full.geojson'
 assert common.sha(source_path)==r['sourceSHA256'] and source_path.stat().st_size==r['sourceBytes']
 if r.get('preparedInputSHA256'):
  assert common.sha(CACHE/f'{code}-full-with-provider-ids.geojson')==r['preparedInputSHA256']
  provider_path=ROOT/f"outputs/global-geodata-cache/{code}-{coverage[code]['adminLevel']}-source.geojson"
  assert common.sha(provider_path)==r['sourceSelection']['additionalProviderSnapshot']['sha256']
 old=common.read(ROOT/'public'/coverage[code]['localUrl'].lstrip('/'))
 old_by={f['id']:f for f in old['features']}
 fc=common.read(ROOT/'public'/r['localUrl'].lstrip('/'));by={f['id']:f for f in fc['features']}
 assert len(by)==len(fc['features'])==len(old['features'])==r['count']
 assert set(by)==set(old_by)
 geoms=[]
 for i,f in by.items():
  assert f['properties']['id']==i
  assert {k:v for k,v in f['properties'].items() if k not in ('center','bbox')}=={k:v for k,v in old_by[i]['properties'].items() if k not in ('center','bbox')}
  g=shape(f['geometry']);assert g.is_valid and not g.is_empty and g.geom_type in ('Polygon','MultiPolygon')
  assert -180<=g.bounds[0]<=g.bounds[2]<=180 and -90<=g.bounds[1]<=g.bounds[3]<=90
  assert g.covers(Point(f['properties']['center']))
  assert list(g.bounds)==f['properties']['bbox']
  geoms.append(g)
 union=unary_union(geoms);land=shape(common.read(ROOT/'public'/r['landUrl'].lstrip('/'))['features'][0]['geometry'])
 assert union.symmetric_difference(land).area<1e-9
 for kind in ['local','land','fallback','country']:
  if kind+'Url' not in r:continue
  p=ROOT/'public'/r[kind+'Url'].lstrip('/');z=ROOT/'public'/r[kind+'GzipUrl'].lstrip('/')
  assert common.sha(p)==r['sha256'][kind] and common.sha(z)==r['sha256'][kind+'Gzip']
  assert gzip.decompress(z.read_bytes())==p.read_bytes()
  assert p.stat().st_size<20_000_000 and z.stat().st_size<10_000_000
 if r.get('fallbackUrl'):
  fallback=shape(common.read(ROOT/'public'/r['fallbackUrl'].lstrip('/'))['features'][0]['geometry'])
  country=shape(common.read(ROOT/'public'/r['countryUrl'].lstrip('/'))['features'][0]['geometry'])
  assert fallback.intersection(union).area<1e-9
  assert country.symmetric_difference(unary_union([union,fallback])).area<1e-9
 assert r['vertexRatio']>=1.5
 r['checks'].update(centerInsideAllGeometries=True,exactBboxAllGeometries=True,gzipRoundtripAllAssets=True,allAssetHashesVerified=True,sourceSnapshotsHashVerified=True)

def prepare_record(code,c,meta,path,url,kind,audit,datasets):
 try:
  return common.prepare(code,c,meta,path,url),kind
 except AssertionError as exc:
  # Some upstream full/simplified exports differ in IDs. Preserve the exact
  # existing ID using its original hash-verified provider polygon; never drop
  # it or substitute another administrative unit.
  if kind!='full' or 'missing full source IDs' not in str(exc):raise
  full=common.read(path);existing=common.read(ROOT/'public'/c['localUrl'].lstrip('/'))
  missing={f['id'] for f in existing['features']}-{'GB-'+str(f['properties']['shapeID']) for f in full['features']}
  provider_path=ROOT/f"outputs/global-geodata-cache/{code}-{c['adminLevel']}-source.geojson"
  expected=datasets[code]['sourceSHA256'];assert common.sha(provider_path)==expected
  provider=common.read(provider_path);by={'GB-'+str(f['properties']['shapeID']):f for f in provider['features']}
  assert missing<=set(by)
  full['features'].extend(by[i] for i in sorted(missing))
  assembled=CACHE/f'{code}-full-with-provider-ids.geojson';common.write(assembled,full)
  r=common.prepare(code,c,meta,assembled,url)
  r.update(sourceSHA256=common.sha(path),sourceBytes=path.stat().st_size,preparedInputSHA256=common.sha(assembled))
  audit['additionalProviderSnapshot']={'url':pinned(meta['simplifiedGeometryGeoJSON']),'sha256':expected,'bytes':provider_path.stat().st_size,'preservedExistingIDs':sorted(missing),'reason':'These existing IDs are absent from the provider full export; exact original provider-simplified polygons retained.'}
  r['preparation']+=' Existing IDs absent from full export retain their hash-verified original provider-simplified geometry; input assembly hash and additional snapshot recorded.'
  return r,'full-with-provider-id-fallback'

def summary(report):
 cs=list(report['countries'].values())
 for r in cs:
  r['inputSourceVertexCount']=r.get('inputSourceVertexCount',r['fullSourceVertexCount'])
  r['sourceVertexCountMeaning']='Selected existing IDs in the exact input snapshot/assembly; for provider-simplified or mixed inputs this is not a count of independently downloaded full geometry.'
 report['sourceCommits']=sorted({r['fullSourceCommit'] for r in cs})
 report['checks']={'countries':len(cs),'totalRegions':sum(r['count'] for r in cs),'originalVertices':sum(r['originalVertexCount'] for r in cs),'vertices':sum(r['vertexCount'] for r in cs),'allIdsPreserved':all(r['checks']['sameIds'] for r in cs),'minimumVertexRatio':min((r['vertexRatio'] for r in cs),default=0),'maxDecodedLocalBytes':max((r['localBytes'] for r in cs),default=0),'maxGzipAssetBytes':max((max(r.get(k+'GzipBytes',0) for k in ['local','land','fallback','country']) for r in cs),default=0)}
 common.write(MANIFEST,report)

def main():
 ap=argparse.ArgumentParser();ap.add_argument('--codes',nargs='*',default=CODES);ap.add_argument('--download-workers',type=int,default=4);ap.add_argument('--max-full-bytes',type=int,default=180_000_000);ap.add_argument('--validate',action='store_true');args=ap.parse_args()
 CACHE.mkdir(parents=True,exist_ok=True);OUT.mkdir(parents=True,exist_ok=True)
 coverage={c['code']:c for c in common.read(DATA/'coverage.json')};catalog=common.read(DATA/'sources-global.json');datasets={d['coverage']['code']:d for d in catalog['datasets']}
 report=common.read(MANIFEST) if MANIFEST.exists() else {'version':1,'generatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'countries':{},'skips':{},'contract':'Current local level, original IDs and all properties except center/bbox preserved. localUrl is shared by borders, picking and saved local fills; landUrl is exact union; country/fallback use explicit overview-minus-local coverage.','limitations':['Historical source years preserved; geometric detail does not certify current administrative coverage.','Provider-simplified fallback is explicitly labeled and only published after measured vertex improvement >=1.5x.','Local source polygons may include water; exact local union is not an independent surveyed coastline.']}
 prior=report['countries']
 if args.validate:
  for code,r in prior.items():validate_record(code,r,coverage);print('VALID',code,flush=True)
  summary(report);return
 meta={code:next(m for m in catalog['catalog'] if m['boundaryISO']==code and m['boundaryType']==coverage[code]['adminLevel']) for code in args.codes}
 pending=[code for code in args.codes if code not in prior]
 # Write valid empty/incremental manifest before network work begins.
 summary(report)
 with concurrent.futures.ThreadPoolExecutor(max_workers=args.download_workers) as pool:
  futures={pool.submit(source,code,coverage[code],meta[code],prior,datasets,args.max_full_bytes):code for code in pending}
  for future in concurrent.futures.as_completed(futures):
   code=futures[future]
   try:
    path,url,kind,audit=future.result()
    r,kind=prepare_record(code,coverage[code],meta[code],path,url,kind,audit,datasets)
    r.update(sourceGeometry=kind,sourceSelection=audit,adminLevel=coverage[code]['adminLevel'])
    if kind=='provider-simplified':r['preparation']=r['preparation'].replace('full-source vertices','provider-simplified-source vertices');r['checks']['cachedProviderSHA256MatchesOriginalManifest']=True
    validate_record(code,r,coverage)
    prior[code]=r;report['skips'].pop(code,None)
   except Exception as exc:
    report['skips'][code]=repr(exc);print('SKIP',code,repr(exc),flush=True)
   summary(report)
 print('SUMMARY',report['checks'],'SKIPS',report['skips'],flush=True)

if __name__=='__main__':main()
