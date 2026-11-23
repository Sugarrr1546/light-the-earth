#!/usr/bin/env python3
"""Apply the reviewed name/lifecycle overlay without touching geometry or visits.

The review asset is deliberately separate from current-boundary manifests. The
final boundary merge must consume its suppressedIds and historicalRegions.
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA = ROOT / 'public/data'
NOTICE = '2017年历史来源；现行县界尚未逐一核验。名称映射不表示已更新行政边界。'


def apply_review(repairs, catalog, features, review):
    for feature in features:
        fid = feature['id']
        if not fid.startswith('GB-62558664B'):
            continue
        prior = {**catalog['regions'].get(fid, {}), **repairs.get(fid, {})}
        prior.update(sourceGeometryYear='2017', currentIdentityVerified=False,
                     sourceName=feature['properties'].get('originalName', feature['properties'].get('name', '')))
        note = prior.get('note', '')
        if NOTICE not in note:
            prior['note'] = NOTICE + (' ' + note if note else '')
        # Only reviewed metadata changes. Current OSM identities use other IDs.
        prior.update(review.get('nameOverrides', {}).get(fid, {}))
        if fid in review.get('historicalRegions', {}):
            prior.update(review['historicalRegions'][fid])
        repairs[fid] = prior
        catalog['regions'][fid] = prior
    catalog.setdefault('sourceAttribution', {})['chinaIdentityReview'] = {
        'reviewedAt': review['reviewedAt'],
        'source': '/data/china-identity-review.json',
        'contract': 'Metadata corrections only; 2017 source geometry is not asserted current. Officially abolished identities are historical and suppressed by the final boundary merge.',
        'limitations': review['limitations'],
    }
    return repairs, catalog


def main():
    def read(name):
        return json.loads((DATA / name).read_text())
    repair_file = read('china-name-repairs.json')
    catalog = read('name-quality.json')
    review = read('china-identity-review.json')
    features = read('aligned/chn.geojson')['features']
    repair_file['repairs'], catalog = apply_review(repair_file['repairs'], catalog, features, review)
    repair_file['metadata']['identityReview'] = '/data/china-identity-review.json'
    repair_file['metadata']['reviewCounts'] = {
        'records': len(repair_file['repairs']),
        'verifiedNames': sum(r.get('status') == 'verified' for r in repair_file['repairs'].values()),
        'unresolvedNames': sum(r.get('status') == 'unresolved' for r in repair_file['repairs'].values()),
        'untranslatedSourceRecords': sum(not r.get('status') for r in repair_file['repairs'].values()),
        'nameOverrides': len(review['nameOverrides']),
        'officiallyRetiredRecords': len(review['historicalRegions']),
    }
    for name, value in [('china-name-repairs.json', repair_file), ('name-quality.json', catalog)]:
        (DATA / name).write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n')
    print('Applied China identity review:', len(review['nameOverrides']), 'name overrides;', len(review['suppressedIds']), 'historical suppression identities')


if __name__ == '__main__':
    main()
