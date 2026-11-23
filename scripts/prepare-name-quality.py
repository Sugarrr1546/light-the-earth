#!/usr/bin/env python3
"""Audit source names/anchors; overlay verified names without rewriting geodata."""
import pathlib,json,re,datetime,collections
from shapely.geometry import shape,Point
ROOT=pathlib.Path(__file__).resolve().parents[1];D=ROOT/'public';OUT=D/'data/name-quality.json'
def read(p):return json.loads(p.read_text())
def usable(value):
 if not isinstance(value,str)or not value.strip():return False
 v=value.strip()
 return bool(re.search(r'[^\W_]',v,re.UNICODE))and not re.search(r'[?�\x00-\x1f\x7f-\x9f]|ï¿½|[ÃÂ][\u00a0-\u00bf]',v)and not re.search(r'^(?:未命名区域|名称待核实|待核实地区|unknown(?:\s|$))',v)and v.lower() not in ['undefined','null','n/a']and not re.search(r'^(?:unknown|unnamed)(?:\b|$)',v,re.I)and v not in ['NaN','nan']
def recover_encoding(text):
 if not isinstance(text,str)or usable(text):return None
 queue=[(text,[])];seen={text}
 while queue:
  value,steps=queue.pop(0)
  if len(steps)>=3:continue
  for codec in ['latin1','cp1252']:
   try:
    restored=value.encode(codec).decode('utf-8')
    if restored==value or restored in seen or restored.encode('utf-8').decode(codec)!=value:continue
   except UnicodeError:continue
   seen.add(restored);method=[*steps,codec+'→UTF-8']
   if usable(restored):return restored,method
   queue.append((restored,method))
 return None
def parts(g):
 if g.geom_type=='Polygon':return [g]
 return [p for c in getattr(g,'geoms',[]) for p in parts(c)]
manifest=read(D/'data/geometry-alignment.json');japan=read(D/'data/japan-name-repairs.json');regions={};issues=[];anchors=[];total=0
for id,r in japan['repairs'].items():
 boundary=r['nameStatus']=='boundary-unassigned'
 regions[id]={'name':r['name'],'aliases':r['aliases']+(['千叶县所属未定地','千叶县归属未定地','东京湾归属未定地']if boundary else []),'parentName':r['parentName'],'status':'boundary-undetermined'if boundary else'verified','note':'日本国土交通省官方数据记为“所属未定地”，尚未归属某个市区町村，不按附近城市命名。'if boundary else'名称已由日本国土交通省2017、2025年行政区数据核验；边界仍代表原来源年份。','evidenceURLs':r['nameSourceURLs'],'evidence':r['nameEvidence']}
china=D/'data/china-name-repairs.json'
if china.exists():
 for id,r in read(china).get('repairs',{}).items():
  if not usable(r.get('name')):continue
  regions[id]={'name':r['name'],'aliases':r.get('aliases',[]),'parentName':r.get('parentName'),'status':r.get('status') or 'verified','note':r.get('note') or '中文名来自 Wikidata，边界仍沿用来源年份。','evidenceURLs':r.get('evidenceURLs',[]),'evidence':r.get('evidence',{})}
taiwan=D/'data/taiwan-name-repairs.json'
if taiwan.exists():
 for id,r in read(taiwan).get('repairs',{}).items():
  if not usable(r.get('name')):continue
  regions[id]={'name':r['name'],'aliases':r.get('aliases',[]),'parentName':r.get('parentName'),'status':'verified','note':'中文名来自 Wikidata（繁体，当地写法），按坐标与来源名称核对；边界和年份仍沿用 2017 年来源。','evidenceURLs':r.get('nameSourceURLs',[])+['https://www.geoboundaries.org/api/current/gbOpen/TWN/ADM2/'],'evidence':r.get('nameEvidence',{})}
