#!/usr/bin/env python3
"""Build pinned geoBoundaries FRA ADM5, without mutating shared manifests.

Run after the base/alignment builders. A parent integration step merges the
coverage/alignment records in precision-france.json. All 35,010 source IDs are
retained; the 129 overseas records are suppressed in metropolitan picking because
GLP/GUF/MTQ/MYT/REU have independent country layers. The land/country silhouette
is the exact union of the 34,881 unsuppressed output polygons.
"""
import argparse, collections, datetime, gzip, hashlib, json, math, pathlib, re, subprocess, urllib.request
from shapely import make_valid
from shapely.geometry import shape, mapping, MultiPolygon, Point
from shapely.ops import unary_union
ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA = ROOT/'public/data'
CACHE = ROOT/'outputs/france-communes-cache'
OUT = DATA/'precision'
SOURCE_SHA = '35ca1a1c457d3f8911a78f614257c7d623970f6efb8bed3ec62c5c51c7b6468b'


def read(p): return json.loads(p.read_text())
def write(p, obj, pretty=False):
    p.parent.mkdir(parents=True, exist_ok=True)
    data = (json.dumps(obj, ensure_ascii=False, allow_nan=False, indent=2 if pretty else None,
                       separators=None if pretty else (',', ':'))+'\n').encode()
    p.write_bytes(data)
    return data

def sha_bytes(data): return hashlib.sha256(data).hexdigest()
def sha(p): return sha_bytes(p.read_bytes())
def parts(g):
    if g.geom_type == 'Polygon': return [g]
    return [p for c in getattr(g, 'geoms', []) for p in parts(c)]
def polygon(g):
    if not g.is_valid: g = make_valid(g)
    ps = parts(g)
    if not ps: raise ValueError('No polygon area')
    result = ps[0] if len(ps) == 1 else MultiPolygon(ps)
    if result.is_empty or not result.is_valid: raise ValueError('Invalid polygon')
    return result

def vertices(c):
    return 1 if isinstance(c[0], (int, float)) else sum(vertices(x) for x in c)

