#!/usr/bin/env python3
"""Current county-level boundaries for the 26 provinces still on 2017 geometry.

Run outputs/geodata-venv/bin/python scripts/prepare-china-current.py after
prepare-central-china-current.py and apply-review-china-geometry.py, then
apply-current-boundaries.py and the usual downstream steps.

Sources (all kept outside the iCloud project folder, in $ATLAS_BUILD_HOME,
default ~/Library/Caches/light-the-earth):
  osm-china/<province>.osm.pbf   Geofabrik extracts of one dated snapshot
                                 (osm-china/download.sh fetches and checks them)
  china-work/                    extracted administrative areas and coastlines
Names and codes are cross-checked against Wikidata's county-level items
(P442 six-digit codes, cached in outputs/china-county-sources/).

Rules, as for the earlier provinces:
  * Geometry comes from OSM without simplification. Coastal counties are cut
    to the land side of the same snapshot's natural=coastline; inland counties
    to their province.
  * Jiangsu, Shanghai, Zhejiang, Anhui and Jiangxi keep their existing current
    counties untouched; new counties stop where those provinces begin.
  * Every older object (2017 county, earlier seam copy) keeps its ID, geometry
    and travel identity as a historical record. Where a 2017 county reaches
    beyond the current provinces, the part outside becomes a seam copy.
  * Where two source counties overlap, the overlap belongs to neither; closed
    inland gaps become neutral land with no county identity. Sea never does.
"""
import copy, gzip, hashlib, importlib.util, json, math, os, pathlib, re, sys, time
import osmium
from osmium.filter import TagFilter, EntityFilter
from osmium.osm import WAY, AREA, RELATION
from shapely import STRtree, coverage_is_valid, make_valid, union_all
from shapely.geometry import shape, mapping, Point, Polygon, MultiPolygon, LineString
from shapely.ops import unary_union, polygonize_full

ROOT = pathlib.Path(__file__).resolve().parents[1]
HOME = pathlib.Path(os.environ.get('ATLAS_BUILD_HOME', pathlib.Path.home() / 'Library/Caches/light-the-earth'))
PBF = HOME / 'osm-china'
WORK = HOME / 'china-work'
OUT = ROOT / 'public/data/precision'
DATA = ROOT / 'public/data'
VERIFIED = time.strftime('%Y-%m-%d')
WIKIDATA = ROOT / 'outputs/china-county-sources/wikidata-counties.json'
MAX_RAW = 256 * 1024 * 1024
HAN = re.compile(r'[\u3400-\u9fff]')

# Geofabrik extract → provinces it carries (name, ISO 3166-2, coastal).
EXTRACTS = {
    'hebei': [('河北省', 'CN-HE', True), ('北京市', 'CN-BJ', False), ('天津市', 'CN-TJ', True)],
    'shanxi': [('山西省', 'CN-SX', False)], 'inner-mongolia': [('内蒙古自治区', 'CN-NM', False)],
    'liaoning': [('辽宁省', 'CN-LN', True)], 'jilin': [('吉林省', 'CN-JL', False)], 'heilongjiang': [('黑龙江省', 'CN-HL', False)],
    'fujian': [('福建省', 'CN-FJ', True)], 'shandong': [('山东省', 'CN-SD', True)], 'henan': [('河南省', 'CN-HA', False)],
    'hubei': [('湖北省', 'CN-HB', False)], 'hunan': [('湖南省', 'CN-HN', False)], 'guangdong': [('广东省', 'CN-GD', True)],
    'guangxi': [('广西壮族自治区', 'CN-GX', True)], 'hainan': [('海南省', 'CN-HI', True)], 'chongqing': [('重庆市', 'CN-CQ', False)],
    'sichuan': [('四川省', 'CN-SC', False)], 'guizhou': [('贵州省', 'CN-GZ', False)], 'yunnan': [('云南省', 'CN-YN', False)],
    'tibet': [('西藏自治区', 'CN-XZ', False)], 'shaanxi': [('陕西省', 'CN-SN', False)], 'gansu': [('甘肃省', 'CN-GS', False)],
    'qinghai': [('青海省', 'CN-QH', False)], 'ningxia': [('宁夏回族自治区', 'CN-NX', False)], 'xinjiang': [('新疆维吾尔自治区', 'CN-XJ', False)],
}
PROVINCE_CODE = {'CN-BJ': '11', 'CN-TJ': '12', 'CN-HE': '13', 'CN-SX': '14', 'CN-NM': '15', 'CN-LN': '21', 'CN-JL': '22', 'CN-HL': '23',
                 'CN-FJ': '35', 'CN-SD': '37', 'CN-HA': '41', 'CN-HB': '42', 'CN-HN': '43', 'CN-GD': '44', 'CN-GX': '45', 'CN-HI': '46',
                 'CN-CQ': '50', 'CN-SC': '51', 'CN-GZ': '52', 'CN-YN': '53', 'CN-XZ': '54', 'CN-SN': '61', 'CN-GS': '62', 'CN-QH': '63',
                 'CN-NX': '64', 'CN-XJ': '65'}


def read(p): return json.loads(pathlib.Path(p).read_text())
def enc(v, pretty=False): return (json.dumps(v, ensure_ascii=False, allow_nan=False, indent=2 if pretty else None, separators=None if pretty else (',', ':')) + '\n').encode()
def write(p, v, pretty=False): p = pathlib.Path(p); p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(enc(v, pretty))
def sha(x): return hashlib.sha256(x).hexdigest()
def log(*a): print(time.strftime('%H:%M:%S'), *a, flush=True)


def polygonal(g, empty=False):
    if not g.is_valid: g = make_valid(g)
    def parts(x): return [x] if x.geom_type == 'Polygon' else [p for s in getattr(x, 'geoms', []) for p in parts(s)]
    ps = [p for p in parts(g) if not p.is_empty and p.area > 0]
    if not ps:
        assert empty, ('empty geometry', g.geom_type)
        return MultiPolygon([])
    out = ps[0] if len(ps) == 1 else MultiPolygon(ps)
    assert out.is_valid
    return out


def feature_center(g):
    c = g.centroid
    return [c.x, c.y] if g.covers(c) else list(g.representative_point().coords[0])


def snapshot_of(slug):
    reader = osmium.io.Reader(str(PBF / f'{slug}.osm.pbf')); stamp = reader.header().get('osmosis_replication_timestamp'); reader.close()
    return stamp


