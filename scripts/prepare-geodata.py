#!/usr/bin/env python3
"""Reproduce the map's attributed GeoJSON. Python 3 + Node/npm are required.

python3 scripts/prepare-geodata.py --validate
python3 scripts/prepare-geodata.py --cache-dir /tmp/light-earth-geodata

Pinned source URLs are recorded in public/data/sources.json. Local layers use
geoBoundaries' supplied simplified geometries, then shared-topology mapshaper
simplification. This is a visualization dataset, not a current boundary register.
"""
import argparse, hashlib, json, math, pathlib, subprocess, urllib.request
ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'public/data'
COUNTRIES = [
    ('CHN', '中国', 'ADM3', '县 / 县级市 / 市辖区', '10%'),
    ('JPN', '日本', 'ADM2', '市町村等地方区域', '45%'),
    ('USA', '美国', 'ADM2', '县及县级等同区域', '60%'),
]

def read(path):
    return json.loads(path.read_text(encoding='utf-8'))

def write(path, data, pretty=False):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2 if pretty else None,
                              separators=None if pretty else (',', ':'), allow_nan=False) + '\n', encoding='utf-8')

def merge_coverage(existing, rebuilt):
    # Rebuilding the original three layers must preserve global additions and
    # their source metadata. Keep supplemental metadata on rebuilt rows too.
    by_code = {item['code']: dict(item) for item in existing}
    for item in rebuilt:
        by_code[item['code']] = {**by_code.get(item['code'], {}), **item}
    return [by_code[code] for code in sorted(by_code)]

def download(url, path):
    if path.exists():
        return
    req = urllib.request.Request(url, headers={'User-Agent': 'LightTheEarth/1.0 dataset preparation'})
    with urllib.request.urlopen(req, timeout=180) as response:
        path.write_bytes(response.read())

def polygons(geometry):
    return geometry['coordinates'] if geometry['type'] == 'MultiPolygon' else [geometry['coordinates']]

def signed_area(ring):
    return sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(ring, ring[1:])) / 2

def point_in_ring(point, ring):
    x,y = point
    inside = False
    for (ax,ay),(bx,by) in zip(ring,ring[1:]):
        if (ay > y) != (by > y) and x < (bx-ax)*(y-ay)/(by-ay)+ax:
            inside = not inside
    return inside

def point_in_polygon(point, polygon):
    return point_in_ring(point, polygon[0]) and not any(point_in_ring(point, hole) for hole in polygon[1:])

def spatial(geometry, preferred=None):
    polys = polygons(geometry)
    coords = [p for poly in polys for ring in poly for p in ring]
    bbox = [min(p[0] for p in coords), min(p[1] for p in coords), max(p[0] for p in coords), max(p[1] for p in coords)]
    # Center the largest polygon, rather than an ocean between distant islands.
    poly = max(polys, key=lambda p: abs(signed_area(p[0])))
    ring = poly[0]
    area = signed_area(ring)
    if preferred and all(math.isfinite(v) for v in preferred):
        center = preferred
    elif abs(area) > 1e-12:
        center = [sum((a[k]+b[k])*(a[0]*b[1]-b[0]*a[1]) for a,b in zip(ring,ring[1:]))/(6*area) for k in [0,1]]
    else:
        center = ring[0]
    if not preferred and not point_in_polygon(center,poly):
        # Choose the longest interior horizontal segment for concave polygons.
        ymin,ymax = min(p[1] for p in ring),max(p[1] for p in ring)
        candidates=[]
        for fraction in [0.5,0.35,0.65,0.2,0.8]:
            y=ymin+(ymax-ymin)*fraction
            xs=sorted(ax+(bx-ax)*(y-ay)/(by-ay) for r in poly for (ax,ay),(bx,by) in zip(r,r[1:]) if (ay>y)!=(by>y))
            for a,b in zip(xs[::2],xs[1::2]):
                point=[(a+b)/2,y]
                if point_in_polygon(point,poly):candidates.append((b-a,point))
        if candidates:center=max(candidates)[1]
    return [round(v,5) for v in center], [round(v,5) for v in bbox]

