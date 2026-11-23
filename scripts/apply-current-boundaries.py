#!/usr/bin/env python3
"""Merge audited current assets last; keep geometry history and transport metadata explicit."""
import json,pathlib,gzip,hashlib,datetime,io,subprocess,sys
ROOT=pathlib.Path(__file__).resolve().parents[1];D=ROOT/'public/data'
def read(p):return json.loads(p.read_text())
def write(p,v):p.write_text(json.dumps(v,ensure_ascii=False,separators=(',',':'))+'\n')
def packed_asset(url,parts=None,expected=None):
 if not parts:return (ROOT/('public'+url)).read_bytes()
 chunks=[]
 for part in parts:
  path=part['url'];assert path.startswith('/data/precision/') and '..'not in path
  value=(ROOT/('public'+path)).read_bytes();assert len(value)==part['bytes']<10_000_000
  if part.get('sha256'):assert hashlib.sha256(value).hexdigest()==part['sha256']
  chunks.append(value)
 result=b''.join(chunks);assert len(result)<=64*1024*1024
 if expected is not None:assert len(result)==expected
 return result

def geo(url):
 p=ROOT/('public'+url)
 if not p.exists():
  asset=catalog['assets'].get(url,{'url':url+'.gz'})
  with gzip.GzipFile(fileobj=io.BytesIO(packed_asset(asset['url'],asset.get('parts'),asset.get('bytes'))))as f:raw=f.read(64*1024*1024+1)
  assert len(raw)<=64*1024*1024;p.write_bytes(raw)
 return read(p)
a=read(D/'geometry-alignment.json');coverage=read(D/'coverage.json');catalog=read(D/'geometry-assets.json');names=read(D/'name-quality.json');history=read(D/'boundary-history.json').get('regions',{}) if(D/'boundary-history.json').exists() else {};updates={}
china_manifest=next(name for name in ['current-central-china.json','current-east-china.json','current-zhejiang.json'] if (D/name).exists())
z=read(D/china_manifest);international=read(D/'current-international.json')
for name in ['current-pacific.json','current-nordic.json']:
 if(D/name).exists():international['countries'].update(read(D/name)['countries'])
updates['CHN']={'alignment':z['alignment'],'coverage':{**z['coveragePatch'],'license':'geoBoundaries CC BY 4.0；OpenStreetMap ODbL 1.0'}}
for admin in [z.get('currentAdministrative'),z.get('currentSourceAdministrative'),*z.get('sourceArchives',[])]:
 if admin:
  catalog['assets'][admin['url']]={'url':admin['gzipUrl'],'bytes':admin['gzipBytes'],'decodedBytes':admin['bytes'],'sha256':admin['sha256'],**({'parts':admin['gzipParts']}if admin.get('gzipParts')else{})}
seamsByLegacy={r['legacyId']:r for r in z.get('seamRegions',[])}
for fid,r in z['retiredRegions'].items():
 prior=names['regions'].get(fid,{})
 status=r.get('status') or r.get('nameStatus') or seamsByLegacy.get(fid,{}).get('nameStatus') or prior.get('status','verified')
 history[fid]={**r,'boundaryStatus':'historical','status':status}
 if status=='unresolved':history[fid].update(name='旧来源待核实区域（旧界）',note='原始来源地名与位置不一致，名称尚待核实。'+r.get('note',''),evidenceURLs=[])
for old in read(D/'hangzhou-boundary-patch.json')['abolished']:
 if old['id'] in history:
  history[old['id']].update(name=old['name']+'（已撤销；2017年旧界）',note=old['note'],retirementKind='administrative-unit-abolished',evidenceURLs=[read(D/'hangzhou-boundary-patch.json')['gazetteUrl']])
for code,v in international['countries'].items():
 updates[code]=v
 if v.get('historyPolicy')=='seam-copies-only':
  for fid,r in v['history'].items():history[fid]={**r,'boundaryStatus':'historical'}
  continue
 prior=geo(v['alignment']['legacyPaintUrl'])
 for f in prior['features']:
  p=f['properties'];history[f['id']]={'boundaryStatus':'historical','note':f"此记录保留原来源年份（{p.get('year','历史版本')}）的历史边界；当前地图使用{v['coverage']['year']}版{v['coverage']['label']}，不会自动合并、拆分或迁移旧足迹。",'evidenceURLs':[v['sourceEvidence'].get('sourceMetadataUrl') or v['alignment']['sourceUrl']],'retirementKind':'geometry-superseded'}
