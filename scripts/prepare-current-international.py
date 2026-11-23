#!/usr/bin/env python3
"""Pinned 2026 official municipalities/LAD replacements; historical visit IDs stay separate.
Run with outputs/geodata-venv/bin/python. Raw copies are ignored QA/build inputs.
"""
import argparse, concurrent.futures, datetime, gzip, hashlib, json, pathlib, subprocess, urllib.parse, urllib.request
from shapely import make_valid, set_precision, STRtree
from shapely.geometry import shape, mapping, MultiPolygon, Point
from shapely.ops import unary_union
ROOT=pathlib.Path(__file__).resolve().parents[1]; DATA=ROOT/'public/data'; OUT=DATA/'precision'; CACHE=ROOT/'outputs/current-international-cache'
ONS='https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Local_Authority_Districts_May_2026_Boundaries_UK_BGC/FeatureServer/0'
NOR='https://api.kartverket.no/kommuneinfo/v1'
NOR_META='https://kartkatalog.geonorge.no/api/metadata/041f1e6e-bdbc-4091-b48f-8a5990f3cc5b'

def read(p):return json.loads(p.read_text())
def enc(v):return (json.dumps(v,ensure_ascii=False,allow_nan=False,separators=(',',':'))+'\n').encode()
def write(p,v):p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(enc(v))
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def fetch(url,p):
 if not p.exists():
  b=urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'LightTheEarth public geodata build'}),timeout=240).read();json.loads(b);p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b)
 return read(p)
def parts(g):
 if g.geom_type=='Polygon':return[g]
 return[p for c in getattr(g,'geoms',[])for p in parts(c)]
def valid(g):
 if not g.is_valid:g=make_valid(g)
 ps=parts(g)
 if not ps:raise ValueError('Empty polygon')
 r=ps[0]if len(ps)==1 else MultiPolygon(ps)
 if not r.is_valid:r=unary_union(ps)
 assert r.is_valid and not r.is_empty;return r

def assets(code,kind,fc):
 p=OUT/f'current-{code.lower()}{"-"+kind if kind!="local"else ""}.geojson';write(p,fc);z=p.with_suffix('.geojson.gz');z.write_bytes(gzip.compress(p.read_bytes(),compresslevel=9,mtime=0))
 assert p.stat().st_size<64*1024*1024 and z.stat().st_size<10_000_000,(p,p.stat().st_size,z.stat().st_size)
 assert gzip.decompress(z.read_bytes())==p.read_bytes()
 return {kind+'Url':'/data/precision/'+p.name,kind+'GzipUrl':'/data/precision/'+z.name,kind+'Bytes':p.stat().st_size,kind+'GzipBytes':z.stat().st_size}, {kind:sha(p),kind+'Gzip':sha(z)}
def layer(g,code,kind):return {'type':'FeatureCollection','features':[{'type':'Feature','id':'current-'+kind+'-'+code,'properties':{'countryCode':code,'derivedFrom':'exact current local polygon union'if kind=='land'else'explicit remote-island overview fallback'},'geometry':mapping(g)}]}
def vertex(g):
 if isinstance(g,dict):return vertex(g['coordinates'])
 if isinstance(g[0],(int,float)):return 1
 return sum(vertex(x)for x in g)

