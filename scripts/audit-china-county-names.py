#!/usr/bin/env python3
"""Chinese names for the county-level areas that still show an English name or a placeholder.

Most of China's map comes from geoBoundaries 2017, named in English. Earlier name work
(prepare-china-names.py, remediate-china-identities.py) gave Chinese names where the
English name and unit type matched Wikidata, and marked the rest "旧来源待核实区域". Many of
those changed type after 2017 (沙湾县 became 沙湾市, 双流县 became 双流区), and others carry
English names Wikidata spells differently (Usu / Wusu, Xinyuan / Künes).

This script reads one cached Wikidata query of every county-level division with a six-digit
administrative code, current or dissolved (outputs/china-county-sources/, query in query.rq
there), and names each such area by the item whose coordinates fall inside it:
  - an item already naming another area, or used twice, is never taken;
  - with several items inside, the one whose English name matches the source wins;
  - with none inside, only a nearby item whose English name matches is accepted;
  - anything else is reported and left as it was.
The name shown is the current one, as chosen for the atlas, unless the item itself was
dissolved (merged or split): then its own historical name, with the successor noted.
The source's English name stays as a search alias and in the note. IDs, geometry, centres
and years are unchanged. Outputs:
  public/data/china-county-name-repairs.json  additive repair map with evidence per area
  public/data/name-quality.json               these areas merged in (others untouched)

Run outputs/geodata-venv/bin/python scripts/audit-china-county-names.py after any step that
rewrites name-quality.json (prepare-name-quality, remediate-china-identities,
apply-current-boundaries). To refresh the cache, rerun query.rq against
https://query.wikidata.org/sparql and save the JSON result as wikidata-counties.json.
"""
import json, pathlib, re, unicodedata
from collections import defaultdict
from shapely import STRtree
from shapely.geometry import shape, Point

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA = ROOT / 'public/data'
CACHE = ROOT / 'outputs/china-county-sources'
NEAR = 0.05
WIKIDATA = 'http://www.wikidata.org/entity/'
# Reviewed by hand. Places merged after 2017 keep the name they had then (the atlas shows current names only
# where the same place changed type); a rename found by code; and Jiayuguan's three districts, which are
# not administrative divisions and so have no code. Keyed by feature ID; 'successor' and 'item' are Wikidata QIDs.
REVIEWED = {
  'GB-62558664B63025908645317': {'name': '城区', 'parent': '大同市', 'successor': 'Q1070000', 'why': '2018 年与南郊区合并调整为平城区'},
  'GB-62558664B24133119430252': {'name': '城区', 'parent': '长治市', 'successor': 'Q1070002', 'why': '2018 年与郊区合并设立潞州区'},
  'GB-62558664B87388663698169': {'name': '郊区', 'parent': '长治市', 'successor': 'Q1070002', 'why': '2018 年与城区合并设立潞州区'},
  'GB-62558664B59240387459246': {'name': '带岭区', 'parent': '伊春市', 'successor': 'Q761859', 'why': '2019 年撤销，与邻近区域合并设立大箐山县'},
  'GB-62558664B64397205822968': {'name': '桥西区', 'parent': '邢台市', 'successor': 'Q1331063', 'why': '2020 年并入原邢台县部分区域，改设信都区'},
  'GB-62558664B81770393806707': {'name': '茫崖行政委员会', 'parent': '海西蒙古族藏族自治州', 'successor': 'Q1201941', 'why': '2018 年与冷湖行委合并设立茫崖市'},
  'GB-62558664B81897964248321': {'name': '冷湖行政委员会', 'parent': '海西蒙古族藏族自治州', 'successor': 'Q1201941', 'why': '2018 年与茫崖行委合并设立茫崖市'},
  'GB-62558664B76452798634790': {'item': 'Q1198806', 'why': '2016 年许昌县改设建安区，行政区域不变'},
  'GB-62558664B9155243010292': {'item': 'Q1028101', 'why': '2024 年部分区域划出设立和康县，皮山县保留'},
  'GB-62558664B42821097796221': {'name': '镜铁区', 'parent': '嘉峪关市', 'item': 'Q532560', 'why': '嘉峪关市不设县级行政区，镜铁区是市辖的非建制区'},
  'GB-62558664B76355407219744': {'name': '雄关区', 'parent': '嘉峪关市', 'item': 'Q532560', 'why': '嘉峪关市不设县级行政区，雄关区是市辖的非建制区'},
  'GB-62558664B48067399197905': {'name': '长城区', 'parent': '嘉峪关市', 'item': 'Q532560', 'why': '嘉峪关市不设县级行政区，长城区是市辖的非建制区'},
}
CJK = re.compile(r'[一-鿿]')
UNIT_WORDS = {'district', 'county', 'city', 'banner', 'autonomous', 'administrative', 'zone', 'xian', 'shi', 'qu', 'qi',
              'zizhixian', 'zizhiqi', 'economic', 'and', 'technical', 'development', 'new', 'area', 'region', 'special'}

