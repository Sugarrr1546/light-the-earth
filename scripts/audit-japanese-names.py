#!/usr/bin/env python3
"""Reproduce Japanese name repairs from official MLIT N03 data.

Install shapely, pyproj, and pyshp in a temporary virtual environment, then run
this script from any directory. It writes an additive repair map and audit only;
it never changes the source feature IDs, geometries, centers, or source years.
The 2017 comparison protects against silently using a 2025 successor's name for
a historical feature. Official downloads are cached under outputs/.
"""
from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from pathlib import Path
from urllib.request import urlretrieve
from zipfile import ZipFile

import shapefile
from pyproj import Transformer
from shapely.geometry import Point, shape
from shapely.ops import transform, unary_union

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / 'outputs/japan-name-sources'
CATALOG = 'https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2025.html'
HISTORICAL = 'https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-v2_3.html'
PREFECTURES = ('03', '11', '12', '19')
PROJECT = Transformer.from_crs('EPSG:4326', 'EPSG:6933', always_xy=True).transform


def source_url(year, prefecture):
    filename = (f'N03-20250101_{prefecture}_GML.zip' if year == 2025
                else f'N03-170101_{prefecture}_GML.zip')
    return f'https://nlftp.mlit.go.jp/ksj/gml/data/N03/N03-{year}/{filename}'


def download(year, prefecture):
    folder = CACHE / (prefecture if year == 2025 else f'2017-{prefecture}')
    archive = folder.with_suffix('.zip')
    CACHE.mkdir(parents=True, exist_ok=True)
    if not archive.exists():
        urlretrieve(source_url(year, prefecture), archive)
    if not folder.exists():
        with ZipFile(archive) as z:
            z.extractall(folder)
    return folder, archive


def load_official(year):
    grouped = defaultdict(list)
    attributes = {}
    hashes = {}
    for pref in PREFECTURES:
        folder, archive = download(year, pref)
        hashes[source_url(year, pref)] = hashlib.sha256(archive.read_bytes()).hexdigest()
        if year == 2025:
            records = json.loads(next(folder.glob('*.geojson')).read_text())['features']
        else:
            reader = shapefile.Reader(str(next(folder.glob('*.shp'))), encoding='cp932')
            records = ({'properties': r.record.as_dict(), 'geometry': r.shape.__geo_interface__}
                       for r in reader.iterShapeRecords())
        for record in records:
            p = {k: (v or '') for k, v in record['properties'].items()}
            key = (pref, tuple(sorted(p.items())))
            geom = shape(record['geometry'])
            grouped[key].append(geom if geom.is_valid else geom.buffer(0))
            attributes[key] = p
    return [{
        'attributes': attributes[key],
        'prefectureCode': key[0],
        'geometry': unary_union(parts),
        'projected': transform(PROJECT, unary_union(parts)),
    } for key, parts in grouped.items()], hashes


def matches(geometry, official):
    projected = transform(PROJECT, geometry)
    scores = []
    for candidate in official:
        if not geometry.intersects(candidate['geometry']):
            continue
        intersection = projected.intersection(candidate['projected']).area
        if intersection:
            scores.append((intersection / projected.area, candidate))
    return sorted(scores, key=lambda item: item[0], reverse=True)


def describe(candidate, year):
    p = candidate['attributes']
    if year == 2017:
        city = p['N03_003'] if p['N03_003'].endswith('市') else ''
        ward = p['N03_004'] if city else ''
        municipality = city or p['N03_004']
        county = '' if city else p['N03_003']
    else:
        municipality = p['N03_004']
        ward = p['N03_005']
        county = p['N03_003']
    return {
        'name': municipality + ward,
        'prefecture': p['N03_001'],
        'municipality': municipality,
        'ward': ward,
        'county': county,
        'officialCode': p['N03_007'],
    }


def largest_part(g):
    return max(g.geoms, key=lambda part: part.area) if g.geom_type == 'MultiPolygon' else g


