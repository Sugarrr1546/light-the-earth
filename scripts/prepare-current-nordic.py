#!/usr/bin/env python3
"""Pinned official Finland current municipalities, with transparent dated physical coast.
Run outputs/geodata-venv/bin/python scripts/prepare-current-nordic.py.
Source snapshot 2026-10-29: NLS INSPIRE AU WFS, Stats Finland 2026 classification.
Only FIN mainland current 292 municipalities are published; ALA keeps its independent layer.
"""
import datetime,gzip,hashlib,json,pathlib,subprocess,urllib.parse,urllib.request,concurrent.futures
from shapely import STRtree,make_valid,set_precision,get_num_coordinates
from shapely.geometry import shape,mapping,Point,MultiPolygon
from shapely.ops import unary_union,transform
from pyproj import Transformer,Geod
ROOT=pathlib.Path(__file__).resolve().parents[1];DATA=ROOT/'public/data';OUT=DATA/'precision';CACHE=ROOT/'outputs/nordic-current-cache'
NLS='https://inspire-wfs.maanmittauslaitos.fi/inspire-wfs/au/ows';META='https://www.maanmittauslaitos.fi/inspire-kyselypalvelut-wfs';ROSTER='https://stat.fi/en/luokitukset/kunta/kunta_1_20260101';CORR='https://stat.fi/en/luokitukset/corrmaps/kunta_1_20260101%23maakunta_1_20260101'
ROSTER_API='https://api.stat.fi/classificationservice/open/api/classifications/v2/classifications/kunta_1_20260101/classificationItems?content=data&format=json&lang=en&meta=max';CORR_API='https://api.stat.fi/classificationservice/open/api/classifications/v2/correspondenceTables/kunta_1_20260101%23maakunta_1_20260101/maps?content=data&format=json&lang=en&meta=min'
SNAPSHOT='2026-10-29';PRECISION=1e-6
BASELINE='3b6e6bc0a7a18b29b764f9d7772ccaab8b70aa74'
SOURCE_SHA256='531d8006d530b96d6068a224fc6e6521eb6681bff12df4662263f75b958ab477'
def baseline(path):return json.loads(subprocess.check_output(['git','show',BASELINE+':public/data/'+path],cwd=ROOT))

def read(p):return json.loads(p.read_bytes())
def enc(v):return(json.dumps(v,ensure_ascii=False,allow_nan=False,separators=(',',':'))+'\n').encode()
def write(p,v):p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(enc(v))
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def parts(g):return[g]if g.geom_type=='Polygon'else[p for c in getattr(g,'geoms',[])for p in parts(c)]
def valid(g):
 if not g.is_valid:g=make_valid(g)
 ps=parts(g)
 if not ps:return None
 result=ps[0]if len(ps)==1 else MultiPolygon(ps)
 if not result.is_valid:result=unary_union(ps)
 assert result.is_valid and not result.is_empty
 return result

def fetch(u,p):
 if not p.exists():
  b=urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'LightTheEarth public geodata preparation'}),timeout=120).read();json.loads(b);p.write_bytes(b)
 return read(p)
def source():
 roster=fetch(ROSTER_API,CACHE/'fi-classification.json');corr=fetch(CORR_API,CACHE/'fi-region-correspondence.json')
 def page(start):
  q={'service':'WFS','version':'2.0.0','request':'GetFeature','typeNames':'au:AdministrativeUnit','srsName':'urn:ogc:def:crs:EPSG::3067','outputFormat':'application/json','cql_filter':"nationalCode LIKE '___'",'count':10,'startIndex':start}
  u=NLS+'?'+urllib.parse.urlencode(q);p=CACHE/f'fi-nls-municipalities-3067-{start:03}.geojson';j=fetch(u,p);assert j['numberReturned']==len(j['features']);return j['features'],{'url':u,'path':str(p.relative_to(ROOT)),'sha256':sha(p),'bytes':p.stat().st_size,'serverTimeStamp':j.get('timeStamp')}
 with concurrent.futures.ThreadPoolExecutor(max_workers=4)as pool:rows=list(pool.map(page,range(0,310,10)))
 fs=[f for row,_ in rows for f in row];assert len(fs)==308==len({f['properties']['nationalCode']for f in fs});assert set(f['properties']['nationalCode']for f in fs)==set(r['code']for r in roster)
 for f in fs:assert f['properties']['nationalLevel']['@href'].endswith('/5thOrder')
 path=CACHE/'fi-nls-municipalities-3067.geojson';write(path,{'type':'FeatureCollection','features':fs});assert sha(path)==SOURCE_SHA256,'Pinned NLS snapshot changed; obtain a newly audited version instead';return fs,roster,corr,path,[r for _,r in rows]