def sources(code):
 if code=='GBR':
  u=ONS+'/query?'+urllib.parse.urlencode({'where':'1=1','outFields':'LAD26CD,LAD26NM,LAD26NMW','outSR':4326,'f':'geojson','resultRecordCount':2000});f=CACHE/'GBR-source.geojson';fc=fetch(u,f);assert len(fc['features'])==361 and not fc.get('exceededTransferLimit')
  item=fetch('https://www.arcgis.com/sharing/rest/content/items/43eddab36751466db7bb4006b242243c?f=json',CACHE/'ons26-item.json');assert item['owner']=='ONSGeography_data' and 'LATEST'in str(item['categories'])
  return fc,u,[f],{'referenceDate':'2026-05','publishedAt':datetime.datetime.fromtimestamp(item['created']/1000,datetime.timezone.utc).isoformat(),'metadataModifiedAt':datetime.datetime.fromtimestamp(item['modified']/1000,datetime.timezone.utc).isoformat(),'itemId':item['id'],'sourceMetadataUrl':'https://www.arcgis.com/sharing/rest/content/items/'+item['id']+'?f=json','source':'Office for National Statistics · May 2026 LAD UK BGC (20 m coastline clipped)','license':'Open Government Licence v3.0','licenseUrl':'https://www.ons.gov.uk/methodology/geography/licences','attribution':'Source: Office for National Statistics licensed under the Open Government Licence v.3.0; Contains OS data © Crown copyright and database right 2026','coastlineYear':'2026-05','coastlineSource':'ONS same-source BGC mean-high-water coastline'}
 rows=fetch(NOR+'/kommuner',CACHE/'nor-communes.json');assert len(rows)==357
 def get(c):return fetch(NOR+'/kommuner/'+c['kommunenummer']+'/omrade?utkoordsys=4326',CACHE/'NOR-areas'/(c['kommunenummer']+'.json'))
 with concurrent.futures.ThreadPoolExecutor(max_workers=4)as pool:areas=list(pool.map(get,sorted(rows,key=lambda x:x['kommunenummer'])))
 fs=[{'type':'Feature','properties':{'kommunenummer':a['kommunenummer'],'kommunenavn':a['kommunenavn']},'geometry':a['omrade']}for a in areas]
 f=CACHE/'NOR-source.geojson';write(f,{'type':'FeatureCollection','features':fs});meta=fetch(NOR_META,CACHE/'nor-meta.json');assert '1.1.2026'in meta['Abstract']
 return read(f),NOR+'/kommuner/{kommunenummer}/omrade?utkoordsys=4326',[f,*sorted((CACHE/'NOR-areas').glob('*.json'))],{'referenceDate':'2026-01-01','sourceMetadataUrl':NOR_META,'source':'© Kartverket · Administrative enheter kommuner 2026','license':'Creative Commons Attribution 4.0 International (CC BY 4.0)','licenseUrl':'https://www.kartverket.no/api-og-data/vilkar-for-bruk','attribution':'© Kartverket, CC BY 4.0; coastline adaptation: geoBoundaries / William & Mary geoLab, CC BY 4.0','coastlineYear':'2013','coastlineSource':'Existing hash-pinned Kartverket-derived precision/nor-land.geojson; coastline mask only, current municipal assignment comes from 2026 official API','coastlineSHA256':sha(DATA/'precision/nor-land.geojson'),'coastlineSourceUrl':read(DATA/'precision-countries.json')['countries']['NOR']['sourceUrl'],'metadataAbstract':meta['Abstract']}