def extract(slug):
    """Administrative relations at levels 4–6, their member ways, and coastline ways, cached per extract.
    Relations osmium cannot close inside this extract are kept with their members for assemble_missing()."""
    pbf = PBF / f'{slug}.osm.pbf'
    expected = (PBF / f'{slug}.md5.expected').read_text().strip()
    dest = WORK / f'{slug}-admin.geojson'; coast = WORK / f'{slug}-coast.geojson'; store = WORK / f'{slug}-ways.json'
    stamp = snapshot_of(slug)
    if dest.exists() and read(dest).get('md5') == expected and read(dest).get('version') == 2 and coast.exists() and store.exists():
        return read(dest), read(coast), read(store)
    digest = hashlib.md5(pbf.read_bytes()).hexdigest(); assert digest == expected, (slug, 'checksum mismatch')
    relations = {}
    for r in osmium.FileProcessor(str(pbf)).with_filter(EntityFilter(RELATION)).with_filter(TagFilter(('boundary', 'administrative'))):
        if r.tags.get('admin_level') in ('4', '5', '6'):
            relations[r.id] = {'tags': dict(r.tags), 'members': [[m.ref, m.role] for m in r.members if m.type == 'w']}
    members = {ref for v in relations.values() for ref, _ in v['members']}
    fp = (osmium.FileProcessor(str(pbf)).with_locations('flex_mem').with_areas(TagFilter(('boundary', 'administrative')))
          .with_filter(EntityFilter(WAY | AREA)))
    factory = osmium.geom.GeoJSONFactory(); areas = []; lines = []; ways = {}
    for o in fp:
        if o.is_area():
            if o.from_way() or o.tags.get('admin_level') not in ('4', '5', '6'): continue
            try: g = polygonal(shape(json.loads(factory.create_multipolygon(o))))
            except Exception: continue
            areas.append({'type': 'Feature', 'id': o.orig_id(), 'properties': {'tags': dict(o.tags), 'timestamp': str(o.timestamp), 'assembly': 'osmium'}, 'geometry': mapping(g)})
        elif o.is_way():
            if o.id in members: ways[str(o.id)] = [[n.lon, n.lat] for n in o.nodes]
            if o.tags.get('natural') == 'coastline':
                lines.append({'type': 'Feature', 'id': o.id, 'properties': {}, 'geometry': {'type': 'LineString', 'coordinates': [[n.lon, n.lat] for n in o.nodes]}})
    assembled = {f['id'] for f in areas}
    open_relations = {str(k): v for k, v in relations.items() if k not in assembled}
    admin = {'type': 'FeatureCollection', 'version': 2, 'md5': expected, 'snapshot': stamp, 'unassembled': open_relations, 'features': areas}
    write(dest, admin); write(coast, {'type': 'FeatureCollection', 'features': lines}); write(store, ways)
    log('extracted', slug, len(areas), 'areas', len(lines), 'coastline ways', len(open_relations), 'relations left open')
    return admin, read(coast), ways


def assemble(members, ways, audit=None):
    """Polygon of a boundary relation from its member ways; None if a way is missing or a ring stays open.
    Faces are kept by the even-odd rule (a ray from the face crosses the member lines an odd number of
    times), which is how renderers read rings that cross or run in parallel; spurs are ignored."""
    import numpy as np
    if any(str(ref) not in ways for ref, _ in members): return None
    lines = [LineString(ways[str(ref)]) for ref, _ in members]
    polys, cuts, dangles, invalid = polygonize_full(unary_union(lines))
    if not len(polys.geoms) or len(invalid.geoms): return None
    noded = unary_union(lines); spurs = unary_union([*dangles.geoms, *cuts.geoms]) if (len(dangles.geoms) or len(cuts.geoms)) else None
    edges = noded.difference(spurs) if spurs is not None else noded
    segs = np.array([[a, b] for g in getattr(edges, 'geoms', [edges]) for a, b in zip(g.coords, list(g.coords)[1:])])
    ax, ay, bx, by = segs[:, 0, 0], segs[:, 0, 1], segs[:, 1, 0], segs[:, 1, 1]
    kept = []
    for face in polys.geoms:
        x, y = face.representative_point().coords[0]
        cross = (ay > y) != (by > y)
        xs = ax[cross] + (y - ay[cross]) * (bx[cross] - ax[cross]) / (by[cross] - ay[cross])
        if int((xs > x).sum()) % 2: kept.append(face)
    if not kept: return None
    if audit is not None: audit.update(faces=len(polys.geoms), keptFaces=len(kept), spurs=len(dangles.geoms) + len(cuts.geoms), droppedFaceAreaDeg2=sum(f.area for f in polys.geoms) - sum(f.area for f in kept))
    return polygonal(unary_union(kept))


OSM_API = 'https://api.openstreetmap.org/api/0.6'


def api_get(path):
    """One OSM API response, cached in the work folder."""
    import urllib.request, xml.etree.ElementTree as ET
    dest = WORK / 'osm-api' / (path.strip('/').replace('/', '-') + '.osm')
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        request = urllib.request.Request(OSM_API + path, headers={'User-Agent': 'light-the-earth-boundaries/1.0'})
        for attempt in range(4):
            try:
                with urllib.request.urlopen(request, timeout=120) as response: dest.write_bytes(response.read()); break
            except Exception as error:
                if attempt == 3: raise
                log('retry', path, error); time.sleep(10 * (attempt + 1))
        time.sleep(1)
    return ET.parse(dest).getroot()


def version_at(kind, oid, snapshot):
    """The element as it stood at the snapshot (latest version not newer than it)."""
    root = api_get(f'/{kind}/{oid}/history')
    versions = [e for e in root if e.tag == kind and e.attrib['timestamp'] <= snapshot]
    assert versions, (kind, oid, 'created after the snapshot')
    element = max(versions, key=lambda e: int(e.attrib['version']))
    assert element.attrib.get('visible', 'true') == 'true', (kind, oid, 'deleted at the snapshot')
    return element


def api_way(wid, snapshot):
    """Coordinates of a way at the snapshot, for member ways no Geofabrik extract carries."""
    full = api_get(f'/way/{wid}/full')
    nodes = {e.attrib['id']: e for e in full if e.tag == 'node'}
    way = next(e for e in full if e.tag == 'way')
    if way.attrib['timestamp'] > snapshot: way = version_at('way', wid, snapshot)
    coords = []
    for nd in way.iter('nd'):
        node = nodes.get(nd.attrib['ref'])
        if node is None or node.attrib['timestamp'] > snapshot: node = version_at('node', nd.attrib['ref'], snapshot)
        coords.append([float(node.attrib['lon']), float(node.attrib['lat'])])
    return coords