def asset(kind,obj):
 p=OUT/f'current-fin{"-"+kind if kind!="local"else""}.geojson';write(p,obj);z=p.with_suffix('.geojson.gz');z.write_bytes(gzip.compress(p.read_bytes(),compresslevel=9,mtime=0));assert p.stat().st_size<64*1024*1024 and z.stat().st_size<10_000_000
 return{kind+'Url':'/data/precision/'+p.name,kind+'GzipUrl':'/data/precision/'+z.name,kind+'Bytes':p.stat().st_size,kind+'GzipBytes':z.stat().st_size},{kind:sha(p),kind+'Gzip':sha(z)}
def layer(g,kind):return {'type':'FeatureCollection','features':[{'type':'Feature','id':'current-'+kind+'-FIN','properties':{'countryCode':'FIN','level':'source','pickableLocal':False,'source':'Exact current selectable municipality union'if kind=='land'else'2017 verified physical-land mask outside current municipality union, excluding complete official Åland administration and independent ALA land; neutral residual only'if kind=='fallback'else'Exact local union plus explicitly neutral physical-land residual'},'geometry':mapping(g)}]}

def main():
 CACHE.mkdir(parents=True,exist_ok=True);fs,roster,corr,src,requests=source();official={r['code']:r['classificationItemNames'][0]['name']for r in roster};regions={r['sourceItem']['code']:{'code':r['targetItem']['code'],'name':r['targetItem']['classificationItemNames'][0]['name']}for r in corr};aland={code for code,r in regions.items()if r['code']=='21'};assert len(aland)==16 and len(official.keys()-aland)==292
 # GeoJSON from the NLS complex-feature service defaults to three output decimals.
 # Request metre CRS first, preserving source mm precision; transform locally to WGS84.
 project=Transformer.from_crs(3067,4326,always_xy=True).transform;full=[]
 for f in fs:
  p=f['properties'];code=p['nationalCode'];g=valid(transform(project,shape(f['geometry'])));assert g is not None
  source_names=[n['spelling']['text']for n in p['name']];assert official[code]in source_names,(code,official[code],source_names);names=list(dict.fromkeys([official[code],*source_names]));full.append({'type':'Feature','id':code,'properties':{'officialCode':code,'name':official[code],'aliases':names,'regionCode':regions[code]['code'],'parentName':regions[code]['name']},'geometry':mapping(g)})
 fullpath=CACHE/'fin-full-wgs84.geojson';write(fullpath,{'type':'FeatureCollection','features':full});candidate=CACHE/'fin-topology.geojson'
 subprocess.run(['npx','--yes','mapshaper@0.7.95',str(fullpath),'-explode','-simplify','dp','interval=20m','keep-shapes','-dissolve','officialCode','copy-fields=name,aliases,regionCode,parentName','-o','force','precision=0.000001',str(candidate)],check=True)
 display=read(candidate);source_components=sum(len(parts(shape(f['geometry'])))for f in full);display_components=sum(len(parts(shape(f['geometry'])))for f in display['features']);assert source_components==display_components,(source_components,display_components)
 # The country API contains Åland's 16 municipalities. Keep its existing ALA namespace
 # separate. Exclude the full exact NLS Åland administrative footprint before coast clip.
 aland_source=valid(unary_union([shape(f['geometry'])for f in full if f['properties']['officialCode']in aland]));assert aland_source is not None
 existing_alignment=baseline('geometry-alignment.json')['countries'];maskpath=DATA/'precision/fin-land.geojson';mask_source=valid(unary_union([shape(f['geometry'])for f in read(maskpath)['features']]));ala_path=ROOT/('public'+existing_alignment['ALA']['landUrl']);ala=valid(unary_union([shape(f['geometry'])for f in read(ala_path)['features']]));assert mask_source and ala
 official_mainland=valid(unary_union([shape(f['geometry'])for f in full if f['properties']['officialCode']not in aland]));assert official_mainland is not None
 mask=valid(mask_source.intersection(official_mainland).difference(unary_union([aland_source,ala])));assert mask is not None
 mask=shape(mapping(mask));rows=[]
 for f in display['features']:
  p=f['properties'];code=p['officialCode']
  if code in aland:continue
  g=set_precision(valid(shape(f['geometry'])),PRECISION);g=valid(shape(mapping(g)).intersection(mask));assert g is not None,code;rows.append((code,p,g))
 rows.sort(key=lambda r:r[0]);geoms=[r[2]for r in rows];tree=STRtree(geoms);conflicts=[];unknown=[]
 for i,g in enumerate(geoms):
  for j in tree.query(g):
   j=int(j)
   if j>i:
    overlap=g.intersection(geoms[j])
    if overlap.area>1e-14:unknown.append(overlap);conflicts.append({'codes':[rows[i][0],rows[j][0]],'areaDeg2':overlap.area,'point':list(overlap.representative_point().coords)[0]})
 if unknown:
  uncertain=unary_union(unknown);geoms=[valid(g.difference(uncertain))for g in geoms];assert all(g is not None for g in geoms);write(CACHE/'fin-overlap-neutral.geojson',{'type':'Feature','properties':{'reason':'Uncertain source overlaps removed from both current owners'},'geometry':mapping(uncertain)})
 current=[]
 for(code,p,_),g in zip(rows,geoms):
  q=max(parts(g),key=lambda x:x.area).representative_point();ident='FIN-KUNTA-2026-'+code
  props={'id':ident,'name':p['name'],'originalName':p['name'],'aliases':p['aliases'],'countryCode':'FIN','countryName':'芬兰','parentName':p['parentName'],'regionCode':p['regionCode'],'level':'local','adminLevel':'ADM3','adminType':'Municipality (kunta / kommun)','center':[q.x,q.y],'bbox':list(g.bounds),'source':'National Land Survey of Finland · INSPIRE Administrative Units current API; Statistics Finland 2026 codes; 2017 physical coast mask','year':'2026','officialCode':code,'boundaryVersion':'2026 classification; current NLS API snapshot 2026-10-29','coastlineYear':'2017'}
  current.append({'type':'Feature','id':ident,'properties':props,'geometry':mapping(g)})
 assert len(current)==292;land=valid(unary_union(geoms));fallback=valid(mask.difference(land));assert fallback is not None;country=valid(unary_union([land,fallback]));assert country is not None
 # Current local and neutral residual share the same physical mask. No overview sea fill.
 worlds=[f for f in read(DATA/'world.geojson')['features']if f['properties']['countryCode']=='FIN'];old=existing_alignment['FIN'];alignment={'legacyPaintUrl':old['localUrl'],'legacyPaintGzipUrl':old['localGzipUrl'],'count':292,'renderCount':292,'suppressedIds':[],'legacyAliases':{},'sourceUrl':META,'downloadUrl':NLS,'sourceSHA256':sha(src),'sourceBytes':src.stat().st_size,'sourceYear':'2026','sourceGeometry':'official full NLS current API snapshot; protected-island shared-topology DP20m display; exact dated physical-coast clip','source':'National Land Survey of Finland · INSPIRE AU current API snapshot 2026-10-29; Statistics Finland municipalities 2026','license':'Creative Commons Attribution 4.0 International (CC BY 4.0); 2017 coastline mask geoBoundaries CC BY4 / OSM ODbL1','licenseUrl':'https://www.maanmittauslaitos.fi/en/opendata-licence-cc40','attribution':'© National Land Survey of Finland, CC BY4.0; © Statistics Finland, CC BY4.0; dated coast: geoBoundaries / © OpenStreetMap contributors, ODbL1.0','sha256':{},'vertexCount':int(sum(get_num_coordinates(g)for g in geoms)),'preparation':'Official NLS current EPSG:3067 requests avoid service default 3-decimal WGS84 truncation; convert using pyproj always_xy; shared mapshaper0.7.95 arcs, explode protected components, DP20m then dissolve by official code; 1e-6 degree mesh; all disputed overlap removed from both owners to neutral land; physical 2017 coast mask; complete Åland official footprint and independent ALA land excluded.','worldIds':[f['id']for f in worlds],'replaceWorldIds':[f['id']for f in worlds],'retainedWorldIds':[],'partialOverviewCoverage':True,'fallbackWorldIds':[f['id']for f in worlds]}
 for kind,obj in [('local',{'type':'FeatureCollection','features':current}),('land',layer(land,'land')),('fallback',layer(fallback,'fallback')),('country',layer(country,'country'))]:
  fields,hashes=asset(kind,obj);alignment.update(fields);alignment['sha256'].update(hashes)
 controls={'Helsinki':([24.94,60.17],True),'Tampere':([23.76,61.50],True),'Oulu':([25.47,65.01],True),'Hailuoto island':([24.72,65.01],True),'Gulf of Finland':([25,59.8],False),'Bothnian Sea':([21,61.5],False),'Archipelago open water':([21,60.1],False),'Mariehamn retained separately as ALA':([19.935,60.097],False),'Stockholm':([18.07,59.33],False)}
 physical={name:{'point':p,'expectedLand':want,'actualLand':country.covers(Point(p))}for name,(p,want)in controls.items()};assert all(r['expectedLand']==r['actualLand']for r in physical.values()),physical
 # Verify independently re-decoded transport files and actual union/overlap contracts.
 decoded={k:read(ROOT/('public'+alignment[k+'Url']))for k in ['local','land','fallback','country']};gg=[shape(f['geometry'])for f in decoded['local']['features']];tree=STRtree(gg);overlap=0
 for i,g in enumerate(gg):
  assert g.is_valid and not g.is_empty and g.covers(Point(decoded['local']['features'][i]['properties']['center']))
  for j in tree.query(g):
   if j>i:overlap=max(overlap,g.intersection(gg[int(j)]).area)
 assert overlap<=1e-14
 dl={k:shape(decoded[k]['features'][0]['geometry'])for k in ['land','fallback','country']};ld=dl['land'].symmetric_difference(unary_union(gg)).area;cd=dl['country'].symmetric_difference(unary_union([dl['land'],dl['fallback']])).area;fo=dl['land'].intersection(dl['fallback']).area;assert ld==0 and cd==0 and fo<=1e-14
 for k in ['local','land','fallback','country']:
  p=ROOT/('public'+alignment[k+'Url']);z=ROOT/('public'+alignment[k+'GzipUrl']);assert gzip.decompress(z.read_bytes())==p.read_bytes()
 oldfeatures=read(ROOT/('public'+old['localUrl']))['features'];oldids={f['id']for f in oldfeatures};assert not oldids.intersection(f['id']for f in current)
 reform_controls=[]
 for before,after in [('Pertunmaa','507'),('Valtimo','541'),('Honkajoki','214')]:
  oldf=next(f for f in oldfeatures if f['properties']['name']==before);point=shape(oldf['geometry']).representative_point();hits=[f for f in current if shape(f['geometry']).covers(point)];assert len(hits)==1 and hits[0]['properties']['officialCode']==after,(before,after)
  reform_controls.append({'historicalName':before,'historicalId':oldf['id'],'point':[point.x,point.y],'currentOfficialCode':after,'currentName':hits[0]['properties']['name']})
 cross={}
 for code in ['ALA','NOR','SWE','RUS','FRO','GRL']:
  a=existing_alignment.get(code)
  if a:
   path=ROOT/('public'+(a.get('countryUrl')or a['landUrl']));other=valid(unary_union([shape(f['geometry'])for f in read(path)['features']]))
  else:other=valid(unary_union([shape(f['geometry'])for f in read(DATA/'world.geojson')['features']if f['properties']['countryCode']==code]))
  intersection=country.intersection(other);point=intersection.representative_point()if not intersection.is_empty else None
  cross[code]={'areaDeg2':intersection.area,'geodeticAreaKm2':abs(Geod(ellps='WGS84').geometry_area_perimeter(intersection)[0])/1e6,'point':[point.x,point.y]if point else None,'bounds':list(intersection.bounds)if point else None,'otherAssetUrl':'/data/world.geojson'if not a else(a.get('countryUrl')or a['landUrl'])}
  if intersection.area>1e-12:write(CACHE/f'fin-cross-{code.lower()}-overlap.geojson',{'type':'Feature','properties':cross[code],'geometry':mapping(intersection)})
 assert cross['ALA']['areaDeg2']<=1e-14
 area=abs(Geod(ellps='WGS84').geometry_area_perimeter(country)[0])/1e6;assert 330000<area<340000,area
 note='2026官方名录全国308个市镇；本网站FIN接入本土292个，奥兰16个继续在独立ALA地图下保留，避免重复点亮。NLS现行行政几何为2026-10-29 API快照，海岸裁至明确标示的2017年精细物理陆地掩膜。'
 coverage={'code':'FIN','sourceISO':'FIN','name':'芬兰','localUrl':alignment['localUrl'],'localGzipUrl':alignment['localGzipUrl'],'paintUrl':alignment['localUrl'],'paintGzipUrl':alignment['localGzipUrl'],'count':292,'adminLevel':'ADM3','label':'市镇（kunta / kommun）','canonical':'Municipalities','year':'2026','source':alignment['source'],'sourceUrl':META,'downloadUrl':NLS,'license':alignment['license'],'licenseUrl':alignment['licenseUrl'],'coverageNote':note,'note':note,'center':[25.75,64.5],'bbox':list(country.bounds),'detailTier':'local','bytes':alignment['localBytes']}
 checks={'all308OfficialCodesExactlyMatched':True,'mainlandOfficialCodes':sorted(set(official)-aland),'separateAlandOfficialCodes':sorted(aland),'currentMainlandCount':292,'preservedAlandCount':16,'sourcePolygonComponentCount':source_components,'displayPolygonComponentCountBeforeCoastClip':display_components,'noIslandComponentLossDuringSimplification':True,'validNonemptyGeometries':True,'centerInsideAllGeometries':True,'maxPairwiseOverlapAreaDeg2':overlap,'sourceOverlapNeutralized':conflicts,'landSymmetricDifferenceAreaDeg2':ld,'countryUnionDifferenceAreaDeg2':cd,'fallbackLocalOverlapAreaDeg2':fo,'physicalLandControlPoints':physical,'physicalLandGeodeticAreaKm2':area,'historicalReformLocationControlPoints':reform_controls,'gzipRoundtripAllAssets':True,'oldIdsRemainHistorical':True,'crossCountryOverlaps':cross,'countryOutsideOfficialCurrentMainlandAreaDeg2':country.difference(official_mainland).area}
 evidence={'referenceDate':'2026-01-01','currentAPISnapshotRetrievedAt':SNAPSHOT,'apiFeatureVersionDatesAvailable':False,'sourceMetadataUrl':META,'sourceClassificationUrl':ROSTER,'sourceClassificationAPIUrl':ROSTER_API,'officialRegionCorrespondenceUrl':CORR,'officialRegionCorrespondenceAPIUrl':CORR_API,'downloadUrl':NLS,'source':alignment['source'],'license':alignment['license'],'licenseUrl':alignment['licenseUrl'],'rawSourceSHA256':sha(src),'rawSourceBytes':src.stat().st_size,'sourceCRS':'EPSG:3067 (metres; source output precision 0.001 metre), locally projected to EPSG:4326','sourceRequests':requests,'officialCountryMunicipalityCount':308,'publishedMainlandMunicipalityCount':292,'retainedIndependentAlandMunicipalityCount':16,'coastlineYear':'2017','coastlineSourceUrl':old['sourceUrl'],'coastlineSHA256':sha(maskpath),'alandExclusionSource':'Official 2026 municipality-to-region code21 Åland classification; full current NLS footprints plus independent ALA physical land','officialMainlandMaskRule':'2017 physical mask is intersected with full official current NLS mainland municipal union before fallback construction; no old-mask residual outside authoritative Finland is retained','alandRetainedAsset':existing_alignment['ALA']['localUrl'],'alandRetainedLandSHA256':sha(ala_path)}
 reforms=[{'effectiveDate':'2025-01-01','before':['Pertunmaa (588)','Mäntyharju (507)'],'after':'Mäntyharju (507)','evidenceUrl':ROSTER},{'effectiveDate':'2026-01-01','before':'Savonlinna / Enonkoski boundary before 39 complete and 4 partial register-unit transfers','after':'No municipal mergers; 2026 register-unit boundary adjustment','evidenceUrl':ROSTER}]
 record={'alignment':alignment,'coverage':coverage,'sourceEvidence':evidence,'audit':{'oldCount':old['count'],'oldYear':old['sourceYear'],'currentCount':292,'currentReferenceDate':'2026-01-01; NLS current geometry API retrieval 2026-10-29','levelChange':'The prior312 source geometries include Åland and old administrative units; current FIN uses292 actual mainland municipalities. National official308 includes16 Åland municipalities retained in the independent ALA map, so the reduction is not represented as20 recent mergers.','identityPolicy':'Distinct versioned official-code current IDs; every prior FIN historical polygon stays at the exact old primary URL. No old visit migration.','reformExamples':reforms,'inputFiles':[{'path':str(p.relative_to(ROOT)),'sha256':sha(p),'bytes':p.stat().st_size}for p in [src,CACHE/'fi-classification.json',CACHE/'fi-region-correspondence.json',maskpath,ala_path]],'checks':checks},'limitations':['NLS current API retrieval date is2026-10-29; the service does not expose feature revision dates. Administrative identity/code validation uses the2026-01-01 official classification; no survey date for every boundary is claimed.','The physical coastline mask references2017 and can omit newer reclamation and small islands absent from the mask; no2026 coastline claim. DP20m protected every source island before coast clipping.','The original full NLS municipal geometry and official classification/correspondence responses are retained under outputs/nordic-current-cache.','Åland retains its existing separate ALA16 historical source; this batch does not replace its local boundary geometry.']}
 seam_records=prepare_neighbor_seams(country,existing_alignment)
 post_cross=copy_cross={k:v for k,v in cross.items()if k not in seam_records}
 for code,item in seam_records.items():
  other=shape(read(ROOT/('public'+item['alignment']['countryUrl']))['features'][0]['geometry']);intersection=country.intersection(other);assert intersection.area<1e-12
  post_cross[code]={'areaDeg2':intersection.area,'geodeticAreaKm2':abs(Geod(ellps='WGS84').geometry_area_perimeter(intersection)[0])/1e6,'otherAssetUrl':item['alignment']['countryUrl']}
 record['audit']['checks']['sourceCrossCountryOverlapsBeforeSeam']=cross;record['audit']['checks']['crossCountryOverlaps']=post_cross
 manifest={'version':1,'generatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'countries':{'FIN':record,**seam_records},'contract':'Current border, picking and fill all use identical localUrl. landUrl is exact selectable union; country is land plus explicit neutral dated physical-land residual. Independent ALA namespace excluded. Historical primary assets unchanged.'};write(DATA/'current-nordic.json',manifest);write(ROOT/'outputs/nordic-current-audit.json',manifest);print('DONE FIN',292,'gzipTotal',sum(alignment[k+'GzipBytes']for k in ['local','land','fallback','country']),'cross',cross,flush=True)


def prepare_neighbor_seams(fin_country,existing):
 """Authoritative current Finland edge trims only intersecting old neighbor displays.
 Every original feature object is retained in the new primary file. Only cut originals
 are suppressed and receive a separate versioned display ID; no historical visit moves.
 """
 import copy
 coverage={r['code']:r for r in baseline('coverage.json')};quality=baseline('name-quality.json')['regions'];records={}
 for code,stem in [('SWE','current-swe-seam'),('NOR','current-nor-fin-seam'),('RUS','current-rus-seam')]:
  before=copy.deepcopy(existing[code]);original=read(ROOT/('public'+before['localUrl']));prior_supp=set(before.get('suppressedIds',[]));original_active=[f for f in original['features']if str(f['id'])not in prior_supp]
  history={};new_features=[];changes=[];supp=set(prior_supp);aliases=copy.deepcopy(before.get('legacyAliases',{}));active=[]
  for f in original_active:
   g=shape(f['geometry']);intersection=g.intersection(fin_country)
   if intersection.area<=1e-14:active.append(f);continue
   previous_id=str(f['id']);q=quality.get(previous_id,{});base_name=q.get('name')or f['properties']['name'];clipped=valid(g.difference(fin_country));ident=f'SEAM-{code}-FIN-2026-'+previous_id
   note='此2017年来源的邻国县市面仅沿芬兰2026官方NLS行政范围与已核验物理陆地进行新旧图接边裁切；未重新核验本国全部行政制度。原面保留历史，足迹不自动迁移。'if code!='NOR'else'此挪威2026市镇显示面仅沿芬兰2026官方NLS行政范围与已核验物理陆地接边裁切，2013挪威海岸掩膜及其余2026市镇边界保持原来源；原现行面保留历史，足迹不自动迁移。'
   status=q.get('status')or f['properties'].get('nameStatus','verified')
   history[previous_id]={'name':base_name+'（芬兰接边前旧界）','aliases':list(dict.fromkeys([base_name,*q.get('aliases',[]),*f['properties'].get('aliases',[])])),'parentName':q.get('parentName')or f['properties'].get('parentName'),'boundaryStatus':'historical','status':status,'nameStatus':status,'retirementKind':'cartographic-seam-copy','retiredAt':SNAPSHOT,'sourceGeometryYear':f['properties'].get('year',before.get('sourceYear')),'note':note,'evidenceURLs':[META,ROSTER]}
   supp.add(previous_id);aliases[previous_id]=previous_id
   if clipped is not None:
    pt=max(parts(clipped),key=lambda x:x.area).representative_point();p=copy.deepcopy(f['properties']);p.update(id=ident,name=base_name,aliases=list(dict.fromkeys([*p.get('aliases',[]),*q.get('aliases',[])])),center=[pt.x,pt.y],bbox=list(clipped.bounds),legacyId=previous_id,nameStatus=status,nameNote=note,note=note,cartographicSeamVersion='FIN NLS current2026-10-29 authoritative administrative extent; dated physical coast',seamEvidenceURLs=[META,ROSTER]);nf={'type':'Feature','id':ident,'properties':p,'geometry':mapping(clipped)};new_features.append(nf);active.append(nf)
   changes.append({'legacyId':previous_id,'id':ident if clipped is not None else None,'sourceName':base_name,'sourceYear':f['properties'].get('year',before.get('sourceYear')),'removedOverlapAreaDeg2':intersection.area,'removedGeodeticAreaKm2':abs(Geod(ellps='WGS84').geometry_area_perimeter(intersection)[0])/1e6,'point':list(intersection.representative_point().coords)[0],'remainingAreaDeg2':clipped.area if clipped is not None else 0})
  assert changes,code
  local={'type':'FeatureCollection','features':[*original['features'],*new_features]};gs=[shape(f['geometry'])for f in active];land=valid(unary_union(gs));assert land is not None
  oldcountry_url=before.get('countryUrl')or before['landUrl'];oldcountry=valid(unary_union([shape(f['geometry'])for f in read(ROOT/('public'+oldcountry_url))['features']]));assert oldcountry is not None
  # Existing explicit remote fallback is retained, except any authoritative Finnish
  # collision. Source leftovers within dated old country land remain neutral only.
  prior_fallback=valid(unary_union([shape(f['geometry'])for f in read(ROOT/('public'+before['fallbackUrl']))['features']]))if before.get('fallbackUrl')else None
  fallback=valid(prior_fallback.difference(fin_country).difference(land))if prior_fallback is not None else None;country=valid(unary_union([land,fallback]))if fallback is not None else land
  a=copy.deepcopy(before);a.update(localUrl='/data/precision/'+stem+'.geojson',localGzipUrl='/data/precision/'+stem+'.geojson.gz',count=len(local['features']),renderCount=len(active),storedFeatureCount=len(local['features']),suppressedIds=sorted(supp),legacyAliases=aliases,legacyPaintUrl=before.get('legacyPaintUrl')or before['localUrl'],legacyPaintGzipUrl=before.get('legacyPaintGzipUrl')or before.get('localGzipUrl'),sourceYear=before.get('sourceYear')or coverage[code]['year'],sourceGeometry=before.get('sourceGeometry','existing source')+'; Finland authoritative-edge cartographic seam',sha256={},sourceUrl=before['sourceUrl'],sourceAttribution=(before.get('sourceAttribution')or before.get('attribution')or before.get('source'))+'; Finland edge © National Land Survey of Finland, CC BY4.0',cartographicSeamReferenceDate='2026-10-29',cartographicSeamEvidenceURL=META,cartographicSeamLocalSourceUrl=before['localUrl'],cartographicSeamLocalSourceSHA256=sha(ROOT/('public'+before['localUrl'])),cartographicSeamOnly=True)
  for k in ['land','country','fallback']:
   for suffix in ['Url','GzipUrl','Bytes','GzipBytes','GzipParts']:a.pop(k+suffix,None)
  def seam_asset(kind,obj):
   p=OUT/(stem+(''if kind=='local'else'-'+kind)+'.geojson');write(p,obj);z=p.with_suffix('.geojson.gz');z.write_bytes(gzip.compress(p.read_bytes(),compresslevel=9,mtime=0));assert p.stat().st_size<64*1024*1024 and z.stat().st_size<10_000_000,(code,kind,p.stat().st_size,z.stat().st_size);a.update({kind+'Url':'/data/precision/'+p.name,kind+'GzipUrl':'/data/precision/'+z.name,kind+'Bytes':p.stat().st_size,kind+'GzipBytes':z.stat().st_size});a['sha256'][kind]=sha(p);a['sha256'][kind+'Gzip']=sha(z)
  def source_layer(g,kind):return {'type':'FeatureCollection','features':[{'type':'Feature','id':'seam-'+kind+'-'+code,'properties':{'countryCode':code,'pickableLocal':False,'source':'Exact active neighbor local union after authoritative Finland boundary seam'if kind=='land'else'Unchanged explicitly dated old physical-land remainder after authoritative Finland clipping; neutral only'if kind=='fallback'else'Exact active local union plus explicit neutral remainder after authoritative Finland edge clipping'},'geometry':mapping(g)}]}
  seam_asset('local',local);seam_asset('land',source_layer(land,'land'));seam_asset('country',source_layer(country,'country'))
  if fallback is not None:seam_asset('fallback',source_layer(fallback,'fallback'))
  a['attribution']=a['sourceAttribution'];a['license']=(a.get('license')or'Original source licence')+'; Finland seam evidence © National Land Survey of Finland CC BY4.0'
  a.update(vertexCount=int(sum(get_num_coordinates(g)for g in gs)),preparation=before.get('preparation','')+'; Preserve every original feature object; suppress only Finland-overlapping source IDs; assign distinct versioned seam-display IDs; subtract authoritative Finland current physical-land footprint only; exact active union for land and same primary for paint/borders/picking. No other remote boundaries altered.')
  assert {str(f['id']):f for f in local['features']if str(f['id'])in{str(x['id'])for x in original['features']}}=={str(f['id']):f for f in original['features']}
  assert land.intersection(fin_country).area<1e-12 and country.intersection(fin_country).area<1e-12
  assert abs(country.symmetric_difference(oldcountry.difference(fin_country)).area)<1e-10
  assert all(g.is_valid and not g.is_empty and g.covers(Point(f['properties']['center']))for f,g in zip(active,gs))
  original_geoms=[shape(f['geometry'])for f in original_active]
  def overlaps(geoms):
   tree=STRtree(geoms);maximum=0;total=0;count=0
   for i,g in enumerate(geoms):
    for j in tree.query(g):
     if j>i:
      area=g.intersection(geoms[int(j)]).area
      if area>1e-14:count+=1;total+=area;maximum=max(maximum,area)
   return {'pairs':count,'totalAreaDeg2':total,'maxAreaDeg2':maximum}
  before_overlaps=overlaps(original_geoms);after_overlaps=overlaps(gs);assert after_overlaps['totalAreaDeg2']<=before_overlaps['totalAreaDeg2']+1e-12
  c=copy.deepcopy(coverage[code]);c.update(localUrl=a['localUrl'],localGzipUrl=a['localGzipUrl'],count=len(local['features']),renderCount=len(active),bytes=a['localBytes'],note=(c.get('note')or c.get('coverageNote',''))+' 仅沿芬兰2026官方行政边界及物理陆域作显示接边，其他区域保留既有来源，原受影响面另存历史。',coverageNote=(c.get('coverageNote')or c.get('note',''))+' 沿芬兰2026官方范围作新旧图接边；这不表示本国区划整体已更新。')
  checks={'everyPriorFeatureObjectUnchanged':True,'baselinePrimaryUrl':before['localUrl'],'priorFeatureCount':len(original['features']),'newSeamFeatureCount':len(new_features),'suppressedPriorIds':sorted(set(history)),'activeFeatureCount':len(active),'validNonemptyGeometries':True,'centerInsideAllGeometries':True,'sourceLocalOverlap':before_overlaps,'postSeamLocalOverlap':after_overlaps,'noIntroducedLocalOverlap':True,'landSymmetricDifferenceAreaDeg2':land.symmetric_difference(unary_union(gs)).area,'countryUnionDifferenceAreaDeg2':country.symmetric_difference(unary_union([land,fallback])if fallback is not None else land).area,'fallbackLocalOverlapAreaDeg2':land.intersection(fallback).area if fallback is not None else 0,'finlandCrossOverlapAreaDeg2':country.intersection(fin_country).area,'sourceCountryMinusFinlandDifferenceAreaDeg2':country.symmetric_difference(oldcountry.difference(fin_country)).area,'finlandEvidenceRule':'Only full official current NLS mainland administrative extent intersected with verified dated physical coast; no Finnish fallback outside official union','changes':changes}
  evidence={'referenceDate':before.get('sourceYear')or c['year'],'sourceMetadataUrl':before['sourceUrl'],'source':before.get('source')or c.get('source'),'baselinePrimaryUrl':before['localUrl'],'baselinePrimarySHA256':sha(ROOT/('public'+before['localUrl'])),'cartographicSeamOnly':True,'cartographicSeamDate':SNAPSHOT,'cartographicSeamEvidenceURLs':[META,ROSTER],'cartographicSeamSourceCountrySHA256':sha(ROOT/('public'+oldcountry_url)),'currentFinlandSHA256':sha(DATA/'precision/current-fin-country.geojson'),'retainsOtherBoundariesAndAdministrativeVersion':True}
  records[code]={'alignment':a,'coverage':c,'sourceEvidence':evidence,'historyPolicy':'seam-copies-only','history':history,'audit':{'oldCount':before.get('renderCount',before['count']),'oldYear':before.get('sourceYear')or c['year'],'currentCount':len(active),'currentReferenceDate':c['year'],'levelChange':'No countrywide administrative update: cartographic seams only along authoritative current Finland. Existing source dates remain.','identityPolicy':'Every original feature retained exactly; only affected originals suppressed; separate SEAM IDs and explicit history prevent automatic visit migration.','checks':checks},'limitations':['Only the Finland-facing cartographic seam is repaired; all other existing source boundaries and administrative reference years remain.','The new Finland administrative footprint uses current official NLS geometry retrieved2026-10-29 and explicit2017 physical coastline clip; it is not derived from old neighbor geometry.','Historical records keep their exact prior polygon and metadata; neighboring authority identities are not silently migrated.']}
  write(CACHE/(code.lower()+'-finland-seam-audit.json'),records[code]);print('SEAM',code,len(changes),'new',len(new_features),'active',len(active),'gzip',sum(a.get(k+'GzipBytes',0)for k in ['local','land','fallback','country']),flush=True)
 return records

if __name__=='__main__':main()
