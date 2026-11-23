#!/usr/bin/env python3
"""Chinese names for each country's local unit type, shown above a place's name.

geoBoundaries describes each country's units in English or the local language
("Raion", "Gminas", "Si, Kun (districts and city districts)"). This replaces those
labels in public/data/coverage.json with Chinese terms: the usual Chinese
rendering where there is one, with the local term in brackets where the unit is
particular to that country. The source wording stays in each record's
`canonical` field. Labels already in Chinese are left alone.

Run python3 scripts/translate-unit-labels.py after any step that rewrites
coverage.json (prepare-global-geodata, apply-current-boundaries, the name audits).
"""
import json, pathlib, re

ROOT = pathlib.Path(__file__).resolve().parents[1]
COVERAGE = ROOT / 'public/data/coverage.json'
LABELS = {
    'AFG': '县（wuleswali）', 'AGO': '市镇（comuna）', 'ARG': '部（departamento）', 'ARM': '市镇共同体', 'ASM': '县',
    'BEN': '市镇', 'BGD': '分区（upazila）', 'BGR': '市镇', 'BHS': '区', 'BLR': '区', 'BLZ': '选区', 'BRA': '市（município）',
    'BRN': '穆金（乡）', 'BTN': '格窝（乡）', 'CAF': '市镇', 'CHE': '市镇（Gemeinde）', 'CHL': '市镇（comuna）',
    'CIV': '省（département）', 'COD': '地域／城市', 'COM': '市镇', 'CPV': '堂区（freguesia）', 'CRI': '县（cantón）',
    'DEU': '县级市／县', 'DJI': '区', 'DNK': '市镇（kommune）', 'DOM': '市', 'DZA': '市镇', 'ECU': '县（cantón）',
    'EGY': '县与区（markaz／qism）', 'ERI': '分区', 'ESP': '市镇（municipio）', 'FJI': '省', 'FSM': '市镇',
    'GAB': '省（département）', 'GEO': '市镇', 'GHA': '区', 'GIN': '省（préfecture）', 'GLP': '市镇', 'GMB': '区',
    'GRC': '市镇', 'GTM': '市镇（municipio）', 'GUF': '区（arrondissement）', 'GUM': '村', 'GUY': '社区议会区',
    'HND': '市镇', 'HRV': '市镇', 'HTI': '市镇', 'IDN': '县／市', 'IND': '副县（tehsil／taluka）', 'IRL': '地方选区',
    'IRN': '县（shahrestan）', 'IRQ': '县（qadha）', 'ISL': '市镇', 'ISR': '分区', 'JAM': '社区', 'JOR': '乡（nahia）',
    'KAZ': '区', 'KEN': '副郡', 'KGZ': '区', 'KOR': '市／郡／区', 'KOS': '市镇', 'KWT': '地区', 'LAO': '县',
    'LBN': '县（qada）', 'LBR': '区', 'LCA': '社区', 'LKA': '分区秘书处辖区', 'LSO': '选区', 'LVA': '市与乡（pilsēta／pagasts）',
    'MDG': '区', 'MDV': '行政环礁', 'MEX': '市镇（municipio）', 'MKD': '市镇（opština）', 'MLI': '市镇', 'MMR': '镇区',
    'MNG': '苏木／区', 'MNP': '市镇', 'MOZ': '县', 'MRT': '县（moughataa）', 'MTQ': '区（arrondissement）', 'MWI': '区',
    'MYS': '县', 'MYT': '市镇', 'NER': '市镇', 'NGA': '地方政府区（LGA）', 'NLD': '市镇（gemeente）',
    'NPL': '市与乡村市', 'OMN': '州（wilayah）', 'PAK': '县（tehsil）', 'PER': '省', 'PHL': '市与自治市',
    'PLW': '村落', 'PNG': '区', 'POL': '乡（gmina）', 'PRI': '市镇', 'PRK': '郡／市／特级市', 'PSE': '省',
    'REU': '区（arrondissement）', 'ROU': '市镇', 'RUS': '区', 'SAU': '省辖区（muhafazah）', 'SDN': '区',
    'SEN': '省（département）', 'SGP': '区', 'SLB': '选区', 'SLE': '区', 'SLV': '市镇', 'SOM': '区', 'SSD': '郡',
    'STP': '县', 'SUR': '区（ressort）', 'SWE': '市镇（kommun）', 'SYC': '区', 'SYR': '地区（mintaqah）',
    'TCD': '省（département）', 'TGO': '省（préfecture）', 'THA': '县（amphoe）', 'TLS': '行政站', 'TON': '区',
    'TUR': '县（ilçe）', 'TUV': '村', 'TZA': '县', 'UGA': '区', 'UKR': '区', 'URY': '市镇', 'UZB': '区（tuman）',
    'VEN': '市镇（municipio）', 'VIR': '分区', 'VNM': '县／郡', 'VUT': '市镇', 'WSM': '区', 'YEM': '县', 'ZAF': '地方自治市',
    'ZMB': '区', 'ZWE': '区',
}
HAN = re.compile(r'[一-鿿]')

def main():
    coverage = json.loads(COVERAGE.read_text())
    changed, left = 0, []
    for record in coverage:
        label = record.get('label') or ''
        if HAN.search(label): continue
        if record['code'] in LABELS:
            record.setdefault('canonical', label)
            record['label'] = LABELS[record['code']]; changed += 1
        else:
            left.append((record['code'], label))
    COVERAGE.write_text(json.dumps(coverage, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(f'translated {changed} unit labels; still not Chinese: {left}')
    assert not left, 'add a Chinese label for every country above'

if __name__ == '__main__': main()
