#!/usr/bin/env python3
"""Verify damaged Hungarian labels against KSH and primary official geography.

Dependencies: shapely>=2.1, pyproj. Only writes the additive name repair map and
outputs/hungary-name-* audit/cache files. Never changes feature IDs, source-year
metadata or geometries. GISCO geometries are used locally for verification;
they are not included in the public repair map or used to replace app polygons.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from urllib.request import urlretrieve
from zipfile import ZipFile
import xml.etree.ElementTree as ET

from pyproj import Transformer
from shapely import transform
from shapely.geometry import Point, shape
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / 'outputs/hungary-name-sources'
KSH = 'https://www.ksh.hu/docs/helysegnevtar/hnt_letoltes_2025.xlsx'
KSH_PAGE = 'https://www.ksh.hu/apps/hntr.telepules?p_lang=HU&p_id='
GISCO_CATALOG = 'https://gisco-services.ec.europa.eu/distribution/v1/lau-2024.html'
GISCO = 'https://gisco-services.ec.europa.eu/distribution/v2/lau/geojson/LAU_RG_01M_2024_4326.geojson'
DISTRICT_PDF = 'https://www.budapest13.hu/wp-content/uploads/2010/03/ujlipotvaros_2009.pdf'
POLICE = ('https://www.police.hu/hu/ugyintezes/szerv/orszagos-rendor-fokapitanysag/'
          'budapesti-rendor-fokapitanysag/xiii-keruleti-0')
POLICE_MAP = 'https://www.google.com/maps/d/kml?mid=1xFiRAQxZppHD3SD2h6Rpd3ywh3yMTsGT&forcekml=1'
NEIGHBORHOOD_ID = 'GB-24034025B74528207384069'
PROJECT = Transformer.from_crs(4326, 6933, always_xy=True).transform
NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}


def fetch(url, filename):
    target = CACHE / filename
    if not target.exists():
        urlretrieve(url, target)
    return target


def projected(geometry):
    return transform(geometry, PROJECT, interleaved=False)


def ksh_rows(path):
    with ZipFile(path) as z:
        strings = [''.join(si.itertext()) for si in ET.fromstring(
            z.read('xl/sharedStrings.xml')).findall('m:si', NS)]
        rows = ET.fromstring(z.read('xl/worksheets/sheet1.xml')).findall('m:sheetData/m:row', NS)
        result = {}
        for row in rows:
            values = {}
            for cell in row:
                column = re.sub(r'\d+', '', cell.attrib['r'])
                value = cell.findtext('m:v', '', NS)
                values[column] = strings[int(value)] if cell.get('t') == 's' else value
            if values.get('B', '').isdigit() and values.get('A'):
                result[values['B'].zfill(5)] = {
                    'name': values['A'], 'code': values['B'].zfill(5),
                    'county': values['D'], 'district': values['F'],
                    'areaHectares2025': float(values['J']),
                    'sheetRow': int(row.attrib['r']),
                }
        return result


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    ksh_file = fetch(KSH, 'hnt_letoltes_2025.xlsx')
    gazetteer = ksh_rows(ksh_file)
    full_lau_file = fetch(GISCO, 'LAU_RG_01M_2024_4326.geojson')
    official_features = [f for f in json.loads(full_lau_file.read_text())['features']
                         if f['properties']['CNTR_CODE'] == 'HU']
    geometries = [shape(f['geometry']) for f in official_features]
    tree = STRtree(geometries)
    precise_features = {f['properties']['id']: f for f in json.loads(
        (ROOT / 'public/data/precision/hun.geojson').read_text())['features']}
    raw_features = json.loads((ROOT / 'public/data/global/hun-adm3.geojson').read_text())['features']
    targets = [f for f in raw_features if '?' in f['properties']['originalName']
               or f['properties']['id'] == NEIGHBORHOOD_ID]
    assert len(targets) == 15
    repairs, audit = {}, []
    for raw in targets:
        old = raw['properties']
        feature = precise_features[old['id']]
        p = feature['properties']
        g = shape(feature['geometry'])
        if not g.is_valid:
            g = g.buffer(0)
        pg = projected(g)
        scores = []
        for j in tree.query(g):
            if g.intersects(geometries[j]):
                ratio = pg.intersection(projected(geometries[j])).area / pg.area
                scores.append((ratio, int(j)))
        scores.sort(reverse=True)
        ratio, index = scores[0]
        official = official_features[index]['properties']
        center = Point(p['center'])
        evidence = {
            'sourceGeometryYear': old['year'],
            'sourceGeometryPreserved': True,
            'currentNameSourceDate': '2025-01-01',
            'spatialVerificationSnapshot': 'GISCO LAU 2024',
            'sourceCenter': p['center'],
            'sourceBBox': list(g.bounds),
            'sourceCenterInsideSourcePolygon': g.covers(center),
            'sourceCenterInsideOfficialLAU': geometries[index].covers(center),
            'officialLAUMatches': [{
                'name': official_features[j]['properties']['LAU_NAME'],
                'giscoID': official_features[j]['properties']['GISCO_ID'],
                'sourceAreaOverlapFraction': round(r, 8),
            } for r, j in scores[:3]],
        }
        if old['id'] != NEIGHBORHOOD_ID:
            code = official['GISCO_ID'].split('_', 1)[1]
            row = gazetteer[code]
            assert official['LAU_NAME'] == row['name']
            assert ratio > 0.85 and scores[1][0] < 0.10
            assert geometries[index].covers(center)
            name = row['name']
            parent = row['county'] + ' / ' + row['district']
            page = fetch(KSH_PAGE + code, code + '.html')
            html = page.read_bytes().decode('iso-8859-2')
            assert '<h1>' + name + '</h1>' in html
            evidence.update({
                'method': 'Unique dominant official LAU polygon overlap; identical KSH identifier and exact gazetteer spelling',
                'officialCode': code, 'kshSheet': 1, 'kshSheetRow': row['sheetRow'],
                'kshAreaHectares2025': row['areaHectares2025'],
                'sourcePolygonAreaHectares': round(pg.area / 10000, 4),
                'officialLAUOverlapFraction': round(ratio, 8),
                'officialName': row['name'],
            })
            urls = [KSH, KSH_PAGE + code, GISCO_CATALOG, GISCO]
            note = '名称经匈牙利中央统计局地名录核验；欧洲委员会官方 LAU 多边形匹配与 KSH 代码一致。保留原2017年边界。'
        else:
            assert official['LAU_NAME'] == 'Budapest' and ratio > 0.999
            fetch(DISTRICT_PDF, 'ujlipotvaros_2009.pdf')
            police_file = fetch(POLICE, 'ujlipotvaros-police.html')
            assert 'Újlipótvárosi Rendőrőrs' in police_file.read_text()
            map_file = fetch(POLICE_MAP, 'ujlipotvaros-police-map.kml')
            kml = ET.fromstring(map_file.read_bytes())
            n = {'k': 'http://www.opengis.net/kml/2.2'}
            label = kml.findtext('k:Document/k:name', '', n)
            coordinates = kml.findtext('.//k:Point/k:coordinates', '', n).strip().split(',')
            marker = [float(coordinates[0]), float(coordinates[1])]
            assert label == 'Újlipótvárosi Rendőrőrs' and g.covers(Point(marker))
            name, parent, code = 'Újlipótváros', 'Budapest / XIII. kerület', None
            evidence.update({
                'method': 'Budapest XIII district official neighborhood boundary description, corroborated by official police embedded map point inside source polygon',
                'currentNameSourceDate': '2009 district publication; official police page accessed 2026-10-27',
                'districtPublicationYear': 2009,
                'districtPublicationPDFPage': 2,
                'districtPublicationBoundaryDescription': 'Dráva utca a Duna folyamtól – Váci út – Nyugati tér – Szt. István körút – Duna folyam a Dráva utcáig.',
                'policeMapPoint': marker,
                'policeMapPointInsideSourcePolygon': True,
                'kind': 'neighborhood',
                'limitation': 'GISCO identifies Budapest at LAU level; official district boundary description and police marker corroborate the neighborhood name, without a claimed official neighborhood polygon overlay.',
            })
            urls = [DISTRICT_PDF, POLICE, POLICE_MAP, GISCO_CATALOG]
            note = '布达佩斯第十三区官方出版物与官方警察机关地图核验：Újlipótváros 是街区名称。该源面不是独立市镇，保持原ID与边界。'
        repairs[old['id']] = {
            'name': name, 'aliases': [name], 'parentName': parent,
            'status': 'verified', 'nameStatus': 'official-name-verified',
            'nameConfidence': 'high', 'nameSourceURLs': urls,
            'nameSource': 'KSH Helységnévtár; European Commission GISCO' if code else 'Budapest XIII district municipality; Hungarian Police',
            'officialCode': code,
            'expectedOriginalName': old['originalName'],
            'nameEvidence': evidence, 'nameNote': note,
        }
        audit.append({'id': old['id'], 'before': old['originalName'], 'after': name,
                      'evidenceURLs': urls, 'evidence': evidence})
    assert len(repairs) == 15
    metadata = {
        'schemaVersion': 1, 'repairCount': 15, 'verifiedCount': 15,
        'unresolvedCount': 0, 'sourceGeometryYearPreserved': '2017',
        'municipalityNameSnapshot': '2025-01-01',
        'spatialVerificationSnapshot': '2024',
        'method': '14 municipality polygon/name/code joins plus one official district neighborhood verification',
        'attribution': 'Központi Statisztikai Hivatal (KSH); European Commission Eurostat GISCO; Budapest Főváros XIII. Kerület; Magyar Rendőrség',
        'geometryReuse': 'Audit only. GISCO polygons are not redistributed in this public repair table and do not replace source geometries.',
        'sourceSHA256': {KSH: hashlib.sha256(ksh_file.read_bytes()).hexdigest(),
                         GISCO: hashlib.sha256(full_lau_file.read_bytes()).hexdigest()},
        'limitation': 'Current official name evidence does not change the source geometry date. Polygon comparisons span different scales and vintages; overlap fractions below 1 do not justify a boundary correction.',
    }
    (ROOT / 'public/data/hungary-name-repairs.json').write_text(
        json.dumps({'metadata': metadata, 'repairs': repairs}, ensure_ascii=False, indent=2) + '\n')
    (ROOT / 'outputs/hungary-name-audit.json').write_text(
        json.dumps({'metadata': metadata, 'features': audit}, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'repairCount': len(repairs), 'verifiedCount': len(repairs),
                      'allCentersInSourcePolygon': all(a['evidence']['sourceCenterInsideSourcePolygon'] for a in audit),
                      'allCentersInOfficialLAU': all(a['evidence']['sourceCenterInsideOfficialLAU'] for a in audit)}))


if __name__ == '__main__':
    main()