def pack(path, fc):
    raw = write(path, fc)
    zipped = gzip.compress(raw, compresslevel=9, mtime=0)
    path.with_suffix(path.suffix+'.gz').write_bytes(zipped)
    assert len(raw) < 48_000_000, (path, len(raw))
    assert len(zipped) < 10_000_000, (path, len(zipped))
    return {'url': '/data/precision/'+path.name, 'gzipUrl': '/data/precision/'+path.name+'.gz',
            'bytes': len(raw), 'gzipBytes': len(zipped), 'sha256': sha_bytes(raw),
            'gzipSHA256': sha_bytes(zipped)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--mapshaper', type=pathlib.Path)
    args = parser.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    meta = next(x for x in read(DATA/'sources-global.json')['catalog']
                if x['boundaryISO']=='FRA' and x['boundaryType']=='ADM5')
    source_url = meta['simplifiedGeometryGeoJSON'].replace(
        'https://github.com/wmgeolab/geoBoundaries/raw/',
        'https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/')
    assert '/9469f09/' in source_url
    source_path = CACHE/'FRA-ADM5-source.geojson'
    if not source_path.exists():
        request = urllib.request.Request(source_url, headers={'User-Agent':'LightTheEarth/1.0'})
        with urllib.request.urlopen(request, timeout=240) as response: source_path.write_bytes(response.read())
    assert sha(source_path) == SOURCE_SHA, 'Pinned source hash changed; explicitly audit before updating'
    original = read(source_path)
    source_ids = {f['properties']['shapeID'] for f in original['features']}
    assert len(source_ids) == len(original['features']) == 35010
    detail_path = CACHE/'FRA-ADM5-detail.geojson'
    command = ['node', str(args.mapshaper)] if args.mapshaper else ['npx', '--yes', 'mapshaper@0.7.95']
    # Shared topology; retain 75% of simplifiable vertices from the provider's
    # simplified source. Six decimals retain sub-metre coordinate precision.
    subprocess.run([*command, str(source_path), '-simplify', '75%', 'keep-shapes',
                    '-o', 'precision=0.000001', 'force', str(detail_path)], check=True)
    detail = read(detail_path)
    assert {f['properties']['shapeID'] for f in detail['features']} == source_ids
    original_by_id = {f['properties']['shapeID']:f for f in original['features']}
    overseas = {c['code']: c for c in read(DATA/'coverage.json') if c['code'] in ['GLP','GUF','MTQ','MYT','REU']}
    overseas_geometries = {code: unary_union([shape(f['geometry']) for f in
        read(ROOT/'public'/c['localUrl'].lstrip('/'))['features']]) for code,c in overseas.items()}
    features, geoms, suppress, restored, repairs = [], [], [], [], []
    groups = collections.defaultdict(list)
    for f in detail['features']:
        p = f['properties']; sid = p['shapeID']; ident = 'GB-'+sid
        g = shape(f['geometry'])
        if not g.is_valid: repairs.append(ident)
        try: g = polygon(g)
        except ValueError:
            g = polygon(shape(original_by_id[sid]['geometry'])); restored.append(ident)
        b = list(g.bounds)
        assert -180 <= b[0] <= b[2] <= 180 and -90 <= b[1] <= b[3] <= 90
        pt = max(parts(g), key=lambda x:x.area).representative_point()
        center = [round(pt.x, 6), round(pt.y, 6)]
        assert g.covers(Point(*center)), ident
        name = str(p.get('shapeName') or '')
        props = {'id':ident,'name':name or '未命名区域 · '+sid[-7:], 'originalName':name,
                 'aliases':[], 'countryCode':'FRA','countryName':'法国','level':'local','adminLevel':'ADM5',
                 'center':center,'bbox':[round(x,6) for x in b],
                 'source':'geoBoundaries gbOpen · '+meta['boundarySource'],'year':meta['boundaryYearRepresented']}
        features.append({'type':'Feature','id':ident,'properties':props,'geometry':mapping(g)})
        if not (-6 < pt.x < 11 and 41 < pt.y < 52):
            # Match against actual overseas polygons, not invented admin codes.
            code = next((c for c,u in overseas_geometries.items() if u.covers(pt)),None)
            if code is None:
                code = max(overseas_geometries, key=lambda c:g.intersection(overseas_geometries[c]).area)
                assert g.intersection(overseas_geometries[code]).area/g.area > .5
            groups[code].append(ident); suppress.append(ident)
        else: geoms.append(g)
    assert all(original_by_id[f['id'][3:]]['properties']['shapeName'] == f['properties']['originalName'] for f in features)
    assert len(features) == 35010 and len(suppress) == 129 and len(geoms) == 34881
    assert {c:len(ids) for c,ids in groups.items()} == {'GLP':32,'GUF':22,'MTQ':34,'REU':24,'MYT':17}
    local = pack(OUT/'fra-adm5.geojson', {'type':'FeatureCollection','features':features})
    union = polygon(unary_union(geoms))
    land_fc = {'type':'FeatureCollection','features':[{'type':'Feature','id':'precision-land-FRA',
        'properties':{'countryCode':'FRA','derivedFrom':'exact union of unsuppressed ADM5 polygons'},'geometry':mapping(union)}]}
    land = pack(OUT/'fra-land.geojson', land_fc)
    # A separate country URL provides the complete same-source metropolitan
    # silhouette. Overseas territory countries retain their independent layers.
    country = pack(OUT/'fra-country.geojson', land_fc)
    reread = read(OUT/'fra-adm5.geojson')
    selected = [shape(f['geometry']) for f in reread['features'] if f['id'] not in set(suppress)]
    reread_union = unary_union(selected)
    symdiff = union.symmetric_difference(reread_union).area
    assert symdiff < 1e-9
    old = next(c for c in read(DATA/'coverage.json') if c['code']=='FRA')
    legacy_url = '/data/global/fra-adm3.geojson'
    legacy = read(ROOT/'public'/legacy_url.lstrip('/'))
    assert len(legacy['features']) == 320
    fixture_counts = {}
    for city,expected in [('Paris',20),('Lyon',9),('Marseille',16)]:
        fs = [f for f in features if re.fullmatch(city+r' \d+(?:er|e) Arrondissement',f['properties']['name'])]
        assert len(fs) == expected
        fixture_counts[city] = {'count':len(fs),'features':[{'id':f['id'],'name':f['properties']['name'],'center':f['properties']['center']} for f in fs]}
    controls = {}
    for city,xy in [('Paris',[2.3522,48.8566]),('Lyon',[4.8357,45.7640]),('Marseille',[5.3698,43.2965]),('Bordeaux',[-0.5792,44.8378]),('Nice',[7.2620,43.7102])]:
        hits = [f for f in features if f['id'] not in suppress and shape(f['geometry']).covers(Point(*xy))]
        assert len(hits)==1,(city,len(hits))
        controls[city]={'point':xy,'id':hits[0]['id'],'name':hits[0]['properties']['name']}
    coverage = {**old,'localUrl':local['url'],'gzipUrl':local['gzipUrl'], 'adminLevel':'ADM5',
       'label':'市镇／市级地方行政区','canonical':meta['boundaryCanonical'],'year':meta['boundaryYearRepresented'],
       'count':35010,'displayCount':34881,'renderCount':34881,'bytes':local['bytes'],'gzipBytes':local['gzipBytes'],
       'source':'geoBoundaries gbOpen · '+meta['boundarySource'],
       'sourceUrl':'https://www.geoboundaries.org/api/current/gbOpen/FRA/ADM5/',
       'license':'geoBoundaries CC BY 4.0；原始目录标注：'+meta['boundaryLicense']+'；原始许可链接：Etalab Licence Ouverte',
       'coverageNote':'2020年历史边界；源载35,010个市镇／市级地方单元，含Paris 20、Lyon 9、Marseille 16个市辖区。法国本土与科西嘉显示34,881个；另129个海外市镇由独立属地图层显示。',
       'detailTier':'local','legacyUrls':list(dict.fromkeys([*old.get('legacyUrls',[]),legacy_url])),
       'bbox':list(union.bounds),'center':[2.55227,46.69611]}
    alignment = {'localUrl':local['url'],'localGzipUrl':local['gzipUrl'],'landUrl':land['url'],'landGzipUrl':land['gzipUrl'],
       'countryUrl':country['url'],'countryGzipUrl':country['gzipUrl'],'count':35010,'renderCount':34881,
       'suppressedIds':sorted(suppress),'legacyAliases':{},'localBytes':local['bytes'],'landBytes':land['bytes'],
       'countryBytes':country['bytes'],'localGzipBytes':local['gzipBytes'],'landGzipBytes':land['gzipBytes'],'countryGzipBytes':country['gzipBytes'],
       'sha256':{'local':local['sha256'],'land':land['sha256'],'country':country['sha256']},
       'gzipSHA256':{'local':local['gzipSHA256'],'land':land['gzipSHA256'],'country':country['gzipSHA256']},
       'source':coverage['source'],'sourceUrl':source_url,'sourceYear':meta['boundaryYearRepresented'],
       'sourceSHA256':SOURCE_SHA,'license':coverage['license'],'replaceWorldIds':['NE-1159320637'],
       'preparation':'mapshaper@0.7.95 shared topology, 75% simplifiable vertices retained, keep-shapes, coordinate precision=0.000001 degrees; exact union of 34,881 unsuppressed normalized polygons'}
    index = [{'id':f['id'],'name':f['properties']['name'],'originalName':f['properties']['originalName'],
              'center':f['properties']['center'],'suppressed':f['id'] in set(suppress)} for f in features]
    write(ROOT/'outputs/france-search-index.json',index)
    report = {'version':1,'generatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
       'coverage':coverage,'alignment':alignment,'metadata':meta,'downloadUrl':source_url,
       'sourceCommit':'9469f09','sourceSHA256':SOURCE_SHA,'sourceBytes':source_path.stat().st_size,
       'sourceCount':35010,'metadataCount':int(meta['admUnitCount']),'idsPreserved':True,
       'assets':{'local':local,'land':land,'country':country},'overseasSuppressedByDisplayCode':dict(groups),
       'legacy':{'urls':[legacy_url],'count':320,'ids':[f['id'] for f in legacy['features']],
                 'paintIntegration':'Keep all 320 old ADM3 IDs in the historical FRA paint package; do not add to primary picking.'},
       'checks':{'sourceAndOutputIdSetsEqual':True,'allIdsUnique':True,'allGeometriesValidNonempty':True,
          'finiteWGS84Coordinates':True,'allCentersCovered':True,'sourceVertices':sum(vertices(f['geometry']['coordinates']) for f in original['features']),
          'outputVertices':sum(vertices(f['geometry']['coordinates']) for f in features),'sameSourceLandSymmetricDifferenceDeg2':symdiff,
          'renderCount':len(geoms),'repairedGeometryIds':repairs,'restoredSourceGeometryIds':restored,'cityControls':controls},
       'municipalArrondissementFixtures':fixture_counts,
       'limitations':['Historical 2020 source; no claim of 2026 official boundaries.',
          'Source mixes communes and municipal arrondissements; Paris, Lyon and Marseille use 20, 9 and 16 arrondissement municipal polygons. No synthetic parent city faces were added.',
          'All 129 overseas source records retained but suppressed from FRA display to avoid duplicate GLP/GUF/MTQ/MYT/REU picking; those layers retain their own historical sources and IDs.',
          'geoBoundaries labels the source license Open Data Commons Attribution License 1.0, but its pinned licenseSource URL points to the Etalab Licence Ouverte PDF. Both statements are retained without silently resolving the discrepancy.',
          'Provider-simplified historical administrative boundaries can include water and omit small coastal details. Exact land union matches displayed polygons, not survey-quality coastlines.']}
    write(DATA/'precision-france.json',report)
    write(ROOT/'outputs/france-communes-report.json',report,True)
    print(json.dumps({'local':local,'land':land,'checks':report['checks']},ensure_ascii=False,indent=2))

if __name__ == '__main__': main()