def wikidata_index():
    rows = read(WIKIDATA)['results']['bindings']; by = {}
    for r in rows:
        code = r['code']['value'].replace(' ', '')
        if not re.fullmatch(r'\d{6}', code): continue
        names = {r[k]['value'] for k in ('cn', 'hans', 'zh') if k in r}
        point = None
        if 'coord' in r:
            m = re.match(r'Point\(([-\d.eE]+) ([-\d.eE]+)\)', r['coord']['value'])
            if m: point = (float(m[1]), float(m[2]))
        item = by.setdefault(r['item']['value'].rsplit('/', 1)[1], {'codes': set(), 'names': set(), 'points': set(), 'dissolved': False, 'en': None, 'label': None})
        item['codes'].add(code); item['names'] |= names
        item['label'] = item['label'] or next((r[k]['value'] for k in ('cn', 'hans', 'zh') if k in r), None)
        if point: item['points'].add(point)
        if 'dissolved' in r: item['dissolved'] = True
        if 'en' in r: item['en'] = r['en']['value']
    return by


def zh_name(tags):
    """Chinese name of a unit: name:zh-Hans / name:zh, else the leading Chinese part of a bilingual name."""
    for key in ('name:zh-Hans', 'name:zh', 'name'):
        m = re.match(r'[\u3400-\u9fff·]+', tags.get(key) or '')
        if m: return m[0]
    return tags.get('name')


def find_province(admin, name, iso):
    hits = [f for f in admin['features'] if f['properties']['tags'].get('admin_level') == '4' and zh_name(f['properties']['tags']) == name]
    if len(hits) > 1: hits = [f for f in hits if f['properties']['tags'].get('ISO3166-2') == iso]
    assert len(hits) == 1, (name, [f['id'] for f in hits])
    return hits[0]


def county_units(province, admin):
    """County-level units of one province: admin_level 6 inside it, plus prefecture-level
    cities with no counties (Dongguan, Zhongshan, Jiayuguan, Danzhou)."""
    pg = shape(province['geometry'])
    inside = lambda f: pg.covers(shape(f['geometry']).representative_point())
    level = lambda f: f['properties']['tags'].get('admin_level')
    counties = [f for f in admin['features'] if level(f) == '6' and inside(f)]
    prefectures = [f for f in admin['features'] if level(f) == '5' and inside(f)]
    pgs = [(f, shape(f['geometry'])) for f in prefectures]
    units = []
    for f in counties:
        g = shape(f['geometry'])
        parents = [(p, pg.intersection(g).area) for p, pg in pgs if pg.intersects(g)]
        parents = [x for x in parents if x[1] > .5 * g.area]
        # A zone nested in a city (平潭综合实验区 in 福州市) is not the county's parent: take the largest.
        parent = max(parents, key=lambda x: shape(x[0]['geometry']).area)[0] if parents else None
        units.append((f, parent, len(parents)))
    report = []
    for p, g in pgs:
        children = [u for u, parent, _ in units if parent is p]
        covered = unary_union([shape(u['geometry']) for u in children]).intersection(g).area if children else 0
        share = covered / g.area
        if not children: units.append((p, None, 0))
        if share < .995: report.append({'prefecture': p['properties']['tags'].get('name'), 'relation': p['id'], 'counties': len(children), 'coveredShare': round(share, 4)})
    return units, report


def coast_land(label, province, lines, historical):
    """Land side of the snapshot's directed natural=coastline (land left, sea right).
    Faces no coastline touches take the side the earlier national land layer gives them."""
    cache = WORK / f'coast-{label}.json'
    fingerprint = sha(enc({'province': mapping(province), 'lines': [mapping(g) for g in lines]}))
    if cache.exists() and (c := read(cache))['fingerprint'] == fingerprint:
        return shape(c['land']), shape(c['sea']), c['audit']
    cells, cuts, dangles, invalid = polygonize_full(union_all([province.boundary, *lines]))
    kept = [g for g in cells.geoms if province.covers(g.representative_point())]
    tree = STRtree(kept); votes = [[0., 0.] for _ in kept]
    pts, owners = [], []
    for line in lines:
        cs = list(line.coords)
        for a, b in zip(cs, cs[1:]):
            dx, dy = b[0] - a[0], b[1] - a[1]; length = math.hypot(dx, dy)
            if not length: continue
            eps = min(1e-7, length / 10)
            for side, sign in ((0, 1), (1, -1)):
                pts.append(Point((a[0] + b[0]) / 2 - sign * dy / length * eps, (a[1] + b[1]) / 2 + sign * dx / length * eps)); owners.append((side, length))
    if pts:
        hit_points, hit_faces = tree.query(pts, predicate='within')
        for p, f in zip(hit_points, hit_faces):
            side, length = owners[int(p)]; votes[int(f)][side] += length
    land_ids, sea_ids, untouched, mixed = [], [], [], []
    for i, (left, right) in enumerate(votes):
        face = kept[i]
        if left == 0 and right == 0:
            point = face.representative_point(); is_land = historical.covers(point)
            (land_ids if is_land else sea_ids).append(i)
            untouched.append({'areaDeg2': face.area, 'point': [point.x, point.y], 'land': is_land})
            continue
        if min(left, right) / max(left, right) > 1e-3:
            mixed.append({'areaDeg2': face.area, 'point': list(face.representative_point().coords[0]), 'landVotes': left, 'seaVotes': right})
        (land_ids if left > right else sea_ids).append(i)
    land = polygonal(unary_union([kept[i] for i in land_ids]), empty=True)
    sea = polygonal(unary_union([kept[i] for i in sea_ids]), empty=True)
    inside = lambda gs: [g for g in gs.geoms if g.intersection(province).length > 1e-10]
    audit = {'coastWays': len(lines), 'faces': len(kept), 'landFaces': len(land_ids), 'seaFaces': len(sea_ids),
             'facesWithoutCoastline': untouched, 'facesWithMixedVotes': mixed,
             'danglingCoastlineSegmentsInside': len(inside(dangles)), 'cutEdgesInside': len(inside(cuts)), 'invalidRings': len(invalid.geoms),
             'administrativeAreaDeg2': province.area, 'landAreaDeg2': land.area, 'seaAreaDeg2': sea.area,
             'rule': 'Same-snapshot OSM natural=coastline ways polygonised with the province boundary; land left, sea right. Faces touching no coastline follow the earlier national land layer. No smoothing or simplification.'}
    write(cache, {'fingerprint': fingerprint, 'land': mapping(land), 'sea': mapping(sea), 'audit': audit})
    return land, sea, audit


