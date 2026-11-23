from pathlib import Path
import osmium,json,shutil,hashlib,sys
from shapely.geometry import shape,mapping
from shapely.ops import unary_union
from shapely import make_valid
from collections import Counter
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'outputs/boundary-supplements';OUT.mkdir(exist_ok=True)
CACHE=ROOT/'outputs/regional-research-cache'
FACTORY=osmium.geom.GeoJSONFactory()
CODES={'MDA':('MD','europe/moldova',8),'MUS':('MU','africa/mauritius',8),'MNE':('ME','europe/montenegro',6),'LBY':('LY','africa/libya',6),'ARE':('AE','asia/gcc-states',8),'BHR':('BH','asia/gcc-states',8),'GRL':('GL','north-america/greenland',5)}
class Handler(osmium.SimpleHandler):
 def __init__(self):
  super().__init__();self.rows=[];self.errors=[]
 def area(self,a):
  t=dict(a.tags)
  if t.get('boundary')!='administrative' or not t.get('admin_level'):return
  try:
   geo=json.loads(FACTORY.create_multipolygon(a));g=shape(geo)
   if not g.is_valid:g=make_valid(g)
   if g.is_empty or g.geom_type not in ['Polygon','MultiPolygon']:raise ValueError(g.geom_type)
   self.rows.append({'type':'Feature','id':('relation/'if a.from_way()==False else'way/')+str(a.orig_id()),'properties':{'osm_id':a.orig_id(),'osm_type':'relation'if a.from_way()==False else'way','admin_level':t['admin_level'],'name':t.get('name:en',t.get('name',str(a.orig_id()))),'originalName':t.get('name',''),'source':'OpenStreetMap contributors / Geofabrik','sourceURL':'https://www.openstreetmap.org/'+('relation/'if a.from_way()==False else'way/')+str(a.orig_id()),'timestamp':str(a.timestamp),'tags':t},'geometry':mapping(g)})
  except Exception as e:self.errors.append({'id':a.orig_id(),'tags':t,'error':str(e)})
def main(code):
 iso,path,level=CODES[code];pbf=OUT/(code+'.osm.pbf')
 if not pbf.exists():shutil.copyfile(CACHE/(code+'.osm.pbf'),pbf)
 h=Handler();h.apply_file(str(pbf),locations=True,idx='flex_mem')
 countries=[f for f in h.rows if f['properties']['admin_level']=='2'and any(f['properties']['tags'].get(k)==iso for k in ['ISO3166-1','ISO3166-1:alpha2'])]
 if countries:
  country=unary_union([shape(f['geometry'])for f in countries]);method='Current OSM admin_level=2 country relation geometry; representative point inside and >=90% area overlap'
 else:
  f=json.loads((ROOT/'public/data/global'/(code.lower()+'-adm1.geojson')).read_text());country=unary_union([shape(x['geometry'])for x in f['features']]);method='Existing geoBoundaries ADM1 union; representative point inside and >=90% area overlap'
 selected=[]
 for f in h.rows:
  if f['properties']['admin_level']!=str(level):continue
  g=shape(f['geometry']);point=g.representative_point()
  if country.buffer(0.00001).covers(point)and country.intersection(g).area/g.area>=0.9:
   selected.append(f)
 allp=OUT/(code+'-OSM-admin-all.geojson');allp.write_text(json.dumps({'type':'FeatureCollection','features':h.rows},ensure_ascii=False,separators=(',',':')))
 dest=OUT/(code+'-OSM-level'+str(level)+'.geojson');dest.write_text(json.dumps({'type':'FeatureCollection','features':selected},ensure_ascii=False,separators=(',',':')))
 meta={'code':code,'source':'OpenStreetMap contributors, Geofabrik extract','sourceURL':'https://download.geofabrik.de/'+path+'.html','downloadURL':'https://download.geofabrik.de/'+path+'-latest.osm.pbf','license':'ODbL 1.0','licenseURL':'https://www.openstreetmap.org/copyright','pbfSHA256':hashlib.sha256(pbf.read_bytes()).hexdigest(),'pbfBytes':pbf.stat().st_size,'osmHeader':None,'allAdminCounts':dict(Counter(f['properties']['admin_level']for f in h.rows)),'selectedOSMAdminLevel':str(level),'selectedCount':len(selected),'selectedFile':str(dest.relative_to(ROOT)),'countryRelations':[f['id']for f in countries],'filterMethod':method,'partial':True,'partialNote':'Completeness requires comparison to official unit lists; OSM precision/coverage is contributor-maintained. No missing polygons invented.','errors':h.errors}
 (OUT/(code+'-OSM-metadata.json')).write_text(json.dumps(meta,ensure_ascii=False,indent=2));print(code,json.dumps(meta,ensure_ascii=False),flush=True)
for c in sys.argv[1:]:main(c)
