#!/usr/bin/env python3
"""Attach Chinese names and parent cities to China counties.

Names come from Wikidata (CC0) administrative codes. A name is kept only when
its coordinate falls in the polygon, or when the English name matches exactly
and is unique. Geometry and stored travel records stay unchanged.
"""
import importlib.util, json, pathlib, re, time, unicodedata, urllib.parse, urllib.request
import zhconv
from shapely.geometry import shape, Point
from shapely import make_valid
from shapely.strtree import STRtree

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA = ROOT / "public" / "data"
CACHE = ROOT / "outputs" / "china-names-cache"
UA = "LightTheEarth/1.0 (personal atlas; county name alignment)"
STOP = {"district", "county", "city", "prefecture", "banner", "league", "autonomous", "special", "new", "region", "area", "hui", "kazak", "kazakh", "mongol", "mongolian", "tibetan", "uyghur", "uygur", "yi", "miao", "zhuang", "dong", "yao", "buyei", "buyi", "korean", "sui", "tujia", "hani", "dai", "lisu", "wa", "naxi", "qiang", "lahu", "ethnic", "joint", "and", "the", "of", "li"}
QUERY = '''PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?item ?code ?zh ?en ?coord ?parentZh ?dissolved WHERE {
  ?item wdt:P442 ?code .
  FILTER(STRLEN(STR(?code))=8)
  ?item rdfs:label ?zh . FILTER(LANG(?zh)="zh")
  OPTIONAL { ?item rdfs:label ?en FILTER(LANG(?en)="en") }
  OPTIONAL { ?item wdt:P625 ?coord }
  OPTIONAL { ?item wdt:P131 ?parent . ?parent rdfs:label ?parentZh FILTER(LANG(?parentZh)="zh") }
  OPTIONAL { ?item wdt:P576 ?dissolved }
}'''


def read(path):
    return json.loads(path.read_text())


def norm_en(value):
    text = unicodedata.normalize("NFKD", value or "").encode("ascii", "ignore").decode().lower().replace("'", "")
    return tuple(token for token in re.split(r"[^a-z0-9]+", text) if token and token not in STOP)


def score(left, right):
    if not left or not right:
        return 0.0
    if left == right:
        return 1.0
    a, b = set(left), set(right)
    return len(a & b) / len(a | b)


def administrative_kind(value):
    """Keep the unit type: dropping County/City/District conflates identities."""
    text = (value or "").lower().split(",", 1)[0].strip()
    for kind in ("autonomous county", "autonomous banner", "county", "district", "city", "banner", "prefecture", "league"):
        if re.search(r"\b" + kind + r"$", text):
            return kind
    return None


def compatible_identity(english, item):
    if item.get("dissolved") or item.get("prefecture"):
        return False
    kind = administrative_kind(english)
    english_kind = administrative_kind(item.get("en"))
    zh = item.get("zh", "")
    chinese_kind = next((value for suffix, value in (("自治县", "autonomous county"), ("自治旗", "autonomous banner"), ("县", "county"), ("区", "district"), ("市", "city"), ("旗", "banner")) if zh.endswith(suffix)), None)
    if english_kind and chinese_kind and english_kind != chinese_kind:
        return False
    item_kind = chinese_kind or english_kind
    return bool(kind and kind == item_kind
                and norm_en((english or "").split(",", 1)[0]) == norm_en((item.get("en") or "").split(",", 1)[0]))


def fetch():
    CACHE.mkdir(parents=True, exist_ok=True)
    dest = CACHE / "qlever.json"
    if dest.exists() and dest.stat().st_size > 1000:
        return read(dest)
    url = "https://qlever.dev/api/wikidata?" + urllib.parse.urlencode({"query": QUERY})
    request = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/sparql-results+json"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                payload = json.load(response)
            break
        except Exception as error:
            if attempt == 2:
                raise
            print("retry", type(error).__name__, flush=True)
            time.sleep(3)
    if "exception" in payload:
        raise SystemExit(payload["exception"])
    dest.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    return payload


