#!/usr/bin/env python3
"""Build one light line mesh of every country's internal local boundaries.

The map shows it between the zoom where local boundaries first appear and the
zoom where a country's exact polygons are on screen, so dense countries whose
exact detail waits for a closer view still show their divisions from afar.

Lines only, for display: selection, colouring and saving keep using the exact
polygons. Vertices snap to a grid of about one pixel at the highest zoom a
country's mesh is drawn, each shared edge is kept once, and the outer land
boundary is left to the country outline.
It ships as vector tiles for zooms 3 to 6 in one content-named folder, so the
map holds only the tiles on screen instead of the whole mesh (about a gigabyte
of worker memory as GeoJSON).

It also builds the border seam fill. Neighbouring countries come from separate
sources whose outlines rarely meet: thin slivers open along land borders and
show the sea colour through. The fill is a strip of land colour drawn under the
exact land along each land border. How wide a gap it closes follows how far
the two sources disagree along that border: about four kilometres where they
agree well, so border lakes stay open, and up to about twelve where they do
not. Only the gap lying across the border is measured and filled: water within
reach of both countries' land and near the border line, inside their world
outline or right at the border's ends. Harbours, bays and lakes reached from
one side, however narrow, stay open; border rivers are drawn as land.

Run outputs/geodata-venv/bin/python scripts/build-overview-borders.py after any
change to a country's primary geometry, with raw geometry restored.
"""
import hashlib, json, pathlib, shutil, time
import numpy as np
import shapely
from shapely.geometry import shape
from shapely.strtree import STRtree

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA = ROOT / 'public/data'
# Exact detail takes over at zoom 6.5 in the densest countries and at 5.5 in other large ones
# (lib/county-render-policy.ts); one pixel there is about 0.008 and 0.016 degrees. Smaller
# countries show exact detail from 3.45 and need the mesh only while they wait to be mounted.
GRIDS = {6.5: 0.01, 5.5: 0.02, 3.45: 0.03}
# The mesh ships as Mapbox vector tiles, so the map holds only the tiles in view. Zoom 3 tiles serve the
# first zoom with local boundaries (3.45), zoom 6 tiles everything up to 6.5. Tile coordinates are finer
# than the mesh grid at every zoom (a zoom 3 unit is 0.011 degrees), so tiling loses no precision; points
# that fall on the same tile unit are merged, nothing else is simplified.
TILE_ZOOMS, EXTENT, TILE_BUFFER, TILE_LAYER = range(3, 7), 4096, 64, 'borders'
OFFSET = np.uint64(1 << 15)
# Seam fill, in degrees: how far the strip reaches from a border, the range of gap half-widths it closes,
# how far it is eroded, its simplification, and how far the world border line may sit from the real one.
SEAM_REACH, SEAM_GAP_MIN, SEAM_GAP_MAX, SEAM_INSET, SEAM_TOLERANCE, SEA_MARGIN = 0.3, 0.02, 0.06, 0.004, 0.003, 0.03
# Beyond the world coastline the strip may reach this far from a border line, to close a river mouth.
BORDER_MOUTH = 0.015
# Where sources disagree badly, enclosed leftovers smaller than this (square degrees) are closed too.
SEAM_HOLE = 0.02

def read(path): return json.loads(path.read_text())

def varint(value):
  out = bytearray()
  while True:
    byte = value & 0x7f; value >>= 7
    if value: out.append(byte | 0x80)
    else: out.append(byte); return bytes(out)

def field(number, payload=None, value=None):
  """One protobuf field: a varint value, or length-delimited bytes."""
  if payload is None: return varint(number << 3) + varint(value)
  return varint(number << 3 | 2) + varint(len(payload)) + payload

def zigzag(value): return (value << 1) ^ (value >> 63)

def encode_tile(groups, codes):
  """One vector tile with a single line layer: per country, a feature with all its lines in tile units."""
  features = b''
  for code, lines in groups.items():
    geometry, cursor = [], (0, 0)
    for line in lines:
      geometry += [1 | 1 << 3, zigzag(int(line[0][0] - cursor[0])), zigzag(int(line[0][1] - cursor[1]))]
      geometry.append(2 | (len(line) - 1) << 3)
      for (x0, y0), (x1, y1) in zip(line[:-1], line[1:]): geometry += [zigzag(int(x1 - x0)), zigzag(int(y1 - y0))]
      cursor = (int(line[-1][0]), int(line[-1][1]))
    packed = lambda values: b''.join(varint(v) for v in values)
    features += field(2, field(2, packed([0, codes[code]])) + field(3, value=2) + field(4, packed(geometry)))
  values = b''.join(field(4, field(1, code.encode())) for code in sorted(codes, key=codes.get))
  layer = field(15, value=2) + field(1, TILE_LAYER.encode()) + features + field(3, b'countryCode') + values + field(5, value=EXTENT)
  return field(3, layer)

