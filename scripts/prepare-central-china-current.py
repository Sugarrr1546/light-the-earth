#!/usr/bin/env python3
"""Cumulative Anhui/Jiangxi current county boundaries with exact shared-edge seams.
Run outputs/geodata-venv/bin/python scripts/prepare-central-china-current.py.
All earlier feature objects and relation identities are retained for historical visits.
Prerequisite: prepare-east-china-current.py and prepare-zhejiang-current.py caches
(province boundaries and the audited directed-coastline mask) must already exist.
"""
import copy,gzip,hashlib,html,importlib.util,json,pathlib,re,subprocess,urllib.request,xml.etree.ElementTree as ET
import osmium,xlrd
from shapely import STRtree,coverage_is_valid
from shapely.geometry import shape,mapping,Point,Polygon,MultiPolygon
from shapely.ops import unary_union
ROOT=pathlib.Path(__file__).resolve().parents[1];CACHE=ROOT/'outputs/central-china-cache';OUT=ROOT/'public/data/precision'
BASELINE='3b6e6bc0a7a18b29b764f9d7772ccaab8b70aa74';SNAPSHOT='2026-10-25T21:21:21Z';VERIFIED='2026-10-29'
AH='https://mz.ah.gov.cn/public/21761/123433761.html';JX='https://mzt.jiangxi.gov.cn/jxsmzt/col/col34862/content/content_2072245187928301568.html'
PBF_HASH={'anhui':'c7bc1f102c555e2be74e8cbd536746e9640dcbaddf11160ed64216418de1c968','jiangxi':'094899df6ee56938bf22842a27cda7fdebad3e70f3a6554a0a0f90fd63fb35f0'}
spec=importlib.util.spec_from_file_location('east',ROOT/'scripts/prepare-east-china-current.py');east=importlib.util.module_from_spec(spec);spec.loader.exec_module(east)
read=east.read;enc=east.enc;write=east.write;sha=east.sha;polygonal=east.polygonal;feature_center=east.feature_center

def fetch(url,p):
 if not p.exists():p.write_bytes(urllib.request.urlopen(url,timeout=180).read())
def pack(name,value):
 raw=enc(value);assert len(raw)<64*1024*1024,(name,len(raw));z=gzip.compress(raw,compresslevel=9,mtime=0);(OUT/name).write_bytes(raw);(OUT/(name+'.gz')).write_bytes(z);assert gzip.decompress(z)==raw
 return {'url':'/data/precision/'+name,'gzipUrl':'/data/precision/'+name+'.gz','bytes':len(raw),'gzipBytes':len(z),'sha256':sha(raw),'gzipSHA256':sha(z),'requiresMultipartTransport':len(z)>=10_000_000}
def base(path):return json.loads(subprocess.check_output(['git','show',f'{BASELINE}:{path}'],cwd=ROOT))
def roster_anhui():
 fetch(AH,CACHE/'anhui-official-2026.html');s=(CACHE/'anhui-official-2026.html').read_text();assert '2026-07-09'in s
 links=list(set(re.findall(r'href="([^"]+\.xlsx?)"',s)));assert len(links)==1,links
 url='https://mz.ah.gov.cn'+links[0];p=CACHE/('anhui-official-2026'+pathlib.Path(links[0]).suffix);fetch(url,p);b=xlrd.open_workbook(p);rs={};parent=None
 for sheet in b.sheets():
  for i in range(sheet.nrows):
   vals=[str(c).strip()for c in sheet.row_values(i)]
   if len(vals)<4:continue
   m=re.match(r'([\u4e00-\u9fff]+)\s+(34\d{4})',vals[2])
   if m:parent=m[1]
   m=re.match(r'([\u4e00-\u9fff]+)\s+(34\d{4})',vals[3])
   if m:rs[m[2]]={'code':m[2],'name':m[1],'parentName':parent,'provinceName':'安徽省','evidenceURL':AH,'officialReferenceDate':'2026-06-30'}
 assert len(rs)==104,len(rs);return list(rs.values()),url