def lang_rank(lang):
    return {"zh-cn": 3, "zh-hans": 2, "zh": 1}.get(lang or "", 0)


def items_from(payload):
    found = {}
    for row in payload["results"]["bindings"]:
        qid = row["item"]["value"].rsplit("/", 1)[-1]
        item = found.setdefault(qid, {"qid": qid, "code": row["code"]["value"], "names": [], "en": "", "parents": [], "dissolved": False, "point": None})
        item["names"].append((lang_rank(row["zh"].get("xml:lang")), row["zh"]["value"]))
        if row.get("en") and not item["en"]:
            item["en"] = row["en"]["value"]
        if row.get("parentZh"):
            item["parents"].append((lang_rank(row["parentZh"].get("xml:lang")), row["parentZh"]["value"]))
        if row.get("dissolved"):
            item["dissolved"] = True
        if item["point"] is None and row.get("coord"):
            point = re.search(r"POINT\(([-\d.]+) ([-\d.]+)\)", row["coord"]["value"])
            if point:
                item["point"] = (float(point.group(1)), float(point.group(2)))
        if item["point"] is None and row.get("lon") and row.get("lat"):
            item["point"] = (float(row["lon"]["value"]), float(row["lat"]["value"]))
    result = []
    for item in found.values():
        item["zh"] = sorted(item["names"], reverse=True)[0][1]
        parents = [name for _, name in item["parents"] if name and name != item["zh"]]
        ranked = sorted(set(parents), key=lambda name: max(rank for rank, label in item["parents"] if label == name), reverse=True)
        cities = [name for name in ranked if name.endswith(("市", "州", "盟", "地区"))]
        item["parent"] = cities[0] if cities else (ranked[0] if ranked else "")
        if item["parent"] and item["zh"].startswith(item["parent"]) and len(item["zh"]) > len(item["parent"]):
            item["zh"] = item["zh"][len(item["parent"]):]
        item["zh"] = zhconv.convert(item["zh"], "zh-cn")
        item["parent"] = zhconv.convert(item["parent"], "zh-cn") if item["parent"] else ""
        if not re.fullmatch(r"\d{2} \d{2} \d{2}", item["code"]):
            continue
        item["en_norm"] = norm_en(item["en"])
        item["prefecture"] = item["code"].replace(" ", "").endswith("00")
        result.append(item)
    return result


def aliases_for(name, parent, english):
    values = [name, english]
    short = name
    for suffix in ("自治县", "自治旗", "林区", "特区", "新区", "矿区", "区", "县", "市", "旗"):
        if name.endswith(suffix) and len(name) - len(suffix) >= 2:
            short = name[: -len(suffix)]
            break
    if short != name:
        values.append(short)
    if parent:
        stem = parent[:-1] if parent.endswith(("市", "州", "盟")) else parent
        values.extend([parent + name, stem + name])
        if short != name:
            values.extend([stem + short, parent + short])
    return [value for value in dict.fromkeys(values) if value and len(value) >= 2]


