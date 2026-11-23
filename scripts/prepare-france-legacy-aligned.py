#!/usr/bin/env python3
"""Map historical ADM3 memory IDs to whole current displayed commune unions.

No clipped administrative lines or nearest-neighbour guesses are generated.
Largest polygon intersection chooses the legacy parent; low-dominance cases are
reported. This is a display crosswalk across 2020/2022 source snapshots, not a
claim that historical parent boundaries equalled present commune membership.
"""
import collections, datetime, gzip, hashlib, json, pathlib
from shapely import STRtree
from shapely.geometry import shape, mapping
from shapely.ops import unary_union
ROOT=pathlib.Path(__file__).resolve().parents[1]
DATA=ROOT/'public/data'
OUT=DATA/'precision/fra-legacy-aligned.geojson'
CACHE=ROOT/'outputs'

def read(p):return json.loads(p.read_text())
def encode(x):return (json.dumps(x,ensure_ascii=False,separators=(',',':'),allow_nan=False)+'\n').encode()
def sha(b):return hashlib.sha256(b).hexdigest()
def write(p,x):p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(encode(x))

def main():
 meta=read(DATA/'precision-france.json')
 current_path=ROOT/'public'/meta['alignment']['localUrl'].lstrip('/')
 current=read(current_path)
 old_path=DATA/'global/fra-adm3.geojson';old=read(old_path)
 suppress=set(meta['alignment']['suppressedIds'])
 local=[f for f in current['features'] if f['id'] not in suppress]
 old_geoms=[shape(f['geometry']) for f in old['features']]
 tree=STRtree(old_geoms)
 children=collections.defaultdict(list)
 crosswalk={};unmatched=[];ambiguous=[];minimum_dominance=1.0;matches=[]
 for f in local:
  g=shape(f['geometry'])
  candidates=[]
  for idx in tree.query(g,predicate='intersects'):
   area=g.intersection(old_geoms[int(idx)]).area
   if area>0:candidates.append((area,old['features'][int(idx)]['id']))
  candidates.sort(key=lambda x:(-x[0],x[1]))
  if not candidates:
   unmatched.append({'communeId':f['id'],'name':f['properties']['name'],'areaDeg2':g.area})
   continue
  best,parent=candidates[0]
  ratio=best/g.area
  assert 0<ratio<=1.0000001
  minimum_dominance=min(minimum_dominance,ratio)
  crosswalk[f['id']]=parent;children[parent].append((f,g))
  matches.append(ratio)
  if ratio<.9:
   ambiguous.append({'communeId':f['id'],'name':f['properties']['name'],'assignedTo':parent,
     'dominantAreaFraction':ratio,'candidates':[{'legacyId':i,'areaFraction':a/g.area} for a,i in candidates]})
 fs=[];fallback=[];audit=[]
 for f in old['features']:
  assigned=children[f['id']]
  if assigned:
   union=unary_union([g for _,g in assigned])
   assert union.geom_type in ('Polygon','MultiPolygon') and union.is_valid and not union.is_empty
   point=max(list(union.geoms),key=lambda x:x.area).representative_point() if union.geom_type=='MultiPolygon' else union.representative_point()
   props={**f['properties'],'center':[point.x,point.y],'bbox':list(union.bounds),
     'geometryYear':'2020','geometryDerivedFrom':'union of largest-intersection assigned displayed ADM5 communes'}
   fs.append({**f,'properties':props,'geometry':mapping(union)})
   audit.append({'id':f['id'],'name':f['properties']['name'],'childCount':len(assigned),'usedLegacyGeometry':False})
  else:
   fs.append(f);fallback.append({'id':f['id'],'name':f['properties']['name'],'reason':'No unsuppressed ADM5 commune has this ADM3 polygon as its largest positive area overlap; retain exact legacy geometry.'})
   audit.append({'id':f['id'],'name':f['properties']['name'],'childCount':0,'usedLegacyGeometry':True})
 assert len(fs)==320 and {f['id'] for f in fs}=={f['id'] for f in old['features']}
 actual=unary_union([shape(f['geometry']) for f in fs if children[f['id']]])
 assigned_union=unary_union([g for pairs in children.values() for _,g in pairs])
 difference=actual.symmetric_difference(assigned_union).area
 assert difference<1e-9
 target=next(f for f in fs if f['id']=='GB-44848369B51463791161265')
 target_parts=children[target['id']]
 assert target_parts
 target_union=unary_union([g for _,g in target_parts])
 assert target_union.symmetric_difference(shape(target['geometry'])).area==0
 raw=encode({'type':'FeatureCollection','features':fs});zipped=gzip.compress(raw,compresslevel=9,mtime=0)
 assert len(raw)<48_000_000 and len(zipped)<10_000_000
 OUT.write_bytes(raw);OUT.with_suffix(OUT.suffix+'.gz').write_bytes(zipped)
 assert gzip.decompress(OUT.with_suffix(OUT.suffix+'.gz').read_bytes())==raw
 crosswalk_file=CACHE/'france-legacy-crosswalk.json';write(crosswalk_file,crosswalk)
 record={'version':1,'generatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
  'countryCode':'FRA','legacyAlignedUrl':'/data/precision/fra-legacy-aligned.geojson',
  'legacyAlignedGzipUrl':'/data/precision/fra-legacy-aligned.geojson.gz','bytes':len(raw),'gzipBytes':len(zipped),
  'sha256':sha(raw),'gzipSHA256':sha(zipped),'count':len(fs),
  'source':{'legacyUrl':'/data/global/fra-adm3.geojson','legacySHA256':sha(old_path.read_bytes()),'legacyYear':'2022',
    'currentUrl':meta['alignment']['localUrl'],'currentSHA256':sha(current_path.read_bytes()),'currentYear':'2020'},
  'assignmentMethod':'For each unsuppressed ADM5 polygon, query STRtree for intersecting legacy ADM3 polygons, compute actual intersection area in WGS84 degree², assign whole polygon to positive maximum overlap (stable ID breaks exact ties). No nearest assignment, no clipping or synthetic dividing lines.',
  'communeToLegacyId':crosswalk,'legacyChildCounts':audit,
  'audit':{'inputLegacyCount':320,'inputVisibleCommuneCount':len(local),'assignedCommuneCount':len(crosswalk),
    'unmatchedCommunes':unmatched,'ambiguousThreshold':.9,'ambiguousAssignments':ambiguous,
    'minimumDominantAreaFraction':minimum_dominance,'retainedLegacyGeometry':fallback,
    'validNonemptyOutputCount':sum(shape(f['geometry']).is_valid and not shape(f['geometry']).is_empty for f in fs),
    'idsPreserved':True,'assignedUnionSymmetricDifferenceDeg2':difference,
    'chateaubriant':{'id':target['id'],'name':target['properties']['name'],'childCount':len(target_parts),
      'currentCommuneUnionSymmetricDifferenceDeg2':target_union.symmetric_difference(shape(target['geometry'])).area}},
  'limitations':['Color-only geometry mapping; saved visit IDs, metadata and administrative labels remain historical.',
    'The current ADM5 source represents2020 and legacy ADM3 source2022; parent assignment is a documented spatial display approximation, not official dated membership.',
    'Whole communes are assigned by largest positive overlap. Low-dominance cases are reported below0.9; their geometry remains the actual complete commune polygon.',
    'No geographically unmatched commune is assigned by proximity. Zero-child legacy IDs retain the old source geometry and are explicitly listed.',
    'Administrative geodata can include waters and source simplification. The aligned shape follows current displayed commune geometry, not a survey coastline.']}
 write(DATA/'precision-france-legacy.json',record)
 write(CACHE/'france-legacy-aligned-report.json',record)
 print(json.dumps({'bytes':len(raw),'gzipBytes':len(zipped),'audit':{k:v for k,v in record['audit'].items() if k!='ambiguousAssignments'},'ambiguousCount':len(ambiguous)},ensure_ascii=False,indent=2))

if __name__=='__main__':main()
