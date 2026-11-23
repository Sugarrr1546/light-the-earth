#!/usr/bin/env python3
"""Chinese names and Chinese parent names for areas outside China, from Wikidata.

For every country whose areas still carry only their source (Latin-script) names:
  1. fetch the country's administrative items from Wikidata (via the QLever
     endpoint, which answers these country-sized queries quickly): location,
     P131 parent, dissolution, and labels in Chinese, English and the country's
     official languages;
  2. match each area to the item whose coordinate lies inside it (or just
     outside) and whose label equals the area's source name;
  3. take the item's Chinese label (traditional converted to simplified with
     the system ICU transform) and the nearest ancestor with a Chinese label;
  4. areas with no Chinese label keep their source name and get a Chinese
     parent from the matched item, or from the items located inside them.

The result is data/foreign-names.json, applied by scripts/build-region-index.mjs.
Nothing is transliterated automatically: a name is either Wikidata's Chinese
label or the source name. Downloads are cached in
$ATLAS_BUILD_HOME/wikidata-names (default ~/Library/Caches/light-the-earth).

  outputs/geodata-venv/bin/python scripts/audit-foreign-names.py [CODE ...]
"""
import collections, json, os, pathlib, re, subprocess, sys, time, unicodedata, urllib.parse, urllib.request
from shapely import STRtree
from shapely.geometry import shape, Point

ROOT = pathlib.Path(__file__).resolve().parents[1]
HOME = pathlib.Path(os.environ.get('ATLAS_BUILD_HOME', pathlib.Path.home() / 'Library/Caches/light-the-earth'))
CACHE = HOME / 'wikidata-names'
OUT = ROOT / 'data/foreign-names.json'
ENDPOINT = 'https://qlever.dev/api/wikidata'
UA = 'light-the-earth-names/1.0 (personal map app)'
SKIP = {'CHN', 'TWN', 'HKG', 'MAC'}
EXTRA_QIDS = {'KOS': ['Q1246'], 'CYN': ['Q23681'], 'SOL': ['Q34754']}
ZH = ['zh-cn', 'zh-hans', 'zh-sg', 'zh-my', 'zh', 'zh-hant', 'zh-tw', 'zh-hk', 'zh-mo']
HAN = re.compile(r'[㐀-鿿]')
PREFIX = 'PREFIX wd: <http://www.wikidata.org/entity/>\nPREFIX wdt: <http://www.wikidata.org/prop/direct/>\nPREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>\nPREFIX skos: <http://www.w3.org/2004/02/skos/core#>\n'
# Words that name the kind of unit rather than the place.
GENERIC = set('''district districts county municipality municipal municipio municipalities commune comuna comune gmina raion rayon region regional
province provincia city town village township the of de del della di da do dos das la le les el los las du des et and amphoe khet kecamatan kabupaten
kota regency prefecture department departement departamento canton parish ward subdistrict sub upazila tehsil taluka taluk mandal block oblast okrug
okres obec mesto miasto kommune kommun gemeinde landkreis stadtkreis kreisfreie kreis stadt ilce ilcesi cercle arrondissement concelho freguesia distrito wilayah mukim
local government area lga council borough gu gun si eup myeon metropolitan unitary authority island islands atoll st saint sainte santa santo san sao'''.split())


def log(*a): print(time.strftime('%H:%M:%S'), *a, flush=True)
def read(p): return json.loads(pathlib.Path(p).read_text())


def sparql(query, dest):
    """TSV result of one query, cached."""
    if dest.exists(): return dest.read_text()
    url = ENDPOINT + '?' + urllib.parse.urlencode({'query': PREFIX + query})
    request = urllib.request.Request(url, headers={'Accept': 'text/tab-separated-values', 'User-Agent': UA})
    for attempt in range(8):
        try:
            with urllib.request.urlopen(request, timeout=600) as response: text = response.read().decode()
            break
        except Exception as error:
            if attempt == 7: raise
            log('retry', dest.name, error); time.sleep(min(300, 30 * 2 ** attempt))
    assert text.startswith('?'), text[:200]
    part = dest.with_suffix('.part'); part.write_text(text); part.rename(dest)
    time.sleep(8)  # be gentle with the shared endpoint
    return text