for code,u in updates.items():
 record=u['alignment'];a['countries'][code]=record
 for i,old in enumerate(coverage):
  if old['code']!=code:continue
  c={**old,**u['coverage'],'localUrl':record['localUrl'],'gzipUrl':record['localGzipUrl'],'count':record['count'],'legacyUrls':sorted(set([*old.get('legacyUrls',[]),old['localUrl'],record.get('legacyPaintUrl',old['localUrl'])]))}
  # paint packages are archived original layers; all current display geometry is
  # chosen through the same-source display manifest, never through this field.
  if record.get('localGzipParts'):c['gzipParts']=record['localGzipParts']
  else:c.pop('gzipParts',None)
  c['paintUrl']=old['paintUrl'];c['paintGzipUrl']=old.get('paintGzipUrl');c['year']=u['coverage'].get('year') or u['coverage'].get('sourceYear') or old['year'];coverage[i]=c
 for kind in ['local','land','fallback','country']:
  url=record.get(kind+'Url');packed=record.get(kind+'GzipUrl')
  if not url:continue
  raw=(ROOT/('public'+url)).read_bytes() if (ROOT/('public'+url)).exists() else geo(url) and (ROOT/('public'+url)).read_bytes()
  assert hashlib.sha256(raw).hexdigest()==record['sha256'][kind],(code,kind)
  if packed:catalog['assets'][url]={'url':packed,'bytes':len(packed_asset(packed,record.get(kind+'GzipParts'),record.get(kind+'GzipBytes'))),'decodedBytes':len(raw),'sha256':record['sha256'][kind],**({'parts':record[kind+'GzipParts']}if record.get(kind+'GzipParts')else{})}
 # Credit must be visible on the map, alongside full source details.
 record['sourceAttribution']=record.get('attribution') or record.get('source') or c.get('source')
 record['sourceDownloadUrl']=record['sourceUrl']
 record['sourceUrl']=u.get('sourceEvidence',{}).get('sourceMetadataUrl') or u['coverage'].get('sourceUrl') or record['sourceUrl']
 c['sourceUrl']=record['sourceUrl']
for fid,r in history.items():
 prior=names['regions'].get(fid,{})
 names['regions'][fid]={**prior,**r,'status':r.get('status')or prior.get('status','verified')}
# Current source properties always outrank old display-name repair aliases.
# Keep the editor's first verification link specific to the selected province.
currentEvidence={}
for province,rows in z.get('currentRegionsByProvince',{}).items():
 fallbackEvidence=read(D/'current-zhejiang.json')['evidenceURLs'] if province=='浙江省' else []
 for r in rows:currentEvidence[r['id']]=[r['evidenceURL']] if r.get('evidenceURL') else fallbackEvidence
for f in geo(z['alignment']['localUrl'])['features']:
 p=f['properties'];fid=f['id']
 if fid in z['alignment']['suppressedIds'] or not (fid.startswith('OSM-CHN-')or fid.startswith('SEAM-CHN-')):continue
 names['regions'][fid]={**names['regions'].get(fid,{}),'name':p['name'],'parentName':p.get('parentName'),'aliases':p.get('aliases',[]),'status':p.get('nameStatus') if p.get('nameStatus') in ['verified','unresolved','encoding-repaired','boundary-undetermined'] else names['regions'].get(fid,{}).get('status','verified'),'center':p['center'],'note':p.get('nameNote')or p.get('note')or('现行县级区划采用数据截至2026-10-25的OSM统一快照，名称及代码按各省市官方名录核验；显示陆域另按真实海岸裁切。'if fid.startswith('OSM-')else'此区域行政区来源仍为2017年，仅沿更新省市的统一边界进行接边修复；原始旧面保留给历史旅行记录。'),'evidenceURLs':([p['officialNameCodeEvidenceURL']] if p.get('officialNameCodeEvidenceURL') else currentEvidence.get(fid) or z['evidenceURLs']) if fid.startswith('OSM-') else names['regions'].get(next((r['legacyId'] for r in z.get('seamRegions',[])if r['id']==fid),''),{}).get('evidenceURLs',[])}
# Preserve audited display transports when regenerating base manifests.
if (D/'display-meshes.json').exists():
 for mesh in read(D/'display-meshes.json')['countries'].values():
  if mesh['method']=='shared-edge-simplification':
   catalog['assets'][mesh['url']]={'url':mesh['url']+'.gz','bytes':mesh['gzipBytes'],'decodedBytes':mesh['bytes'],'sha256':mesh['sha256']}
for item in z.get('seamRegions',[]):
 if item.get('nameStatus')=='unresolved':
  repair=names['regions'][item['id']];repair.update(name='接边待核实区域',status='unresolved',note='原始来源名称与地理位置不一致，名称尚待核实，地图暂不显示该地名标签。此面仅沿已更新省市边界进行接边修复，未核验为现行官方县界。',evidenceURLs=[])
a['generatedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat();a['checks']['currentBoundaryCodes']=list(updates)
write(D/'geometry-alignment.json',a);write(D/'coverage.json',coverage);write(D/'geometry-assets.json',catalog);write(D/'name-quality.json',names);write(D/'boundary-history.json',{'version':1,'regions':history})
print('Applied',','.join(updates),'historical geometry records',len(history))

# Reviewed overlays always run last so regeneration cannot restore mislabels or derived historical shapes.
if(D/'china-identity-review.json').exists():subprocess.run([sys.executable,str(ROOT/'scripts/remediate-china-identities.py')],check=True)
if(D/'review-provenance-delta.json').exists():subprocess.run([sys.executable,str(ROOT/'scripts/apply-review-provenance.py')],check=True)
