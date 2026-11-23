#!/usr/bin/env python3
"""Build broad, attributed local administrative boundary coverage.

Requires Python 3.10+, shapely 2.1.2 and node/mapshaper 0.7.95. The default
catalog is the checked-in source snapshot; --refresh-catalog explicitly reads
the provider's current catalog. Source geometries are pinned by their URL.

python scripts/prepare-global-geodata.py --workers 4
python scripts/prepare-global-geodata.py --validate

All runtime files are same-origin static assets. Provider requests happen only
while preparing data, and never include personal travel records.
"""
import argparse
import concurrent.futures
import datetime
import hashlib
import json
import math
import pathlib
import subprocess
import threading
import time
import urllib.request

from shapely.geometry import shape, mapping, Polygon, MultiPolygon
from shapely import make_valid

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA = ROOT / 'public/data'
GLOBAL = DATA / 'global'
CATALOG_URL = 'https://www.geoboundaries.org/api/current/gbOpen/ALL/ALL/'
PRESERVE = {'CHN', 'JPN', 'USA'}
ISO_ALIASES = {'XKX': 'KOS'}
EXTRA_NAMES = {'GLP': '瓜德罗普', 'GUF': '法属圭亚那', 'MTQ': '马提尼克',
               'MYT': '马约特', 'REU': '留尼汪', 'XKX': '科索沃'}
# Local layers that leave much of the country outside every unit; the aligned
# step fills the rest from the overview outline instead of showing it as sea.
PARTIAL = {'URY': '乌拉圭市镇不覆盖全国，农村地区不属于任何市镇，约 64% 国土无县级面；未覆盖部分随国家级回忆显示，部分覆盖。'}
# Local travel units are country-specific. Some ADM3 layers describe villages,
# wards, parishes or enumeration areas and are deliberately not the default.
PREFER = {
    'CHN': 'ADM3', 'JPN': 'ADM2', 'USA': 'ADM2', 'DEU': 'ADM3',
    'FRA': 'ADM3', 'GBR': 'ADM3', 'ESP': 'ADM3', 'ITA': 'ADM4',
    'CAN': 'ADM3', 'TWN': 'ADM2', 'KOR': 'ADM2', 'NZL': 'ADM2',
    'IND': 'ADM3', 'BEL': 'ADM4', 'AUT': 'ADM3', 'FIN': 'ADM3',
    'CZE': 'ADM3', 'SVK': 'ADM3', 'LUX': 'ADM3', 'HUN': 'ADM3',
    'GRC': 'ADM3', 'CHE': 'ADM3', 'PHL': 'ADM3', 'ZAF': 'ADM3',
    'CHL': 'ADM3', 'BOL': 'ADM3', 'BGD': 'ADM3', 'LKA': 'ADM3',
    'MMR': 'ADM3', 'NPL': 'ADM3', 'PAK': 'ADM3', 'DZA': 'ADM3',
    'CAF': 'ADM3', 'ETH': 'ADM3', 'BIH': 'ADM3', 'BFA': 'ADM3',
    'SYC': 'ADM3', 'UGA': 'ADM3', 'CIV': 'ADM3', 'CMR': 'ADM3',
    'POL': 'ADM3', 'HTI': 'ADM3', 'ALB': 'ADM3',
}
KEEP_ADM2 = {'BDI', 'BEN', 'CRI', 'EST', 'GMB', 'IRN', 'JAM', 'KEN',
             'KHM', 'KOR', 'LTU', 'MDG', 'MOZ', 'MWI', 'MYS', 'NZL',
             'PAN', 'PRI', 'PRT', 'RWA', 'SEN', 'SLE', 'SWE', 'SYR',
             'TUN', 'TZA', 'UKR', 'VUT', 'ZWE'}
COARSE_NAMES = ('village', 'ward', 'barrio', 'submunicip', 'freguesia',
                'enumeration', 'council', 'collin', 'fokontany')
PRINT_LOCK = threading.Lock()


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def write(path, data, pretty=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(data, ensure_ascii=False, allow_nan=False,
                         indent=2 if pretty else None,
                         separators=None if pretty else (',', ':')) + '\n'
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(encoded, encoding='utf-8')
    tmp.replace(path)


def download(url, path):
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    last = None
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers={
                'User-Agent': 'LightTheEarth/1.0 open-boundary-preparation'})
            with urllib.request.urlopen(request, timeout=150) as response:
                with path.with_suffix('.part').open('wb') as output:
                    while block := response.read(1024 * 1024):
                        output.write(block)
            path.with_suffix('.part').replace(path)
            return
        except Exception as exc:
            last = exc
            time.sleep(attempt + 1)
    raise RuntimeError(f'Download failed: {url}: {last}')