def short_name(name):
    for suffix in ('自治县', '自治旗', '特区', '林区', '县', '区', '市', '旗'):
        if name.endswith(suffix) and len(name) - len(suffix) >= 2: return name[:-len(suffix)]
    return name


def pack(name, value):
    raw = enc(value); assert len(raw) < MAX_RAW, (name, len(raw))
    (OUT / name).write_bytes(raw)
    return {'url': '/data/precision/' + name, 'bytes': len(raw), 'sha256': sha(raw)}



EARLIER_PROVINCES = [('outputs/east-china-cache/jiangsu-admin.geojson', 913012), ('outputs/east-china-cache/shanghai-admin.geojson', 913067),
                     ('outputs/current-china-cache/zhejiang-province-extracted.geojson', 553302),
                     ('outputs/central-china-cache/anhui-admin.geojson', 913011), ('outputs/central-china-cache/relation-913109.geojson', 913109)]


def match_wikidata(tags, iso, wd, by_name):
    """Code and name evidence from Wikidata: the item OSM links to, else a unique live name match in the province."""
    prefix = PROVINCE_CODE[iso]; name = zh_name(tags); ref = tags.get('ref:admin:CN')
    qid = tags.get('wikidata'); item = wd.get(qid) if qid else None; how = 'osm-wikidata-tag'
    if not item or not any(c.startswith(prefix) for c in item['codes']):
        live = [k for k in by_name.get(name, []) if not wd[k]['dissolved'] and any(c.startswith(prefix) for c in wd[k]['codes'])]
        if len(live) != 1: return None
        qid, item, how = live[0], wd[live[0]], 'unique-name-in-province'
    codes = sorted(c for c in item['codes'] if c.startswith(prefix))
    code = ref if ref in codes else codes[0] if len(codes) == 1 else None
    return {'qid': qid, 'how': how, 'code': code, 'codes': codes, 'nameAgrees': name in item['names'], 'dissolved': item['dissolved'], 'en': item['en'], 'label': item['label']}