def roster_jiangxi():
 fetch(JX,CACHE/'jiangxi-official-2026.html');s=(CACHE/'jiangxi-official-2026.html').read_text();assert '2026-07-01'in s and '截至2026年6月30日'in re.sub('<[^>]+>','',s)
 rs={};parent=None
 for tr in re.findall(r'<tr\b.*?</tr>',s,re.S|re.I):
  for value in re.findall(r'<t[dh]\b[^>]*>(.*?)</t[dh]>',tr,re.S|re.I):
   v=html.unescape(re.sub('<[^>]+>','',value)).strip();m=re.fullmatch(r'([\u4e00-\u9fff]+)\s*(36\d{4})',v)
   if not m:continue
   if m[2].endswith('00'):parent=m[1]
   else:rs[m[2]]={'code':m[2],'name':m[1],'parentName':parent,'provinceName':'江西省','evidenceURL':JX,'officialReferenceDate':'2026-06-30'}
 assert len(rs)==100,len(rs);return list(rs.values())
def extract(slug):
 p=CACHE/(slug+'-261025.osm.pbf');fetch(f'https://download.geofabrik.de/asia/china/{slug}-261025.osm.pbf',p);assert sha(p.read_bytes())==PBF_HASH[slug]
 reader=osmium.io.Reader(str(p));stamp=reader.header().get('osmosis_replication_timestamp');reader.close();assert stamp==SNAPSHOT
 dest=CACHE/(slug+'-admin.geojson')
 if not dest.exists():
  h=east.Extract();h.apply_file(str(p),locations=True,idx='flex_mem');write(dest,{'type':'FeatureCollection','features':h.features})
 return read(dest)['features']
def supplement(rid):
 p=CACHE/f'relation-{rid}.osm';url=f'https://api.openstreetmap.org/api/0.6/relation/{rid}/full';fetch(url,p);stamp=max(e.attrib.get('timestamp','')for e in ET.parse(p).getroot());assert stamp<=SNAPSHOT,(rid,stamp)
 # Every returned node, way and relation is checked, not just the parent relation.
 dest=p.with_suffix('.geojson')
 if not dest.exists():
  h=east.Extract();h.apply_file(str(p),locations=True,idx='flex_mem');write(dest,{'type':'FeatureCollection','features':h.features})
 return next(f for f in read(dest)['features']if f['id']==rid),stamp

def farm_source():
 p=CACHE/'wanhe-farm-town.geojson'
 if not p.exists():
  class Farm(osmium.SimpleHandler):
   def __init__(self):super().__init__();self.features=[];self.factory=osmium.geom.GeoJSONFactory()
   def area(self,a):
    if not a.from_way() and a.tags.get('name') in ['皖河农场','海口镇']:
     self.features.append({'type':'Feature','id':a.orig_id(),'properties':{'tags':dict(a.tags),'timestamp':str(a.timestamp)},'geometry':json.loads(self.factory.create_multipolygon(a))})
  h=Farm();h.apply_file(str(CACHE/'anhui-261025.osm.pbf'),locations=True,idx='flex_mem');write(p,{'type':'FeatureCollection','features':h.features})
 return read(p)

