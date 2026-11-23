#!/usr/bin/env python3
"""Chinese names for Taiwan's townships, matched from Wikidata.

The boundary source (geoBoundaries gbOpen 2017, from OpenStreetMap) names most of
Taiwan's 368 township-level divisions in romanised form only and gives no county.
This script reads one cached Wikidata query of the current townships, districts,
county-administered cities and mountain indigenous townships and districts
(outputs/taiwan-name-sources/, query in query.rq there), and matches each item to
the boundary that contains its coordinates. Every match is cross-checked against
the source's own name (romanised or Chinese); anything that does not resolve to
exactly one item is reported and left as it was, never guessed.

Names are the traditional forms used locally (zh-tw label); simplified forms and
the romanised source name become search aliases. Feature IDs, geometry, centres
and the source year are unchanged. Outputs:
  public/data/taiwan-name-repairs.json  additive repair map with evidence per feature
  public/data/name-quality.json         Taiwan entries merged in (others untouched)
  public/data/coverage.json             Taiwan's unit label in Chinese

Run outputs/geodata-venv/bin/python scripts/audit-taiwan-names.py. To refresh the
cache, rerun the query in outputs/taiwan-name-sources/query.rq against
https://query.wikidata.org/sparql and save the JSON result as wikidata-townships.json.
prepare-name-quality.py reads the repair map, so a full name audit keeps these names.
"""
import json, pathlib, re, unicodedata
from collections import defaultdict
from shapely import STRtree
from shapely.geometry import shape, Point

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA = ROOT / 'public/data'
CACHE = ROOT / 'outputs/taiwan-name-sources'
SOURCE = DATA / 'global/twn-adm2.geojson'
UNIT_LABEL = '乡镇市区'
# A township point may sit just outside a coastline that the 2017 source draws differently.
NEAR = 0.03

def read(path): return json.loads(path.read_text())
def write(path, value): path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n')

def roman(text):
  """Romanised name reduced to letters: no tone marks, unit words, apostrophes or hyphens."""
  text = unicodedata.normalize('NFKD', text or '').encode('ascii', 'ignore').decode().lower()
  text = re.sub(r'\b(district|township|town|city|rural|urban|mountain|indigenous|aboriginal|county)\b', ' ', text)
  return re.sub(r'[^a-z]', '', text)

def sounds(text):
  """Consonant outline that Hanyu Pinyin, Tongyong Pinyin and Wade-Giles spellings of one name share."""
  text = roman(text).replace('ngg', 'ng').replace('ng', 'N')
  for spelling, sound in (('jh', 'z'), ('zh', 'z'), ('ts', 'z'), ('tz', 'z'), ('ch', 'q'), ('sh', 'x'), ('sy', 'x'), ('hs', 'x'),
                          ('c', 'q'), ('s', 'x'), ('j', 'z'), ('k', 'g'), ('p', 'b'), ('t', 'd')):
    text = text.replace(spelling, sound)
  return re.sub(r'[aeiouyhw]', '', text)

def han(text):
  """Chinese name without spaces, a parenthesised romanisation, or a variant of 台/臺."""
  return re.sub(r'\s|\(.*?\)|（.*?）', '', text or '').replace('台', '臺')

def wikidata_items():
  items = {}
  for row in read(CACHE / 'wikidata-townships.json')['results']['bindings']:
    value = lambda key: row.get(key, {}).get('value')
    item = items.setdefault(value('item'), {'url': value('item'), 'labels': {}, 'parents': {}, 'classes': set()})
    item['classes'].add(value('class').rsplit('/', 1)[-1])
    for key in ('tw', 'hant', 'zh', 'cn', 'hans', 'en'):
      if value(key): item['labels'][key] = value(key)
    if value('coord'):
      lng, lat = map(float, re.findall(r'-?\d+(?:\.\d+)?', value('coord')))
      item['point'] = Point(lng, lat)
    if value('parent'):
      item['parents'][value('parent')] = value('parentTw') or value('parentHant') or value('parentZh')
  return items

def county(parents):
  """The county or special municipality among an item's parents (not the province)."""
  names = [name for name in parents.values() if name and name.endswith(('市', '縣')) and not name.endswith('省')]
  return sorted(names, key=len)[0] if names else None

def agrees(feature_name, item):
  """Does the boundary source's own name support this item?"""
  labels = item['labels']
  if re.search(r'[一-鿿]', feature_name):
    own = han(feature_name)
    return any(han(labels.get(key)) == own for key in ('tw', 'hant', 'zh'))
  return bool(roman(feature_name)) and sounds(feature_name) == sounds(labels.get('en'))