def main():
    before = json.loads((ROOT / 'outputs/name-quality-before.json').read_text())
    targets = {p['id']: p for p in before if p['code'] == 'JPN'}
    official_2025, hashes_2025 = load_official(2025)
    official_2017, hashes_2017 = load_official(2017)
    data = json.loads((ROOT / 'public/data/aligned/jpn.geojson').read_text())
    repairs, audit = {}, []
    for feature in data['features']:
        p = feature['properties']
        if p['id'] not in targets:
            continue
        g = shape(feature['geometry'])
        g = g if g.is_valid else g.buffer(0)
        current = matches(g, official_2025)
        historical = matches(g, official_2017)
        assert current and historical, f'No official match: {p["id"]}'
        ratio, best = current[0]
        old_ratio, old_best = historical[0]
        modern = describe(best, 2025)
        old = describe(old_best, 2017)
        assert modern['name'] == old['name'], f'Historical name differs: {p["id"]}'
        # Small fringe differences reflect geometry simplification/coastline
        # differences. Never use a nearest-centroid match to infer a name.
        unassigned = modern['name'] == '所属未定地'
        assert ratio > (0.85 if unassigned else 0.94), f'Insufficient overlap: {p["id"]}'
        name = modern['prefecture'] + modern['name'] if unassigned else modern['name']
        parent = modern['prefecture']
        if modern['ward']:
            parent += ' / ' + modern['municipality']
        elif modern['county']:
            parent += ' / ' + modern['county']
        aliases = list(dict.fromkeys([name, modern['name'], modern['prefecture'] + modern['name']]))
        center = Point(p['center'])
        urls = [CATALOG, source_url(2025, best['prefectureCode']),
                HISTORICAL, source_url(2017, old_best['prefectureCode'])]
        evidence = {
            'method': 'equal-area polygon intersection with official N03; independently matched 2017 and 2025',
            'overlapFraction2025': round(ratio, 8),
            'overlapFraction2017': round(old_ratio, 8),
            'officialName2017': old['name'],
            'officialName2025': modern['name'],
            'officialCode2017': old['officialCode'] or None,
            'officialCode2025': modern['officialCode'] or None,
            'sourceGeometryYear': str(p.get('year', '2017')),
            'nameSourceDates': ['2017-01-01', '2025-01-01'],
        }
        note = ('国土数値情報の正式属性は「所属未定地」。市町村への所属は未定のため、近隣市名を割り当てない。'
                if unassigned else '2017年と2025年の公式行政区域データで同名を確認。元の境界と識別子を保持。')
        if ratio < 0.98 and not unassigned:
            note += '小さな境界片であり、公式西区との重なりは約94.4%。代表点も公式西区内。'
        repairs[p['id']] = {
            'name': name,
            'aliases': aliases,
            'parentName': parent,
            'nameSource': '国土交通省 国土数値情報 N03 行政区域データ',
            'nameSourceURLs': urls,
            'nameStatus': 'boundary-unassigned' if unassigned else 'official-name-verified',
            'nameConfidence': 'high',
            'officialCode': modern['officialCode'],
            'expectedOriginalName': targets[p['id']]['originalName'],
            'nameEvidence': evidence,
            'nameNote': note,
        }
        audit.append({
            'id': p['id'], 'before': targets[p['id']]['name'], 'after': name,
            'evidence': evidence,
            'center': p['center'],
            'bbox': list(g.bounds),
            'centerInsideSourcePolygon': g.covers(center),
            'centerInsideLargestSourcePolygon': largest_part(g).covers(center),
            'centerInsideMatchedOfficialPolygon2025': best['geometry'].covers(center),
            'centerInsideMatchedOfficialPolygon2017': old_best['geometry'].covers(center),
            'representativePointLargestPolygon': list(largest_part(g).representative_point().coords[0]),
            'anchorRecommendation': 'retain-current-anchor' if largest_part(g).covers(center) else 'use-largest-polygon-interior-point',
            'topMatches2025': [dict(describe(candidate, 2025), overlapFraction=round(score, 8))
                               for score, candidate in current[:3]],
            'note': note,
        })
    assert len(repairs) == len(targets) == 26
    metadata = {
        'schemaVersion': 1,
        'purpose': 'Additive verified Japanese feature-name repairs; no geometry or ID replacement',
        'geometrySnapshotYear': '2017 (source metadata; preserved)',
        'officialNameSnapshots': ['2017-01-01', '2025-01-01'],
        'attribution': '国土交通省 国土数値情報（行政区域データ）を利用して地名対応表を作成',
        'license2025': 'CC BY 4.0',
        'sourceURLs': [CATALOG, HISTORICAL],
        'sourceArchiveSHA256': hashes_2017 | hashes_2025,
        'repairCount': len(repairs),
        'boundaryUnassignedCount': sum(r['nameStatus'] == 'boundary-unassigned' for r in repairs.values()),
    }
    (ROOT / 'public/data/japan-name-repairs.json').write_text(
        json.dumps({'metadata': metadata, 'repairs': repairs}, ensure_ascii=False, indent=2) + '\n')
    report = {'metadata': metadata, 'features': audit}
    (ROOT / 'outputs/japan-name-audit.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'repairCount': len(repairs),
                      'allCentersInLargestPolygon': all(r['centerInsideLargestSourcePolygon'] for r in audit),
                      'allCentersInOfficialPolygon': all(r['centerInsideMatchedOfficialPolygon2025'] for r in audit),
                      'boundaryUnassignedCount': metadata['boundaryUnassignedCount']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
