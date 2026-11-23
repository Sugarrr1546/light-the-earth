#!/usr/bin/env python3
"""Compose the 2026 Zhejiang mesh with the pinned historical China layer.

Run with outputs/geodata-venv/bin/python. Only this task's outputs are written;
merge current-zhejiang.json separately. The baseline commit and source hashes
make repeated runs independent of later shared-manifest edits. No individual
polygon simplification, buffering, gap filling, or boundary invention is used.
"""
import collections
import copy
import gzip
import hashlib
import html
import json
import math
import pathlib
import re
import subprocess
import urllib.request
import xml.etree.ElementTree as ET

import osmium
from shapely import STRtree, coverage_is_valid, make_valid
from shapely.geometry import MultiPolygon, Polygon, LineString, Point, mapping, shape
from shapely.ops import unary_union, polygonize_full
from shapely import union_all, orient_polygons
from pyproj import Geod

ROOT = pathlib.Path(__file__).resolve().parents[1]
CACHE = ROOT / 'outputs/current-china-cache'
OUT = ROOT / 'public/data/precision'
BASELINE = '4316998'
SNAPSHOT = '2026-10-25T21:21:21Z'
VERIFIED = '2026-10-27'
MCA = 'https://www.mca.gov.cn/mzsj/xzqh/2025/202401xzqh.html'
NO_CHANGE = 'https://www.hzzx.gov.cn/cshz/content/2026-01/08/content_9158827.htm'
COUNT = 'https://www.ezhejiang.gov.cn/2025-01/17/c_392859.htm'
LONGGANG = 'https://zjlg.gov.cn/col/col1229004099/index.html'
OSM = 'https://download.geofabrik.de/asia/china/zhejiang.html'
HANGZHOU = 'https://zfgb.hangzhou.gov.cn/18/106220253/t106220253064/528872.shtml'


def read(path):
    return json.loads(path.read_text())


def encode(value, pretty=False):
    return (json.dumps(value, ensure_ascii=False, allow_nan=False,
                       indent=2 if pretty else None,
                       separators=None if pretty else (',', ':')) + '\n').encode()