def main():
  source = read(SOURCE)
  features = source['features']
  shapes = [shape(f['geometry']) for f in features]
  tree = STRtree(shapes)
  items = {url: item for url, item in wikidata_items().items() if 'point' in item}
  inside = defaultdict(list)
  for item in items.values():
    for index in tree.query(item['point'], predicate='within'):
      inside[int(index)].append(item)
  repairs, report = {}, {'matched': 0, 'nameMismatch': [], 'unmatched': [], 'ambiguous': [], 'reused': []}
  used = defaultdict(list)
  deferred = []
  def settle(index, item, method):
    props = features[index]['properties']
    labels = item['labels']
    name = labels.get('tw') or labels.get('hant') or labels.get('zh')
    confirmed = agrees(props['name'], item)
    if not confirmed:
      report['nameMismatch'].append({'id': props['id'], 'sourceName': props['name'], 'wikidata': name, 'english': labels.get('en'), 'item': item['url'], 'method': method})
    used[item['url']].append(props['id'])
    simplified = labels.get('cn') or labels.get('hans')
    parent = county(item['parents'])
    # The source's own spelling helps search, unless it is really another township's name (the source calls 新營 Xiaying).
    misnamed = not confirmed and any(agrees(props['name'], other) for other in items.values() if other is not item)
    aliases = [alias for alias in dict.fromkeys([name, simplified, (parent or '') + name if parent else None, labels.get('en'), None if misnamed else props['name']]) if alias]
    repairs[props['id']] = {
      'name': name, 'aliases': aliases, 'parentName': parent,
      'nameSource': 'Wikidata', 'nameSourceURLs': [item['url']],
      'nameStatus': 'verified',
      'nameEvidence': {'method': method, 'sourceNameConfirms': confirmed, 'sourceName': props['name'], 'english': labels.get('en'), 'simplified': simplified, 'wikidataClasses': sorted(item['classes'])},
    }
  for index, feature in enumerate(features):
    props = feature['properties']
    candidates = inside.get(index, [])
    method = 'coordinates inside boundary'
    if len(candidates) > 1 and not any(agrees(props['name'], item) for item in candidates):
      deferred.append(index)
      continue
    if len(candidates) != 1:
      # No point inside (or several): accept only an item whose name the source confirms.
      near = [item for item in items.values() if shapes[index].distance(item['point']) <= NEAR] if not candidates else candidates
      named = [item for item in near if agrees(props['name'], item)]
      if len(named) != 1:
        report['ambiguous' if candidates else 'unmatched'].append({'id': props['id'], 'sourceName': props['name'], 'candidates': [i['labels'].get('tw') for i in near]})
        continue
      candidates, method = named, ('source name among several points inside' if len(inside.get(index, [])) > 1 else 'source name, point within %.2f degrees' % NEAR)
    settle(index, candidates[0], method)
  for index in deferred:
    props = features[index]['properties']
    free = [item for item in inside[index] if item['url'] not in used]
    if len(free) == 1: settle(index, free[0], 'only point inside not claimed by another boundary')
    else: report['ambiguous'].append({'id': props['id'], 'sourceName': props['name'], 'candidates': [i['labels'].get('tw') for i in inside[index]]})
  report['reused'] = {url: ids for url, ids in used.items() if len(ids) > 1}
  if report['reused']:
    # One township item cannot name two boundaries; leave both as they were.
    for ids in report['reused'].values():
      for fid in ids: repairs.pop(fid, None)
  report['matched'] = len(repairs)
  fetched = (CACHE / 'fetched-at.txt').read_text().strip() if (CACHE / 'fetched-at.txt').exists() else None
  metadata = {'schemaVersion': 1, 'purpose': 'Additive Chinese names for Taiwan township-level divisions; no geometry or ID replacement',
              'source': 'Wikidata (CC0), query in outputs/taiwan-name-sources/query.rq', 'fetchedAt': fetched,
              'boundarySource': 'geoBoundaries gbOpen TWN ADM2 (2017)', 'script': 'scripts/audit-taiwan-names.py'}
  write(DATA / 'taiwan-name-repairs.json', {'metadata': metadata, 'repairs': repairs})
  (CACHE / 'audit.json').write_text(json.dumps(report, ensure_ascii=False, indent=1) + '\n')

  quality = read(DATA / 'name-quality.json')
  for fid, repair in repairs.items():
    quality['regions'][fid] = {'name': repair['name'], 'aliases': repair['aliases'], 'parentName': repair['parentName'], 'status': 'verified',
                               'note': TAIWAN_NOTE, 'evidenceURLs': repair['nameSourceURLs'] + [SOURCE_URL], 'evidence': repair['nameEvidence']}
  write(DATA / 'name-quality.json', quality)
  coverage = read(DATA / 'coverage.json')
  for record in coverage:
    if record.get('code') == 'TWN': record['label'] = UNIT_LABEL
  write(DATA / 'coverage.json', coverage)
  print(f"matched {report['matched']} of {len(features)}; name mismatches {len(report['nameMismatch'])}; unmatched {len(report['unmatched'])}; ambiguous {len(report['ambiguous'])}; items used twice {len(report['reused'])}")

TAIWAN_NOTE = '中文名来自 Wikidata（繁体，当地写法），按坐标与来源名称核对；边界和年份仍沿用 2017 年来源。'
SOURCE_URL = 'https://www.geoboundaries.org/api/current/gbOpen/TWN/ADM2/'

if __name__ == '__main__': main()