def read(path): return json.loads(path.read_text())
def write(path, value): path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n')

def stem(text):
  """English place name reduced to its proper-name part."""
  text = unicodedata.normalize('NFKD', (text or '').split(',', 1)[0]).encode('ascii', 'ignore').decode().lower().replace("'", '')
  return ''.join(token for token in re.split(r'[^a-z]+', text) if token and token not in UNIT_WORDS)

def county_items(name='wikidata-counties.json'):
  items = {}
  for row in read(CACHE / name)['results']['bindings']:
    value = lambda key: row.get(key, {}).get('value')
    item = items.setdefault(value('item'), {'url': value('item'), 'qid': value('item').rsplit('/', 1)[-1], 'parents': set()})
    for key in ('code', 'cn', 'hans', 'zh', 'en', 'dissolved', 'successor'):
      if value(key) and key not in item: item[key] = value(key)
    if value('coord') and 'point' not in item:
      lng, lat = map(float, re.findall(r'-?\d+(?:\.\d+)?', value('coord')))
      item['point'] = Point(lng, lat)
    if value('parentZh'): item['parents'].add(value('parentZh'))
  for item in items.values():
    item['name'] = item.get('cn') or item.get('hans') or item.get('zh')
  return items

def parent_of(item, province=False):
  """The prefecture-level parent, not the province (unless the item is itself a prefecture-level city)."""
  names = [name for name in item['parents'] if province or not name.endswith(('省', '自治区', '特别行政区')) or name in ('北京市', '天津市', '上海市', '重庆市')]
  names = [name for name in names if name != '中华人民共和国']
  chosen = sorted(names, key=lambda name: (name.endswith('省'), len(name)))[0] if names else None
  return SIMPLIFIED.get(chosen, chosen)

# Parent names come from Wikidata's general Chinese label, which is sometimes traditional (和田地區); use the
# simplified label of the same prefecture-level item where there is one.
SIMPLIFIED = {}