def main():
    WORK.mkdir(parents=True, exist_ok=True)
    previous = read(DATA / 'current-central-china.json'); align = copy.deepcopy(previous['alignment'])
    data = read(ROOT / ('public' + align['localUrl'])); original = {f['id']: copy.deepcopy(f) for f in data['features']}
    assert len(original) == len(data['features']) == align['count'], 'restore the precision sources first (node scripts/restore-precision-geometry.mjs)'
    catalog = read(DATA / 'name-quality.json')['regions']
    oldcurrent_ids = {r['id'] for rows in previous['currentRegionsByProvince'].values() for r in rows}
    suppressed = set(align['suppressedIds']); aliases = copy.deepcopy(align['legacyAliases']); retired = copy.deepcopy(previous['retiredRegions'])
    oldprov = polygonal(unary_union([shape(next(f['geometry'] for f in read(ROOT / path)['features'] if f['id'] == rid)) for path, rid in EARLIER_PROVINCES]))
    oldcountry = polygonal(shape(read(ROOT / ('public' + align['countryUrl']))['features'][0]['geometry']))
    oldfallback = polygonal(shape(read(ROOT / ('public' + align['fallbackUrl']))['features'][0]['geometry']), empty=True)
    wd = wikidata_index(); by_name = {}
    for k, v in wd.items():
        for n in v['names']: by_name.setdefault(n, []).append(k)

    extracts = {k: v for k, v in EXTRACTS.items() if not os.environ.get('CHINA_ONLY') or k in os.environ['CHINA_ONLY'].split(',')}  # CHINA_ONLY: trial runs
    snapshots = {slug: snapshot_of(slug) for slug in extracts}
    assert len(set(snapshots.values())) == 1, snapshots
    SNAPSHOT = next(iter(snapshots.values())); DAY = SNAPSHOT[:10]
    log('snapshot', SNAPSHOT)

    provinces = []; lines = {}; incomplete = {}; admins = {}; ways = {}
    for slug in extracts:
        admin, coast, store = extract(slug); admins[slug] = admin; ways.update(store)
        for f in coast['features']: lines.setdefault(f['id'], f['geometry']['coordinates'])
    # Relations no single extract closes (a member way lies in a neighbouring extract): assemble from all of them.
    assembled = {f['id'] for a in admins.values() for f in a['features']}; recovered = set()
    for slug, admin in admins.items():
        incomplete[slug] = []
        for rid, rel in admin['unassembled'].items():
            rid = int(rid)
            if rid in assembled or rid in recovered: continue
            note = {}; g = assemble(rel['members'], ways, note)
            if g is None: incomplete[slug].append({'relation': rid, 'name': rel['tags'].get('name'), 'adminLevel': rel['tags'].get('admin_level')}); continue
            admin['features'].append({'type': 'Feature', 'id': rid, 'properties': {'tags': rel['tags'], 'assembly': 'member-ways-across-extracts', 'assemblyAudit': note}, 'geometry': mapping(g)}); recovered.add(rid)
    log('relations assembled across extracts:', len(recovered))
    # One pool of areas: a relation may close only in a neighbouring extract.
    pool = {}
    for a in admins.values():
        for f in a['features']: pool.setdefault(f['id'], f)
    admin = {'features': list(pool.values())}
    open_relations = {int(rid): rel for a in admins.values() for rid, rel in a['unassembled'].items() if int(rid) not in pool}
    fetched = {}
    def supplement(rid):
        rel = open_relations[rid]; missing = [ref for ref, _ in rel['members'] if str(ref) not in ways]
        for ref in missing: ways[str(ref)] = fetched[ref] = api_way(ref, SNAPSHOT)
        note = {}; g = assemble(rel['members'], ways, note); assert g is not None, ('still open after fetching member ways', rid, rel['tags'].get('name'))
        f = {'type': 'Feature', 'id': rid, 'properties': {'tags': rel['tags'], 'assembly': 'member-ways-with-osm-api-supplement', 'apiWays': missing, 'assemblyAudit': note}, 'geometry': mapping(g)}
        pool[rid] = f; admin['features'].append(f); del open_relations[rid]
        for a in admins.values(): a['unassembled'].pop(str(rid), None)
        log('assembled', rid, zh_name(rel['tags']), 'with', len(missing), 'ways from the OSM API')
    # Provinces first: their own relations may reach into the sea beyond every extract.
    for members in extracts.values():
        for name, iso, coastal in members:
            if any(f['properties']['tags'].get('admin_level') == '4' and zh_name(f['properties']['tags']) == name for f in admin['features']): continue
            rid = next(r for r, rel in open_relations.items() if rel['tags'].get('admin_level') == '4' and zh_name(rel['tags']) == name and rel['tags'].get('ISO3166-2', iso) == iso)
            supplement(rid)
    targets = polygonal(unary_union([shape(f['geometry']) for f in admin['features'] if f['properties']['tags'].get('admin_level') == '4' and f['properties']['tags'].get('ISO3166-2') in PROVINCE_CODE]))
    # Then prefectures and counties of these provinces left open for the same reason.
    for rid, rel in list(open_relations.items()):
        if rel['tags'].get('admin_level') not in ('5', '6') or not re.match(r'[\u3400-\u9fff]', rel['tags'].get('name', '')): continue
        ref = rel['tags'].get('ref:admin:CN', '')
        if ref and ref[:2] not in PROVINCE_CODE.values(): continue
        known = [ways[str(ref)] for ref, _ in rel['members'] if str(ref) in ways]
        points = [Point(c) for w in known for c in w[::max(1, len(w) // 8)]]
        if points and sum(targets.covers(pt) for pt in points) > .8 * len(points): supplement(rid)
    for slug in admins: incomplete[slug] = [{'relation': rid, 'name': zh_name(rel['tags']), 'adminLevel': rel['tags'].get('admin_level')} for rid, rel in open_relations.items() if str(rid) in admins[slug]['unassembled']]
    for slug, members in extracts.items():
        for name, iso, coastal in members:
            pf = find_province(admin, name, iso); units, partial = county_units(pf, admin)
            provinces.append({'slug': slug, 'name': name, 'iso': iso, 'coastal': coastal, 'relation': pf['id'], 'geometry': polygonal(shape(pf['geometry'])), 'units': units, 'partialPrefectures': partial})
        log(slug, ', '.join(f"{p['name']} {len(p['units'])}" for p in provinces if p['slug'] == slug))
    newprov = polygonal(unary_union([p['geometry'] for p in provinces]))
    combined = polygonal(unary_union([newprov, oldprov]))
    province_overlaps = []
    for i, a in enumerate(provinces):
        for b in provinces[i + 1:]:
            if (area := a['geometry'].intersection(b['geometry']).area) > 1e-12: province_overlaps.append({'a': a['name'], 'b': b['name'], 'areaDeg2': area})
        if (area := a['geometry'].intersection(oldprov).area) > 1e-12: province_overlaps.append({'a': a['name'], 'b': 'earlier current provinces', 'areaDeg2': area})

    # Physical land of each province.
    line_geoms = {k: LineString(v) for k, v in lines.items()}; line_ids = list(line_geoms); line_tree = STRtree([line_geoms[k] for k in line_ids])
    coast_audit = {}; seas = []
    for p in provinces:
        if not p['coastal']:
            p['land'] = p['geometry'].difference(oldprov); continue
        near = [line_geoms[line_ids[int(i)]] for i in line_tree.query(p['geometry'], predicate='intersects')]
        land, sea, audit = coast_land(p['iso'], p['geometry'], near, oldcountry)
        p['land'] = polygonal(land.difference(oldprov), empty=True); seas.append(sea.difference(oldprov)); coast_audit[p['name']] = audit
        log('coast', p['name'], 'ways', len(near), 'mixed faces', len(audit['facesWithMixedVotes']), 'faces without coastline', len(audit['facesWithoutCoastline']))
    sea = polygonal(unary_union(seas), empty=True)

    # Counties: OSM polygon ∩ province land, outside the earlier current provinces.
    current = []; administrative = []; dropped = []; unmatched = []; wikidata_notes = []
    for p in provinces:
        for f, parent, parent_count in p['units']:
            t = f['properties']['tags']; rid = f['id']; name = zh_name(t); sid = f'OSM-CHN-relation-{rid}'
            assert sid not in original, sid
            raw = polygonal(shape(f['geometry']))
            g = polygonal(raw.intersection(p['land']), empty=True)
            if g.is_empty or g.area < 1e-10:
                dropped.append({'id': sid, 'name': name, 'province': p['name'], 'rawAreaDeg2': raw.area, 'landAreaDeg2': g.area}); continue
            parent_name = zh_name(parent['properties']['tags']) if parent else p['name']
            m = match_wikidata(t, p['iso'], wd, by_name)
            if not m and t.get('admin_level') == '5' and t.get('wikidata') and parent is None :
                # Prefecture-level cities without counties: the cached Wikidata list holds county codes only.
                ref = t.get('ref:admin:CN', ''); code = ref + '00' if re.fullmatch(r'\d{4}', ref) else ref if re.fullmatch(r'\d{6}', ref) else None
                m = {'qid': t['wikidata'], 'how': 'osm-wikidata-tag-prefecture', 'code': code, 'codes': [code] if code else [], 'nameAgrees': True, 'dissolved': False, 'en': None, 'label': None}
            if not m: unmatched.append({'id': sid, 'name': name, 'parent': parent_name, 'province': p['name'], 'level': t.get('admin_level'), 'osmWikidata': t.get('wikidata')})
            elif not m['nameAgrees'] or m['dissolved'] or not m['code']: wikidata_notes.append({'id': sid, 'name': name, **{k: m[k] for k in ('qid', 'how', 'codes', 'nameAgrees', 'dissolved')}})
            evidence = f"https://www.wikidata.org/wiki/{m['qid']}" if m else f'https://www.openstreetmap.org/relation/{rid}'
            note = (f'现行县级区划采用{DAY} OSM统一快照；名称与区划代码经Wikidata核对。' if m and m['nameAgrees'] and not m['dissolved']
                    else f'现行边界采用{DAY} OSM统一快照；名称取自OSM，Wikidata未见对应的现行县级区划（可能为功能区或新近调整）。')
            osm_name = name
            if m and not m['nameAgrees'] and not m['dissolved'] and m['code'] and m.get('label') and HAN.match(m['label']):
                name = m['label']; m['nameAgrees'] = True  # the name that goes with the official code; OSM's stays an alias
                note = f'现行县级区划采用{DAY} OSM统一快照；显示与区划代码{m["code"]}对应的正式名称（OSM记作“{osm_name}”）。'
            en = t.get('name:en') or (m['en'] if m else None) or name
            props = {'id': sid, 'name': name, 'originalName': en, 'aliases': list(dict.fromkeys([name, short_name(name), parent_name + name, osm_name, en])),
                     'parentName': parent_name, 'provinceName': p['name'], 'countryCode': 'CHN', 'countryName': '中国', 'level': 'local', 'adminLevel': 'ADM3',
                     'adminCode': (m or {}).get('code') or t.get('ref:admin:CN'), 'year': '2026（OSM快照）',
                     'source': f"© OpenStreetMap contributors · Geofabrik {p['slug']}；{SNAPSHOT}", 'sourceUrl': f'https://www.openstreetmap.org/relation/{rid}',
                     'license': 'ODbL 1.0', 'nameStatus': 'verified', 'boundarySnapshot': SNAPSHOT, 'officialNameCodeEvidenceURL': evidence,
                     'wikidata': (m or {}).get('qid'), 'nameNote': note, 'osmAdminLevel': t.get('admin_level')}
            administrative.append({'type': 'Feature', 'id': sid, 'properties': dict(props, center=feature_center(raw), bbox=list(raw.bounds)), 'geometry': mapping(raw)})
            props.update(center=feature_center(g), bbox=list(g.bounds), geometryRole='current-physical-land' if p['coastal'] else 'province-clipped-current-inland-administrative-land')
            current.append({'type': 'Feature', 'id': sid, 'properties': props, 'geometry': g})
    ids = [f['id'] for f in current]; assert len(ids) == len(set(ids))
    # Unofficial parts OSM maps under an official unit (XPCC 垦区 under 可克达拉市) join that unit.
    merged = []
    official = {(f['properties']['provinceName'], f['properties']['name']): f for f in current if f['properties']['wikidata']}
    for f in list(current):
        owner = official.get((f['properties']['provinceName'], f['properties']['parentName']))
        if f['properties']['wikidata'] or not owner: continue
        owner['geometry'] = polygonal(unary_union([owner['geometry'], f['geometry']]))
        owner['properties']['aliases'] = list(dict.fromkeys([*owner['properties']['aliases'], f['properties']['name']]))
        owner['properties'].update(center=feature_center(owner['geometry']), bbox=list(owner['geometry'].bounds), geometryNote=owner['properties'].get('geometryNote', '') + f"含OSM单列的{f['properties']['name']}。")
        merged.append({'id': f['id'], 'name': f['properties']['name'], 'into': owner['id'], 'intoName': owner['properties']['name']}); current.remove(f)
    # The same land mapped twice (平潭县 and 平潭综合实验区): keep the coded county-level unit.
    duplicates = []
    gs = [f['geometry'] for f in current]; tree = STRtree(gs); drop = set()
    for i, g in enumerate(gs):
        for j in tree.query(g, predicate='intersects'):
            j = int(j)
            if j <= i or i in drop or j in drop: continue
            if g.intersection(gs[j]).area < .9 * min(g.area, gs[j].area): continue
            rank = lambda k: (bool(current[k]['properties']['wikidata']), current[k]['properties']['osmAdminLevel'] == '6')
            loser = min((i, j), key=rank)
            if rank(i) == rank(j): continue
            drop.add(loser); duplicates.append({'dropped': current[loser]['id'], 'name': current[loser]['properties']['name'], 'kept': current[i + j - loser]['id'], 'keptName': current[i + j - loser]['properties']['name']})
    current = [f for k, f in enumerate(current) if k not in drop]
    if merged or duplicates: log('merged', merged, 'duplicates', duplicates)
    log('counties', len(current), 'dropped', len(dropped), 'without wikidata', len(unmatched), 'wikidata notes', len(wikidata_notes))

    # Overlapping source counties: the overlap belongs to neither.
    gs = [f['geometry'] for f in current]; tree = STRtree(gs); conflicts = []; cut = {}
    for i, g in enumerate(gs):
        for j in tree.query(g, predicate='intersects'):
            j = int(j)
            if j <= i: continue
            area = g.intersection(gs[j])
            if area.area <= 1e-12: continue
            conflicts.append({'a': current[i]['id'], 'aName': current[i]['properties']['name'], 'b': current[j]['id'], 'bName': current[j]['properties']['name'], 'areaDeg2': area.area})
            for k in (i, j): cut.setdefault(k, []).append(area)
    consumed = []
    for i, parts in cut.items():
        g = polygonal(gs[i].difference(unary_union(parts)), empty=True); gs[i] = g
        if g.is_empty or g.area < 1e-10: consumed.append(i); continue
        current[i]['properties'].update(center=feature_center(g), bbox=list(g.bounds), geometryQualityNote='源边界交叠从双方点击面同时扣除，未推断县级归属。')
    for f, g in zip(current, gs): f['geometry'] = mapping(g)
    consumed_units = [{'id': current[i]['id'], 'name': current[i]['properties']['name']} for i in consumed]
    for i in sorted(consumed, reverse=True): del current[i]
    if consumed_units: log('units wholly inside source overlaps', consumed_units)
    log('conflicts', len(conflicts))

    # Older objects: historical where current provinces now cover them; the part outside becomes a seam copy.
    # Remnants outside every current province: real pieces (disputed areas the 2017 source drew inside China)
    # stay as seam copies; pieces inside holes of the national outline become neutral land; border slivers go.
    MIN_SEAM_PART = .01  # deg², about 100 km²
    holes = polygonal(unary_union([Polygon(r) for p in getattr(combined, 'geoms', [combined]) for r in p.interiors]), empty=True)
    seams = []; remnants = []; untouched = []; hole_parts = []
    for fid, f in original.items():
        if fid in suppressed or fid in oldcurrent_ids: continue
        assert fid.startswith(('GB-', 'SEAM-CHN-')), fid
        g = polygonal(shape(f['geometry'])); overlap = g.intersection(combined).area
        if overlap <= 1e-12: untouched.append(fid); continue
        legacy = f['properties'].get('legacyGeometryId', fid); meta = catalog.get(legacy, {}) | catalog.get(fid, {}) if fid.startswith('SEAM-') else catalog.get(fid, {})
        name = re.sub(r'（[^）]*旧[^）]*）$', '', meta.get('name') or f['properties']['name']); status = meta.get('status', 'unresolved')
        suppressed.add(fid); aliases[fid] = fid
        retired.setdefault(fid, {'name': name + ('（2017年旧界）' if fid.startswith('GB-') else '（接边旧副本）'), 'aliases': list(dict.fromkeys([name, *meta.get('aliases', []), *f['properties'].get('aliases', [])])),
                                 'parentName': meta.get('parentName', f['properties'].get('parentName', '')),
                                 'note': f'保留原始边界和旅行身份。现行区县采用{DAY} OSM统一快照；此标记表示几何更替，不表示该单位撤销。',
                                 'evidenceURLs': meta.get('evidenceURLs', []), 'lastValidYear': None, 'retiredAt': VERIFIED, 'sourceGeometryYear': '2017',
                                 'retirementKind': 'geometry-superseded' if fid.startswith('GB-') else 'cartographic-seam-superseded',
                                 'oldUnitNameVerified': status == 'verified', 'status': status, 'nameStatus': status})
        rest = polygonal(g.difference(combined), empty=True); parts = [] if rest.is_empty else list(getattr(rest, 'geoms', [rest]))
        kept = [q for q in parts if q.area >= MIN_SEAM_PART]; inner = [q for q in parts if q.area < MIN_SEAM_PART and holes.covers(q.representative_point())]
        hole_parts.extend(inner)
        remnants.append({'legacyId': fid, 'name': name, 'overlapAreaDeg2': overlap, 'remnantAreaDeg2': rest.area, 'remnantParts': len(parts),
                         'seamAreaDeg2': sum(q.area for q in kept), 'neutralHoleAreaDeg2': sum(q.area for q in inner), 'droppedBorderSliverAreaDeg2': rest.area - sum(q.area for q in kept) - sum(q.area for q in inner)})
        if not kept: continue
        rest = polygonal(unary_union(kept))
        sid = 'SEAM-CHN-' + legacy + '-NATIONAL' + DAY.replace('-', '')
        seam = copy.deepcopy(f); seam.update(id=sid, geometry=mapping(rest))
        seam['properties'].update(id=sid, name=name, aliases=retired[fid]['aliases'], parentName=retired[fid]['parentName'], center=feature_center(rest), bbox=list(rest.bounds),
                                  year='2017区划；2026全国接边', sourceGeometryYear='2017', source=f'geoBoundaries 2017；仅按{DAY} OSM省界裁去重叠', legacyGeometryId=legacy,
                                  cartographicRepair='subtract-current-provinces', nameStatus=status,
                                  note='2017年来源画在现行OSM省界以外的部分（多为争议地区），沿用旧几何与名称；不表示已核验的现行县界。')
        seams.append(seam)
    log('retired', len(remnants), 'seam copies', len(seams), 'untouched 2017', len(untouched))
    if os.environ.get('CHINA_ONLY'): return locals()

    data['features'].extend([*current, *seams]); by = {f['id']: f for f in data['features']}; assert len(by) == len(data['features'])
    assert all(by[fid] == f for fid, f in original.items()), 'an earlier object changed'
    active = [f for f in data['features'] if f['id'] not in suppressed]; ags = [polygonal(shape(f['geometry'])) for f in active]
    activeunion = polygonal(unary_union(ags)); tree = STRtree(ags); pairs = []
    for i, g in enumerate(ags):
        for j in tree.query(g, predicate='intersects'):
            j = int(j)
            if j > i and (area := g.intersection(ags[j]).area) > 1e-12: pairs.append({'a': active[i]['id'], 'b': active[j]['id'], 'areaDeg2': area})
    assert not pairs, pairs[:10]
    assert activeunion.intersection(sea).area < 1e-9, activeunion.intersection(sea).area

    # Neutral land: province land no county claims, and earlier neutral land outside the new provinces.
    newland = polygonal(unary_union([p['land'] for p in provinces]))
    fallback = polygonal(unary_union([newland, oldfallback.difference(newprov), *hole_parts]).difference(activeunion), empty=True)
    country = polygonal(unary_union([activeunion, fallback]))
    lost = polygonal(oldcountry.difference(country), empty=True)
    lost_outside = polygonal(lost.difference(newprov), empty=True)
    dropped_slivers = sum(r['droppedBorderSliverAreaDeg2'] for r in remnants)
    assert lost_outside.area < dropped_slivers + 1e-6, ('earlier land lost outside the new provinces', lost_outside.area, dropped_slivers)

    assets = {'local': pack('chn-current.geojson', data)}
    for kind, g, role in [('land', activeunion, 'exact-active-administrative-union'), ('fallback', fallback, 'neutral-land-without-current-county'), ('country', country, 'active-union-plus-neutral-land')]:
        assets[kind] = pack(f'chn-current-{kind}.geojson', {'type': 'FeatureCollection', 'features': [{'type': 'Feature', 'id': 'CHN-' + kind, 'properties': {'countryCode': 'CHN', 'name': '中国' if kind != 'fallback' else '未分配区县的陆地', 'role': role, **({'pickable': False} if kind != 'country' else {})}, 'geometry': mapping(g)}]})
    for kind, a in assets.items():
        align[kind + 'Url'] = a['url']; align[kind + 'Bytes'] = a['bytes']; align['sha256'][kind] = a['sha256']
        for key in ('GzipUrl', 'GzipBytes', 'GzipParts'): align.pop(kind + key, None)
        align['sha256'].pop(kind + 'Gzip', None)
    write(WORK / 'chn-current-administrative.geojson', {'type': 'FeatureCollection', 'features': administrative})

    rows = [{'id': f['id'], 'code': f['properties']['adminCode'], 'name': f['properties']['name'], 'parentName': f['properties']['parentName'], 'provinceName': f['properties']['provinceName'], 'evidenceURL': f['properties']['officialNameCodeEvidenceURL'], 'wikidata': f['properties']['wikidata']} for f in current]
    byprov = {p['name']: [r for r in rows if r['provinceName'] == p['name']] for p in provinces}
    provinceaudits = {}
    for p in provinces:
        units = [shape(f['geometry']) for f in current if f['properties']['provinceName'] == p['name']]; union = unary_union(units)
        provinceaudits[p['name']] = {'relation': p['relation'], 'extract': p['slug'], 'coastal': p['coastal'], 'counties': len(units), 'partialPrefectures': p['partialPrefectures'],
                                     'landAreaDeg2': p['land'].area, 'countyAreaDeg2': union.area, 'neutralAreaDeg2': p['land'].difference(union).area,
                                     'outsideProvinceLandAreaDeg2': union.difference(p['land']).area, 'coverageIsValid': bool(coverage_is_valid(units))}
    fixtures = []
    for label, xy, name in [('Beijing', [116.397, 39.909], '东城区'), ('Shenzhen', [114.06, 22.54], '福田区'), ('Chengdu', [104.0436, 30.6656], '青羊区'), ('Lhasa', [91.14, 29.65], '城关区'),
                            ('Urumqi', [87.62, 43.80], '天山区'), ('Haikou', [110.33, 20.04], '龙华区'), ('Dongguan', [113.75, 23.02], '东莞市'), ('Xiongan', [115.92, 39.04], '容城县')]:
        hits = [f['properties']['name'] for f in current if shape(f['geometry']).covers(Point(*xy))]
        fixtures.append({'label': label, 'coordinates': xy, 'expected': name, 'hits': hits, 'ok': hits == [name]})
    if not all(x['ok'] for x in fixtures): log('FIXTURE MISMATCH', [x for x in fixtures if not x['ok']])
    audit = {'snapshotAt': SNAPSHOT, 'extracts': {slug: {'snapshot': snapshots[slug], 'incompleteRelations': incomplete[slug]} for slug in extracts},
             'baselineStoredCount': len(original), 'newCountyCount': len(current), 'earlierCurrentCount': len(oldcurrent_ids), 'retiredCount': len(remnants),
             'newSeamCount': len(seams), 'untouched2017Count': len(untouched), 'storedCount': len(data['features']), 'activeCount': len(active), 'suppressedCount': len(suppressed),
             'droppedSeaOnlyUnits': dropped, 'unitsWithoutWikidata': unmatched, 'wikidataNotes': wikidata_notes, 'sourceCountyOverlapConflicts': conflicts, 'unitsWhollyInsideOverlaps': consumed_units, 'mergedIntoOfficialUnits': merged, 'duplicateUnitsDropped': duplicates,
             'provinceOverlaps': province_overlaps, 'positiveOverlapPairs': pairs, 'activeInSeaAreaDeg2': activeunion.intersection(sea).area,
             'earlierLandNowSeaOrUnclaimedAreaDeg2': lost.area, 'earlierLandOutsideProvincesDroppedAreaDeg2': lost_outside.area, 'droppedBorderSliverAreaDeg2': dropped_slivers, 'minimumSeamPartAreaDeg2': MIN_SEAM_PART, 'neutralLandAreaDeg2': fallback.area, 'provinces': provinceaudits, 'coastlines': coast_audit,
             'countyFixtureChecks': fixtures, 'seamRepairs': remnants, 'allPreviousObjectsRetainedUnchanged': True}
    write(WORK / 'china-current-audit.json', audit, True)

    align.update(count=len(data['features']), renderCount=len(active), suppressedIds=sorted(suppressed), legacyAliases=aliases,
                 source=f'© OpenStreetMap contributors（中国大陆31省区市现行县级区划；{DAY}及2026-10-25快照）· geoBoundaries 2017（历史边界与境外接边残片）',
                 sourceUrl='https://download.geofabrik.de/asia/china.html', sourceYear=f'2026（OSM快照：26省区市{DAY}；苏沪浙皖赣2026-10-25）；{len(seams)}处争议地区残片沿用2017', snapshotAt=SNAPSHOT, verifiedAt=VERIFIED,
                 checks={k: v for k, v in audit.items() if k not in ('coastlines', 'seamRepairs', 'provinces')},
                 preparation=f'Earlier feature superset retained unchanged. {len(current)} county-level units from the {DAY} Geofabrik extracts, province-clipped and cut to the same snapshot natural=coastline; names and codes cross-checked with Wikidata P442. Overlaps assigned to neither; unclaimed province land neutral. All 2017 objects now covered are historical; parts outside current provinces kept as seam copies.')
    notes = [f'中国大陆31个省级行政区的县级边界均来自OSM快照（26省区市为{DAY}，苏沪浙皖赣为2026-10-25），并非官方测绘成果。',
             '新增26省区市的名称和六位区划代码与Wikidata（P442）逐项核对；未能对上的单位在审计中列出，地图沿用OSM中文名。',
             '沿海省份按同一快照的OSM海岸线裁切到陆地；内陆省份按省界裁切。来源区县互相重叠的部分不归任何一方，未被区县覆盖的省内陆地为中性陆地。',
             '2017年旧区县和此前的接边副本全部保留为历史身份，旧足迹不自动迁移；越出现行省界的旧区县残片保留为接边副本。']
    currentrs = [*previous['currentRegions'], *rows]
    sources = [{'file': f'osm-china/{slug}.osm.pbf', 'url': f'https://download.geofabrik.de/asia/china/{slug}/{slug}-{(PBF / f"{slug}.snapshot").read_text().strip()}.osm.pbf', 'md5': (PBF / f'{slug}.md5.expected').read_text().strip(), 'bytes': (PBF / f'{slug}.osm.pbf').stat().st_size} for slug in extracts]
    manifest = {'version': 1, 'snapshotAt': SNAPSHOT, 'verifiedAt': VERIFIED, 'alignment': align, 'retiredRegions': retired,
                'currentAdministrative': {'path': 'china-work/chn-current-administrative.geojson', 'count': len(administrative), 'runtime': False, 'published': False, 'geometryRole': 'uncropped-source-current-administrative-provenance'},
                'sourceArchives': [previous['currentAdministrative'], *previous.get('sourceArchives', [])],
                'coastlineEvidence': previous['coastlineEvidence'], 'suggestedFallback': {**assets['fallback'], 'areaDeg2': fallback.area, 'ownership': None},
                'seamRegions': [*previous['seamRegions'], *[{'id': f['id'], 'legacyId': f['properties']['legacyGeometryId'], 'name': f['properties']['name'], 'nameStatus': f['properties']['nameStatus'], 'parentName': f['properties']['parentName']} for f in seams]],
                'coveragePatch': {'count': len(data['features']), 'source': align['source'], 'sourceYear': align['sourceYear'], 'license': previous['coveragePatch']['license'], 'sourceUrl': align['sourceUrl'],
                                  'coverageNote': '中国大陆31省区市县级区划均采用2026年OSM快照：' + '；'.join(notes)},
                'evidenceURLs': [*previous['evidenceURLs'], 'https://download.geofabrik.de/asia/china.html', 'https://www.wikidata.org/wiki/Property:P442'],
                'licensing': previous['licensing'], 'officialRoster': previous['officialRoster'], 'currentRegions': currentrs,
                'currentRegionsByProvince': {**previous['currentRegionsByProvince'], **byprov}, 'sourceCache': [*previous['sourceCache'], *sources],
                'audit': {k: v for k, v in audit.items() if k != 'coastlines'}, 'limitations': [*notes, *previous['limitations']]}
    write(DATA / 'current-china.json', manifest, True)
    log('wrote', len(data['features']), 'features,', len(active), 'active;', {k: round(v['bytes'] / 2**20, 1) for k, v in assets.items()}, 'MiB')


if __name__ == '__main__': main()