def rows(text):
    lines = text.rstrip('\n').split('\n'); head = [h.lstrip('?') for h in lines[0].split('\t')]
    for line in lines[1:]:
        yield dict(zip(head, line.split('\t')))


def qid(value): return value.rsplit('/', 1)[-1].rstrip('>') if value else None


ESCAPES = {'t': '\t', 'n': '\n', 'r': '\r', 'b': '\b', 'f': '\f', '"': '"', "'": "'", '\\': '\\'}


def unescape(text):
    """Turtle string escapes (\\", \\\\, \\n, \\uXXXX, \\UXXXXXXXX) as QLever writes them in TSV."""
    def one(m):
        e = m[1]
        return chr(int(e[1:], 16)) if e[0] in 'uU' else ESCAPES.get(e, e)
    return re.sub(r'\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)', one, text)


def literal(value):
    m = re.fullmatch(r'"(.*)"@([a-zA-Z-]+)', value or '')
    return (unescape(m[1]), m[2].lower()) if m else (None, None)


def norm(text):
    text = unicodedata.normalize('NFKD', text)
    text = ''.join(c for c in text if not unicodedata.combining(c)).lower().replace('ı', 'i').replace('ł', 'l').replace('ø', 'o').replace('đ', 'd').replace('ß', 'ss')
    text = re.sub(r"['’`ʻʼ]", '', text)
    words = [w for w in re.findall(r'[a-z0-9]+|[^\x00-\x7f\s\W]+', text) if w not in GENERIC]
    return ' '.join(words)


def to_simplified(names):
    """Traditional → simplified with macOS's ICU transform (no network, no extra package)."""
    names = sorted(set(names))
    if not names: return {}
    script = CACHE / 'hant-hans.swift'
    script.write_text('import Foundation\nwhile let line = readLine() { print(line.applyingTransform(StringTransform("Hant-Hans"), reverse: false) ?? line) }\n')
    out = subprocess.run(['swift', str(script)], input='\n'.join(names) + '\n', capture_output=True, text=True, check=True).stdout.rstrip('\n').split('\n')
    assert len(out) == len(names)
    return dict(zip(names, out))


def country_items():
    text = sparql('SELECT ?c ?iso WHERE { ?c wdt:P298 ?iso . FILTER NOT EXISTS { ?c wdt:P576 [] } }', CACHE / 'countries.tsv')
    by = collections.defaultdict(list)
    for r in rows(text): by[literal(r['iso'])[0] or r['iso'].strip('"')].append(qid(r['c']))
    return by


def fetch(code, qids):
    values = ' '.join('wd:' + q for q in qids)
    scope = f'VALUES ?c {{ {values} }} {{ ?item wdt:P17 ?c }} UNION {{ ?item wdt:P131+ ?c }} ?item wdt:P31/wdt:P279* wd:Q56061 .'
    langs = sparql(f'SELECT DISTINCT ?code WHERE {{ VALUES ?c {{ {values} }} ?c wdt:P37 ?l . ?l wdt:P424 ?code }}', CACHE / f'{code}-languages.tsv')
    codes = sorted({literal(r['code'])[0] or r['code'].strip('"') for r in rows(langs)} | {'en', 'mul'} | set(ZH))
    structure = sparql(f'SELECT DISTINCT ?item ?coord ?parent ?end WHERE {{ {scope} OPTIONAL {{ ?item wdt:P625 ?coord }} OPTIONAL {{ ?item wdt:P131 ?parent }} OPTIONAL {{ ?item wdt:P576 ?end }} }}', CACHE / f'{code}-items.tsv')
    langs_in = ','.join(f'"{c}"' for c in codes)
    labels = sparql(f'SELECT DISTINCT ?item ?label WHERE {{ {scope} ?item rdfs:label ?label . FILTER(LANG(?label) IN ({langs_in})) }}', CACHE / f'{code}-labels.tsv')
    items = {}
    for r in rows(structure):
        it = items.setdefault(qid(r['item']), {'points': set(), 'parents': set(), 'dissolved': False, 'names': set(), 'zh': {}})
        m = re.match(r'"?POINT\(([-\d.eE]+) ([-\d.eE]+)\)', r.get('coord') or '')
        if m: it['points'].add((float(m[1]), float(m[2])))
        if r.get('parent'): it['parents'].add(qid(r['parent']))
        if r.get('end'): it['dissolved'] = True
    for r in rows(labels):
        text, lang = literal(r['label'])
        if not text or qid(r['item']) not in items: continue
        it = items[qid(r['item'])]
        if lang in ZH:
            if HAN.search(text): it['zh'].setdefault(lang, text)
        else: it['names'].add(norm(text))
    return items, set(qids)


