#!/usr/bin/env python3
"""Apply audited precision outputs last; original and legacy source files stay intact."""
import pathlib,json,hashlib,datetime
ROOT=pathlib.Path(__file__).resolve().parents[1];D=ROOT/'public/data'
def read(p):return json.loads(p.read_text())
def write(p,data):p.write_text(json.dumps(data,ensure_ascii=False,separators=(',',':'))+'\n')
aligned=read(D/'geometry-alignment.json');coverage=read(D/'coverage.json');updates={}
country_manifest=D/'precision-countries.json'
if country_manifest.exists():updates.update(read(country_manifest)['countries'])
remaining_manifest=D/'precision-remaining.json'
if remaining_manifest.exists():updates.update(read(remaining_manifest)['countries'])
france=read(D/'precision-france.json');updates['FRA']=france['alignment']
legacy=read(D/'precision-france-legacy.json')
updates['FRA']['legacyPaintUrl']=legacy['legacyAlignedUrl']
for code,value in updates.items():aligned['countries'][code]=value
for i,c in enumerate(coverage):
 if c['code']=='FRA':coverage[i]={**c,**france['coverage'],'legacyUrls':sorted(set([*c.get('legacyUrls',[]),'/data/global/fra-adm3.geojson']))}
aligned['version']=2;aligned['generatedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
aligned['checks']['precisionUpgradeCodes']=sorted(updates)
aligned['checks']['maximumDecodedAssetBytes']=max(x['localBytes'] for x in aligned['countries'].values())
aligned['checks']['maxAssetBytes']=max(max(x.get('localGzipBytes',x['localBytes']),x.get('landGzipBytes',x['landBytes'])) for x in aligned['countries'].values())
aligned['contract']='Primary local polygons define land, outlines, interaction and current saved fills. Gzip transport is lossless. Suppress declared duplicate picking IDs. Keep historical IDs in legacy paint; preserve uncovered world land through fallback and replaceWorldIds.'
write(D/'geometry-alignment.json',aligned);write(D/'coverage.json',coverage)
# Development serves raw baseline files and exact prepacked precision files;
# production pack-geometry generates a complete catalog for every source file.
assets={}
for a in aligned['countries'].values():
 for kind in ['local','land','fallback','country']:
  url=a.get(kind+'Url');packed=a.get(kind+'GzipUrl')
  if not url or not packed:continue
  path=ROOT/'public'/packed.lstrip('/');parts=a.get(kind+'GzipParts')
  if parts:
   assert all((ROOT/'public'/p['url'].lstrip('/')).stat().st_size==p['bytes']for p in parts)
   size=sum(p['bytes']for p in parts)
  else:assert path.exists(),packed;size=path.stat().st_size
  assets[url]={'url':packed,'bytes':size,'decodedBytes':a[kind+'Bytes'],'sha256':a['sha256'][kind],**({'parts':parts}if parts else{})}
assets[legacy['legacyAlignedUrl']]={'url':legacy['legacyAlignedGzipUrl'],'bytes':legacy['gzipBytes'],'decodedBytes':legacy['bytes'],'sha256':legacy['sha256']}
write(D/'geometry-assets.json',{'version':1,'codec':'gzip','maximumDecodedBytes':64*1024*1024,'assets':assets})
print('Merged precision:',','.join(sorted(updates)), '; France rendered',france['alignment']['renderCount'],'; packed development assets',len(assets))

# Current administrative versions always override historical precision upgrades.
if (D/'current-zhejiang.json').exists() and (D/'current-international.json').exists():
 import subprocess
 subprocess.run(['python3',str(ROOT/'scripts/apply-current-boundaries.py')],check=True)