def validate():
    report=[]
    seen=set()
    for filename in ['world.geojson','chn.geojson','jpn.geojson','usa.geojson']:
        path=OUT/filename
        collection=read(path)
        assert collection['type']=='FeatureCollection'
        for f in collection['features']:
            p=f['properties'];g=f['geometry']
            assert f['type']=='Feature' and g['type'] in ['Polygon','MultiPolygon'], (filename,p.get('id'))
            assert f['id']==p['id'] and p['id'] not in seen, p['id']
            seen.add(p['id'])
            for field in ['name','countryCode','countryName','level','adminLevel','source','year']:
                assert isinstance(p[field],str) and p[field], (filename,p['id'],field)
            assert len(p['center'])==2 and len(p['bbox'])==4
            assert all(math.isfinite(v) for v in p['center']+p['bbox'])
            assert -180<=p['center'][0]<=180 and -90<=p['center'][1]<=90
            assert polygons(g)
            for poly in polygons(g):
                assert poly
                for ring in poly:
                    assert len(ring)>=4 and ring[0]==ring[-1], p['id']
                    assert abs(signed_area(ring))>0, p['id']
                    for point in ring:
                        assert len(point)==2 and all(math.isfinite(v) for v in point)
                        assert -180.00001<=point[0]<=180.00001 and -90.00001<=point[1]<=90.00001
        report.append({'file':filename,'count':len(collection['features']),'bytes':path.stat().st_size,
                       'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
    coverage=read(OUT/'coverage.json')
    for item in coverage:
        dataset=read(ROOT/'public'/item['localUrl'].lstrip('/'))
        assert item['count']==len(dataset['features'])
        assert all(f['properties']['countryCode']==item['code'] for f in dataset['features'])
    return report

def prepare(cache):
    cache.mkdir(parents=True,exist_ok=True)
    sources=read(OUT/'sources.json')
    enrichment=read(OUT/'name-enrichment.json') if (OUT/'name-enrichment.json').exists() else {}
    world_path=cache/'world.geojson'
    download(sources['world']['url'],world_path)
    world=read(world_path);new=[]
    for f in world['features']:
        p=f['properties'];g=f['geometry']
        code=next((p[k] for k in ['ISO_A3_EH','ISO_A3','ADM0_A3'] if isinstance(p.get(k),str) and p[k]!='-99'),p['ADM0_A3'])
        name=p.get('NAME_ZH') or p.get('NAME_EN') or p['NAME']
        center,bbox=spatial(g,[p['LABEL_X'],p['LABEL_Y']])
        props={'id':f"NE-{p['NE_ID']}",'name':name,'originalName':p.get('NAME_EN') or p['NAME'],
               'aliases':list(dict.fromkeys(x for x in [p.get('NAME_EN'),p.get('NAME_ZHT'),code] if x)),
               'countryCode':code,'countryName':name,'level':'country','adminLevel':'ADM0','center':center,'bbox':bbox,
               'source':'Natural Earth 1:50m · Public Domain','year':'2022（源文件版本）'}
        new.append({'type':'Feature','id':props['id'],'properties':props,'geometry':g})
    write(OUT/'world.geojson',{'type':'FeatureCollection','features':new})
    coverage=[]
    for code,name,adm,label,percent in COUNTRIES:
        meta=sources['locals'][code]
        source_path=cache/f'{code}.geojson';compact=cache/f'{code}-compact.geojson'
        url=meta['simplifiedGeometryGeoJSON'].replace('https://github.com/wmgeolab/geoBoundaries/raw/','https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/')
        download(url,source_path)
        if not compact.exists():
            subprocess.run(['npx','--yes','mapshaper@0.7.95',str(source_path),'-simplify',percent,'keep-shapes','-o','precision=0.00001',str(compact)],check=True)
        original=read(source_path);local=read(compact)
        originals_by_id={f['properties']['shapeID']:f for f in original['features']}
        original_ids=set(originals_by_id)
        assert len(original_ids)==len(original['features'])
        for sid,entry in enrichment.items():
            if sid in originals_by_id:
                source_feature=originals_by_id[sid]
                assert source_feature['properties']['shapeName']==entry['originalName']
                assert any(point_in_polygon(entry['coordinate'],p) for p in polygons(source_feature['geometry'])), sid
        assert {f['properties']['shapeID'] for f in local['features']}==original_ids
        features=[];unnamed=0
        for f in local['features']:
            p=f['properties'];g=f['geometry'];sid=p['shapeID'];enriched=enrichment.get(sid,{})
            assert g, sid
            original_name=p.get('shapeName')
            if not original_name:unnamed+=1
            display=enriched.get('name') or original_name or f'未命名区域 · {sid[-7:]}'
            center,bbox=spatial(g)
            props={'id':f'GB-{sid}','name':display,'originalName':original_name or '',
                   'aliases':list(dict.fromkeys(x for x in [original_name,*enriched.get('aliases',[])] if x)),
                   'countryCode':code,'countryName':name,'level':'local','adminLevel':adm,'center':center,'bbox':bbox,
                   'source':f"geoBoundaries gbOpen · {meta['boundarySource']}",'year':meta['boundaryYearRepresented']}
            if enriched:
                props['nameSource']=enriched['nameSource']
                if enriched.get('parentName'):props['parentName']=enriched['parentName']
            features.append({'type':'Feature','id':props['id'],'properties':props,'geometry':g})
        write(OUT/f'{code.lower()}.geojson',{'type':'FeatureCollection','features':features})
        note=f"{meta['boundaryYearRepresented']} 年历史边界，用于旅行记录展示；简化版实载 {len(features):,} 区域。"
        if len(features)!=int(meta['admUnitCount']):note+=f"源元数据记载 {int(meta['admUnitCount']):,}，与简化下载版存在差异。"
        if code=='CHN':note+='以来源覆盖的县、县级市及市辖区为单位；多数名称沿用源英文，部分已核对中文。'
        if code=='JPN':note+='来源层级标注 Subprefectures，实际含市町村及东京特别区，层级并非完全一致。'
        if code=='USA':note+='含县、县级等同区域及来源收录的属地区域；县名可能重名。'
        if unnamed:note+=f'其中 {unnamed} 个区域原名称为空，保留源 ID。'
        coverage.append({'code':code,'name':name,'localUrl':f'/data/{code.lower()}.geojson','adminLevel':adm,'label':label,
                         'year':meta['boundaryYearRepresented'],'source':f"geoBoundaries gbOpen · {meta['boundarySource']}",
                         'license':f"geoBoundaries CC BY 4.0；原始来源：{meta['boundaryLicense']}",
                         'coverageNote':note,'count':len(features),
                         'bytes':(OUT/f'{code.lower()}.geojson').stat().st_size})
    coverage_path=OUT/'coverage.json'
    existing=read(coverage_path) if coverage_path.exists() else []
    write(coverage_path,merge_coverage(existing,coverage),True)
    report=validate()
    write(OUT/'validation.json',{'retrievedAt':'2026-10-22','checks':['unique global IDs','feature.id matches properties.id','finite coordinates and viewport metadata','closed nonzero polygon rings','original simplified-source feature IDs preserved','coverage counts match files'],'files':report},True)
    print(json.dumps(report,ensure_ascii=False,indent=2))

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--cache-dir',type=pathlib.Path,default=ROOT/'.cache/geodata')
    parser.add_argument('--validate',action='store_true')
    args=parser.parse_args()
    if args.validate:print(json.dumps(validate(),ensure_ascii=False,indent=2))
    else:prepare(args.cache_dir)
