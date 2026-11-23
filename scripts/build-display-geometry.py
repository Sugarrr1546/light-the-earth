#!/usr/bin/env python3
"""Simplified same-ID county geometry for countries whose paint file is a different layer."""
import json
from pathlib import Path
from shapely.geometry import shape, mapping
from shapely import make_valid

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "public" / "data" / "display"
DEST.mkdir(parents=True, exist_ok=True)


def parts(geom):
    if geom.geom_type == "Polygon":
        return [geom]
    if geom.geom_type in ("MultiPolygon", "GeometryCollection"):
        found = []
        for child in geom.geoms:
            found.extend(parts(child))
        return found
    return []


def simplify(feature):
    geom = shape(feature["geometry"])
    if not geom.is_valid:
        geom = make_valid(geom)
    geom = geom.simplify(0.02, preserve_topology=True)
    polygons = [part for part in parts(geom) if part.area > 1e-10]
    if not polygons:
        original = shape(feature["geometry"])
        polygons = [part for part in parts(original if original.is_valid else make_valid(original)) if part.area > 0]
    if not polygons:
        raise ValueError(feature.get("id"))
    from shapely.geometry import MultiPolygon
    geom = polygons[0] if len(polygons) == 1 else MultiPolygon(polygons)
    encoded = json.loads(json.dumps(mapping(geom)))

    def round_coords(value):
        if isinstance(value, float):
            return round(value, 3)
        if isinstance(value, list):
            return [round_coords(item) for item in value]
        return value

    feature_id = feature.get("id") or feature["properties"]["id"]
    return {"type": "Feature", "id": feature_id, "properties": {"id": feature_id}, "geometry": round_coords(encoded)}


def main():
    source = ROOT / "public/data/precision/fra-adm5.geojson"
    data = json.loads(source.read_text())
    features = []
    for index, feature in enumerate(data["features"], 1):
        features.append(simplify(feature))
        if index % 5000 == 0:
            print(index, flush=True)
    path = DEST / "fra.geojson"
    path.write_text(json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")))
    print(path.name, round(path.stat().st_size / 1e6, 2), "MB", len(features))


if __name__ == "__main__":
    main()
