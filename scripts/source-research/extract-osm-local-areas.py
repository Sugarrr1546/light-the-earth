"""Reproducible OSM admin area extraction. Usage: venv/python script path.osm.pbf
Data source: Geofabrik daily OpenStreetMap extract; ODbL 1.0.
No geometries are invented; PyOsmium assembles relation multipolygons.
"""
import osmium, json, sys, pathlib, collections
class Handler(osmium.SimpleHandler):
 def __init__(self):
  super().__init__();self.features=[];self.errors=[];self.factory=osmium.geom.GeoJSONFactory()
 def area(self,a):
  tags=dict(a.tags)
  if tags.get('boundary')!='administrative' or tags.get('admin_level') in [None,'1','2','3']:return
  try:
   geom=json.loads(self.factory.create_multipolygon(a));ident=('way' if a.from_way() else 'relation')+'/'+str(a.orig_id());self.features.append({'type':'Feature','id':'OSM-'+ident.replace('/','-'),'properties':{**tags,'sourceId':ident,'sourceURL':'https://www.openstreetmap.org/'+ident,'license':'ODbL 1.0','copyright':'© OpenStreetMap contributors'},'geometry':geom})
  except Exception as e:self.errors.append({'id':a.id,'error':str(e)})
for path in sys.argv[1:]:
 p=pathlib.Path(path);h=Handler();h.apply_file(str(p),locations=True,idx='flex_mem');out=p.with_suffix('.admin.geojson');out.write_text(json.dumps({'type':'FeatureCollection','features':h.features},ensure_ascii=False));print(p.name,len(h.features),collections.Counter(f['properties']['admin_level'] for f in h.features),len(h.errors),flush=True)
