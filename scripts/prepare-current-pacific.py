#!/usr/bin/env python3
"""Pinned official 2026 Pacific local boundaries; exact common paint/border/land mesh.
Run outputs/geodata-venv/bin/python scripts/prepare-current-pacific.py.
Full official source responses and dated clipping mask are retained under ignored outputs/.
"""
import argparse, concurrent.futures, datetime, gzip, hashlib, json, pathlib, subprocess, urllib.parse, urllib.request
from shapely import make_valid, set_precision, STRtree
from shapely.geometry import shape, mapping, MultiPolygon, Point
from shapely.ops import unary_union
from pyproj import Geod
ROOT=pathlib.Path(__file__).resolve().parents[1]; DATA=ROOT/'public/data'; OUT=DATA/'precision'; CACHE=ROOT/'outputs/pacific-current-cache'
ABS_META='https://www.abs.gov.au/statistics/standards/australian-statistical-geography-standard-asgs/edition-4-july-2026-june-2031/access-and-downloads/digital-boundary-files'
NZ_META='https://datafinder.stats.govt.nz/layer/123496-territorial-authority-2026-clipped/'
ABS_API='https://geo.abs.gov.au/arcgis/rest/services/ASGS2026/LGA/MapServer/0'
NZ_API='https://services2.arcgis.com/vKb0s8tBIA3bdocZ/arcgis/rest/services/Territorial_Authority_2026/FeatureServer/0'
def read(p):return json.loads(p.read_bytes())
def enc(v):return (json.dumps(v,ensure_ascii=False,allow_nan=False,separators=(',',':'))+'\n').encode()
def write(p,v):p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(enc(v))
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def parts(g):
 if g.geom_type=='Polygon':return[g]
 return[p for c in getattr(g,'geoms',[])for p in parts(c)]
def valid(g):
 if not g.is_valid:g=make_valid(g)
 ps=parts(g)
 if not ps:return None
 r=ps[0]if len(ps)==1 else MultiPolygon(ps)
 if not r.is_valid:r=unary_union(ps)
 assert r.is_valid and not r.is_empty;return r

def asset(code,kind,fc):
 p=OUT/f'current-{code.lower()}{"-"+kind if kind!="local"else ""}.geojson';write(p,fc);z=p.with_suffix('.geojson.gz');z.write_bytes(gzip.compress(p.read_bytes(),compresslevel=9,mtime=0))
 assert p.stat().st_size<64*1024*1024 and z.stat().st_size<10_000_000,(str(p),p.stat().st_size,z.stat().st_size)
 return {kind+'Url':'/data/precision/'+p.name,kind+'GzipUrl':'/data/precision/'+z.name,kind+'Bytes':p.stat().st_size,kind+'GzipBytes':z.stat().st_size},{kind:sha(p),kind+'Gzip':sha(z)}
def fc(g,code,kind):return {'type':'FeatureCollection','features':[{'type':'Feature','id':f'current-{kind}-{code}','properties':{'countryCode':code,'level':'source','source':('Official 2026 non-LGA unincorporated areas and explicitly identified remote overview land'if code=='AUS'else'Dated 2021 physical-land mask outside current 2026 authority union plus disjoint Natural Earth remote islands, including Tokelau dependency; no authority identity assigned')if kind=='fallback'else'Exact current local polygon union'if kind=='land'else'Exact current local union plus explicit neutral land fallback','pickableLocal':False},'geometry':mapping(g)}]}
def download(url,p):
 if not p.exists():p.write_bytes(urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'LightTheEarth geodata preparation'}),timeout=240).read())
 return read(p)
def queryurl(base,where='1=1'):return base+'/query?'+urllib.parse.urlencode({'where':where,'outFields':'*','outSR':4326,'f':'geojson','resultRecordCount':2000})
def source(code):
 base=ABS_API if code=='AUS'else NZ_API;p=CACHE/(code.lower()+'-source.geojson')
 if code=='NZL':
  item=download('https://www.arcgis.com/sharing/rest/content/items/b7f8726da7f6467a9cb42221b0013938?f=json',CACHE/'nzl-arcgis-item.json');assert item['owner']=='StatsNZGeospatial'
  if not p.exists():
   def page(i):
    u=queryurl(base,f'OBJECTID >= {i} AND OBJECTID < {i+10}');j=download(u,CACHE/f'nzl-source-page-{i}.geojson');assert 'features'in j and not j.get('exceededTransferLimit');return j['features']
   with concurrent.futures.ThreadPoolExecutor(max_workers=4)as pool:fs=[f for rows in pool.map(page,range(1,69,10))for f in rows]
   write(p,{'type':'FeatureCollection','features':fs})
 j=download(queryurl(base),p);assert len(j['features'])==(567 if code=='AUS'else 68)and not j.get('exceededTransferLimit');return j,p,queryurl(base)