hungary=D/'data/hungary-name-repairs.json'
if hungary.exists():
 for id,r in read(hungary).get('repairs',{}).items():
  if not usable(r.get('name')):continue
  regions[id]={'name':r['name'],'aliases':r.get('aliases',[]),'parentName':r.get('parentName'),'status':'verified','note':r.get('note')or r.get('nameNote')or'名称已按匈牙利官方来源核验；保留原边界和年份。','evidenceURLs':r.get('evidenceURLs')or r.get('nameSourceURLs',[]),'evidence':r.get('evidence',r.get('nameEvidence',{}))}
urls=[('/data/world.geojson','WORLD')]+[(x['localUrl'],code)for code,x in manifest['countries'].items()]
for url,code in urls:
 fc=read(D/url.lstrip('/'))
 for f in fc['features']:
  total+=1;p=f['properties'];id=p['id'];bad=not usable(p.get('name'))and not usable(p.get('originalName'))
  if bad and id not in regions:
   recovered=recover_encoding(p.get('name'))or recover_encoding(p.get('originalName'))
   if recovered:
    restored,steps=recovered
    regions[id]={'name':restored,'aliases':[restored],'status':'encoding-repaired','note':'来源地名的字符编码已恢复；名称、边界年份沿用原数据。','evidenceURLs':[manifest['countries'].get(code,{}).get('sourceUrl','')],'encodingEvidence':{'originalName':p.get('name'),'steps':steps,'reversible':True}}
  if bad:
   issues.append({'id':id,'code':code,'originalName':p.get('name'),'resolved':regions.get(id,{}).get('status')in['verified','boundary-undetermined','encoding-repaired']})
   if id not in regions:regions[id]={'status':'unresolved','note':'来源名称缺失或损坏，暂无可核验地名。保留真实边界与地区标识，地图暂不显示名称。','evidenceURLs':[manifest['countries'].get(code,{}).get('sourceUrl','')]}
  g=shape(f['geometry']);point=Point(*p['center'])
  if not g.covers(point):
   polygons=parts(g);q=max(polygons,key=lambda x:x.area).representative_point();center=[q.x,q.y]
   assert g.covers(Point(*center));regions.setdefault(id,{}).update(center=center,anchorReason='Original label center fell outside source polygon; use largest polygon internal point.');anchors.append({'id':id,'code':code,'before':p['center'],'after':center})
coverage=read(D/'data/coverage.json')
for c in coverage:
 if c['code']=='JPN':c['coverageNote']=re.sub(r'其中\s*24\s*个区域原名称为空，保留源\s*ID。','原来源的24处缺名及2处损坏地名已据官方资料核验修复；保留地区ID和原2017年几何。',c['coverageNote'])
(D/'data/coverage.json').write_text(json.dumps(coverage,ensure_ascii=False,separators=(',',':'))+'\n')
report={'version':1,'generatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'regions':regions,'checks':{'featuresAudited':total,'badSourceNames':len(issues),'verifiedJapanRepairs':len(japan['repairs']),'encodingRepairs':sum(r.get('status')=='encoding-repaired'for r in regions.values()),'verifiedNames':sum(r.get('status')=='verified'for r in regions.values()),'unresolvedNames':sum(r.get('status')=='unresolved'for r in regions.values()),'correctedOutsideAnchors':len(anchors),'badNamesByCountry':dict(collections.Counter(x['code']for x in issues))},'contract':'Name/label presentation only: no geometry/ID/year/private records are rewritten. Verified official repairs are named; unresolved names have a stable explanatory detail label and no map text. Corrected anchors lie inside their source polygon.','sourceAttribution':{'japan':japan['metadata'],'hungary':read(hungary).get('metadata',{})if hungary.exists()else{},'encoding':'Reversible UTF-8/Latin-1 or Windows-1252 recovery of original dataset names; no invented geographic names.'},'issues':issues,'anchorAudit':anchors}
OUT.write_text(json.dumps(report,ensure_ascii=False,separators=(',',':'))+'\n')
print(json.dumps(report['checks'],ensure_ascii=False))