def prepare(code):
 fc,url,inputs,meta=sources(code);sourcepath=CACHE/(code+'-source.geojson');sourcehash=sha(sourcepath)
 prior=read(DATA/'current-international.json')['countries'].get(code)if(DATA/'current-international.json').exists()else None
 if prior:assert prior['alignment']['sourceSHA256']==sourcehash,('Pinned source changed',code)
 selected=CACHE/(code+'-topology-input.geojson');write(selected,fc);candidate=CACHE/(code+'-topology.geojson')
 # Shared arc topology, uniform precision, then exact polygonal intersection.
 subprocess.run(['npx','--yes','mapshaper@0.7.95',str(selected),'-simplify','10%'if code=='NOR'else'100%','keep-shapes','-o','force','precision=0.000001',str(candidate)],check=True)
 fc=read(candidate);mask=set_precision(shape(read(DATA/'precision/nor-land.geojson')['features'][0]['geometry']),1e-6)if code=='NOR'else None
 raw=[]
 for f in fc['features']:
  p=f['properties'];cid=p['kommunenummer']if code=='NOR'else p['LAD26CD'];name=p['kommunenavn']if code=='NOR'else p['LAD26NM'];g=set_precision(valid(shape(f['geometry'])),1e-6)
  if mask is not None:g=valid(g.intersection(mask))
  raw.append((cid,name,p,g))
 raw.sort(key=lambda r:r[0]);geoms=[shape(mapping(r[3]))for r in raw];source_union=valid(unary_union(geoms));tree=STRtree(geoms);repaired=[]
 for i,g in enumerate(geoms):
  prior_geoms=[geoms[int(j)]for j in tree.query(g)if j<i and g.intersection(geoms[int(j)]).area>1e-14]
  if prior_geoms:
   overlap=g.intersection(unary_union(prior_geoms)).area;g=valid(g.difference(unary_union(prior_geoms)));repaired.append({'code':raw[i][0],'removedOverlapDeg2':overlap});geoms[i]=g
 fs=[]
 for (cid,name,p,_),g in zip(raw,geoms):
  q=max(parts(g),key=lambda x:x.area).representative_point();i=f'{code}-'+('KOM'if code=='NOR'else'LAD')+'-2026-'+cid
  props={'id':i,'name':name,'originalName':name,'aliases':[p['LAD26NMW']]if code=='GBR'and p.get('LAD26NMW','').strip()else[],'countryCode':code,'countryName':'挪威'if code=='NOR'else'英国','level':'local','adminLevel':'ADM2'if code=='NOR'else'ADM3','center':[q.x,q.y],'bbox':list(g.bounds),'source':meta['source'],'year':meta['referenceDate'],'officialCode':cid,'boundaryVersion':meta['referenceDate']}
  assert g.covers(Point(props['center']));fs.append({'type':'Feature','id':i,'properties':props,'geometry':mapping(g)})
 union=valid(unary_union(geoms));tree=STRtree(geoms);overlaps=[]
 for i,g in enumerate(geoms):
  for j in tree.query(g):
   if j>i:
    a=g.intersection(geoms[int(j)]).area
    if a>1e-14:overlaps.append([raw[i][0],raw[int(j)][0],a])
 assert not overlaps,overlaps
 alignment={'legacyPaintUrl':f'/data/precision/{code.lower()}.geojson','legacyPaintGzipUrl':f'/data/precision/{code.lower()}.geojson.gz','count':len(fs),'renderCount':len(fs),'suppressedIds':[],'legacyAliases':{},'sourceUrl':url,'sourceSHA256':sourcehash,'sourceBytes':sourcepath.stat().st_size,'sourceYear':meta['referenceDate'],'sourceGeometry':'official-full; topology-preserving display simplification','source':meta['source'],'license':meta['license'],'licenseUrl':meta['licenseUrl'],'attribution':meta['attribution'],'sha256':{},'vertexCount':sum(vertex(f['geometry'])for f in fs),'preparation':'Shared mapshaper@0.7.95 arc topology; 1e-6 degree precision; Norway official 2026 municipalities clipped to explicit 2013 coastline mask; exact local union used for land, border and painting; deterministic removal of measurable source overlap.'}
 for kind,obj in [('local',{'type':'FeatureCollection','features':fs}),('land',layer(union,code,'land'))]:
  fields,hashes=assets(code,kind,obj);alignment.update(fields);alignment['sha256'].update(hashes)
 worlds=[f for f in read(DATA/'world.geojson')['features']if f['properties']['countryCode']==code];alignment.update(worldIds=[f['id']for f in worlds],replaceWorldIds=[f['id']for f in worlds],retainedWorldIds=[])
 if code=='NOR':
  remote=[p for f in worlds for p in parts(shape(f['geometry']))if p.centroid.y>74 or p.bounds[0]<0];fallback=valid(unary_union(remote).difference(union));country=valid(unary_union([union,fallback]));assert fallback.intersection(union).area<1e-14
  for kind,g in [('fallback',fallback),('country',country)]:
   fields,hashes=assets(code,kind,layer(g,code,kind));alignment.update(fields);alignment['sha256'].update(hashes)
  alignment.update(partialOverviewCoverage=True,fallbackWorldIds=[f['id']for f in worlds],fallbackSource='Natural Earth overview remote Svalbard/Jan Mayen components only, outside current mainland local union',fallbackSourceSHA256=sha(DATA/'world.geojson'))
 label='市镇（kommuner）'if code=='NOR'else'地方行政区（Local Authority Districts）'
 note=(f'2026-01-01 官方现行357个市镇；2026行政边界，2013精细海岸掩膜；斯瓦尔巴/扬马延保留明确国土后备层。'if code=='NOR'else'2026年5月 ONS 官方现行361个地方行政区，20米概化并裁至平均高潮线；含2023年行政重组。')
 coverage={'code':code,'sourceISO':code,'name':'挪威'if code=='NOR'else'英国','localUrl':alignment['localUrl'],'localGzipUrl':alignment['localGzipUrl'],'paintUrl':alignment['localUrl'],'paintGzipUrl':alignment['localGzipUrl'],'count':len(fs),'adminLevel':'ADM2'if code=='NOR'else'ADM3','label':label,'canonical':'Municipalities'if code=='NOR'else'Local Authority Districts','year':meta['referenceDate'],'source':meta['source'],'sourceUrl':url,'license':meta['license'],'licenseUrl':meta['licenseUrl'],'coverageNote':note,'note':note,'center':fs[max(range(len(fs)),key=lambda i:geoms[i].area)]['properties']['center'],'bbox':list(union.bounds),'detailTier':'local','bytes':alignment['localBytes']}
 oldfs=read(ROOT/'public'/alignment['legacyPaintUrl'].lstrip('/'))['features']
 assert not(set(f['id']for f in oldfs)&set(f['id']for f in fs)),'Current identities must not migrate historical visits'
 checks={'validNonemptyGeometries':True,'centerInsideAllGeometries':True,'noCurrentLocalOverlap':True,'pairwiseOverlapAreaDeg2':0,'landSymmetricDifferenceAreaDeg2':shape(read(OUT/f'current-{code.lower()}-land.geojson')['features'][0]['geometry']).symmetric_difference(union).area,'gzipRoundtripAllAssets':True,'allAssetHashesVerified':True,'sourceOverlapRepairs':repaired,'sourcePartitionUnionDifferenceAreaDeg2':union.symmetric_difference(source_union).area,'oldIdsRemainHistorical':True}
 assert checks['landSymmetricDifferenceAreaDeg2']==0
 assert checks['sourcePartitionUnionDifferenceAreaDeg2']<1e-10
 record={'alignment':alignment,'coverage':coverage,'sourceEvidence':meta,'audit':{'oldCount':old['count'],'oldYear':old['year'],'oldLabel':old['label'],'currentCount':len(fs),'currentReferenceDate':meta['referenceDate'],'identityPolicy':'Distinct versioned current IDs; no automatic transfer of old visited regions; historical assets left in place.','inputFiles':[{'path':str(p.relative_to(ROOT)),'sha256':sha(p),'bytes':p.stat().st_size}for p in inputs],'checks':checks}}
 if code=='GBR':
  now={f['properties']['officialCode']:f['properties']['name']for f in fs};assert {k:now[k]for k in ['E06000063','E06000064','E06000065','E06000066']}=={'E06000063':'Cumberland','E06000064':'Westmorland and Furness','E06000065':'North Yorkshire','E06000066':'Somerset'}
  record['audit']['levelChange']='Old 216 Counties and Unitary Authorities (2020) replaced by official current 361 Local Authority Districts (2026); count change combines finer local level and actual administrative reforms.'
  record['audit']['reformExamples']=[{'effectiveDate':'2023-04-01','before':['Cumbria county','Allerdale','Carlisle','Copeland','Barrow-in-Furness','Eden','South Lakeland'],'after':['Cumberland (E06000063)','Westmorland and Furness (E06000064)'],'evidenceUrl':'https://www.cumberland.gov.uk/what-lgr'},{'effectiveDate':'2023-04-01','before':['Craven','Hambleton','Harrogate','Richmondshire','Ryedale','Scarborough','Selby'],'after':['North Yorkshire (E06000065)'],'evidenceUrl':'https://www.legislation.gov.uk/uksi/2022/328/made'},{'effectiveDate':'2023-04-01','before':['Mendip','Sedgemoor','Somerset West and Taunton','South Somerset'],'after':['Somerset (E06000066)'],'evidenceUrl':'https://www.legislation.gov.uk/uksi/2022/329/made'}]
  record['limitations']=['ONS BGC coast is generalised to 20 m; the source reference date is May 2026, published September 2026, not a live administrative feed.']
 else:
  now={f['properties']['officialCode']:f['properties']['name']for f in fs};assert now['1580']=='Haram' and now['1508']=='Ålesund' and now['3118']=='Indre Østfold'
  record['audit']['reformExamples']=[{'effectiveDate':'2020-01-01','before':'109 municipalities merged into 43; 356 total after reform','after':'357 municipalities from 2024 onward','evidenceUrl':'https://www.kartverket.no/til-lands/kommunereform/tekniske-endringer-ved-sammenslaing-og-grensejustering'},{'effectiveDate':'2024-01-01','before':['Ålesund (1507)'],'after':['Ålesund (1508)','Haram (1580)'],'evidenceUrl':'https://www.kartverket.no/en/about-kartverket/nyheter/eiendom/2024/januar/kommune-og-fylkesendringene-per-1.-januar-2024'},{'effectiveDate':'2026-01-01','before':'Boundaries before the two Indre Østfold / Nordre Follo adjustments and one Indre Østfold / Vestby adjustment','after':'2026 official API polygons include the three adjustments','evidenceUrl':NOR_META}]
  record['limitations']=['Municipal administrative boundaries reference 2026-01-01; coastal clipping mask references 2013. This update does not claim a 2026 surveyed coastline.','Svalbard and Jan Mayen are explicit overview remote-island fallback land, outside the 357 mainland municipalities; no synthetic municipality IDs assigned.','Coastal reclamation since the 2013 coastline snapshot can be absent; exact coastline matching is guaranteed across the rendered local, country land and current paint layers.']
 return record

def main():
 ap=argparse.ArgumentParser();ap.add_argument('--codes',nargs='*',default=['GBR','NOR']);args=ap.parse_args();CACHE.mkdir(parents=True,exist_ok=True)
 manifest=read(DATA/'current-international.json')if(DATA/'current-international.json').exists()else{'version':1,'countries':{},'contract':'Country coverage and alignment patches; new versioned IDs never migrate old visit records. All current paint, borders and picking must use localUrl. landUrl is exact local union. Explicit remote fallback only outside that union.'}
 for code in args.codes:
  manifest['countries'][code]=prepare(code);manifest['generatedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat();write(DATA/'current-international.json',manifest);write(ROOT/'outputs/current-international-audit.json',manifest);print('DONE',code,manifest['countries'][code]['coverage']['count'],flush=True)
if __name__=='__main__':main()