def source_url(meta):
    # Official GitHub LFS binary endpoint. raw.githubusercontent can return
    # a text LFS pointer instead of GeoJSON for these repository files.
    return meta['simplifiedGeometryGeoJSON'].replace(
        'https://github.com/wmgeolab/geoBoundaries/raw/',
        'https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/')


def canonical(meta):
    value = str(meta.get('boundaryCanonical', '')).strip()
    return '' if value.lower() in ('unknown', 'nan', 'gbopen', '') else value


def choose(layers):
    iso = layers[0]['boundaryISO']
    by_level = {d['boundaryType']: d for d in layers}
    wanted = PREFER.get(iso)
    if wanted in by_level:
        return by_level[wanted], 'country-specific local administrative unit'
    if iso not in KEEP_ADM2 and 'ADM3' in by_level:
        d = by_level['ADM3']
        name = canonical(d).lower()
        if (0 < int(d['admUnitCount']) < 15000
                and any(word in name for word in ('municip', 'commune', 'county', 'township'))
                and not any(word in name for word in COARSE_NAMES)):
            return d, 'named municipal or county-level source unit'
    if 'ADM2' in by_level:
        return by_level['ADM2'], 'second administrative level; source canonical retained'
    if 'ADM1' in by_level:
        return by_level['ADM1'], 'only first-level subdivision available'
    return min(layers, key=lambda d: int(d['boundaryType'][3:])), 'finest available source group without an ADM1/ADM2 layer'


def polygon_parts(g):
    if g.geom_type == 'Polygon':
        return [g]
    if hasattr(g, 'geoms'):
        return [p for child in g.geoms for p in polygon_parts(child)]
    return []


def normalized_geometry(raw):
    g = shape(raw)
    repaired = not g.is_valid
    if repaired:
        parts = polygon_parts(make_valid(g))
        if not parts:
            raise ValueError('A source feature has no polygonal area after repair')
        g = parts[0] if len(parts) == 1 else MultiPolygon(parts)
    if g.is_empty or not g.is_valid or g.geom_type not in ('Polygon', 'MultiPolygon'):
        raise ValueError('Invalid or empty polygon geometry')
    bounds = list(g.bounds)
    if not (-180.00001 <= bounds[0] <= bounds[2] <= 180.00001
            and -90.00001 <= bounds[1] <= bounds[3] <= 90.00001):
        raise ValueError(f'Coordinates outside WGS84: {bounds}')
    main = max(polygon_parts(g), key=lambda p: p.area)
    point = main.representative_point()
    center = [round(point.x, 5), round(point.y, 5)]
    return mapping(g), center, [round(v, 5) for v in bounds], repaired, main.area


def normalize(collection, meta, code, name, original_by_id=None):
    features, repairs, unnamed, max_area, country_center = [], 0, 0, -1, None
    restored = []
    for feature in collection['features']:
        props = feature['properties']
        sid = props['shapeID']
        original_name = str(props.get('shapeName') or '').strip()
        if not original_name:
            unnamed += 1
        try:
            geometry, center, bbox, repaired, area = normalized_geometry(feature['geometry'])
        except (ValueError, TypeError):
            # Rounding may collapse a tiny polygon even with keep-shapes.
            # Restore that exact source geometry rather than lose the entire
            # country's fine layer or manufacture a replacement shape.
            if original_by_id is None or sid not in original_by_id:
                raise
            geometry, center, bbox, repaired, area = normalized_geometry(original_by_id[sid]['geometry'])
            restored.append(sid)
        repairs += int(repaired)
        if area > max_area:
            max_area, country_center = area, center
        p = {
            'id': f'GB-{sid}', 'name': original_name or f'未命名区域 · {sid[-7:]}',
            'originalName': original_name, 'aliases': [],
            'countryCode': code, 'countryName': name, 'level': 'local',
            'adminLevel': meta['boundaryType'], 'center': center, 'bbox': bbox,
            'source': f"geoBoundaries gbOpen · {meta['boundarySource']}",
            'year': meta['boundaryYearRepresented'],
        }
        features.append({'type': 'Feature', 'id': p['id'], 'properties': p, 'geometry': geometry})
    bbox = [min(f['properties']['bbox'][0] for f in features),
            min(f['properties']['bbox'][1] for f in features),
            max(f['properties']['bbox'][2] for f in features),
            max(f['properties']['bbox'][3] for f in features)]
    return {'type': 'FeatureCollection', 'features': features}, {
        'center': country_center, 'bbox': bbox, 'repairedGeometryCount': repairs,
        'unnamedCount': unnamed, 'restoredSourceGeometryIDs': restored,
    }