def write(path, value, pretty=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(encode(value, pretty))


def sha(data):
    return hashlib.sha256(data).hexdigest()


def baseline(path):
    return json.loads(subprocess.check_output(['git', 'show', f'{BASELINE}:{path}'], cwd=ROOT))


def fetch(url, path):
    if not path.exists():
        with urllib.request.urlopen(url, timeout=60) as response:
            path.write_bytes(response.read())


def polygonal(g):
    if not g.is_valid:
        g = make_valid(g)
    def parts(x):
        if x.geom_type == 'Polygon':
            return [x]
        return [p for sub in getattr(x, 'geoms', []) for p in parts(sub)]
    ps = parts(g)
    assert ps
    g = ps[0] if len(ps) == 1 else MultiPolygon(ps)
    assert g.is_valid and not g.is_empty
    return g


class Extract(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.features = []
        self.factory = osmium.geom.GeoJSONFactory()

    def area(self, a):
        tags = dict(a.tags)
        if a.from_way() or tags.get('boundary') != 'administrative':
            return
        if tags.get('admin_level') not in ['4', '5', '6']:
            return
        g = polygonal(shape(json.loads(self.factory.create_multipolygon(a))))
        self.features.append({'type': 'Feature', 'id': a.orig_id(),
                              'properties': {'tags': tags, 'timestamp': str(a.timestamp)},
                              'geometry': mapping(g)})


def relation(relation_id, basename):
    source = CACHE / f'{basename}-relation-full.osm'
    dest = CACHE / f'{basename}-extracted.geojson'
    fetch(f'https://api.openstreetmap.org/api/0.6/relation/{relation_id}/full', source)
    if not dest.exists():
        h = Extract()
        h.apply_file(str(source), locations=True, idx='flex_mem')
        write(dest, {'type': 'FeatureCollection', 'features': h.features})
    return next(f for f in read(dest)['features'] if f['id'] == relation_id)


def official_roster():
    source = CACHE / 'zhejiang-mca-2024.html'
    fetch(MCA, source)
    rows, parent = [], None
    for row in re.findall(r'<tr\b.*?</tr>', source.read_text(), re.S | re.I):
        cols = [html.unescape(re.sub('<[^>]+>', '', cell)).replace('\xa0', '').strip()
                for cell in re.findall(r'<td\b[^>]*>(.*?)</td>', row, re.S | re.I)]
        codes = [(i, c) for i, c in enumerate(cols) if re.fullmatch(r'33\d{4}', c)]
        if not codes:
            continue
        i, code = codes[0]
        name = cols[i + 1]
        if code.endswith('0000'):
            continue
        if code.endswith('00'):
            parent = name
        else:
            rows.append({'code': code, 'name': name, 'parentName': parent})
    assert len(rows) == 90 and len({r['name'] for r in rows}) == 90
    write(CACHE / 'zhejiang-mca-2024-rows.json', rows, True)
    return rows


def pack(name, value):
    raw = encode(value)
    assert len(raw) < 64 * 1024 * 1024
    packed = gzip.compress(raw, compresslevel=9, mtime=0)
    assert len(packed) < 10 * 1024 * 1024
    (OUT / name).write_bytes(raw)
    (OUT / (name + '.gz')).write_bytes(packed)
    assert gzip.decompress(packed) == raw
    return {'url': '/data/precision/' + name,
            'gzipUrl': '/data/precision/' + name + '.gz',
            'bytes': len(raw), 'gzipBytes': len(packed), 'sha256': sha(raw)}


def coast_land(province, historical_land):
    """Polygonize directed OSM coastlines without synthesizing shoreline edges."""
    maskfile = CACHE / 'zhejiang-land-mask.geojson'
    metafile = CACHE / 'zhejiang-land-mask-metadata.json'
    coastfile = CACHE / 'zhejiang-coastlines.geojson'
    pbfhash = sha((CACHE / 'zhejiang-latest.osm.pbf').read_bytes())
    if not coastfile.exists():
        class Coast(osmium.SimpleHandler):
            def __init__(self):
                super().__init__()
                self.features = []
            def way(self, w):
                if w.tags.get('natural') == 'coastline':
                    line = LineString([(n.lon, n.lat) for n in w.nodes])
                    self.features.append({'type': 'Feature', 'id': w.id,
                        'properties': {'timestamp': str(w.timestamp)}, 'geometry': mapping(line)})
        handler = Coast()
        handler.apply_file(str(CACHE / 'zhejiang-latest.osm.pbf'), locations=True, idx='flex_mem')
        write(coastfile, {'type': 'FeatureCollection', 'features': handler.features})
    lines = [shape(f['geometry']) for f in read(coastfile)['features']]
    full_coast = unary_union(lines)
    if maskfile.exists() and metafile.exists() and read(metafile)['pbfSHA256'] == pbfhash:
        meta = read(metafile)
        meta['unknownFaces'] = len(meta.pop('inlandEnclaveEvidence', []))
        assert meta['unknownFaces'] == 0
        administrative_faces = polygonize_full(province.boundary)[0]
        meta['excludedNonProvinceFaces'] = sum(not province.covers(g.representative_point()) for g in administrative_faces.geoms)
        cached_mask = read(maskfile)
        cached_mask['properties'] = meta
        write(maskfile, cached_mask)
        write(metafile, meta, True)
        return shape(cached_mask['geometry']), shape(read(CACHE / 'zhejiang-sea-mask.geojson')['geometry']), full_coast, meta
    clipped = [g.intersection(province) for g in lines if g.intersects(province)]
    polygons, cuts, dangles, invalid = polygonize_full(union_all([province.boundary, *clipped]))
    assert not cuts.geoms and not dangles.geoms and not invalid.geoms
    # polygonize also emits faces inside administrative holes (foreign
    # enclaves). They are outside Zhejiang and must not enter either mask.
    cells = [g for g in polygons.geoms if province.covers(g.representative_point())]
    tree = STRtree(cells)
    votes = [[0., 0.] for _ in cells]
    for line in lines:
        cs = list(line.coords)
        for a, b in zip(cs, cs[1:]):
            dx, dy = b[0] - a[0], b[1] - a[1]
            length = math.hypot(dx, dy)
            if not length:
                continue
            eps = min(1e-7, length / 10)
            for side, sign in [(0, 1), (1, -1)]:
                p = Point((a[0] + b[0]) / 2 - sign * dy / length * eps,
                          (a[1] + b[1]) / 2 + sign * dx / length * eps)
                for i in tree.query(p, predicate='within'):
                    votes[int(i)][side] += length
    land_ids, sea_ids = [], []
    for i, (left, right) in enumerate(votes):
        assert left > 0 or right > 0, ('No coast evidence for face', i)
        assert min(left, right) / max(left, right) < 1e-4, (i, left, right)
        (land_ids if left > right else sea_ids).append(i)
    land = polygonal(unary_union([cells[i] for i in land_ids]))
    sea = polygonal(unary_union([cells[i] for i in sea_ids]))
    assert land.intersection(sea).area < 1e-12
    assert province.symmetric_difference(unary_union([land, sea])).area < 1e-12
    geod = Geod(ellps='WGS84')
    area = lambda g: geod.geometry_area_perimeter(orient_polygons(g))[0] / 1e6
    meta = {'pbfSHA256': pbfhash, 'coastSnapshotAt': SNAPSHOT, 'coastWays': len(lines),
            'polygonizedFaces': len(cells), 'landFaces': len(land_ids), 'seaFaces': len(sea_ids),
            'conflictingFaces': 0, 'cutEdges': 0, 'danglingEdges': 0, 'invalidRings': 0,
            'unknownFaces': 0, 'excludedNonProvinceFaces': len(polygons.geoms) - len(cells),
            'administrativeAreaKm2': area(province),
            'physicalLandAreaKm2': area(land), 'removedMaritimeAreaKm2': area(sea),
            'oldZhejiangUnionAreaKm2': area(historical_land),
            'oldZhejiangUnionInCurrentSeaKm2': area(historical_land.intersection(sea)),
            'source': '© OpenStreetMap contributors; natural=coastline directed ways from pinned Geofabrik Zhejiang PBF',
            'rule': 'Polygonize exact coastlines plus administrative outer boundary; discard faces outside province, including foreign enclaves. Land on left, sea on right. All retained coastal faces have directed evidence.',
            'license': 'ODbL 1.0'}
    write(maskfile, {'type': 'Feature', 'properties': meta, 'geometry': mapping(land)})
    write(CACHE / 'zhejiang-sea-mask.geojson', {'type': 'Feature', 'properties': {}, 'geometry': mapping(sea)})
    write(metafile, meta, True)
    return land, sea, full_coast, meta


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    reader = osmium.io.Reader(str(CACHE / 'zhejiang-latest.osm.pbf'))
    header_timestamp = reader.header().get('osmosis_replication_timestamp')
    reader.close()
    assert header_timestamp == SNAPSHOT
    source = CACHE / 'all-admin.geojson'
    if not source.exists():
        raise SystemExit('Run scripts/prepare-current-china.py --extract-only with the pinned Geofabrik PBF first.')
    all_admin = read(source)['features']
    units = [f for f in all_admin if f['properties']['tags']['admin_level'] == '6']
    assert len(units) == 89
    # The Geofabrik crop omits Shengsi's complete relation; all supplemental OSM
    # objects were last edited before the PBF snapshot (checked below).
    shengsi = relation(3308120, 'shengsi')
    units.append(shengsi)
    province = relation(553302, 'zhejiang-province')
    supplemental_timestamps = {}
    for name in ['shengsi', 'zhejiang-province']:
        xml = ET.parse(CACHE / f'{name}-relation-full.osm').getroot()
        latest = max(element.attrib.get('timestamp', '') for element in xml)
        assert latest <= SNAPSHOT
        supplemental_timestamps[name] = latest
    roster = official_roster()
    official = {r['name']: r for r in roster}
    assert set(official) == {f['properties']['tags']['name'] for f in units}
    data = baseline('public/data/aligned/chn.geojson')
    alignment = baseline('public/data/geometry-alignment.json')['countries']['CHN']
    repairs = baseline('public/data/china-name-repairs.json')['repairs']
    original = {f['id']: f for f in data['features']}
    historical = [f for f in data['features'] if f['id'].startswith('GB-') and
                  repairs.get(f['id'], {}).get('evidence', {}).get('code', '').replace(' ', '').startswith('33')]
    assert len(historical) == 89
    provincial = shape(province['geometry'])
    historical_union = unary_union([polygonal(shape(f['geometry'])) for f in historical])
    physical_land_mask, verified_sea, coastlines, coast_meta = coast_land(provincial, historical_union)
    coast_fixtures = []
    for label, xy, expected_land in [
            ('Hangzhou', (120.16, 30.25), True), ('Ningbo', (121.55, 29.87), True),
            ('Wenzhou', (120.65, 28.0), True), ('Zhoushan', (122.106, 30.016), True),
            ('Shengsi', (122.45, 30.725), True), ('Donghai', (122.0, 28.5), False),
            ('HangzhouBay', (121.0, 30.42), False), ('ZhoushanOffshore', (122.5, 29.5), False)]:
        actual = physical_land_mask.covers(Point(*xy))
        assert actual == expected_land, (label, xy)
        assert expected_land or verified_sea.covers(Point(*xy)), (label, xy)
        coast_fixtures.append({'name': label, 'coordinates': list(xy),
                               'expectedLand': expected_land, 'landMaskCovers': actual})
    retired = {}
    for f in historical:
        oldid = f['id']
        repair = repairs[oldid]
        name = re.sub(r'（.*?）', '', repair['name'])
        aliases = list(dict.fromkeys([name, f['properties']['originalName'], *repair.get('aliases', [])]))
        note = '此记录保留2017年来源的原始多边形，仅用于历史回忆；现行地图使用2026年OSM浙江统一县界。此标记表示几何版本更替，不表示该行政区已撤销。'
        valid_year, retired_at = None, VERIFIED
        if name == '苍南县':
            note += '2019年原苍南县龙港镇析设县级龙港市，旧苍南记录不会自动扩展或拆分为现行两市县。'
            valid_year, retired_at = 2018, '2019-08-16'
        if name in ['上城区', '拱墅区', '余杭区', '萧山区', '江干区', '下城区']:
            note += '2021年杭州部分区划调整；旧记录不自动迁移为现行区界。'
            valid_year, retired_at = 2020, '2021-04-09'
        evidence = [MCA, NO_CHANGE]
        if repair['parentName'] == '杭州市':
            evidence.append(HANGZHOU)
        if name == '苍南县':
            evidence.append(LONGGANG)
        retired[oldid] = {'name': name + '（2017年旧界）', 'aliases': aliases,
                          'parentName': repair['parentName'], 'note': note,
                          'evidenceURLs': evidence, 'lastValidYear': valid_year,
                          'retiredAt': retired_at, 'sourceGeometryYear': '2017',
                          'retirementKind': 'geometry-superseded'}
        alignment['legacyAliases'][oldid] = oldid
    suppressed = set(alignment['suppressedIds']) | set(retired)
    assert len(suppressed) == 103
    current = []
    unchanged_hangzhou = []
    for u in sorted(units, key=lambda f: official[f['properties']['tags']['name']]['code']):
        tags = u['properties']['tags']
        record = official[tags['name']]
        new_id = 'OSM-CHN-relation-' + str(u['id'])
        g = shape(u['geometry'])
        assert g.is_valid and not g.is_empty
        if new_id in original:
            assert original[new_id]['geometry'] == u['geometry'], new_id
            feature = copy.deepcopy(original[new_id])
            unchanged_hangzhou.append(new_id)
        else:
            feature = {'type': 'Feature', 'id': new_id, 'properties': {}, 'geometry': u['geometry']}
        point = max(polygonal(g).geoms, key=lambda x: x.area).representative_point() if g.geom_type == 'MultiPolygon' else g.representative_point()
        english = tags.get('name:en', record['name'])
        city = record['parentName']
        aliases = [record['name'], record['name'][:-1], city + record['name'], city[:-1] + record['name'][:-1], english]
        feature['properties'].update({'id': new_id, 'name': record['name'], 'originalName': english,
                                      'aliases': list(dict.fromkeys(aliases)), 'parentName': city,
                                      'countryCode': 'CHN', 'countryName': '中国',
                                      'level': 'local', 'adminLevel': 'ADM3', 'adminCode': record['code'],
                                      'center': [point.x, point.y], 'bbox': list(g.bounds),
                                      'year': '2026（OSM快照）',
                                      'source': '© OpenStreetMap contributors · Geofabrik 浙江；' + SNAPSHOT,
                                      'sourceUrl': f'https://www.openstreetmap.org/relation/{u["id"]}',
                                      'license': 'ODbL 1.0', 'nameStatus': 'verified',
                                      'boundarySnapshot': SNAPSHOT})
        current.append(feature)
    assert len(unchanged_hangzhou) == 13
    administrative_current = copy.deepcopy(current)
    administrative_union = unary_union([shape(f['geometry']) for f in administrative_current])
    assert administrative_union.symmetric_difference(provincial).area < 1e-12
    administrative_asset = pack('chn-zhejiang-current-administrative.geojson',
        {'type': 'FeatureCollection', 'features': administrative_current})
    coast_changed_ids = []
    preserved_hangzhou_render_ids = []
    for f in current:
        raw_geometry = shape(f['geometry'])
        if raw_geometry.difference(physical_land_mask).area > 1e-14:
            clipped = polygonal(raw_geometry.intersection(physical_land_mask))
            f['geometry'] = mapping(clipped)
            coast_changed_ids.append(f['id'])
        else:
            clipped = raw_geometry
            if f['id'] in unchanged_hangzhou:
                preserved_hangzhou_render_ids.append(f['id'])
        point = max(clipped.geoms, key=lambda x: x.area).representative_point() if clipped.geom_type == 'MultiPolygon' else clipped.representative_point()
        f['properties'].update({'center': [point.x, point.y], 'bbox': list(clipped.bounds),
            'coastlineSnapshotAt': SNAPSHOT,
            'source': f['properties']['source'] + '；按同源OSM海岸线裁切陆域显示',
            'geometryRole': 'coastline-clipped-current-administrative-land'})
    by = dict(original)
    by.update({f['id']: f for f in current})
    data['features'] = [by[f['id']] for f in data['features']]
    data['features'].extend(f for f in current if f['id'] not in original)
    assert len(data['features']) == 2954
    for f in historical:
        assert by[f['id']] == f
    current_ids = {f['id'] for f in current}
    for fid, feature in original.items():
        if fid not in current_ids:
            assert by[fid] == feature
    gs = [shape(f['geometry']) for f in current]
    edge_matching_coverage = bool(coverage_is_valid(gs))
    assert edge_matching_coverage
    union = unary_union(gs)
    province_delta = administrative_union.symmetric_difference(provincial).area
    physical_land_delta = union.symmetric_difference(physical_land_mask).area
    overlap = max(0, sum(g.area for g in gs) - union.area)
    assert province_delta < 1e-12 and physical_land_delta < 1e-12 and overlap < 1e-12
    pairs, tree = [], STRtree(gs)
    for i, g in enumerate(gs):
        for rawj in tree.query(g, predicate='intersects'):
            j = int(rawj)
            if j > i:
                area = g.intersection(gs[j]).area
                if area > 1e-12:
                    pairs.append({'a': current[i]['id'], 'b': current[j]['id'], 'areaDeg2': area})
    assert not pairs
    external = [f for f in data['features'] if f['id'] not in suppressed and f['id'] not in {x['id'] for x in current}]
    edge_overlaps = []
    seam_features = []
    for f in external:
        g = polygonal(shape(f['geometry']))
        if not g.intersects(provincial):
            continue
        area = g.intersection(provincial).area
        if area > 1e-12:
            legacy_id = f['id']
            new_id = 'SEAM-CHN-' + legacy_id + '-ZJ20261025'
            repair = repairs.get(legacy_id, {})
            name = repair.get('name', f['properties']['name'])
            clipped = polygonal(g.difference(provincial))
            assert clipped.intersection(provincial).area < 1e-12
            # This only subtracts the verified OSM province; no other boundary
            # is interpolated or moved. Full old GB object remains in storage.
            assert g.difference(clipped).symmetric_difference(g.intersection(provincial)).area < 1e-12
            seam = copy.deepcopy(f)
            point = clipped.representative_point()
            seam.update({'id': new_id, 'geometry': mapping(clipped)})
            seam['properties'].update({'id': new_id, 'name': name,
                'aliases': list(dict.fromkeys([*repair.get('aliases', []), *f['properties'].get('aliases', []), name])),
                'parentName': repair.get('parentName', f['properties'].get('parentName', '')),
                'center': [point.x, point.y], 'bbox': list(clipped.bounds),
                'year': '2017区划；2026浙江接边', 'sourceGeometryYear': '2017',
                'source': 'geoBoundaries 2017；按2026-10-25 OSM浙江省界裁去重叠，仅作制图接边修复',
                'legacyGeometryId': legacy_id, 'cartographicRepair': 'subtract-verified-Zhejiang-province',
                'nameStatus': repair.get('status', 'unresolved')})
            seam_features.append(seam)
            suppressed.add(legacy_id)
            alignment['legacyAliases'][legacy_id] = legacy_id
            note = '保留2017年来源的完整历史多边形。现行显示副本仅裁去与2026年OSM浙江省界重叠的部分，属于制图接边修复，未声称该外省县界完成现行官方核验。'
            retired[legacy_id] = {'name': name + '（2017年旧界）',
                'aliases': seam['properties']['aliases'], 'parentName': seam['properties']['parentName'],
                'note': note, 'evidenceURLs': [*repair.get('evidenceURLs', []), OSM, 'https://www.openstreetmap.org/relation/553302'],
                'lastValidYear': None, 'retiredAt': VERIFIED, 'sourceGeometryYear': '2017',
                'retirementKind': 'cartographic-seam-copy'}
            edge_overlaps.append({'id': legacy_id, 'activeId': new_id, 'name': name,
                                  'originalName': f['properties'].get('originalName'), 'overlapAreaDeg2': area,
                                  'overlapFractionOfLegacyPolygon': area / g.area,
                                  'afterOverlapAreaDeg2': clipped.intersection(provincial).area,
                                  'otherBoundaryChangesAreaDeg2': g.difference(clipped).symmetric_difference(g.intersection(provincial)).area})
    assert len(seam_features) == 21
    data['features'].extend(seam_features)
    assert len(data['features']) == 2975 and len(suppressed) == 124
    active = [polygonal(shape(f['geometry'])) for f in data['features'] if f['id'] not in suppressed]
    land_union = unary_union(active)
    all_active_sea_overlap = land_union.intersection(verified_sea).area
    assert all_active_sea_overlap < 1e-12
    uncovered_historical = historical_union.difference(land_union)
    polygons = list(land_union.geoms) if land_union.geom_type == 'MultiPolygon' else [land_union]
    enclosed_holes = unary_union([Polygon(ring) for p in polygons for ring in p.interiors])
    # Only enclosed inland holes can be neutral coverage. Open coastal remnants
    # are deliberately excluded, preserving the newer Zhejiang outer outline.
    inland_candidate = uncovered_historical.difference(provincial).intersection(enclosed_holes)
    candidate_parts = list(inland_candidate.geoms) if inland_candidate.geom_type == 'MultiPolygon' else [inland_candidate]
    safe_parts = [g for g in candidate_parts if not g.is_empty and g.geom_type == 'Polygon' and g.distance(coastlines) > .01]
    neutral_fallback = polygonal(unary_union(safe_parts))
    open_residual = uncovered_historical.difference(neutral_fallback)
    assert neutral_fallback.intersection(provincial).area < 1e-12
    assert neutral_fallback.intersection(land_union).area < 1e-12
    country_union = unary_union([land_union, neutral_fallback])
    def outer_shell(g):
        ps = list(g.geoms) if g.geom_type == 'MultiPolygon' else [g]
        return unary_union([Polygon(p.exterior) for p in ps])
    coast_delta = outer_shell(land_union).symmetric_difference(outer_shell(country_union)).area
    assert coast_delta < 1e-12
    # A neutral source-footprint residual is offered separately for the parent
    # map's fallback policy. It has no county ownership, no picking IDs, and is
    # never inserted into the primary current county collection.
    residual = {'type': 'FeatureCollection', 'features': [{'type': 'Feature',
        'id': 'CHN-zhejiang-historical-coverage-residual',
        'properties': {'countryCode': 'CHN', 'role': 'neutral-historical-source-coverage',
                       'name': '浙江旧来源覆盖残余（未分配现行区县）',
                       'sourceGeometryYear': '2017', 'pickable': False,
                       'source': 'Exact 2017 Zhejiang GB union minus active China union; no ownership assigned'},
        'geometry': mapping(neutral_fallback)}]}
    country = {'type': 'FeatureCollection', 'features': [{'type': 'Feature', 'id': 'CHN-country',
        'properties': {'countryCode': 'CHN', 'name': '中国', 'role': 'active-administrative-union-plus-neutral-inland-seams'},
        'geometry': mapping(country_union)}]}
    write(ROOT / 'outputs/zhejiang-current-open-residual.geojson', {'type': 'FeatureCollection', 'features': [{
        'type': 'Feature', 'properties': {'role': 'excluded-open-source-version-residual'}, 'geometry': mapping(open_residual)}]})
    land = {'type': 'FeatureCollection', 'features': [{'type': 'Feature', 'id': 'CHN-land',
            'properties': {'countryCode': 'CHN', 'name': '中国', 'role': 'exact-active-administrative-union'},
            'geometry': mapping(land_union)}]}
    main_asset = pack('chn-zhejiang-current.geojson', data)
    land_asset = pack('chn-zhejiang-current-land.geojson', land)
    residual_asset = pack('chn-zhejiang-current-fallback.geojson', residual)
    country_asset = pack('chn-zhejiang-current-country.geojson', country)
    for oldname in ['chn-zhejiang-current-residual.geojson', 'chn-zhejiang-current-residual.geojson.gz']:
        (OUT / oldname).unlink(missing_ok=True)
    for kind, asset in [('local', main_asset), ('land', land_asset), ('fallback', residual_asset), ('country', country_asset)]:
        alignment[kind + 'Url'] = asset['url']
        alignment[kind + 'GzipUrl'] = asset['gzipUrl']
        alignment[kind + 'Bytes'] = asset['bytes']
        alignment[kind + 'GzipBytes'] = asset['gzipBytes']
        alignment['sha256'][kind] = asset['sha256']
    checks = {'currentZhejiangCount': 90, 'historicalZhejiangCount': 89,
              'pbfHeaderTimestamp': header_timestamp,
              'supplementalObjectsLastEditedAt': supplemental_timestamps,
              'exactEdgeMatchingCoverageValid': edge_matching_coverage,
              'coastlineFixtureChecks': coast_fixtures,
              'officialRosterExactMatch': True, 'provinceUnionSymmetricDifferenceAreaDeg2': province_delta,
              'provinceGapAreaDeg2': provincial.difference(administrative_union).area,
              'outsideProvinceAreaDeg2': administrative_union.difference(provincial).area,
              'renderedZhejiangUnionVsVerifiedLandMaskAreaDeg2': physical_land_delta,
              'renderedZhejiangUnionInVerifiedSeaAreaDeg2': union.intersection(verified_sea).area,
              'allActiveChinaUnionInVerifiedZhejiangSeaAreaDeg2': all_active_sea_overlap,
              'withinZhejiangOverlapAreaDeg2': overlap, 'positiveOverlapPairs': pairs,
              'unchangedHangzhouAdministrativeGeometryIds': unchanged_hangzhou,
              'unchangedHangzhouRenderGeometryIds': preserved_hangzhou_render_ids,
              'coastlineClippedCurrentGeometryIds': coast_changed_ids,
              'coastlineClippedHangzhouGeometryIds': [i for i in coast_changed_ids if i in unchanged_hangzhou],
              'allHistoricalZhejiangFeatureObjectsUnchanged': True,
              'allOtherChinaFeatureObjectsUnchanged': True,
              'seamAdjustedOutsideCountyCount': len(seam_features),
              'allSeamOriginalsRetainedUnchanged': True,
              'landUnionSymmetricDifferenceAreaDeg2': land_union.symmetric_difference(shape(land['features'][0]['geometry'])).area,
              'provincialMixedVersionOverlaps': edge_overlaps,
              'provincialMixedVersionOverlapAreaDeg2': sum(x['overlapAreaDeg2'] for x in edge_overlaps),
              'provincialMixedVersionOverlapAfterRepairAreaDeg2': sum(x['afterOverlapAreaDeg2'] for x in edge_overlaps),
              'historicalZhejiangFootprintNoLongerInActiveUnionAreaDeg2': uncovered_historical.area,
              'neutralEnclosedInlandFallbackAreaDeg2': neutral_fallback.area,
              'excludedOpenOrCoastalResidualAreaDeg2': open_residual.area,
              'fallbackVsCurrentProvinceOverlapAreaDeg2': neutral_fallback.intersection(provincial).area,
              'fallbackVsPrimaryActiveUnionOverlapAreaDeg2': neutral_fallback.intersection(land_union).area,
              'fallbackInVerifiedSeaAreaDeg2': neutral_fallback.intersection(verified_sea).area,
              'countryVsActivePlusNeutralFallbackSymmetricDifferenceAreaDeg2': country_union.symmetric_difference(unary_union([land_union, neutral_fallback])).area,
              'countryOuterShellVsActiveOuterShellSymmetricDifferenceAreaDeg2': coast_delta,
              'fallbackRule': 'Exact 2017 Zhejiang GB union minus active China union, outside raw current province and within enclosed holes; discard whole components within0.01degree of actual2026coastlines. No county assignment or synthetic coast.',
              'historicalFootprintDifferenceMeaning': '2017 Zhejiang footprint minus active whole-China union. This is a source-version difference, not proof of present-day uncovered land.'}
    baseline_source = {key: alignment.get(key) for key in ['source', 'sourceUrl', 'sourceSHA256', 'sourceYear', 'license']}
    alignment.update({'count': len(data['features']), 'renderCount': len(active),
                      'suppressedIds': sorted(suppressed), 'replaceWorldIds': alignment.get('replaceWorldIds', []),
                      'source': 'geoBoundaries gbOpen (2017, outside Zhejiang) · © OpenStreetMap contributors (Zhejiang 2026)',
                      'sourceUrl': 'https://download.geofabrik.de/asia/china/zhejiang-latest.osm.pbf',
                      'sourceSHA256': sha((CACHE / 'zhejiang-latest.osm.pbf').read_bytes()),
                      'baselineSource': baseline_source,
                      'sourceYear': '混合版本：浙江2026-10-25；其余主体2017',
                      'license': 'Open Data Commons Open Database License 1.0',
                      'preparation': 'Pinned 4316998 baseline; every original GB feature retained unchanged. All 90 current Zhejiang counties use complete OSM relation geometry on one shared node mesh. Existing 13 Hangzhou coordinate arrays unchanged. The 21 overlapping outside-province GB counties are historical-only; separate stable SEAM IDs subtract the exact verified OSM Zhejiang province, with no other boundary movement. No simplification, buffering, or invented county ownership. Active land is exact unary union. Neutral fallback uses only enclosed inland holes intersecting the 2017 Zhejiang footprint; open/coastal residuals excluded. Country is exact union of active land plus neutral fallback.',
                      'snapshotAt': SNAPSHOT, 'verifiedAt': VERIFIED, 'checks': checks})
    alignment['coastlineEvidence'] = coast_meta
    alignment['preparation'] = alignment['preparation'].replace('Existing 13 Hangzhou coordinate arrays unchanged.',
        'All 13 Hangzhou administrative coordinate arrays unchanged in provenance archive; runtime land uses exact same-snapshot natural=coastline clipping, retaining IDs.')
    alignment['preparation'] += ' All90 renderedZhejiangpolygons intersect exact directed2026OSMcoastline landmask; maritime administrative areas remain only in separate90relation provenancearchive. Neutralfallbackexcludes verifiedsea and nearcoastcomponents.'
    # lastValidYear is populated only for documented administrative changes;
    # null means the old source's last validity date has not been established.
    limitation = ['全国其他省份主体仍为2017年来源，未声称完成全国现行县界核验。',
                  '名称、代码与民政部2024年末名录逐项核对；2025年无区划变更获政府页面确认。2026年OSM快照与该90县名录一致，尚无逐项2026年政府县界测绘依据。',
                  '浙江90县原始行政面与OSM省界完全闭合；显示陆域统一按同源海岸线裁切。21个外省县的显示副本仅沿已核验的浙江省界裁去重叠。其余边界保留2017年版本，制图修复不构成外省现行官方县界核验。',
                  '浙江与外省旧来源之间的封闭内陆缝隙，按可核验的旧来源覆盖补为灰色中性面，未核验行政归属，不纳入任何区县。开放或沿海残余不补回，以保留新版本外轮廓。',
                  '浙江原始OSM行政面包含海域，仅在90县行政来源归档保留。现行浙江显示面按同快照OSM海岸线裁切陆域；其他省份仍保留其原始来源精度。']
    cache_records = []
    for name, url in [('zhejiang-latest.osm.pbf', 'https://download.geofabrik.de/asia/china/zhejiang-latest.osm.pbf'),
                      ('all-admin.geojson', OSM),
                      ('zhejiang-coastlines.geojson', 'https://download.geofabrik.de/asia/china/zhejiang-latest.osm.pbf'),
                      ('zhejiang-land-mask.geojson', 'https://download.geofabrik.de/asia/china/zhejiang-latest.osm.pbf'),
                      ('shengsi-relation-full.osm', 'https://api.openstreetmap.org/api/0.6/relation/3308120/full'),
                      ('zhejiang-province-relation-full.osm', 'https://api.openstreetmap.org/api/0.6/relation/553302/full'),
                      ('zhejiang-mca-2024.html', MCA)]:
        path = CACHE / name
        cache_records.append({'file': str(path.relative_to(ROOT)), 'url': url,
                              'bytes': path.stat().st_size, 'sha256': sha(path.read_bytes())})
    manifest = {'version': 1, 'baselineCommit': BASELINE, 'snapshotAt': SNAPSHOT, 'verifiedAt': VERIFIED,
                'alignment': alignment, 'retiredRegions': retired,
                'currentAdministrative': {**administrative_asset,
                    'count': 90, 'runtime': False, 'geometryRole': 'uncropped-source-administrative-provenance-including-maritime-areas',
                    'rawProvinceClosureAreaDeg2': province_delta},
                'coastlineEvidence': coast_meta,
                'suggestedFallback': {**residual_asset,
                    'areaDeg2': neutral_fallback.area, 'ownership': None,
                    'source': 'Pinned 4316998 2017 Zhejiang GB union minus active China union, restricted to enclosed holes',
                    'purpose': 'Neutral inland seam coverage only; never a current county polygon or click target'},
                'seamRegions': [{'id': f['id'], 'legacyId': f['properties']['legacyGeometryId'],
                                 'name': f['properties']['name'], 'nameStatus': f['properties']['nameStatus'],
                                 'parentName': f['properties']['parentName']} for f in seam_features],
                'coveragePatch': {'count': len(data['features']),
                                  'source': alignment['source'], 'sourceYear': alignment['sourceYear'],
                                  'coverageNote': '浙江省现行90个县级行政区统一采用2026-10-25 OSM快照，名称代码对照民政部名录；显示陆域按同快照OSM海岸线裁切，含海域的原始行政面另作来源归档。旧浙江89个GB多边形保留为历史记录。21个相邻外省县的2017年显示副本按同一浙江省界消除重叠，原始多边形也完整保留为历史记录。未核验行政归属的封闭内陆细缝显示为灰色中性面，不归属任何区县。其他省份主体仍沿用2017年来源，未逐一核验到当前版本。',
                                  'license': alignment['license'], 'sourceUrl': OSM},
                'evidenceURLs': [MCA, NO_CHANGE, COUNT, HANGZHOU, LONGGANG, OSM,
                                 'https://www.openstreetmap.org/relation/553302',
                                 'https://www.openstreetmap.org/copyright'],
                'licensing': {'geometry': '© OpenStreetMap contributors, ODbL 1.0',
                              'licenseUrl': 'https://opendatacommons.org/licenses/odbl/1-0/',
                              'officialNamesCodes': 'Administrative facts verified against Ministry of Civil Affairs list; official pages do not supply these polygons.'},
                'officialRoster': roster, 'currentRegions': [{**official[f['properties']['name']], 'id': f['id']} for f in current],
                'sourceCache': cache_records, 'audit': checks, 'limitations': limitation}
    write(ROOT / 'public/data/current-zhejiang.json', manifest, True)
    write(ROOT / 'outputs/zhejiang-current-audit.json', manifest, True)
    print(json.dumps({'count': alignment['count'], 'renderCount': alignment['renderCount'],
                       'localBytes': main_asset['bytes'], 'gzipBytes': main_asset['gzipBytes'],
                       'landBytes': land_asset['bytes'], 'checks': checks}, ensure_ascii=False, indent=2), flush=True)


if __name__ == '__main__':
    main()
