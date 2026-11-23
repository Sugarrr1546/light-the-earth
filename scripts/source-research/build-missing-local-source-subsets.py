"""Rebuild source subsets without changing original geometries or source IDs.
Run from project root using outputs/geodata-venv/bin/python.
Prerequisites: original geoBoundaries caches, Geofabrik extracted admin GeoJSON,
and the two saved Nominatim full polygon results (Carmo/Grouville).
"""
import json,pathlib
from shapely.geometry import shape
p=pathlib.Path('outputs/boundary-supplements')
def read(n):return json.load(open(p/n))
def write(code,features):
 out=p/f'local-selected-{code}.geojson';out.write_text(json.dumps({'type':'FeatureCollection','features':features},ensure_ascii=False));print(code,len(features))
def nomin(name,relation):
 x=next(f for f in read(name) if f['osm_type']=='relation' and f['osm_id']==relation)
 return {'type':'Feature','id':f'OSM-relation-{relation}','properties':{'name':x.get('name') or x['display_name'].split(',')[0],'admin_level':'6' if relation==5758865 else '8','boundary':'administrative','sourceId':f'relation/{relation}','sourceURL':f'https://www.openstreetmap.org/relation/{relation}','license':'ODbL 1.0','copyright':'© OpenStreetMap contributors'},'geometry':x['geojson']}
channel=read('guernsey-jersey-latest.osm.admin.geojson')['features']
jey=[f for f in channel if f['properties'].get('name') and f['properties']['admin_level']=='8' and shape(f['geometry']).centroid.x>-2.4]
jey.append(nomin('nominatim-JEY-Grouville.json',9238571));write('JEY',jey)
ggy=[f for f in channel if f['properties'].get('name') and ((f['properties']['admin_level']=='8' and shape(f['geometry']).centroid.x<-2.4) or (f['properties']['admin_level']=='4' and f['properties']['name'] in ['Alderney','Sark']))];write('GGY',ggy)
for code,name,level in [('IMN','isle-of-man','8'),('FRO','faroe-islands','7'),('MAC','macau','6')]:
 a=[f for f in read(name+'-latest.osm.admin.geojson')['features'] if f['properties']['admin_level']==level]
 if code=='MAC':a.append(nomin('nominatim-MAC-Carmo.json',5758865))
 write(code,a)
a=read('cook-islands-latest.osm.admin.geojson')['features'];write('COK',[f for f in a if f['properties']['name']!='Rarotonga'])
# Named, complete 16 Åland municipalities. World coastline filtering would
# erroneously discard small islands and offshore municipal geometry.
aland={'Eckerö','Föglö','Hammarland','Saltvik','Brändö','Jomala','Kumlinge','Lemland','Vårdö','Geta','Sund','Lumparland','Kökar','Sottunga','Finström','Mariehamn'}
a=json.load(open('outputs/global-geodata-cache/FIN-ADM3-source.geojson'))['features'];write('ALA',[f for f in a if f['properties']['shapeName'] in aland])
# These are display-scope subsets only, not assertions of sovereignty. A source
# polygon is retained whole if >50% of its area lies inside the existing world
# display region; no boundaries or units are invented. Border units can differ.
world=json.load(open('public/data/world.geojson'))['features']
for code,parent in [('CYN','CYP'),('SOL','SOM')]:
 area=shape(next(f['geometry'] for f in world if f['properties']['countryCode']==code));a=json.load(open(f'outputs/global-geodata-cache/{parent}-ADM2-source.geojson'))['features'];kept=[]
 for f in a:
  geom=shape(f['geometry'])
  if geom.intersection(area).area/geom.area>.5:kept.append(f)
 write(code,kept)
# Six actual Cayman admin_level8 districts. Source geometries are from saved
# Nominatim results; OSM official relation API supplies authoritative OSM tags.
import xml.etree.ElementTree as ET
raw=ET.parse(p/'osm-CYM-relation-metadata.xml').getroot()
tags={int(x.attrib['id']):{v.attrib['k']:v.attrib['v'] for v in x.findall('tag')} for x in raw.findall('relation')};features=[]
for n in ['West-Bay','George-Town','Bodden-Town','North-Side','East-End','Sister-Islands']:
 x=next(x for x in read('nominatim-CYM-'+n+'.json') if x.get('category')=='boundary' and x['type']=='administrative' and x['geojson']['type'] in ['Polygon','MultiPolygon']);t=tags[x['osm_id']]
 features.append({'type':'Feature','id':'OSM-relation-'+str(x['osm_id']),'properties':{**t,'sourceId':'relation/'+str(x['osm_id']),'sourceURL':'https://www.openstreetmap.org/relation/'+str(x['osm_id']),'license':'ODbL 1.0','copyright':'© OpenStreetMap contributors'},'geometry':x['geojson']})
write('CYM',features)