def process(meta, reason, world, cache, mapshaper):
    iso, level = meta['boundaryISO'], meta['boundaryType']
    code = ISO_ALIASES.get(iso, iso)
    name = world.get(code, {}).get('name') or EXTRA_NAMES.get(iso) or meta['boundaryName']
    filename = f'{code.lower()}-{level.lower()}.geojson'
    path = GLOBAL / filename
    result_path = cache / f'{iso}-{level}-result.json'
    if path.exists() and result_path.exists():
        cached = read(result_path)
        if cached['sha256'] == hashlib.sha256(path.read_bytes()).hexdigest():
            return cached
    raw_path = cache / f'{iso}-{level}-source.geojson'
    download(source_url(meta), raw_path)
    original = read(raw_path)
    ids = [f['properties']['shapeID'] for f in original['features']]
    if not ids or len(set(ids)) != len(ids):
        raise ValueError(f'{iso} {level}: duplicate or missing source feature IDs')
    # Retain about a fifth of source vertices, reducing very large datasets more.
    # Output size is checked after compact serialization; retry only as necessary.
    percent = min(35.0, max(2.0, 3_000_000 / raw_path.stat().st_size * 100))
    compact_path = cache / f'{iso}-{level}-compact.geojson'
    for attempt in range(4):
        command = [*mapshaper, str(raw_path), '-simplify', f'{percent:.3f}%',
                   'keep-shapes', '-o', 'precision=0.00001', 'force', str(compact_path)]
        run = subprocess.run(command, capture_output=True, text=True, timeout=360)
        if run.returncode:
            raise RuntimeError(f'{iso} {level} mapshaper: {run.stderr[-3000:]}')
        compact = read(compact_path)
        if {f['properties']['shapeID'] for f in compact['features']} != set(ids):
            raise ValueError(f'{iso} {level}: feature IDs changed during simplification')
        normalized, stats = normalize(compact, meta, code, name,
                                      {f['properties']['shapeID']: f for f in original['features']})
        write(path, normalized)
        if path.stat().st_size <= 5_000_000:
            break
        percent *= 0.45
    if path.stat().st_size > 10_000_000:
        path.unlink()
        raise ValueError(f'{iso} {level}: final file exceeds 10 MB')
    count = len(normalized['features'])
    source_meta_count = int(meta['admUnitCount'])
    label = canonical(meta) or f"地方行政区（{level}）"
    note = f"{meta['boundaryYearRepresented']} 年历史边界；{label}，实载 {count:,} 个区域。"
    if level == 'ADM1':
        note += '当前接入省 / 州等一级细分，尚未接入县市层级。'
    if source_meta_count != count:
        note += f'来源目录记载 {source_meta_count:,} 个，与下载版存在差异；保留下载版全部要素。'
    if stats['unnamedCount']:
        note += f"{stats['unnamedCount']} 个源名称为空，以稳定 ID 标示。"
    note += PARTIAL.get(code, '')
    coverage = {
        'code': code, 'sourceISO': iso, 'name': name, 'localUrl': f'/data/global/{filename}',
        'adminLevel': level, 'label': label, 'canonical': meta.get('boundaryCanonical', ''),
        'year': meta['boundaryYearRepresented'],
        'source': f"geoBoundaries gbOpen · {meta['boundarySource']}",
        'sourceUrl': f'https://www.geoboundaries.org/api/current/gbOpen/{iso}/{level}/',
        'license': f"geoBoundaries CC BY 4.0；原始来源：{meta['boundaryLicense']}",
        'coverageNote': note, 'count': count,
        'center': world.get(code, {}).get('center') or stats['center'],
        'bbox': world.get(code, {}).get('bbox') or stats['bbox'],
        'detailTier': 'regional' if level == 'ADM1' else 'local',
        'bytes': path.stat().st_size,
        **({'partial': True} if code in PARTIAL else {}),
    }
    result = {
        'coverage': coverage, 'metadata': meta, 'selectionReason': reason,
        'downloadUrl': source_url(meta), 'sourceCount': len(ids), 'metadataCount': source_meta_count,
        'sourceBytes': raw_path.stat().st_size,
        'sourceSHA256': hashlib.sha256(raw_path.read_bytes()).hexdigest(),
        'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
        'simplificationPercent': round(percent, 4), 'idsPreserved': True, **stats,
    }
    write(result_path, result, True)
    return result