def mercator(coords, zoom):
  """Longitude and latitude to world tile units at a zoom."""
  size = EXTENT * 2 ** zoom
  lat = np.radians(np.clip(coords[:, 1], -85.0511, 85.0511))
  return np.column_stack(((coords[:, 0] + 180) / 360 * size, (1 - np.arcsinh(np.tan(lat)) / np.pi) / 2 * size))

def vector_tiles(features):
  """Every tile with mesh lines, as {(z, x, y): bytes}."""
  tiles = {}
  for zoom in TILE_ZOOMS:
    lines, owners = [], []
    for feature in features:
      for line in feature['geometry']['coordinates']:
        lines.append(shapely.linestrings(mercator(np.asarray(line, float), zoom))); owners.append(feature['properties']['countryCode'])
    lines = np.array(lines); owners = np.array(owners); tree = STRtree(lines)
    bounds = shapely.bounds(lines) / EXTENT
    keys = {(x, y) for (x0, y0, x1, y1) in bounds for x in range(int(x0), int(x1) + 1) for y in range(int(y0), int(y1) + 1)}
    for x, y in sorted(keys):
      box = (x * EXTENT - TILE_BUFFER, y * EXTENT - TILE_BUFFER, (x + 1) * EXTENT + TILE_BUFFER, (y + 1) * EXTENT + TILE_BUFFER)
      hits = tree.query(shapely.box(*box))
      if not len(hits): continue
      groups = {}
      for index, clipped in zip(hits, shapely.clip_by_rect(lines[hits], *box)):
        for part in shapely.get_parts(shapely.line_merge(clipped) if clipped.geom_type == 'MultiLineString' else clipped):
          if part.is_empty or part.geom_type != 'LineString': continue
          points = np.rint(shapely.get_coordinates(part) - (x * EXTENT, y * EXTENT)).astype(np.int64)
          points = points[np.r_[True, np.any(points[1:] != points[:-1], axis=1)]]
          if len(points) >= 2: groups.setdefault(owners[index], []).append(points.tolist())
      if groups:
        codes = {code: i for i, code in enumerate(sorted(groups))}
        tiles[(zoom, x, y)] = encode_tile({code: groups[code] for code in sorted(groups)}, codes)
    print('tiles at zoom', zoom, sum(1 for key in tiles if key[0] == zoom), flush=True)
  return tiles

def detail_zoom(record, code):
  """Mirrors countyRenderPolicy in lib/county-render-policy.ts."""
  count = record.get('renderCount', record.get('count', 0))
  viewport = record.get('localBytes', 0) >= 8 * 1024 * 1024 or count >= 1500
  return (6.5 if count >= (5000 if code in ('IND', 'BRA') else 10000) else 5.5) if viewport else 3.45

def segment_keys(geometry, grid):
  """Undirected grid segments of one geometry's rings, each listed once."""
  rings = shapely.get_rings(geometry)
  if not len(rings): return np.empty(0, np.uint64)
  coords, index = shapely.get_coordinates(rings, return_index=True)
  grid = np.rint(coords / grid).astype(np.int64)
  joined = index[1:] == index[:-1]
  a, b = grid[:-1][joined], grid[1:][joined]
  moved = np.any(a != b, axis=1)
  a, b = a[moved], b[moved]
  swap = (a[:, 0] > b[:, 0]) | ((a[:, 0] == b[:, 0]) & (a[:, 1] > b[:, 1]))
  low, high = np.where(swap[:, None], b, a).astype(np.uint64), np.where(swap[:, None], a, b).astype(np.uint64)
  keys = ((low[:, 0] + OFFSET) << np.uint64(48)) | ((low[:, 1] + OFFSET) << np.uint64(32)) | ((high[:, 0] + OFFSET) << np.uint64(16)) | (high[:, 1] + OFFSET)
  # A sliver that collapses on the grid walks the same segment out and back; count it once.
  return np.unique(keys)

def decode(keys, grid):
  parts = [((keys >> np.uint64(shift)) & np.uint64(0xffff)).astype(np.int64) - (1 << 15) for shift in (48, 32, 16, 0)]
  return (np.stack(parts, axis=1).reshape(-1, 2, 2) * grid)

