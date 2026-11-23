"""Derive TTO's 15 local jurisdictions from the pinned Natural Earth source.
Run from project root. Preserve original16; dissolve Eastern/Western Tobago.
See sources-supplements.json and TTO-naturalearth-metadata for official structure.
"""
import json,pathlib
from shapely.geometry import shape,mapping
from shapely.ops import unary_union
p=pathlib.Path('outputs/boundary-supplements')
a=json.load(open(p/'natural-earth-admin1.geojson'))['features']
a=[f for f in a if f['properties'].get('adm0_a3')=='TTO']
b=[f for f in a if 'Tobago' in str(f['properties'].get('name'))]
assert len(a)==16 and len(b)==2
rest=[f for f in a if f not in b]
rest.append({'type':'Feature','id':'ne/TTO-Tobago','properties':{'ne_id':None,'name':'Tobago','adm0_a3':'TTO','mergedSourceIDs':[f['properties']['ne_id'] for f in b]},'geometry':mapping(unary_union([shape(f['geometry']) for f in b]))})
(p/'TTO-naturalearth-local15.geojson').write_text(json.dumps({'type':'FeatureCollection','features':rest},ensure_ascii=False))