def controles(g,code):
 checks={'Moreton Bay':([153.3,-27.2],False),'Sydney offshore':([151.5,-33.9],False),'Bass Strait':([146,-39.5],False),'Sydney':([151.21,-33.87],True)}if code=='AUS'else{'Cook Strait':([174.5,-41.2],False),'Hauraki Gulf':([175,-36.6],False),'Foveaux Strait':([168,-46.7],False),'Wellington':([174.777,-41.29],True),'Auckland':([174.763,-36.849],True),'Christchurch':([172.636,-43.531],True),'South Island':([171,-44],True)}
 result={k:{'point':p,'expectedLand':e,'actualLand':g.covers(Point(p))}for k,(p,e)in checks.items()};assert all(r['expectedLand']==r['actualLand']for r in result.values());return result

def prepare(code):
 original,src,url=source(code); isaus=code=='AUS';codefield='LGA_CODE_2026'if isaus else'TA2026_V1_00';namefield='LGA_NAME_2026'if isaus else'TA2026_V1_00_NAME'
 nongeographic=[f['properties'][namefield]for f in original['features']if not f['geometry']]
 selected=[f for f in original['features']if f['geometry']and(isaus or f['properties'][codefield]!='999')]
 assert len(selected)==(548 if isaus else 67)
 infile=CACHE/(code.lower()+'-topology-input.geojson');candidate=CACHE/(code.lower()+'-topology.geojson');write(infile,{'type':'FeatureCollection','features':selected})
 fields=namefield if isaus else namefield+','+namefield+'_ASCII'
 subprocess.run(['npx','--yes','mapshaper@0.7.95',str(infile),'-explode','-simplify','dp','interval=20m','keep-shapes','-dissolve',codefield,'copy-fields='+fields,'-o','force','precision=0.000001',str(candidate)],check=True)

 current=read(candidate);mask=None
 source_parts=sum(len(parts(shape(f['geometry'])))for f in selected);display_parts=sum(len(parts(shape(f['geometry'])))for f in current['features']);assert source_parts==display_parts,(code,source_parts,display_parts)
 if not isaus:
  maskpath=DATA/'precision/nzl-land.geojson';mask=set_precision(valid(shape(read(maskpath)['features'][0]['geometry'])),1e-6);assert mask is not None;controles(mask,code)
 rows=[];fallback_geoms=[]
 for f in current['features']:
  p=f['properties'];g=set_precision(valid(shape(f['geometry'])),1e-6)
  if mask is not None:g=valid(g.intersection(mask))
  assert g is not None,(code,p[codefield])
  if isaus and p[namefield].startswith('Unincorporated'):
   fallback_geoms.append(shape(mapping(g)));continue
  rows.append((str(p[codefield]),p[namefield],p,g))
 rows.sort(key=lambda r:r[0]);geoms=[shape(mapping(r[3]))for r in rows];full=valid(unary_union(geoms));repairs=[];tree=STRtree(geoms)
 for i,g in enumerate(geoms):
  prior=[geoms[int(j)]for j in tree.query(g)if j<i and g.intersection(geoms[int(j)]).area>1e-14]
  if prior:
   overlap=g.intersection(unary_union(prior)).area;g=valid(g.difference(unary_union(prior)));assert g is not None;geoms[i]=g;repairs.append({'officialCode':rows[i][0],'overlapRemovedDeg2':overlap})
 fs=[]
 for (cid,name,p,_),g in zip(rows,geoms):
  q=max(parts(g),key=lambda x:x.area).representative_point();ident=f'{code}-'+('LGA'if isaus else'TA')+'-2026-'+cid
  props={'id':ident,'name':name,'originalName':name,'aliases':[]if isaus else[p[namefield+'_ASCII']]if p.get(namefield+'_ASCII')and p[namefield+'_ASCII']!=name else[],'countryCode':code,'countryName':'澳大利亚'if isaus else'新西兰','level':'local','adminLevel':'ADM2','adminType':'Local Government Area'if isaus else'Territorial Authority','center':[q.x,q.y],'bbox':list(g.bounds),'source':'Australian Bureau of Statistics · ASGS Edition 4 LGA 2026'if isaus else'Stats NZ · Territorial Authority 2026 HD; 2021 physical-land coast clip','year':'2026','officialCode':cid,'boundaryVersion':'2026','coastlineYear':'2026 LGA / unincorporated; 2022 remote overview fallback'if isaus else'2021 physical mask; 2022 remote overview fallback'}
  fs.append({'type':'Feature','id':ident,'properties':props,'geometry':mapping(g)})
 assert len(fs)==(542 if isaus else 67)
 # Materialize ordinary doubles before overlays: GEOS fixed precision must not snap a separately decoded land edge.
 land=valid(unary_union(geoms));fallback=valid(unary_union(fallback_geoms).difference(land))if isaus else valid(shape(mapping(mask)).difference(land))
 worlds=[f for f in read(DATA/'world.geojson')['features']if f['properties']['countryCode']==code]
 separate=[f for f in read(DATA/'world.geojson')['features']if isaus and f['properties']['countryCode']in['NFK','HMD']]
 excluded=[]
 if isaus and fallback is not None:
  keep=[]
  for p in parts(fallback):
   owner=next((f for f in separate if p.intersects(shape(f['geometry']).envelope.buffer(0.05))),None)
   if owner:excluded.append({'retainedSeparateCountryCode':owner['properties']['countryCode'],'worldId':owner['id'],'bounds':list(p.bounds),'removedAreaDeg2':p.area,'reason':'Whole remote source component retained in existing separate world territory; no coarse coastline clipping'})
   else:keep.append(p)
  fallback=valid(unary_union(keep))
 # Keep whole remote overview islands only when disjoint from physical source land.
 # Coarse coastline differences on covered islands never become fallback slivers.
 physical_base=valid(unary_union([land,fallback]))if fallback is not None else land
 remotes=[p for f in worlds for p in parts(shape(f['geometry']))if p.intersection(physical_base).area<1e-12]
 if remotes:
  extra=valid(unary_union(remotes).difference(physical_base))
  if extra is not None:fallback=valid(unary_union([fallback,extra]))if fallback is not None else extra
 country=valid(unary_union([land,fallback]))if fallback is not None else land
 physical=controles(country,code);area=abs(Geod(ellps='WGS84').geometry_area_perimeter(country)[0])/1e6
 assert (7_600_000<area<7_800_000)if isaus else(265_000<area<270_000)
 metaurl=ABS_META if isaus else'https://www.arcgis.com/home/item.html?id=b7f8726da7f6467a9cb42221b0013938';licenseurl='https://www.abs.gov.au/website-privacy-copyright-and-disclaimer#copyright-and-creative-commons'if isaus else'https://datafinder.stats.govt.nz/license/attribution-4-0-international/'
 alignment={'legacyPaintUrl':f'/data/precision/{code.lower()}.geojson','legacyPaintGzipUrl':f'/data/precision/{code.lower()}.geojson.gz','count':len(fs),'renderCount':len(fs),'suppressedIds':[],'legacyAliases':{},'sourceUrl':metaurl,'downloadUrl':url,'sourceSHA256':sha(src),'sourceBytes':src.stat().st_size,'sourceYear':'2026','sourceGeometry':'official full HD, shared-arc display simplification, exact common mesh','source':fs[0]['properties']['source'],'license':'Creative Commons Attribution 4.0 International (CC BY 4.0)','licenseUrl':licenseurl,'attribution':'© Commonwealth of Australia, Australian Bureau of Statistics, CC BY 4.0'if isaus else'© Stats NZ, CC BY 4.0; 2021 coastline mask: geoBoundaries / William & Mary geoLab, CC BY 4.0','sha256':{},'preparation':'Shared mapshaper@0.7.95 arc topology; explode island components, Douglas-Peucker 20m 3D distance threshold with keep-shapes, dissolve to original official code; 1e-6-degree output precision; exact local union; neutral nonlocal fallback excluded from selectable authorities.','worldIds':[f['id']for f in worlds],'replaceWorldIds':[f['id']for f in worlds],'retainedWorldIds':[],'partialOverviewCoverage':True,'fallbackWorldIds':[f['id']for f in worlds]}
 for kind,obj in [('local',{'type':'FeatureCollection','features':fs}),('land',fc(land,code,'land')),('fallback',fc(fallback,code,'fallback')),('country',fc(country,code,'country'))]:
  fields,hashes=asset(code,kind,obj);alignment.update(fields);alignment['sha256'].update(hashes)
 # Decode each independently from the distributed gzip before checking geometry contract.
 decoded={}
 for kind in ['local','land','fallback','country']:
  gz=ROOT/'public'/alignment[kind+'GzipUrl'].lstrip('/');raw=ROOT/'public'/alignment[kind+'Url'].lstrip('/');b=gzip.decompress(gz.read_bytes());assert b==raw.read_bytes();assert sha(raw)==alignment['sha256'][kind]and sha(gz)==alignment['sha256'][kind+'Gzip'];decoded[kind]=json.loads(b)
 gs=[shape(f['geometry'])for f in decoded['local']['features']];tree=STRtree(gs);maxoverlap=0
 for i,g in enumerate(gs):
  assert g.is_valid and not g.is_empty and g.covers(Point(decoded['local']['features'][i]['properties']['center']))
  for j in tree.query(g):
   if j>i:maxoverlap=max(maxoverlap,g.intersection(gs[int(j)]).area)
 assert maxoverlap<=1e-14,maxoverlap
 lu=unary_union(gs);dg={k:shape(decoded[k]['features'][0]['geometry'])for k in ['land','fallback','country']};assert all(g.is_valid and not g.is_empty for g in dg.values());ld=dg['land'].symmetric_difference(lu).area;cd=dg['country'].symmetric_difference(unary_union([dg['land'],dg['fallback']])).area;ov=dg['land'].intersection(dg['fallback']).area;assert ld==0 and cd==0 and ov<=1e-14,(ld,cd,ov)
 assert all(dg['country'].intersection(shape(f['geometry'])).area<=1e-14 for f in separate)
 old=read(DATA/'precision-countries.json')['countries'][code];oldids={f['id']for f in read(DATA/'precision'/f'{code.lower()}.geojson')['features']};assert not oldids.intersection(f['id']for f in fs)
 note='2026 ABS 现行542个LGA；另6个未建制地区使用中性国土后备层，均不作为LGA点选；LGA海岸来自2026官方边界，少量遥远岛屿保留2022概览国土后备层。'if isaus else'2026-01-01 Stats NZ 现行67个territorial authorities（含Chatham Islands）；2021物理陆地掩膜裁剪海岸；999域外区域为中性后备层。'
 coverage={'code':code,'sourceISO':code,'name':'澳大利亚'if isaus else'新西兰','localUrl':alignment['localUrl'],'localGzipUrl':alignment['localGzipUrl'],'paintUrl':alignment['localUrl'],'paintGzipUrl':alignment['localGzipUrl'],'count':len(fs),'adminLevel':'ADM2','label':'地方政府区（LGA）'if isaus else'市／区（Territorial Authorities）','canonical':'Local Government Areas'if isaus else'Territorial Authorities','year':'2026','source':alignment['source'],'sourceUrl':metaurl,'downloadUrl':url,'license':alignment['license'],'licenseUrl':licenseurl,'coverageNote':note,'note':note,'center':fs[max(range(len(fs)),key=lambda i:geoms[i].area)]['properties']['center'],'bbox':list(country.bounds),'detailTier':'local','bytes':alignment['localBytes']}
 checks={'sourcePolygonComponentCount':source_parts,'displayPolygonComponentCountBeforeCoastClip':display_parts,'noIslandComponentLossDuringSimplification':True,'independentlyDecodedGzipAssets':True,'gzipRoundtripAllAssets':True,'allAssetHashesVerified':True,'validNonemptyGeometries':True,'centerInsideAllGeometries':True,'noCurrentLocalOverlap':True,'maxPairwiseOverlapAreaDeg2':maxoverlap,'landSymmetricDifferenceAreaDeg2':ld,'countryUnionDifferenceAreaDeg2':cd,'fallbackLocalOverlapAreaDeg2':ov,'sourceOverlapRepairs':repairs,'sourcePartitionUnionDifferenceAreaDeg2':land.symmetric_difference(full).area,'oldIdsRemainHistorical':True,'separateTerritoryOverlapAreaDeg2':{f['properties']['countryCode']:dg['country'].intersection(shape(f['geometry'])).area for f in separate},'separateTerritoryComponentsExcluded':excluded,'physicalLandControlPoints':physical,'physicalLandGeodeticAreaKm2':area}
 evidence={'referenceDate':'2026-10-14'if isaus else'2026-01-01','publishedAt':'2026-10-14'if isaus else datetime.datetime.fromtimestamp(read(CACHE/'nzl-arcgis-item.json')['created']/1000,datetime.timezone.utc).isoformat(),'sourceMetadataUrl':metaurl,'downloadUrl':url,'source':alignment['source'],'license':alignment['license'],'licenseUrl':licenseurl,'rawSourceSHA256':sha(src),'rawSourceBytes':src.stat().st_size,'sourceRetrievalMode':'Original official full-country response; supplemental public API response pages retained where available','nongeographicRowsOmitted':nongeographic,'neutralFallbackOfficialCodes':['19399','29399','49399','79399','89399','99399']if isaus else['999'],'coastlineYear':'2026 LGA / unincorporated; 2022 remote overview fallback'if isaus else'2021 physical mask; 2022 remote overview fallback'}
 limitations=['ABS LGA polygons are official statistical Mesh Block approximations of gazetted boundaries, not legal survey boundaries.','Six unincorporated areas and remote overview islands remain neutral nonlocal land; no synthetic LGA identity. Norfolk source components excluded from AUS fallback to preserve the existing separate NFK world classification; HMD also remains separate.','Shared-topology Douglas-Peucker 20m target with each island protected before dissolve; all 542 actual LGA retained; full official geometry archived under outputs/pacific-current-cache.']if isaus else['Administrative identities and boundaries reference 2026-01-01; physical coastline clip references 2021 and can omit later reclamation. No 2026 surveyed coastline claim.','2026 coastline-clipped HD layer 123496 and 2026-09-30 LINZ coastline metadata verified, but public export/WFS data endpoints required credentials; no credentials used.','2021 coastline mask verified at 267,913 km² and Cook Strait, Hauraki Gulf and Foveaux Strait water controls; 67 actual authorities remain selectable, 999 and coastal differences remain neutral land fallback. Disjoint remote overview islands, including Tokelau dependency already present in country overview, retain neutral land only.','Shared-topology Douglas-Peucker 20m target with each island protected before dissolve; original full 2026 authority geometry archived.']
 if not isaus:evidence.update(coastlineSourceUrl=old['sourceUrl'],coastlineMetadataUrl='https://datafinder.stats.govt.nz/layer/105153-territorial-authority-2021-generalised/',coastlineSHA256=sha(DATA/'precision/nzl-land.geojson'),availableCurrentCoastlineMetadataUrls=[NZ_META,'https://data.linz.govt.nz/layer/51153-nz-coastlines-and-islands-polygons-topo-150k/'])
 evidence.update(remoteFallbackSource='Natural Earth 1:50m world.geojson disjoint whole offshore-island components only; no authority IDs',remoteFallbackSHA256=sha(DATA/'world.geojson'))
 return {'alignment':alignment,'coverage':coverage,'sourceEvidence':evidence,'audit':{'oldCount':old['count'],'oldYear':old['sourceYear'],'currentCount':len(fs),'currentReferenceDate':evidence['referenceDate'],'levelChange':'548 official 2026 geographic categories split into 542 actual LGAs and 6 neutral unincorporated areas'if isaus else'Prior 88 advertised ADM2 polygons include finer subdivisions; current layer uses 67 actual territorial authorities, including one Auckland Council and Chatham Islands Council. Count reduction is not presented as 21 recent mergers.','officialGeographicRowCount':548 if isaus else 68,'neutralFallbackCount':6 if isaus else 1,'neutralRemoteOverviewComponents':len(remotes),'identityPolicy':'New stable versioned official-code IDs, no automatic historical visit migration; exact old primary URL retained as historical asset.','inputFiles':[{'path':str(p.relative_to(ROOT)),'sha256':sha(p),'bytes':p.stat().st_size}for p in [src,*sorted(CACHE.glob('nzl-source-page-*.geojson'))]if not isaus or p==src],'checks':checks},'limitations':limitations}
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--codes',nargs='*',default=['AUS','NZL']);args=ap.parse_args();CACHE.mkdir(parents=True,exist_ok=True);p=DATA/'current-pacific.json';m=read(p)if p.exists()else{'version':1,'countries':{},'contract':'localUrl is the same primary county/city mesh for picking, borders and paint; landUrl exactly equals its union. Country equals land plus explicit neutral nonlocal fallback. Official-code versioned current IDs never migrate historical visits.'}
 for code in args.codes:
  m['countries'][code]=prepare(code);m['generatedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat();write(p,m);write(ROOT/'outputs/pacific-current-audit.json',m);print('DONE',code,m['countries'][code]['coverage']['count'],m['countries'][code]['audit']['checks'],flush=True)
if __name__=='__main__':main()