def country_mesh(local_path, land_path, suppressed, grid):
  features = [f for f in read(local_path)['features'] if f.get('geometry') and str(f.get('id', f['properties'].get('id'))) not in suppressed]
  if len(features) < 2: return []
  keys = np.concatenate([segment_keys(shape(f['geometry']), grid) for f in features])
  unique, counts = np.unique(keys, return_counts=True)
  outer = np.empty(0, np.uint64)
  if land_path and land_path.exists():
    outer = np.concatenate([segment_keys(shape(f['geometry']), grid) for f in read(land_path)['features'] if f.get('geometry')] or [outer])
  # Shared by two areas, or not part of the outer land boundary.
  kept = unique[(counts >= 2) | ~np.isin(unique, outer)]
  if not len(kept): return []
  lines = shapely.linestrings(decode(kept, grid))
  merged = shapely.line_merge(shapely.multilinestrings(lines, indices=np.zeros(len(lines), dtype=np.intp))[0])
  simplified = shapely.simplify(merged, grid * 0.6, preserve_topology=False)
  parts = shapely.get_parts(simplified)
  return [np.round(shapely.get_coordinates(part), 2).tolist() for part in parts if not shapely.is_empty(part)]

def polygonal(geometry):
  """The polygon parts of any geometry, as one valid geometry."""
  stack, parts = [shapely.make_valid(geometry)], []
  while stack:
    item = stack.pop()
    if item.is_empty: continue
    if item.geom_type == 'Polygon': parts.append(item)
    elif hasattr(item, 'geoms'): stack.extend(item.geoms)
  return shapely.union_all(parts) if parts else shapely.Polygon()

def across(border, land_a, land_b, distance):
  """Where a gap between the two sources can be: near their land border and within `distance` of both lands.
  Water reached from one side only is a real harbour, bay or lake however narrow it is."""
  return shapely.intersection(shapely.intersection(land_a.buffer(distance, quad_segs=2), land_b.buffer(distance, quad_segs=2)), border.buffer(distance + SEA_MARGIN, quad_segs=2))

def border_seams(alignment):
  world = {}
  for feature in read(DATA / 'world.geojson')['features']:
    code, geometry = feature['properties']['countryCode'], polygonal(shape(feature['geometry']))
    world[code] = shapely.union(world[code], geometry) if code in world else geometry
  lands = {}
  def land(code):
    if code not in lands:
      record = alignment.get(code)
      # A country without local boundaries keeps its world outline on the map.
      lands[code] = polygonal(shapely.union_all([shape(f['geometry']) for f in read(ROOT / ('public' + (record.get('countryUrl') or record['landUrl'])))['features'] if f.get('geometry')])) if record else world[code]
    return lands[code]
  codes = sorted(world)
  tree = STRtree([world[code] for code in codes])
  pieces, pairs, widest = [], 0, 0.0
  for a in codes:
    for index in tree.query(world[a], predicate='intersects'):
      b = codes[index]
      if b <= a or (a not in alignment and b not in alignment): continue
      border = shapely.intersection(world[a].boundary, world[b].boundary)
      if border.is_empty or border.length < 0.02: continue
      zone = border.buffer(SEAM_REACH, quad_segs=4)
      clip = lambda geometry: polygonal(shapely.intersection(shapely.clip_by_rect(geometry, *zone.bounds), zone))
      land_a, land_b = clip(land(a)), clip(land(b))
      both = shapely.union(land_a, land_b)
      if both.is_empty: continue
      pair = shapely.union(world[a], world[b])
      # Mean distance by which the two sources miss or overlap each other along this border. Only the gap lying
      # across the border counts: harbours and bays beside it once made Hong Kong's sources look 12 km apart.
      gap = polygonal(shapely.intersection(shapely.difference(shapely.intersection(zone, pair), both), shapely.intersection(across(border, land_a, land_b, 2 * SEAM_GAP_MAX), border.buffer(SEAM_GAP_MAX, quad_segs=2))))
      mismatch = (gap.area + shapely.intersection(land_a, land_b).area) / border.length
      reach = min(max(2.5 * mismatch, SEAM_GAP_MIN), SEAM_GAP_MAX)
      closed = both.buffer(reach, quad_segs=3).buffer(-reach, quad_segs=3)
      if reach > 1.5 * SEAM_GAP_MIN:
        closed = shapely.union_all([shapely.Polygon(polygon.exterior, [hole for hole in polygon.interiors if shapely.Polygon(hole).area >= SEAM_HOLE]) for polygon in shapely.get_parts(polygonal(closed))])
      # The strip fills only water across the border, inside the world outline or right at the border's ends,
      # where coarse world coastlines stop short of a river mouth. It also stays clear of the zone rim,
      # where the closing would round over the cut.
      water = shapely.intersection(across(border, land_a, land_b, 2 * reach), shapely.union(pair, border.buffer(BORDER_MOUTH, quad_segs=2)))
      seam = shapely.intersection(shapely.intersection(closed, border.buffer(SEAM_REACH - reach, quad_segs=4)), shapely.union(both, water))
      seam = polygonal(seam.buffer(-SEAM_INSET, quad_segs=2).simplify(SEAM_TOLERANCE))
      if seam.is_empty: continue
      pieces.append(seam); pairs += 1; widest = max(widest, reach)
      print('seam', a, b, f'{border.length:.1f}deg mismatch {mismatch:.4f} closes {2 * reach:.3f}', flush=True)
  merged = polygonal(shapely.union_all(pieces))
  polygons = [part for part in shapely.get_parts(merged) if not part.is_empty]
  coordinates = [[np.round(shapely.get_coordinates(ring), 4).tolist() for ring in [polygon.exterior, *polygon.interiors]] for polygon in polygons]
  # One feature per polygon keeps every tile bucket small.
  return {'type': 'FeatureCollection', 'features': [{'type': 'Feature', 'properties': {}, 'geometry': {'type': 'Polygon', 'coordinates': rings}} for rings in coordinates]}, pairs, widest

