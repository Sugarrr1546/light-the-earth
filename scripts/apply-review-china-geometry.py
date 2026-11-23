#!/usr/bin/env python3
"""Offline review overlay: keep old polygons, exclude confirmed abolished identities
from current picking, and preserve their former physical land as neutral coverage.
Run with the same Shapely environment as the boundary preparation scripts.
"""
import json,pathlib,gzip,hashlib
from shapely.geometry import shape,mapping
from shapely.ops import unary_union
R=pathlib.Path(__file__).resolve().parents[1];D=R/'public/data'
def read(p):return json.loads(p.read_text())
def raw(o):return(json.dumps(o,ensure_ascii=False,separators=(',',':'))+'\n').encode()
def save(p,o):b=raw(o);p.write_bytes(b)if not p.exists()or p.read_bytes()!=b else None
m=read(D/'current-central-china.json');review=read(D/'china-identity-review.json');a=m['alignment'];primary=read(R/('public'+a['localUrl']));by={f['id']:f for f in primary['features']}
assert set(review['suppressedIds'])<=set(by)
before_country=shape(read(R/('public'+a.get('countryUrl',a['landUrl'])))['features'][0]['geometry'])
suppressed=set(a['suppressedIds'])|set(review['suppressedIds']);active=[shape(f['geometry'])for f in primary['features']if f['id']not in suppressed];land=unary_union(active).normalize();fallback=before_country.difference(land).normalize();country=unary_union([land,fallback]).normalize()
assert land.is_valid and fallback.is_valid and country.is_valid
assert land.intersection(fallback).area<1e-12 and country.symmetric_difference(before_country).area<1e-12
for kind,g in [('land',land),('fallback',fallback),('country',country)]:
 value={'type':'FeatureCollection','features':[{'type':'Feature','id':'CHN-review-'+kind,'properties':{'countryCode':'CHN','pickable':False,'role':'reviewed-active-union'if kind=='land'else'neutral-physical-land-without-asserted-current-county'if kind=='fallback'else'exact-active-union-plus-neutral-preserved-physical-land'},'geometry':mapping(g)}]}
 b=raw(value);url='/data/precision/chn-review-'+kind+'.geojson';p=R/('public'+url);p.write_bytes(b);z=gzip.compress(b,compresslevel=9,mtime=0);p.with_suffix('.geojson.gz').write_bytes(z);assert len(z)<10_000_000 and len(b)<64*1024*1024
 a.update({kind+'Url':url,kind+'GzipUrl':url+'.gz',kind+'Bytes':len(b),kind+'GzipBytes':len(z)});a['sha256'][kind]=hashlib.sha256(b).hexdigest();a['sha256'][kind+'Gzip']=hashlib.sha256(z).hexdigest();a.pop(kind+'GzipParts',None)
a['suppressedIds']=sorted(suppressed);a['renderCount']=len(active)
for fid in review['suppressedIds']:a['legacyAliases'][fid]=fid
m['retiredRegions'].update(review['historicalRegions'])
a['checks']['identityReview']={'addedSuppressedIds':review['suppressedIds'],'currentRenderCount':len(active),'primaryGeometryUnchanged':True,'physicalCountryDifferenceAreaDeg2':country.symmetric_difference(before_country).area,'neutralAreaDeg2':fallback.area}
m['audit']['identityReview']=a['checks']['identityReview']
notice='确证已撤销的旧身份仅供历史足迹使用；其旧陆域保留为中性陆地，不推断现行县级归属。'
if notice not in m['coveragePatch']['coverageNote']:m['coveragePatch']['coverageNote']+=' '+notice
# Empty replacement arrays must never leave a second Natural Earth coast visible.
world=read(D/'world.geojson');worldids=[f['id']for f in world['features']if f['properties']['countryCode']=='CHN']
a['replaceWorldIds']=worldids;a['worldIds']=worldids
save(D/'current-central-china.json',m)
for name in ['current-east-china.json','current-zhejiang.json']:
 old=read(D/name);old['alignment']['replaceWorldIds']=worldids;old['alignment']['worldIds']=worldids;save(D/name,old)
print('Reviewed China active regions:',len(active),'neutral land retained; country change',country.symmetric_difference(before_country).area)
