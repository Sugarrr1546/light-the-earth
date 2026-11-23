#!/usr/bin/env python3
"""Apply source-specific review corrections last, after current/precision merges.

Only metadata manifests are written. No geometry is reconstructed or replaced.
Run twice to verify byte-identical output; --data-dir supports isolated fixtures.
"""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def apply(data):
    def read(name):
        return json.loads((data / name).read_text())

    changed = []
    def write(name, value):
        encoded = (json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n').encode()
        path = data / name
        if path.read_bytes() != encoded:
            path.write_bytes(encoded)
            changed.append(name)

    delta = read('review-provenance-delta.json')
    alignment = read('geometry-alignment.json')
    countries = alignment['countries']
    historical = delta['franceHistorical']
    original = data / historical['legacyPaintUrl'].removeprefix('/data/')
    raw = original.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == historical['sha256'], 'Original French historical source changed'
    features = json.loads(raw)['features']
    assert len(features) == historical['count']
    fixture = next(f for f in features if f['id'] == historical['fixtureId'])
    assert fixture['properties']['originalName'] == historical['fixtureName']
    history_metadata = {key: historical[key] for key in ['legacyPaintUrl', 'sha256', 'count', 'year', 'source', 'license']}
    countries['FRA']['legacyPaintUrl'] = historical['legacyPaintUrl']
    countries['FRA']['historicalGeometry'] = history_metadata
    france = read('precision-france.json')
    france['alignment']['legacyPaintUrl'] = historical['legacyPaintUrl']
    france['alignment']['historicalGeometry'] = history_metadata
    write('precision-france.json', france)
    archive = read('precision-france-legacy.json')
    assert archive['legacyAlignedUrl'] == historical['derivedArchiveUrl']
    archive.update(runtime=False, geometryRole='derived-commune-assignment-provenance-only',
                   runtimeHistoricalGeometry=history_metadata)
    write('precision-france-legacy.json', archive)

    mixed = delta['chinaMixedLicense']
    def china_license(record):
        record['license'] = mixed['license']
        base = record.get('source', '')
        record['sourceAttribution'] = base + ' · ' + mixed['visibleSuffix']

    china_license(countries['CHN'])
    # Preserve each archived batch's own source years and source provenance.
    for name in ['current-zhejiang.json', 'current-east-china.json', 'current-central-china.json']:
        if not (data / name).exists():
            continue
        manifest = read(name)
        china_license(manifest['alignment'])
        if 'coveragePatch' in manifest:
            manifest['coveragePatch']['license'] = mixed['license']
        write(name, manifest)

    coverage = read('coverage.json')
    for row in coverage:
        actual = countries.get(row['code'])
        if not actual:
            continue
        previous = row['localUrl']
        # Runtime source files may have been packed away; localBytes remains the
        # decoded canonical-byte count from the audited alignment manifest.
        local = data / actual['localUrl'].removeprefix('/data/')
        if local.exists():
            assert local.stat().st_size == actual['localBytes'], (row['code'], 'canonical byte size differs')
        if previous != actual['localUrl']:
            row['legacyUrls'] = sorted(set([*row.get('legacyUrls', []), previous]))
        row.update(localUrl=actual['localUrl'], bytes=actual['localBytes'],
                   count=actual['count'], renderCount=actual['renderCount'])
        for key in ['source', 'sourceUrl', 'license', 'sourceAttribution']:
            if actual.get(key):
                row[key] = actual[key]
        if actual.get('sourceYear'):
            row['year'] = actual['sourceYear']
            row['sourceYear'] = actual['sourceYear']
        if actual.get('localGzipUrl'):
            row['gzipUrl'] = actual['localGzipUrl']
            row['gzipBytes'] = actual['localGzipBytes']
        else:
            row.pop('gzipUrl', None)
            row.pop('gzipBytes', None)
        if actual.get('localGzipParts'):
            row['gzipParts'] = actual['localGzipParts']
        else:
            row.pop('gzipParts', None)
        if row['code'] == 'HKG':
            row['coverageNote'] = delta['hongKong']['coverageNote']
        if row['code'] == 'FRA':
            row['historicalGeometry'] = history_metadata
    write('geometry-alignment.json', alignment)
    write('coverage.json', coverage)
    print(json.dumps({'updated': changed, 'countries': len(countries),
                      'records': sum(row['count'] for row in coverage),
                      'rendered': sum(row.get('renderCount', row['count']) for row in coverage)}, ensure_ascii=False))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', type=Path, default=ROOT / 'public/data')
    apply(parser.parse_args().data_dir)