def main():
  alignment = read(DATA / 'geometry-alignment.json')['countries']
  features, vertices = [], 0
  for code in sorted(alignment):
    record = alignment[code]
    started = time.monotonic()
    land = ROOT / ('public' + record['landUrl']) if record.get('landUrl') else None
    lines = country_mesh(ROOT / ('public' + record['localUrl']), land, set(record.get('suppressedIds', [])), GRIDS[detail_zoom(record, code)])
    if not lines: continue
    count = sum(len(line) for line in lines)
    vertices += count
    features.append({'type': 'Feature', 'properties': {'countryCode': code}, 'geometry': {'type': 'MultiLineString', 'coordinates': lines}})
    print(code, len(lines), count, f'{time.monotonic() - started:.1f}s', flush=True)
  # The tiles go in one content-named folder, so a changed mesh never mixes with cached tiles of the old one.
  directory = DATA / 'overview'
  directory.mkdir(exist_ok=True)
  for stale in [*directory.glob('borders-*'), *directory.glob('seams-*')]: stale.unlink()
  for stale in directory.glob('tiles-*'): shutil.rmtree(stale)
  tiles = vector_tiles(features)
  digest = hashlib.sha256(b''.join(f'{z}/{x}/{y}'.encode() + tiles[(z, x, y)] for z, x, y in sorted(tiles))).hexdigest()
  folder = directory / f'tiles-{digest[:16]}'
  for (z, x, y), raw in tiles.items():
    (folder / str(z) / str(x)).mkdir(parents=True, exist_ok=True)
    (folder / str(z) / str(x) / f'{y}.pbf').write_bytes(raw)
  tile_set = {'url': f'/data/overview/{folder.name}/{{z}}/{{x}}/{{y}}.pbf', 'layer': TILE_LAYER, 'minzoom': TILE_ZOOMS[0], 'maxzoom': TILE_ZOOMS[-1],
              'count': len(tiles), 'bytes': sum(len(raw) for raw in tiles.values()), 'sha256': digest, 'countries': [f['properties']['countryCode'] for f in features]}
  seam_collection, seam_pairs, seam_widest = border_seams(alignment)
  seam_raw = (json.dumps(seam_collection, separators=(',', ':'), allow_nan=False) + '\n').encode()
  seam_digest = hashlib.sha256(seam_raw).hexdigest()
  seam_url = f'/data/overview/seams-{seam_digest[:16]}.json'
  (ROOT / ('public' + seam_url)).write_bytes(seam_raw)
  seams = {'url': seam_url, 'bytes': len(seam_raw), 'sha256': seam_digest, 'borders': seam_pairs, 'closesGapsUpToDegrees': round(seam_widest * 2, 3)}
  manifest = {'version': 2, 'contract': 'Display-only internal local boundaries for overview zooms; exact polygons remain the source for selection and saving.', 'grids': {str(zoom): grid for zoom, grid in GRIDS.items()}, 'vertices': vertices, 'tiles': tile_set, 'seams': seams}
  (DATA / 'overview-borders.json').write_text(json.dumps(manifest, separators=(',', ':')) + '\n')
  print('DONE', len(features), 'countries', vertices, 'vertices', len(tiles), 'tiles', tile_set['bytes'], 'bytes', 'seams', seam_pairs, len(seam_raw), flush=True)

if __name__ == '__main__': main()