def validate():
    coverage = read(DATA / 'coverage.json')
    seen, reports = set(), []
    for item in coverage:
        path = ROOT / 'public' / item['localUrl'].lstrip('/')
        fc = read(path)
        assert fc['type'] == 'FeatureCollection'
        assert len(fc['features']) == item['count']
        for f in fc['features']:
            p = f['properties']
            assert f['id'] == p['id'] and p['id'] not in seen
            seen.add(p['id'])
            assert p['countryCode'] == item['code']
            assert p['adminLevel'] == item['adminLevel']
            assert p['name'] and p['level'] == 'local'
            g = shape(f['geometry'])
            assert not g.is_empty and g.is_valid
            assert g.geom_type in ('Polygon', 'MultiPolygon')
            assert all(math.isfinite(v) for v in p['center'] + p['bbox'])
        reports.append({'code': item['code'], 'file': item['localUrl'],
                        'count': item['count'], 'bytes': path.stat().st_size,
                        'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    return reports


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--cache-dir', type=pathlib.Path, default=ROOT / 'outputs/global-geodata-cache')
    parser.add_argument('--workers', type=int, default=4)
    parser.add_argument('--refresh-catalog', action='store_true')
    parser.add_argument('--mapshaper', type=pathlib.Path)
    parser.add_argument('--validate', action='store_true')
    args = parser.parse_args()
    if args.validate:
        print(json.dumps(validate(), ensure_ascii=False, indent=2))
        return
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    GLOBAL.mkdir(parents=True, exist_ok=True)
    mapshaper = ['node', str(args.mapshaper)] if args.mapshaper else ['npx', '--yes', 'mapshaper@0.7.95']
    catalog_path = ROOT / 'outputs/global-boundaries-catalog.json'
    prior_sources = DATA / 'sources-global.json'
    if args.refresh_catalog or not catalog_path.exists():
        if prior_sources.exists() and not args.refresh_catalog:
            write(catalog_path, read(prior_sources)['catalog'], True)
        else:
            if args.refresh_catalog and catalog_path.exists():
                catalog_path.unlink()
            download(CATALOG_URL, catalog_path)
    catalog = read(catalog_path)
    by_country, rejected = {}, []
    for meta in catalog:
        if meta['boundaryType'] == 'ADM0':
            continue
        # Official current catalog has one mislabeled IND ADM0 row repeated as
        # ADM1. Its boundaryID is the reliable evidence for rejecting that row.
        if f"-{meta['boundaryType']}-" not in meta['boundaryID']:
            rejected.append({'boundaryID': meta['boundaryID'], 'boundaryType': meta['boundaryType'],
                             'reason': 'boundaryID and declared level disagree'})
            continue
        by_country.setdefault(meta['boundaryISO'], []).append(meta)
    world = {}
    for feature in read(DATA / 'world.geojson')['features']:
        # Natural Earth repeats AUS for minor island possessions. Preserve the
        # first (main-country) label and viewport, rather than the last island.
        properties = feature['properties']
        world.setdefault(properties['countryCode'], properties)
    prior = {c['code']: c for c in read(DATA / 'coverage.json')}
    old_sources = read(DATA / 'sources.json')
    preserved = []
    for code in sorted(PRESERVE):
        item = dict(prior[code])
        meta = old_sources['locals'][code]
        item.update({'sourceISO': code, 'sourceUrl': f"https://www.geoboundaries.org/api/current/gbOpen/{code}/{item['adminLevel']}/",
                     'canonical': meta.get('boundaryCanonical', ''), 'detailTier': 'local',
                     'center': world[code]['center'], 'bbox': world[code]['bbox'],
                     'bytes': (ROOT / 'public' / item['localUrl'].lstrip('/')).stat().st_size})
        preserved.append(item)
    jobs = [(choose(layers), layers) for iso, layers in sorted(by_country.items()) if iso not in PRESERVE]
    results, failures = [], []

    def worker(job):
        (meta, reason), layers = job
        try:
            return process(meta, reason, world, args.cache_dir, mapshaper), None
        except Exception as first:
            fallbacks = sorted((m for m in layers if int(m['boundaryType'][3:]) < int(meta['boundaryType'][3:])),
                               key=lambda m: int(m['boundaryType'][3:]), reverse=True)
            fallback_errors = []
            for fallback in fallbacks:
                try:
                    result = process(fallback, 'coarser fallback after selected layer failed', world, args.cache_dir, mapshaper)
                    result['fallbackReason'] = str(first)
                    result['coverage']['coverageNote'] += '更细层下载或校验失败，显示已核验的较粗层级边界。'
                    return result, {'code': meta['boundaryISO'], 'selectedLevel': meta['boundaryType'],
                                    'fallback': fallback['boundaryType'], 'reason': str(first)}
                except Exception as second:
                    fallback_errors.append(str(second))
            return None, {'code': meta['boundaryISO'], 'selectedLevel': meta['boundaryType'],
                          'reason': str(first), 'fallbackErrors': fallback_errors}

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(worker, job): job[0][0]['boundaryISO'] for job in jobs}
        for index, future in enumerate(concurrent.futures.as_completed(futures), 1):
            code = futures[future]
            result, failure = future.result()
            if result:
                results.append(result)
                c = result['coverage']
                print(f"[{index}/{len(jobs)}] {code} {c['adminLevel']} {c['count']} units {result['bytes'] / 1e6:.2f} MB", flush=True)
            if failure:
                failures.append(failure)
                print(f"[{index}/{len(jobs)}] ISSUE {code}: {json.dumps(failure, ensure_ascii=False)}", flush=True)
    coverage = sorted(preserved + [r['coverage'] for r in results], key=lambda c: c['code'])
    covered = {c['code'] for c in coverage}
    gaps = [{'code': code, 'name': item['name'], 'reason': 'No gbOpen local administrative layer in the pinned catalog',
             'availableLevel': 'ADM0', 'center': item['center']}
            for code, item in world.items() if code not in covered]
    write(DATA / 'coverage.json', coverage, True)
    write(DATA / 'coverage-gaps.json', {
        'retrievedAt': datetime.date.today().isoformat(), 'catalogUrl': CATALOG_URL,
        'coveredCountriesAndTerritories': len(coverage),
        'regionalOnly': [c['code'] for c in coverage if c['detailTier'] == 'regional'],
        'unavailable': gaps, 'failures': failures, 'rejectedMetadata': rejected,
        'aliases': [{'sourceISO': a, 'mapISO': b, 'evidence': 'geoBoundaries XKX and Natural Earth KOS are both named Kosovo / 科索沃'}
                    for a, b in ISO_ALIASES.items()],
    }, True)
    write(prior_sources, {
        'retrievedAt': datetime.date.today().isoformat(), 'catalogUrl': CATALOG_URL,
        'catalog': catalog, 'preserved': sorted(PRESERVE),
        'pipeline': {'mapshaper': '0.7.95', 'shapely': '2.1.2',
                     'targetBytes': 5000000, 'maximumBytes': 10000000,
                     'coordinatePrecision': 0.00001, 'keepShapes': True,
                     'geometryRepair': 'Shapely make_valid; polygon parts retained; collapsed simplified features restored from their exact source geometry'},
        'datasets': sorted(results, key=lambda r: r['coverage']['code']),
    }, True)
    checks = validate()
    write(DATA / 'validation-global.json', {
        'validatedAt': datetime.date.today().isoformat(),
        'checks': ['globally unique IDs', 'feature IDs match source IDs', 'coverage counts match',
                   'valid nonempty polygon geometry', 'finite center and bbox', 'all assets same-origin'],
        'files': checks,
    }, True)
    print(json.dumps({'countries': len(coverage), 'units': sum(c['count'] for c in coverage),
                      'bytes': sum(c['bytes'] for c in coverage), 'gaps': len(gaps),
                      'failures': len(failures)}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