def main():
 CACHE.mkdir(parents=True,exist_ok=True);
 prerequisites=['outputs/east-china-cache/jiangsu-admin.geojson','outputs/east-china-cache/shanghai-admin.geojson','outputs/current-china-cache/zhejiang-province-extracted.geojson','outputs/east-china-cache/east-combined-sea-mask.geojson']
 for prerequisite in prerequisites:assert (ROOT/prerequisite).exists(),('Run the preceding east-China/Zhejiang preparation first; missing audited prerequisite',prerequisite)
 ah,ahxls=roster_anhui();jx=roster_jiangxi();fa=extract('anhui');fj=extract('jiangxi');supp={}
 for rid in [913109,3046784,3190446,3190448,3190361,3046790]:
  f,stamp=supplement(rid);supp[str(rid)]=stamp
  if rid not in {v['id']for v in fj}:fj.append(f)
 previous=base('public/data/current-east-china.json');data=read(OUT/'chn-east-current.geojson');original=copy.deepcopy({f['id']:f for f in data['features']});assert len(original)==3132
 align=copy.deepcopy(previous['alignment']);repairs=base('public/data/china-name-repairs.json')['repairs'];oldgs={fid:polygonal(shape(f['geometry']))for fid,f in original.items()}
 oldcurrentids={r['id']for rs in previous['currentRegionsByProvince'].values()for r in rs};oldcurrent=[f for f in data['features']if f['id']in oldcurrentids];assert len(oldcurrent)==201
 provs={slug:shape(next(f['geometry']for f in fs if f['properties']['tags'].get('name')==name and f['properties']['tags']['admin_level']=='4'))for slug,name,fs in [('anhui','安徽省',fa),('jiangxi','江西省',fj)]}
 newprov=polygonal(unary_union(list(provs.values())));assert provs['anhui'].intersection(provs['jiangxi']).area<1e-12
 eastprovs=[]
 for fn,rid in [('outputs/east-china-cache/jiangsu-admin.geojson',913012),('outputs/east-china-cache/shanghai-admin.geojson',913067),('outputs/current-china-cache/zhejiang-province-extracted.geojson',553302)]:eastprovs.append(shape(next(f['geometry']for f in read(ROOT/fn)['features']if f['id']==rid)))
 combined=polygonal(unary_union([newprov,*eastprovs]));sea=shape(read(ROOT/'outputs/east-china-cache/east-combined-sea-mask.geojson')['geometry']);assert newprov.intersection(sea).area<1e-12
 administrative=[];current=[];rosters=[('anhui',ah,fa),('jiangxi',jx,fj)]
 for slug,rs,fs in rosters:
  pgs={f['properties']['tags']['name']:shape(f['geometry'])for f in fs if f['properties']['tags']['admin_level']=='5'}
  for record in rs:
   matches=[f for f in fs if f['properties']['tags']['admin_level']=='6'and f['properties']['tags'].get('name')==record['name']]
   if len(matches)>1:matches=[f for f in matches if pgs[record['parentName']].covers(shape(f['geometry']).representative_point())]
   assert len(matches)==1,(record,[f['id']for f in matches]);u=matches[0];tags=u['properties']['tags'];assert not tags.get('ref:admin:CN')or tags.get('ref:admin:CN')==record['code'],(record,tags)
   g=polygonal(shape(u['geometry']));sid='OSM-CHN-relation-'+str(u['id']);assert sid not in original
   props={'id':sid,'name':record['name'],'originalName':tags.get('name:en',record['name']),'aliases':list(dict.fromkeys([record['name'],record['name'][:-1],record['parentName']+record['name'],tags.get('name:en',record['name'])])),'parentName':record['parentName'],'provinceName':record['provinceName'],'countryCode':'CHN','countryName':'中国','level':'local','adminLevel':'ADM3','adminCode':record['code'],'center':feature_center(g),'bbox':list(g.bounds),'year':'2026（OSM快照）','source':'© OpenStreetMap contributors · Geofabrik '+slug+'；'+SNAPSHOT,'sourceUrl':f'https://www.openstreetmap.org/relation/{u["id"]}','license':'ODbL 1.0','nameStatus':'verified','boundarySnapshot':SNAPSHOT,'officialNameCodeEvidenceURL':record['evidenceURL'],'officialNameCodeReferenceDate':'2026-06-30'}
   administrative.append({'type':'Feature','id':sid,'properties':copy.deepcopy(props),'geometry':mapping(g)})
   g=polygonal(g.intersection(provs[slug]));props.update(center=feature_center(g),bbox=list(g.bounds),geometryRole='province-clipped-current-inland-administrative-land');current.append({'type':'Feature','id':sid,'properties':props,'geometry':mapping(g)})
 assert len(current)==204 and len({f['id']for f in current})==204
 # Source conflicts remain unassigned; never select a county by iteration order.
 rawgs=[shape(f['geometry'])for f in current];tree=STRtree(rawgs);conflicts=[];byconflict={}
 for i,g in enumerate(rawgs):
  for j in tree.query(g,predicate='intersects'):
   j=int(j)
   if j<=i:continue
   area=g.intersection(rawgs[j]);
   if area.area<=1e-12:continue
   conflicts.append({'a':current[i]['id'],'b':current[j]['id'],'areaDeg2':area.area,'rule':'Source intersection removed from both click targets; retained in raw provenance, neutral inland land only.'})
   for k in [i,j]:byconflict.setdefault(k,[]).append(area)
 for i,gs in byconflict.items():
  g=polygonal(rawgs[i].difference(unary_union(gs)));current[i]['geometry']=mapping(g);current[i]['properties'].update(center=feature_center(g),bbox=list(g.bounds),geometryQualityNote='源边界交叠从双方点击面同时扣除，未推断县级归属。')
 # Older source names and identities are untouched in the source feature superset.
 suppressed=set(align['suppressedIds']);aliases=copy.deepcopy(align['legacyAliases']);retired=copy.deepcopy(previous['retiredRegions'])
 historical_ids={fid for fid in original if fid.startswith('GB-')and(repairs.get(fid,{}).get('evidence',{}).get('code','').startswith(('34','36'))or oldgs[fid].intersection(newprov).area/oldgs[fid].area>.5)}
 for fid in sorted(historical_ids):
  f=original[fid];repair=repairs.get(fid,{});name=re.sub(r'（.*?）','',repair.get('name',f['properties']['name']));verified=repair.get('status')=='verified';suppressed.add(fid);aliases[fid]=fid
  retired.setdefault(fid,{'name':name+'（2017年旧界）','aliases':list(dict.fromkeys([name,f['properties'].get('originalName',name),*repair.get('aliases',[])])),'parentName':repair.get('parentName',f['properties'].get('parentName','')),'note':'保留2017年原始边界和旅行身份。现行安徽、江西使用2026-10-25 OSM几何及2026-06-30官方县级名录；此标记表示几何更替，不表示该单位撤销。','evidenceURLs':[*repair.get('evidenceURLs',[]),AH,JX],'lastValidYear':None,'retiredAt':VERIFIED,'sourceGeometryYear':'2017','retirementKind':'geometry-superseded','oldUnitNameVerified':verified,'status':'verified'if verified else'unresolved','nameStatus':'verified'if verified else'unresolved'})
 oldseams=[f for f in data['features']if f['id'].startswith('SEAM-CHN-')]
 for f in oldseams:
  fid=f['id'];legacy=f['properties']['legacyGeometryId'];suppressed.add(fid);aliases[fid]=fid
  # Keep previous historical metadata unchanged whenever it already exists.
  if fid not in retired:retired[fid]={'name':f['properties']['name']+'（江浙沪接边旧副本）','aliases':f['properties'].get('aliases',[]),'parentName':f['properties'].get('parentName',''),'note':'保留前版江浙沪接边副本；现行安徽、江西县级源或五省统一接边替代，不自动迁移旅行记录。','evidenceURLs':[AH,JX],'lastValidYear':None,'retiredAt':VERIFIED,'sourceGeometryYear':'2017','retirementKind':'cartographic-seam-superseded','oldUnitNameVerified':f['properties'].get('nameStatus')=='verified'}
  if legacy not in historical_ids and legacy not in previous['alignment']['suppressedIds']:suppressed.discard(legacy)
  if legacy not in historical_ids and legacy in {r['legacyId']for r in previous['seamRegions']}:suppressed.discard(legacy)
 seamfeatures=[];seamaudit=[]
 for fid,f in original.items():
  if fid in suppressed or fid in oldcurrentids or not fid.startswith('GB-'):continue
  g=oldgs[fid];overlap=g.intersection(combined).area
  if overlap<=1e-12:continue
  clipped=polygonal(g.difference(combined),empty=True);suppressed.add(fid);aliases[fid]=fid;repair=repairs.get(fid,{});name=repair.get('name',f['properties']['name']);sid='SEAM-CHN-'+fid+'-CENTRAL20261025'
  if not clipped.is_empty:
   seam=copy.deepcopy(f);seam.update(id=sid,geometry=mapping(clipped));seam['properties'].update(id=sid,name=name,aliases=list(dict.fromkeys([*repair.get('aliases',[]),*f['properties'].get('aliases',[]),name])),parentName=repair.get('parentName',f['properties'].get('parentName','')),center=feature_center(clipped),bbox=list(clipped.bounds),year='2017区划；2026皖赣江浙沪接边',sourceGeometryYear='2017',source='geoBoundaries 2017；仅按2026-10-25 OSM皖赣江浙沪省界裁去重叠',legacyGeometryId=fid,cartographicRepair='subtract-verified-Anhui-Jiangxi-Jiangsu-Shanghai-Zhejiang-provinces',nameStatus=repair.get('status','unresolved'));seamfeatures.append(seam)
  if fid not in retired:retired[fid]={'name':name+'（2017年旧界）','aliases':list(dict.fromkeys([name,*repair.get('aliases',[])])),'parentName':repair.get('parentName',f['properties'].get('parentName','')),'note':'原始2017几何保留；现行副本仅沿安徽、江西、江苏、上海、浙江同快照省界裁去重叠，其余省县界未声称完成当前核验。','evidenceURLs':[*repair.get('evidenceURLs',[]),AH,JX],'lastValidYear':None,'retiredAt':VERIFIED,'sourceGeometryYear':'2017','retirementKind':'cartographic-seam-copy'}
  seamaudit.append({'legacyId':fid,'activeId':sid if not clipped.is_empty else None,'name':name,'beforeAreaDeg2':overlap,'afterAreaDeg2':clipped.intersection(combined).area,'otherBoundaryChangesAreaDeg2':g.difference(clipped).symmetric_difference(g.intersection(combined)).area})
 seam_by_legacy={f['properties']['legacyGeometryId']:f for f in seamfeatures};old_seam_checks=[]
 for f in oldseams:
  legacy=f['properties']['legacyGeometryId']
  if legacy in historical_ids:continue
  expected=shape(f['geometry']).difference(combined);repl=seam_by_legacy.get(legacy);actual=shape(repl['geometry'])if repl else MultiPolygon([]);delta=expected.symmetric_difference(actual).area;assert delta<1e-12,(legacy,delta)
  old_seam_checks.append({'oldSeamId':f['id'],'legacyId':legacy,'newSeamId':repl['id']if repl else None,'outsideCurrentProvinceSymmetricDifferenceAreaDeg2':delta})
 data['features'].extend([*current,*seamfeatures]);by={f['id']:f for f in data['features']};assert len(by)==len(data['features'])
 assert all(by[fid]==f for fid,f in original.items());assert all(retired[k]==v for k,v in previous['retiredRegions'].items())
 active=[f for f in data['features']if f['id']not in suppressed];ags=[polygonal(shape(f['geometry']))for f in active];activeunion=polygonal(unary_union(ags));currentall=[*oldcurrent,*current];cgs=[shape(f['geometry'])for f in currentall];currentunion=polygonal(unary_union(cgs));tree=STRtree(ags);pairs=[]
 for i,g in enumerate(ags):
  for j in tree.query(g,predicate='intersects'):
   j=int(j)
   if j>i and(area:=g.intersection(ags[j]).area)>1e-12:pairs.append({'a':active[i]['id'],'b':active[j]['id'],'areaDeg2':area})
 assert not pairs,pairs;assert activeunion.intersection(sea).area<1e-12
 # Retain prior neutral coverage outside the newly updated inland provinces.
 # New neutral land is only bounded, source-supported interior holes, never sea.
 oldfallback=shape(read(OUT/'chn-east-current-fallback.geojson')['features'][0]['geometry']);oldcountry=shape(read(OUT/'chn-east-current-country.geojson')['features'][0]['geometry']);oldphysical=oldcountry
 possible=polygonal(unary_union([oldfallback.difference(newprov),newprov.difference(currentunion)]),empty=True).difference(activeunion)
 ps=list(activeunion.geoms)if activeunion.geom_type=='MultiPolygon'else[activeunion];holes=unary_union([Polygon(r)for p in ps for r in p.interiors]);fallback=polygonal(possible.intersection(holes).difference(sea),empty=True);countryunion=polygonal(unary_union([activeunion,fallback]))
 assert fallback.intersection(activeunion).area<1e-12 and fallback.intersection(sea).area<1e-12
 assert oldfallback.difference(newprov).difference(countryunion).area<1e-12,'Old neutral land lost outside new provinces'
 assets={'local':pack('chn-central-current.geojson',data)}
 for kind,g,role in [('land',activeunion,'exact-active-administrative-union'),('fallback',fallback,'neutral-source-supported-enclosed-inland-residual'),('country',countryunion,'active-administrative-union-plus-neutral-inland-seams')]:
  assets[kind]=pack(f'chn-central-current-{kind}.geojson',{'type':'FeatureCollection','features':[{'type':'Feature','id':'CHN-'+kind,'properties':{'countryCode':'CHN','name':'中国'if kind!='fallback'else'封闭内陆来源残余（未分配区县）','role':role,**({'pickable':False}if kind=='fallback'else{})},'geometry':mapping(g)}]})
 adminasset=pack('chn-central-current-administrative.geojson',{'type':'FeatureCollection','features':administrative})
 for kind,a in assets.items():
  for suf,key in [('Url','url'),('GzipUrl','gzipUrl'),('Bytes','bytes'),('GzipBytes','gzipBytes')]:align[kind+suf]=a[key]
  align.pop(kind+'GzipParts',None);align['sha256'][kind]=a['sha256'];align['sha256'][kind+'Gzip']=a['gzipSHA256']
 fixtures=[]
 for name,xy,code in [('Wanzhi',[118.57,31.15],'340210'),('Fanchang',[118.19,31.08],'340212'),('Wuwei',[117.91,31.3],'340281'),('WanheFarm',[116.7663322725815,30.4230259],'340803'),('Honggutan',[115.86,28.69],'360113'),('Lushan',[115.99,29.45],'360483'),('Guangxin',[117.91,28.45],'361104'),('Wuyuan',[117.86,29.25],'361130')]:
  hits=[f for f in current if shape(f['geometry']).covers(Point(*xy))];assert len(hits)==1 and hits[0]['properties']['adminCode']==code,(name,[f['properties']['name']for f in hits]);fixtures.append({'name':name,'coordinates':xy,'currentName':hits[0]['properties']['name'],'officialCode':code,'uniqueCurrentCountyHit':True})
 farmfc=farm_source();farm=shape(next(f['geometry']for f in farmfc['features']if f['properties']['tags']['name']=='皖河农场'));daguan=shape(next(f['geometry']for f in current if f['properties']['adminCode']=='340803'));huaining=shape(next(f['geometry']for f in current if f['properties']['adminCode']=='340822'));assert farm.difference(daguan).area<1e-12 and farm.intersection(huaining).area<1e-12
 farmcheck={'sourceRelationId':16848373,'sourceSnapshotAt':SNAPSHOT,'farmSourceAreaDeg2':farm.area,'farmOutsideDaguanAreaDeg2':farm.difference(daguan).area,'farmInsideHuainingAreaDeg2':farm.intersection(huaining).area,'point':feature_center(farm),'reportUrl':'https://api.app.anhuinews.com/appcontent/9592853.html','announcementOriginalDirectlyRetrieved':False,'interpretation':'The complete same-snapshot OSM Wanhe Farm administrative polygon is already contained in Daguan and absent from Huaining. This checks consistency with the publicly reproduced 2026-09-14 transfer announcement; the original government announcement was not directly retrieved and no official surveyed transfer polygon was obtained.'}
 provinceaudits={}
 for slug,rs,fs in rosters:
  units=[f for f in current if f['properties']['provinceName']==rs[0]['provinceName']];gs=[shape(f['geometry'])for f in units];union=unary_union(gs);gap=provs[slug].difference(union)
  provinceaudits[slug]={'officialCountyCount':len(rs),'officialRosterExactMatch':True,'currentLocalSourceGapAreaDeg2':gap.area,'currentLocalOutsideProvinceAreaDeg2':union.difference(provs[slug]).area,'currentSourceUnassignedInlandGapAreaDeg2':gap.intersection(fallback).area,'physicalInlandGapAfterNeutralAreaDeg2':provs[slug].difference(countryunion).area,'localOverlapAreaDeg2':max(0,sum(g.area for g in gs)-union.area),'sourceCoverageIsValid':bool(coverage_is_valid(gs))}
 oldnotes=previous['limitations'];notes=['安徽104、江西100县市区名称和代码逐项匹配2026-06-30省民政官方名录；几何来自2026-10-25 OSM快照，并非官方测绘成果。','现行资料包含湾沚、繁昌、无为、红谷滩、庐山、广信等更名或重组后单位；旧身份完整保留，未自动迁移旅行足迹。','安徽、江西均为内陆省份，县面按同源省界裁切；省内来源缺口只在闭合内陆作为中性面保留，无县级点选身份。','OSM皖河农场完整源面已落入大观区且不与怀宁相交，与2026-09-14区划变动转载报道所述归属一致；未直接取得政府公告原文及测绘转移面，不能声称逐界点核验。','其他省份仍主要为2017来源，外省接边副本仅裁去已更新五省，未完成全国现行核验。',*oldnotes]
 audit={'baselineStoredCount':len(original),'baselineActiveCount':previous['alignment']['renderCount'],'newCountyCount':204,'currentAnhuiCount':104,'currentJiangxiCount':100,'preservedEastChinaCount':201,'historicalAnhuiJiangxiCount':len(historical_ids),'oldSeamArchiveCount':len(oldseams),'newSeamCount':len(seamfeatures),'storedCount':len(data['features']),'activeCount':len(active),'suppressedCount':len(suppressed),'pbfHeaderTimestamp':SNAPSHOT,'supplementalObjectsAllRecursiveLatestTimestamp':supp,'officialRosterExactMatch':True,'allPreviousObjectsRetainedUnchanged':True,'allPreviousHistoricalMetadataRetainedUnchanged':True,'allPrevious201CurrentCountyObjectsRetainedUnchanged':True,'sourceCountyOverlapConflicts':conflicts,'positiveOverlapPairs':pairs,'pairwiseOverlapToleranceDeg2':1e-12,'allActiveChinaInVerifiedSeaAreaDeg2':activeunion.intersection(sea).area,'fallbackInVerifiedSeaAreaDeg2':fallback.intersection(sea).area,'everyActiveFeatureCenterInside':all(g.covers(Point(*f['properties']['center']))for f,g in zip(active,ags)),'oldOutsideSeamPreservation':old_seam_checks,'seamRepairs':seamaudit,'seamOverlapBeforeAreaDeg2':sum(a['beforeAreaDeg2']for a in seamaudit),'seamOverlapAfterAreaDeg2':sum(a['afterAreaDeg2']for a in seamaudit),'currentCoverageIsValid':bool(coverage_is_valid(cgs)),'provinces':provinceaudits,'countyFixtureChecks':fixtures,'coastlineFixtureChecks':previous['audit']['coastlineFixtureChecks'],'wanheFarmTransferConsistency':farmcheck,'neutralEnclosedInlandFallbackAreaDeg2':fallback.area,'landVsActiveUnionAreaDeg2':0,'countryVsLandPlusFallbackAreaDeg2':0}
 assert audit['everyActiveFeatureCenterInside'];assert all(v['physicalInlandGapAfterNeutralAreaDeg2']<1e-12 for v in provinceaudits.values()),provinceaudits
 align.update(count=len(data['features']),renderCount=len(active),suppressedIds=sorted(suppressed),legacyAliases=aliases,source='geoBoundaries gbOpen (2017 outside Anhui/Jiangxi/Jiangsu/Shanghai/Zhejiang) · © OpenStreetMap contributors (皖赣江浙沪2026)',sourceUrl='https://download.geofabrik.de/asia/china/',sourceYear='混合版本：安徽、江西、江苏、上海、浙江2026-10-25；其余主体2017',sourceSHA256=PBF_HASH['anhui'],snapshotAt=SNAPSHOT,verifiedAt=VERIFIED,checks=audit,preparation='Pinned3b6e6bc baseline feature superset and historical metadata retained unchanged. Official2026-06-30 AH104/JX100 name/code roster; same-snapshot county/province boundaries, exact shared vertices, no simplification or buffering. Exact full-source conflicts removed from both owners; only closed source-supported inland gaps neutral. Old outside counties receive distinct five-province seam copies; all old seams archived. Prior directed-coastline mask and all201 prior current county objects preserved.')
 currentrs=[{**r,'id':next(f['id']for f in current if f['properties']['adminCode']==r['code'])}for r in [*ah,*jx]]
 srcs=[];sourceurls={'anhui-261025.osm.pbf':'https://download.geofabrik.de/asia/china/anhui-261025.osm.pbf','jiangxi-261025.osm.pbf':'https://download.geofabrik.de/asia/china/jiangxi-261025.osm.pbf','anhui-official-2026.html':AH,'anhui-official-2026.xls':ahxls,'jiangxi-official-2026.html':JX,'wanhe-farm-town.geojson':'https://download.geofabrik.de/asia/china/anhui-261025.osm.pbf'}
 for rid in [913109,3046784,3190446,3190448,3190361,3046790]:sourceurls[f'relation-{rid}.osm']=f'https://api.openstreetmap.org/api/0.6/relation/{rid}/full'
 for filename,url in sourceurls.items():
  p=CACHE/filename;srcs.append({'file':str(p.relative_to(ROOT)),'url':url,'bytes':p.stat().st_size,'sha256':sha(p.read_bytes())})
 manifest={'version':1,'baselineCommit':BASELINE,'snapshotAt':SNAPSHOT,'verifiedAt':VERIFIED,'alignment':align,'retiredRegions':retired,'currentAdministrative':{**adminasset,'count':204,'runtime':False,'geometryRole':'uncropped-source-current-administrative-provenance'},'sourceArchives':[previous['currentAdministrative'],previous['currentSourceAdministrative'],*previous.get('sourceArchives',[])],'coastlineEvidence':previous['coastlineEvidence'],'suggestedFallback':{**assets['fallback'],'areaDeg2':fallback.area,'ownership':None,'purpose':'Neutral source-supported closed inland residual only; no county pick target'},'seamRegions':[{'id':f['id'],'legacyId':f['properties']['legacyGeometryId'],'name':f['properties']['name'],'nameStatus':f['properties']['nameStatus'],'parentName':f['properties']['parentName']}for f in seamfeatures],'coveragePatch':{'count':len(data['features']),'source':align['source'],'sourceYear':align['sourceYear'],'coverageNote':'安徽104县、江西100县、江苏95县、上海16区及浙江90县采用2026-10-25 OSM统一快照；安徽江西名称代码与2026-06-30官方名录逐项核对。海岸省沿用同快照物理陆域，内陆省按统一省界精确裁切。闭合来源缝隙为中性陆地，不推断县归属。旧几何及接边副本均保留为历史身份；相邻其他省仅修复接边，主体仍为2017来源。皖河农场OSM源面已全部位于大观区，与2026-09-14区划变动转载报道所述归属一致；未直接取得公告原文及官方测绘转移面，不声称逐界点核验。','license':align['license'],'sourceUrl':align['sourceUrl']},'evidenceURLs':[AH,JX,*previous['evidenceURLs'],'https://download.geofabrik.de/asia/china/anhui.html','https://download.geofabrik.de/asia/china/jiangxi.html'],'licensing':previous['licensing'],'officialRoster':[*previous['officialRoster'],*ah,*jx],'currentRegions':[*previous['currentRegions'],*currentrs],'currentRegionsByProvince':{**previous['currentRegionsByProvince'],'安徽省':[r for r in currentrs if r['code'].startswith('34')],'江西省':[r for r in currentrs if r['code'].startswith('36')]},'sourceCache':[*previous['sourceCache'],*srcs],'audit':audit,'limitations':notes,'assetTransport':{k:{'gzipBytes':v['gzipBytes'],'requiresMultipartTransport':v['requiresMultipartTransport']}for k,v in assets.items()}}
 write(ROOT/'public/data/current-central-china.json',manifest,True);write(ROOT/'outputs/central-china-current-audit.json',manifest,True);write(CACHE/'official-rosters.json',{'anhui':ah,'jiangxi':jx},True)
 print(json.dumps({'assets':assets,'administrative':adminasset,'audit':audit},ensure_ascii=False,indent=2),flush=True)
if __name__=='__main__':main()