def main():
    rows = items_from(fetch())
    print("rows", len(rows), flush=True)
    by_qid = {}
    for item in rows:
        by_qid.setdefault(item["qid"], item)
    places = list(by_qid.values())
    print("wikidata places", len(places), flush=True)

    aligned = read(DATA / "aligned" / "chn.geojson")
    patch = read(DATA / "hangzhou-boundary-patch.json")
    alignment = read(DATA / "geometry-alignment.json")["countries"]["CHN"]
    abolished = {item["id"]: item for item in patch["abolished"]}
    replaced = {item["id"] for item in patch["replaced"]} | {item["id"] for item in patch["added"]}
    # Suppressed source IDs still need truthful names for saved historical visits.
    # Their current-selection status is controlled by the boundary manifest.
    skip = set()
    features = []
    geoms = []
    for feature in aligned["features"]:
        if feature["id"] in skip or not feature["id"].startswith("GB-62558664B"):
            continue
        geom = shape(feature["geometry"])
        if not geom.is_valid:
            geom = make_valid(geom)
        props = feature["properties"]
        features.append({
            "id": feature["id"],
            "english": props.get("originalName") or props.get("name") or "",
            "en_norm": norm_en(props.get("originalName") or props.get("name") or ""),
            "year": props.get("year") or "2017",
        })
        geoms.append(geom)
    tree = STRtree(geoms)
    pairs = []
    for item in places:
        if not item["point"] or item["dissolved"]:
            continue
        point = Point(*item["point"])
        for index in tree.query(point, predicate="within"):
            poly = features[int(index)]
            if not compatible_identity(poly["english"], item):
                continue
            pairs.append((score(poly["en_norm"], item["en_norm"]), 0 if item["dissolved"] else 1, 0 if item["prefecture"] else 1, int(index), item["qid"]))
    pairs.sort(reverse=True)
    used_poly, used_item = set(), set()
    chosen = {}
    for value, current, local, index, qid in pairs:
        if index in used_poly or qid in used_item or value < 0.5:
            continue
        if by_qid[qid]["prefecture"] and value < 0.99:
            continue
        chosen[index] = qid
        used_poly.add(index)
        used_item.add(qid)
    by_qid = {item["qid"]: item for item in places}
    for index, poly in enumerate(features):
        if index in chosen or not poly["en_norm"]:
            continue
        # A coordinate known to lie outside this polygon is negative evidence.
        # Do not assign the globally unique English name to a distant namesake.
        hits = [item for item in places if item["qid"] not in used_item and not item["point"] and compatible_identity(poly["english"], item)]
        if len(hits) == 1:
            chosen[index] = hits[0]["qid"]
            used_item.add(hits[0]["qid"])

    repairs = {}
    for index, qid in chosen.items():
        poly = features[index]
        item = by_qid[qid]
        note = f"中文名来自 Wikidata（CC0），英文实体类型及坐标与该多边形对应。边界为{poly['year']}年历史来源，未逐一核验为现行县界。"
        if poly["id"] in replaced:
            note = "名称对应当前区划。杭州市这片边界采用2026年OpenStreetMap快照，范围按2021年国务院批复后的区界，不是2017年的旧多边形。"
        if poly["id"] in abolished:
            note = abolished[poly["id"]]["note"]
        name = abolished[poly["id"]]["name"] + "（已撤销）" if poly["id"] in abolished else item["zh"]
        repairs[poly["id"]] = {
            "name": name,
            "aliases": aliases_for(item["zh"], item["parent"], poly["english"]),
            "parentName": item["parent"] or ("杭州市" if poly["id"] in abolished or poly["id"] in replaced else ""),
            "status": "verified",
            "note": note,
            "evidenceURLs": [f"https://www.wikidata.org/wiki/{qid}", patch["gazetteUrl"]] if poly["id"] in replaced or poly["id"] in abolished else [f"https://www.wikidata.org/wiki/{qid}"],
            "evidence": {"wikidata": qid, "code": item["code"], "english": item["en"], "dissolved": item["dissolved"], "match": "coordinate" if item["point"] else "english"},
            "sourceGeometryYear": str(poly["year"]),
            "currentIdentityVerified": poly["id"] in replaced,
        }
        if not repairs[poly["id"]]["parentName"]:
            repairs[poly["id"]].pop("parentName")
    # Districts added or abolished must stay named even if Wikidata missed them.
    for item in patch["added"] + patch["replaced"] + patch["abolished"]:
        repair = repairs.get(item["id"], {"aliases": [], "status": "verified", "evidenceURLs": [patch["gazetteUrl"]]})
        repair["name"] = item["name"] + ("（已撤销）" if item["id"] in abolished else "")
        repair["parentName"] = "杭州市"
        repair["aliases"] = list(dict.fromkeys([*repair.get("aliases", []), *aliases_for(item["name"], "杭州市", item["originalName"])]))
        repair["status"] = "verified"
        if item["id"] in abolished:
            repair["note"] = item["note"]
        elif "2021" not in repair.get("note", ""):
            repair["note"] = "杭州市这片边界采用2026年OpenStreetMap快照，范围按2021年国务院批复后的区界。"
        repairs[item["id"]] = repair

    enrichment = read(DATA / "name-enrichment.json")
    for key, extra in enrichment.items():
        fid = key if key.startswith("GB-") else "GB-" + key
        if fid in repairs:
            repairs[fid]["aliases"] = list(dict.fromkeys([*repairs[fid]["aliases"], *extra.get("aliases", []), extra.get("name", "")]))
            repairs[fid]["parentName"] = repairs[fid].get("parentName") or extra.get("parentName", "")

    catalog = read(DATA / "name-quality.json")
    # Replace this generator's scope, retaining independent history/anchor fields.
    # update() alone left stale mappings on unmatched distant namesakes.
    for feature in aligned["features"]:
        fid = feature["id"]
        if not fid.startswith("GB-62558664B"):
            continue
        if fid not in repairs and fid in catalog["regions"] and catalog["regions"][fid].get("evidence", {}).get("wikidata"):
            prior = catalog["regions"][fid]
            catalog["regions"][fid] = {k: v for k, v in prior.items() if k in ("center", "anchorReason", "boundaryStatus", "retirementKind", "sourceGeometryYear")}
            catalog["regions"][fid].update(name=f"旧来源待核实区域 · {fid[-10:]}", aliases=[feature["properties"].get("originalName", "")], parentName="", status="unresolved", note="2017年历史来源；旧名称映射未通过实体类型及位置核验，现行县界未核验。", evidenceURLs=[])
    catalog["regions"].update(repairs)
    review_path = DATA / "china-identity-review.json"
    if review_path.exists():
        spec = importlib.util.spec_from_file_location("china_identity_review", ROOT / "scripts/remediate-china-identities.py")
        review_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(review_module)
        repairs, catalog = review_module.apply_review(repairs, catalog, aligned["features"], read(review_path))
    catalog.setdefault("sourceAttribution", {})["china"] = {
        "source": "Wikidata P442 county-level codes, CC0",
        "matched": len(repairs),
        "polygons": len(features),
        "hangzhou": "2021 State Council adjustment; OSM geometry is separate from these names",
    }
    (DATA / "china-name-repairs.json").write_text(json.dumps({"metadata": catalog["sourceAttribution"]["china"], "repairs": repairs}, ensure_ascii=False, separators=(",", ":")) + "\n")
    (DATA / "name-quality.json").write_text(json.dumps(catalog, ensure_ascii=False, separators=(",", ":")) + "\n")
    required = {
        "GB-62558664B82614955491445": "西湖区",
        "GB-62558664B9496053300630": "海淀区",
        patch["unchangedHangzhouXihuId"]: "西湖区",
    }
    for fid, name in required.items():
        got = repairs.get(fid, {}).get("name")
        if got != name:
            raise SystemExit(f"{fid} named {got}, expected {name}")
    tianhe = next(feature for feature in aligned["features"] if feature["properties"].get("originalName") == "Tianhe District")
    if repairs.get(tianhe["id"], {}).get("name") != "天河区" or repairs[tianhe["id"]].get("parentName") != "广州市":
        raise SystemExit(f"Tianhe resolved to {repairs.get(tianhe['id'])}")
    jianggan = next(item for item in patch["abolished"] if item["originalName"] == "Jianggan District")
    if "撤销" not in repairs[jianggan["id"]]["note"] or not repairs[jianggan["id"]]["name"].startswith("江干区"):
        raise SystemExit("Jianggan was not marked abolished")
    print("matched", len(repairs), "of", len(features), "tianhe", tianhe["id"])


def places_by(places, qid):
    for item in places:
        if item["qid"] == qid:
            return item
    raise KeyError(qid)


if __name__ == "__main__":
    main()