def zh_label(item, simple):
    for lang in ZH:
        if lang in item['zh']:
            # Wikidata disambiguators ("切尔滕纳姆 (英国国会选区)") are not part of the name.
            label = re.sub(r'\s*[（(][^（）()]*[）)]\s*$', '', simple.get(item['zh'][lang], item['zh'][lang]))
            if HAN.search(label): return label
    return None


def ancestors(q, items, roots, seen=None):
    """Breadth-first P131 ancestors, live ones first, stopping at the country."""
    out, frontier, seen = [], [q], {q}
    while frontier:
        nxt = []
        for x in frontier:
            ps = sorted(items.get(x, {}).get('parents', ()), key=lambda p: items.get(p, {}).get('dissolved', True))
            for p in ps:
                if p in seen or p in roots or p not in items: continue
                seen.add(p); out.append(p); nxt.append(p)
        frontier = nxt
    return out


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    only = set(sys.argv[1:])
    coverage = read(ROOT / 'public/data/coverage.json'); alignment = read(ROOT / 'public/data/geometry-alignment.json')['countries']
    catalog = read(ROOT / 'public/data/name-quality.json')['regions']
    isos = country_items()
    result = read(OUT) if OUT.exists() and only else {'version': 1, 'countries': {}}
    for c in coverage:
        code = c['code']
        if code in SKIP or (only and code not in only): continue
        url = alignment.get(code, {}).get('localUrl') or c['localUrl']
        features = read(ROOT / ('public' + url))['features']
        suppressed = set(alignment.get(code, {}).get('suppressedIds', []))
        areas = []
        for f in features:
            fid = str(f.get('id') or f['properties']['id'])
            if fid in suppressed: continue
            shown = catalog.get(fid, {}).get('name') or f['properties'].get('name') or ''
            if HAN.search(shown): continue
            source = [n for n in {f['properties'].get('name'), f['properties'].get('originalName'), catalog.get(fid, {}).get('name')} if n]
            areas.append((fid, source, shape(f['geometry'])))
        if not areas: continue
        qids = EXTRA_QIDS.get(code) or isos.get(code)
        if not qids: log('no Wikidata item for', code); continue
        t = time.time()
        try: items, roots = fetch(code, qids)
        except Exception as error: log('SKIPPED', code, error); continue
        simple = to_simplified([v for it in items.values() for v in it['zh'].values()])
        located = [(q, Point(p)) for q, it in items.items() for p in it['points']]
        polys = [a[2] for a in areas]; tree = STRtree(polys)
        inside = collections.defaultdict(set)
        if located:
            pi, ai = tree.query([p for _, p in located], predicate='within')
            for i, j in zip(pi, ai): inside[int(j)].add(located[int(i)][0])
        near = collections.defaultdict(set)
        if located:
            pi, ai = tree.query([p for _, p in located], predicate='dwithin', distance=0.03)
            for i, j in zip(pi, ai): near[int(j)].add(located[int(i)][0])
        depth_memo = {}
        def depth(q):
            """Steps up P131 to the country (shortest); None if the chain never reaches it."""
            if q in depth_memo: return depth_memo[q]
            depth_memo[q] = None; frontier, seen, d = [q], {q}, 0
            while frontier and d < 12:
                d += 1; nxt = []
                for x in frontier:
                    for p in items.get(x, {}).get('parents', ()):
                        if p in roots: depth_memo[q] = d; return d
                        if p not in seen and p in items: seen.add(p); nxt.append(p)
                frontier = nxt
            return None
        def candidates(j):
            keys = {norm(s) for s in areas[j][1]} - {''}
            return [[q for q in pool if keys & items[q]['names']] for pool in (inside[j], near[j] - inside[j])]
        # The level of this country's areas: the usual depth of unambiguous same-name items inside them.
        levels = collections.Counter(depth(hits[0]) for j in range(len(areas)) for hits in candidates(j)[:1] if len(hits) == 1)
        target = levels.most_common(1)[0][0] if levels else None
        stats = collections.Counter(); out = {}; matched = {}
        for j in range(len(areas)):
            pick = None
            for hits in candidates(j):
                # Same-name items in one area: a named one, then the highest (a district over its own seat),
                # then the live one, then the usual level of this country (levels differ between regions).
                if len(hits) > 1: hits = [q for q in hits if items[q]['zh']] or hits
                if len(hits) > 1: hits = [q for q in hits if not any(q in ancestors(o, items, roots) for o in hits if o != q)] or hits
                if len(hits) > 1: hits = [q for q in hits if not items[q]['dissolved']] or hits
                if len(hits) > 1 and target is not None:
                    best = min(abs((depth(q) or 99) - target) for q in hits); hits = [q for q in hits if abs((depth(q) or 99) - target) == best]
                if len(hits) == 1: pick = hits[0]; break
                if len(hits) > 1: stats['ambiguous'] += 1; break
            if pick and target is not None and depth(pick) is not None and depth(pick) > target:
                # A same-name seat inside the area (Göttingen in Landkreis Göttingen): the area is its ancestor of that
                # name, whose own item often has no coordinate.
                keys = {norm(x) for x in areas[j][1]} - {''}
                up = next((a for a in ancestors(pick, items, roots) if depth(a) == target and keys & items[a]['names']), None)
                if up: stats['promotedToAncestor'] += 1; pick = up
                else: stats['belowLevel'] += 1  # same name, deeper level: the name still translates the area's name
            if pick: matched[j] = pick
        def first_parent(q, want=None):
            d = depth(q)
            return next((a for a in ancestors(q, items, roots) if zh_label(items[a], simple) and (d is None or depth(a) is None or depth(a) < d) and (want is None or depth(a) == want)), None)
        # The usual parent level of this country (French communes: the département, not an intercommunality).
        parent_levels = collections.Counter(depth(p) for p in (first_parent(q) for q in matched.values()) if p and depth(p) is not None)
        parent_depth = parent_levels.most_common(1)[0][0] if parent_levels else None
        def parent_of(q):
            exact = first_parent(q, parent_depth)
            if exact or parent_depth is None: return exact
            # No ancestor at the usual parent level: the nearest one above it, never one below (a village's town).
            return next((a for a in ancestors(q, items, roots) if zh_label(items[a], simple) and depth(a) is not None and depth(a) <= parent_depth), None)
        level = {parent_of(q) for q in matched.values()} - {None}
        for j, (fid, source, _) in enumerate(areas):
            q = matched.get(j); name = zh_label(items[q], simple) if q else None
            if q: parent = parent_of(q)
            else:
                votes = collections.Counter(a for x in inside[j] for a in ancestors(x, items, roots) if a in level)
                parent = votes.most_common(1)[0][0] if votes else None
            parent_name = zh_label(items[parent], simple) if parent else None
            if name and parent_name == name: parent_name = None
            stats['areas'] += 1; stats['matched'] += bool(q); stats['chineseName'] += bool(name); stats['chineseParent'] += bool(parent_name)
            if name or parent_name: out[fid] = [name, parent_name, q]
        stats['level'] = target or 0
        parents = sorted({v[1] for v in out.values() if v[1]})
        index = {p: i for i, p in enumerate(parents)}
        result['countries'][code] = {'stats': dict(stats), 'parents': parents, 'regions': {fid: [v[0], index[v[1]] if v[1] else None, v[2]] for fid, v in sorted(out.items())}}
        log(code, dict(stats), f'{time.time() - t:.0f}s')
    result.update(generatedAt=time.strftime('%Y-%m-%d'), source='Wikidata (CC0), queried through the QLever endpoint', license='CC0 1.0',
                  rule='Chinese label of the Wikidata item whose coordinate lies in the area and whose label equals the source name; parent = nearest P131 ancestor with a Chinese label. Traditional labels converted to simplified with ICU Hant-Hans. No automatic transliteration.')
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n')
    total = collections.Counter()
    for v in result['countries'].values(): total.update(v['stats'])
    log('total', dict(total))


if __name__ == '__main__': main()
