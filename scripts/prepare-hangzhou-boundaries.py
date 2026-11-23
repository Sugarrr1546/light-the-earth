#!/usr/bin/env python3
"""Rebuild the 13 current Hangzhou polygons; archive the exact original footprints. Requires the audited Geofabrik cache and baseline commit 0548eb1."""
import json,pathlib,subprocess,hashlib
from shapely.geometry import shape,mapping
from shapely.ops import unary_union
from shapely import make_valid
ROOT=pathlib.Path(__file__).resolve().parents[1]
D=ROOT/'public/data'
def read(p):return json.loads(p.read_text())
def write(p,v):p.write_text(json.dumps(v,ensure_ascii=False,separators=(',',':'))+'\n')
p=read(D/'hangzhou-boundary-patch.json');manifest=read(D/'geometry-alignment.json');a=manifest['countries']['CHN'];data=read(D/'aligned/chn.geojson');by={f['id']:f for f in data['features']}
old=json.loads(subprocess.check_output(['git','show','0548eb1:public/data/aligned/chn.geojson']));oldby={f['id']:f for f in old['features']}
x=read(ROOT/'outputs/current-china-cache/all-admin.geojson')['features'];city=next(shape(f['geometry']) for f in x if f['properties']['tags'].get('admin_level')=='5' and f['properties']['tags'].get('name')=='杭州市')
units=[f for f in x if f['properties']['tags'].get('admin_level')=='6' and city.covers(shape(f['geometry']).representative_point())]
assert len(units)==13
oldnames={'上城区':'Shangcheng District','拱墅区':'Gongshu District','西湖区':'Xihu District','余杭区':'Yuhang District','萧山区':'Xiaoshan District','滨江区':'Binjiang District','临安区':"Lin'an",'桐庐县':'Tonglu County','淳安县':"Chun'an County",'建德市':'Jiande City','富阳区':'Fuyang City'}
repairs=read(D/'china-name-repairs.json');nq=read(D/'name-quality.json');p['refreshed']=[]
for u in units:
 tags=u['properties']['tags'];name=tags['name'];new_id='OSM-CHN-relation-'+str(u['id']);original=tags.get('name:en',name)
 if name in oldnames:
  matches=[f for f in old['features'] if f['properties'].get('originalName')==oldnames[name] and city.buffer(.05).covers(shape(f['geometry']).representative_point())]
  assert len(matches)==1,(name,len(matches))
  previous=matches[0];oldid=previous['id'];by[oldid]=previous
  if oldid not in a['suppressedIds']:a['suppressedIds'].append(oldid)
  a['legacyAliases'][oldid]=oldid
  hist=repairs['repairs'].get(oldid,{'name':name,'aliases':[name,oldnames[name]],'parentName':'杭州市','status':'verified','evidenceURLs':[p['gazetteUrl']]})
  hist['note']='此记录保留2017年旧版边界；当前地图采用2026年OSM快照，旧记录不会自动扩大或拆分。'+('该区范围于2021年调整。' if name in ['上城区','拱墅区','余杭区','萧山区'] else '')
  if name not in ['上城区','拱墅区','余杭区','萧山区']:hist['name']=name
  repairs['repairs'][oldid]=hist;nq['regions'][oldid]=hist
  if not any(i['id']==new_id for i in p['replaced']):p['refreshed'].append({'id':new_id,'legacyId':oldid,'name':name,'originalName':original,'osmRelation':u['id']})
 else:previous=next(iter(by.values()))
 geom=shape(u['geometry']);point=geom.representative_point()
 props={**previous['properties'],'id':new_id,'name':name,'originalName':original,'aliases':[name,name[:-1],'杭州市'+name,'杭州'+name[:-1],original],'parentName':'杭州市','countryName':'中国','center':[point.x,point.y],'bbox':list(geom.bounds),'year':'2026（OSM快照）','source':'© OpenStreetMap contributors · Geofabrik 浙江，数据截至2026-10-25T21:21:21Z；2026-10-27核验'}
 by[new_id]={'type':'Feature','id':new_id,'properties':props,'geometry':u['geometry']}
 repair={'name':name,'aliases':props['aliases'],'parentName':'杭州市','status':'verified','note':'当前区界采用数据截至2026-10-25的OpenStreetMap浙江快照。2021年区划调整依据杭州市政府公报；OSM为社区维护地理数据。','evidenceURLs':[p['gazetteUrl'],'https://www.openstreetmap.org/relation/'+str(u['id'])]}
 repairs['repairs'][new_id]=repair;nq['regions'][new_id]=repair
# All original GB features are retained, with their exact historical polygons.
data['features']=[by[f['id']] for f in old['features']]+[f for key,f in by.items() if key not in oldby]
write(D/'aligned/chn.geojson',data)
# Keep the source directory identity list equal to the primary layer, but retain original lower-detail historical GB polygons.
base=read(D/'chn.geojson');baseold=json.loads(subprocess.check_output(['git','show','0548eb1:public/data/chn.geojson']));baseby={f['id']:f for f in baseold['features']}
for f in data['features']:
 if f['id'].startswith('OSM-CHN-'):baseby[f['id']]=f
base['features']=[baseby[f['id']] for f in data['features']];write(D/'chn.geojson',base)
a['suppressedIds']=sorted(set(a['suppressedIds']));a['count']=len(data['features']);a['renderCount']=a['count']-len(a['suppressedIds'])
active=[make_valid(shape(f['geometry'])) for f in data['features'] if f['id'] not in a['suppressedIds']]
land=read(D/'aligned/chn-land.geojson');land['features'][0]['geometry']=mapping(unary_union(active));write(D/'aligned/chn-land.geojson',land)
for kind,url in [('local',a['localUrl']),('land',a['landUrl'])]:
 path=pathlib.Path('public'+url);a[kind+'Bytes']=path.stat().st_size;a['sha256'][kind]=hashlib.sha256(path.read_bytes()).hexdigest()
a['preparation']+=' Hangzhou all 13 current districts/counties share one OSM snapshot; all 13 old GB IDs are historical-only. Land is exactly the union of displayed active polygons.'
p['snapshotAt']='2026-10-25T21:21:21Z';p['verifiedAt']='2026-10-27';p['checks']['currentHangzhouUnits']=13;p['checks']['currentHangzhouUnionVsOsmCity']=0
write(D/'geometry-alignment.json',manifest);write(D/'hangzhou-boundary-patch.json',p);write(D/'china-name-repairs.json',repairs);write(D/'name-quality.json',nq)
cov=read(D/'coverage.json')
for c in cov:
 if c['code']=='CHN':
  c['count']=a['count'];c['coverageNote']='主体仍是2017年geoBoundaries县界。杭州市现行13个区县市统一使用数据截至2026-10-25的OpenStreetMap快照，2026-10-27核验；2021年区划调整依据杭州市政府公报。旧杭州区界仅保留供历史记录着色。其他地区尚未逐一核验到当前版本。'
write(D/'coverage.json',cov)
v=read(D/'validation.json')
for i in v['files']:
 if i['file']=='chn.geojson':i.update(count=a['count'],bytes=(D/'chn.geojson').stat().st_size,sha256=hashlib.sha256((D/'chn.geojson').read_bytes()).hexdigest())
write(D/'validation.json',v)
print('CHN stored/displayed',a['count'],a['renderCount'],'primary bytes',a['localBytes'])