def main():
  quality = read(DATA / 'name-quality.json')
  names = quality['regions']
  alignment = read(DATA / 'geometry-alignment.json')['countries']['CHN']
  hidden = set(alignment.get('suppressedIds', []))
  features = [f for f in read(ROOT / ('public' + alignment['localUrl']))['features'] if f['properties']['id'] not in hidden]
  shown = lambda p: names.get(p['id'], {}).get('name') or p.get('name') or ''
  is_target = lambda p: names.get(p['id'], {}).get('status') == 'unresolved' or not CJK.search(shown(p))
  shapes = [shape(f['geometry']) for f in features]
  tree = STRtree(shapes)
  every = county_items()
  items = {url: item for url, item in every.items() if item.get('name') and 'point' in item}
  # Prefecture-level cities with no counties (东莞, 中山, 儋州) name their whole area; used only when no county fits.
  prefectures = {url: item for url, item in county_items('wikidata-prefectures.json').items() if item.get('name') and 'point' in item}
  for row in read(CACHE / 'wikidata-prefectures.json')['results']['bindings']:
    if row.get('zh') and row.get('cn'): SIMPLIFIED.setdefault(row['zh']['value'], row['cn']['value'])
  lookup = {**prefectures, **every}
  # Items that already name an area with a Chinese name belong there.
  claimed = {repair.get('evidence', {}).get('wikidata') for fid, repair in names.items() if repair.get('status') == 'verified'} - {None}
  inside = defaultdict(list)
  for item in items.values():
    for index in tree.query(item['point'], predicate='within'): inside[int(index)].append(item)
  targets = [index for index, f in enumerate(features) if is_target(f['properties'])]
  repairs, used = {}, defaultdict(list)
  report = {'targets': len(targets), 'byName': [], 'locationOnly': [], 'reviewed': [], 'unresolved': []}
  for index in targets:
    props = features[index]['properties']
    source = props.get('originalName') or props.get('name') or ''
    if props['id'] in REVIEWED:
      review = REVIEWED[props['id']]
      item = lookup.get(WIKIDATA + (review.get('item') or review['successor']), {})
      successor = item.get('name') if review.get('successor') else None
      name = review.get('name') or item.get('name')
      note = f'2017 年来源记为“{source}”。{review["why"]}' + ('，按当时名称显示。' if successor else '。') + '边界仍为 2017 年来源。'
      repairs[props['id']] = {'name': name, 'aliases': [alias for alias in dict.fromkeys([name, successor, source]) if alias], 'parentName': review.get('parent') or parent_of(item),
                              'nameSource': 'Wikidata，人工核对', 'nameSourceURLs': [WIKIDATA + (review.get('item') or review['successor'])], 'note': note,
                              'evidence': {'wikidata': item.get('qid') if not successor else None, 'successor': successor, 'successorWikidata': review.get('successor'), 'sourceName': source, 'method': 'reviewed: ' + review['why']}}
      report['reviewed'].append({'source': source, 'name': name, 'why': review['why']})
      continue
    free = [item for item in inside.get(index, []) if item['qid'] not in claimed]
    named = [item for item in free if stem(item.get('en')) and stem(item.get('en')) == stem(source)]
    if len(named) == 1: item, method = named[0], 'coordinates inside, English name agrees'
    elif len(free) == 1: item, method = free[0], 'only unclaimed coordinates inside'
    elif not free:
      near = [item for item in items.values() if item['qid'] not in claimed and shapes[index].distance(item['point']) <= NEAR and stem(item.get('en')) == stem(source)]
      if not near:
        near = [item for item in prefectures.values() if item['qid'] not in claimed and shapes[index].distance(item['point']) <= NEAR and stem(item.get('en')) == stem(source)]
      if len(near) != 1:
        report['unresolved'].append({'id': props['id'], 'source': source, 'inside': [i['name'] for i in inside.get(index, [])]}); continue
      item, method = near[0], f'English name agrees, coordinates within {NEAR} degrees'
    else:
      report['unresolved'].append({'id': props['id'], 'source': source, 'inside': [i['name'] for i in free]}); continue
    used[item['qid']].append(props['id'])
    successor = items.get(item.get('successor') or '', {}).get('name')
    dissolved = bool(item.get('dissolved'))
    name = item['name']
    located = '坐标落在此区域内' if 'inside' in method else '英文名一致，坐标在区域附近'
    note = (f'2017 年来源记为“{source}”；中文名按 Wikidata 核对（{located}）。'
            + (f'此建制已撤销{"，现为" + successor if successor else ""}，按当时名称显示。' if dissolved else '显示现行名称，边界仍为 2017 年来源，之后可能有调整。'))
    aliases = [alias for alias in dict.fromkeys([name, successor, source, item.get('en')]) if alias]
    repairs[props['id']] = {'name': name, 'aliases': aliases, 'parentName': parent_of(item, province=item['url'] in prefectures), 'nameSource': 'Wikidata', 'nameSourceURLs': [item['url']],
                            'note': note, 'evidence': {'wikidata': item['qid'], 'code': item.get('code'), 'english': item.get('en'), 'sourceName': source,
                                                       'method': method, 'dissolved': item.get('dissolved'), 'successor': successor}}
    (report['byName'] if 'agrees' in method else report['locationOnly']).append({'source': source, 'name': name, 'english': item.get('en'), 'method': method})
  duplicates = {qid: ids for qid, ids in used.items() if len(ids) > 1}
  for qid, ids in duplicates.items():
    for fid in ids:
      dropped = repairs.pop(fid, None)
      report['unresolved'].append({'id': fid, 'source': dropped['evidence']['sourceName'] if dropped else None, 'reason': f'{qid} matched several areas'})
  for bucket in ('byName', 'locationOnly'):
    report[bucket] = [row for row in report[bucket] if any(r['evidence']['sourceName'] == row['source'] and r['name'] == row['name'] for r in repairs.values())]
  fetched = (CACHE / 'fetched-at.txt').read_text().strip() if (CACHE / 'fetched-at.txt').exists() else None
  # Areas that have since become historical (a current boundary replaced them) keep their earlier repair:
  # old visits still show that name. They are no longer audited here and are not merged again below.
  path = DATA / 'china-county-name-repairs.json'
  earlier = read(path)['repairs'] if path.exists() else {}
  fresh = dict(repairs)
  repairs = {**{fid: r for fid, r in earlier.items() if fid in hidden and fid not in fresh}, **fresh}
  write(DATA / 'china-county-name-repairs.json', {'metadata': {'schemaVersion': 1, 'purpose': 'Chinese names for county-level areas left with English or placeholder names; no geometry or ID replacement',
        'source': 'Wikidata (CC0), query in outputs/china-county-sources/query.rq', 'fetchedAt': fetched, 'script': 'scripts/audit-china-county-names.py'}, 'repairs': repairs})
  (CACHE / 'audit.json').write_text(json.dumps(report, ensure_ascii=False, indent=1) + '\n')
  for fid, repair in fresh.items():
    previous = names.get(fid, {})
    names[fid] = {**({'boundaryStatus': previous['boundaryStatus']} if previous.get('boundaryStatus') else {}),
                  'name': repair['name'], 'aliases': repair['aliases'], 'parentName': repair['parentName'], 'status': 'verified',
                  'note': repair['note'], 'evidenceURLs': repair['nameSourceURLs'], 'evidence': repair['evidence']}
  # Historical ones: the identity review that runs before this restores its placeholder; put the repaired
  # name back with the historical marking boundary-history.json gives it.
  history = read(DATA / 'boundary-history.json')['regions'] if (DATA / 'boundary-history.json').exists() else {}
  for fid, repair in repairs.items():
    if fid in fresh: continue
    past = history.get(fid, {})
    name = past['name'] if past.get('status') == 'verified' and repair['name'] in past.get('name', '') else repair['name'] + '（2017年旧界）'
    names[fid] = {**names.get(fid, {}), **past, 'name': name, 'aliases': list(dict.fromkeys([repair['name'], *repair['aliases']])), 'parentName': repair['parentName'],
                  'status': 'verified', 'evidenceURLs': repair['nameSourceURLs'], 'evidence': repair['evidence'], 'boundaryStatus': 'historical'}
  write(DATA / 'name-quality.json', quality)
  print(f"targets {len(targets)}; named {len(fresh)}, kept {len(repairs) - len(fresh)} now historical ({len(report['byName'])} with agreeing English name, {len(report['locationOnly'])} by location only, {len(report['reviewed'])} reviewed by hand); left as they were {len(report['unresolved'])}")

if __name__ == '__main__': main()
