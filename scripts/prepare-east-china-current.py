#!/usr/bin/env python3
"""Pinned JS/SH current counties, physical coastline clipping, historical-preserving seams.
Run outputs/geodata-venv/bin/python scripts/prepare-east-china-current.py.
Requires osmium, shapely>=2.1, pyproj, xlrd. No geometry simplification.
"""
import copy, gzip, hashlib, html, importlib.util, json, math, pathlib, re, subprocess, urllib.request
import xml.etree.ElementTree as ET
import osmium, xlrd
from shapely import STRtree, coverage_is_valid, make_valid, union_all
from shapely.geometry import Polygon, MultiPolygon, LineString, Point, shape, mapping
from shapely.ops import unary_union, polygonize_full
ROOT=pathlib.Path(__file__).resolve().parents[1]
CACHE=ROOT/'outputs/east-china-cache'
OUT=ROOT/'public/data/precision'
BASELINE='481e965'
PBF_SHA256={'jiangsu':'e1a6be976f3dd62bfe9c3534422e27a389d5e6edc0af18cb90b60256f89de32c','shanghai':'a799174c6e0d7204203c94c1dcd948799f472d20a2b33e8373dde7c322e8b5b5'}
SNAPSHOT='2026-10-25T21:21:21Z'
VERIFIED='2026-10-27'
JS='https://mzt.jiangsu.gov.cn/art/2026/7/2/art_78635_11723214.html'
SH='https://mzj.sh.gov.cn/MZ_zhuzhan1539_0-2-8-1459/20260727/535996b5abd045baac0c65552f4527d9.html'
JSXLS='https://mzt.jiangsu.gov.cn/module/download/downfile.jsp?classid=0&filename=76ec7c4bda4a48ac9df378bff7abb145.xls'
def read(p):return json.loads(p.read_text())
def enc(v,pretty=False):return (json.dumps(v,ensure_ascii=False,allow_nan=False,indent=2 if pretty else None,separators=None if pretty else (',',':'))+'\n').encode()
def write(p,v,pretty=False):p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(enc(v,pretty))
def sha(x):return hashlib.sha256(x).hexdigest()
def base(p):return json.loads(subprocess.check_output(['git','show',f'{BASELINE}:{p}'],cwd=ROOT))
def fetch(url,p):
    if not p.exists():
        with urllib.request.urlopen(url,timeout=180) as r:p.write_bytes(r.read())
def polygonal(g,empty=False):
    if not g.is_valid:g=make_valid(g)
    def parts(x):return [x] if x.geom_type=='Polygon' else [p for s in getattr(x,'geoms',[]) for p in parts(s)]
    ps=parts(g)
    if not ps and empty:return MultiPolygon([])
    assert ps,('empty geometry',g.geom_type)
    out=ps[0] if len(ps)==1 else MultiPolygon(ps)
    assert out.is_valid
    return out
class Extract(osmium.SimpleHandler):
    def __init__(self):super().__init__();self.features=[];self.coasts=[];self.factory=osmium.geom.GeoJSONFactory()
    def area(self,a):
        tags=dict(a.tags)
        if a.from_way() or tags.get('boundary')!='administrative' or (tags.get('admin_level') not in ['4','5','6'] and tags.get('name') not in ['娄葑街道','斜塘街道','唯亭街道','胜浦街道','金鸡湖街道']):return
        self.features.append({'type':'Feature','id':a.orig_id(),'properties':{'tags':tags,'timestamp':str(a.timestamp)},'geometry':mapping(polygonal(shape(json.loads(self.factory.create_multipolygon(a)))))})
    def way(self,w):
        if w.tags.get('natural')=='coastline':self.coasts.append({'type':'Feature','id':w.id,'properties':{'timestamp':str(w.timestamp)},'geometry':mapping(LineString([(n.lon,n.lat) for n in w.nodes]))})
def extract(slug):
    p=CACHE/f'{slug}-261025.osm.pbf';fetch(f'https://download.geofabrik.de/asia/china/{slug}-261025.osm.pbf',p)
    assert sha(p.read_bytes())==PBF_SHA256[slug],('Pinned PBF checksum mismatch',slug)
    rd=osmium.io.Reader(str(p));stamp=rd.header().get('osmosis_replication_timestamp');rd.close();assert stamp==SNAPSHOT,(slug,stamp)
    dest=CACHE/f'{slug}-admin.geojson'
    if not dest.exists():
        h=Extract();h.apply_file(str(p),locations=True,idx='flex_mem');write(dest,{'type':'FeatureCollection','features':h.features});write(CACHE/f'{slug}-coastlines.geojson',{'type':'FeatureCollection','features':h.coasts})
    return read(dest)['features']
def rosters():
    fetch(JS,CACHE/'jiangsu-official-2026.html');fetch(JSXLS,CACHE/'jiangsu-official-2026.xls');fetch(SH,CACHE/'shanghai-official-2026.html')
    wb=xlrd.open_workbook(CACHE/'jiangsu-official-2026.xls');rows=[];parent=None;street_codes={}
    for s in wb.sheets():
        for i in range(s.nrows):
            vals=[str(int(c.value)) if c.ctype==2 else str(c.value).strip() for c in s.row(i)]
            if len(vals)>5 and vals[4] in ['娄葑街道','斜塘街道','唯亭街道','胜浦街道','金鸡湖街道']:street_codes[vals[4]]=vals[5]
            if len(vals)<4:continue
            if vals[2]:
                m=re.search(r'([\u4e00-\u9fff]+)\s+(32\d{4})',vals[2])
                if m:parent=m[1]
            m=re.search(r'([\u4e00-\u9fff]+)\s+(32\d{4})',vals[3])
            if m:rows.append({'code':m[2],'name':m[1],'parentName':parent,'provinceName':'江苏省','evidenceURL':JS})
    shrows=[]
    for tr in re.findall(r'<tr\b.*?</tr>',(CACHE/'shanghai-official-2026.html').read_text(),re.S|re.I):
        vals=[html.unescape(re.sub('<[^>]+>','',x)).strip() for x in re.findall(r'<td\b[^>]*>(.*?)</td>',tr,re.S|re.I)]
        if len(vals)>1 and re.fullmatch(r'31\d{4}',vals[1]) and vals[1]!='310000':shrows.append({'code':vals[1],'name':re.split(r'[（(]',vals[0])[0],'parentName':'上海市','provinceName':'上海市','evidenceURL':SH})
    assert street_codes=={'斜塘街道':'320505006','娄葑街道':'320505007','唯亭街道':'320506009','胜浦街道':'320506010','金鸡湖街道':'320506012'},street_codes
    assert len(rows)==95 and len(shrows)==16,(len(rows),len(shrows),rows[:5])
    write(CACHE/'official-rosters.json',{'jiangsu':rows,'shanghai':shrows,'industrialParkOfficialStreetCodes':street_codes},True)
    return rows,shrows

def coast_land(province,slug,lines,historical_land):
    """Exact directed natural=coastline partition. Administrative sea never land."""
    mask=CACHE/f'{slug}-land-mask.geojson';sea=CACHE/f'{slug}-sea-mask.geojson';meta=CACHE/f'{slug}-coast-audit.json'
    fingerprint=sha(enc({'province':mapping(province),'coastlines':[mapping(g) for g in lines]}))
    if mask.exists() and meta.exists() and read(meta).get('classifierVersion')==2 and read(meta).get('sourceGeometrySHA256')==fingerprint:return shape(read(mask)['geometry']),shape(read(sea)['geometry']),read(meta)
    # Node full source lines with the boundary before polygonizing. Clipping
    # first creates floating-point endpoint dangles where the coast crosses
    # provincial borders. Source-crop dangles outside this province are benign.
    cells,cuts,dangles,invalid=polygonize_full(union_all([province.boundary,*lines]))
    inside_dangles=[g for g in dangles.geoms if g.intersection(province).length>1e-10]
    inside_cuts=[g for g in cuts.geoms if g.intersection(province).length>1e-10]
    assert not inside_cuts and not inside_dangles and not invalid.geoms,(slug,len(inside_cuts),len(inside_dangles),len(invalid.geoms))
    kept=[g for g in cells.geoms if province.covers(g.representative_point())]
    tree=STRtree(kept);votes=[[0.,0.] for _ in kept]
    for line in lines:
        cs=list(line.coords)
        for a,b in zip(cs,cs[1:]):
            dx,dy=b[0]-a[0],b[1]-a[1];length=math.hypot(dx,dy)
            if not length:continue
            eps=min(1e-7,length/10)
            for side,sign in [(0,1),(1,-1)]:
                point=Point((a[0]+b[0])/2-sign*dy/length*eps,(a[1]+b[1])/2+sign*dx/length*eps)
                for i in tree.query(point,predicate='within'):votes[int(i)][side]+=length
    lids=[];sids=[];inland=[]
    fullcoast=unary_union(lines)
    for i,(left,right) in enumerate(votes):
        if left==0 and right==0:
            face=kept[i];point=face.representative_point();distance=face.distance(fullcoast)
            assert distance>1 and historical_land.covers(point),('Unclassified physical face',slug,i,distance)
            inland.append({'face':i,'areaDeg2':face.area,'point':[point.x,point.y],'distanceToCoastDeg':distance,'historicalSourceContainsPoint':True,'evidence':'Administrative inland exclave more than one degree from any pinned coastline, corroborated by original historical China land coverage. No maritime face uses this rule.'})
            lids.append(i);continue
        assert min(left,right)/max(left,right)<1e-4,('Contradictory coast votes',slug,i,left,right)
        (lids if left>right else sids).append(i)
    land=polygonal(unary_union([kept[i] for i in lids]));water=polygonal(unary_union([kept[i] for i in sids]))
    assert land.intersection(water).area<1e-12
    assert province.symmetric_difference(unary_union([land,water])).area<1e-12
    audit={'classifierVersion':2,'sourceGeometrySHA256':fingerprint,'inlandEnclaveEvidence':inland,'snapshotAt':SNAPSHOT,'coastWays':len(lines),'polygonizedFaces':len(kept),'landFaces':len(lids),'seaFaces':len(sids),'cutEdges':0,'danglingEdges':0,'invalidRings':0,'unknownFaces':0,'conflictingFaces':0,'excludedNonProvinceFaces':len(cells.geoms)-len(kept),'sourceCropDanglesOutsideProvince':len(dangles.geoms),'administrativeAreaDeg2':province.area,'physicalLandAreaDeg2':land.area,'verifiedSeaAreaDeg2':water.area,'rule':'Exact same-snapshot directed OSM natural=coastline ways plus province boundary polygonization; retain only province-contained faces. Land left / sea right. No shoreline interpolation or simplification.'}
    write(mask,{'type':'Feature','properties':audit,'geometry':mapping(land)});write(sea,{'type':'Feature','properties':{},'geometry':mapping(water)});write(meta,audit,True)
    return land,water,audit

def supplemental(rid):
    path=CACHE/f'relation-{rid}.osm'
    fetch(f'https://api.openstreetmap.org/api/0.6/relation/{rid}/full',path)
    latest=max(e.attrib.get('timestamp','') for e in ET.parse(path).getroot())
    assert latest<=SNAPSHOT,(rid,latest)
    dest=CACHE/f'relation-{rid}.geojson'
    if not dest.exists():
        h=Extract();h.apply_file(str(path),locations=True,idx='flex_mem');write(dest,{'type':'FeatureCollection','features':h.features})
    return next(f for f in read(dest)['features'] if f['id']==rid),latest

def pack(name,value):
    raw=enc(value);assert len(raw)<64*1024*1024,(name,len(raw))
    packed=gzip.compress(raw,compresslevel=9,mtime=0)
    (OUT/name).write_bytes(raw);(OUT/(name+'.gz')).write_bytes(packed)
    assert gzip.decompress(packed)==raw
    return {'url':'/data/precision/'+name,'gzipUrl':'/data/precision/'+name+'.gz','bytes':len(raw),'gzipBytes':len(packed),'sha256':sha(raw),'gzipSHA256':sha(packed),'requiresMultipartTransport':len(packed)>10_000_000}

def feature_center(g):
    p=max(g.geoms,key=lambda x:x.area) if g.geom_type=='MultiPolygon' else g
    q=p.representative_point();assert g.covers(q)
    return [q.x,q.y]

def main():
    CACHE.mkdir(parents=True,exist_ok=True);OUT.mkdir(parents=True,exist_ok=True)
    js,sh=rosters()
    fsjs=extract('jiangsu');fssh=extract('shanghai');supplemental_times={}
    for rid in [398353,398374]:
        f,t=supplemental(rid);supplemental_times[str(rid)]=t
        if rid not in {u['id'] for u in fssh}:fssh.append(f)
    bysource={f['id']:f for f in [*fsjs,*fssh]}
    jsprov=shape(bysource[913012]['geometry']);shprov=shape(bysource[913067]['geometry'])
    zjprov=shape(next(f for f in read(ROOT/'outputs/current-china-cache/zhejiang-province-extracted.geojson')['features'] if f['id']==553302)['geometry'])
    provincial=unary_union([jsprov,shprov,zjprov])
    data=json.loads(gzip.decompress(subprocess.check_output(['git','show',f'{BASELINE}:public/data/precision/chn-zhejiang-current.geojson.gz'],cwd=ROOT)))
    previous=base('public/data/current-zhejiang.json');alignment=copy.deepcopy(previous['alignment']);repairs=base('public/data/china-name-repairs.json')['repairs']
    original={f['id']:copy.deepcopy(f) for f in data['features']}
    original_geoms={fid:polygonal(shape(f['geometry'])) for fid,f in original.items()}
    historical_all=unary_union([g for fid,g in original_geoms.items() if fid.startswith('GB-')])
    coastfiles=[CACHE/'jiangsu-coastlines.geojson',CACHE/'shanghai-coastlines.geojson',ROOT/'outputs/current-china-cache/zhejiang-coastlines.geojson']
    byway={f['id']:f for p in coastfiles for f in read(p)['features']};lines=[shape(f['geometry']) for f in byway.values()]
    landmask,verifiedsea,coastaudit=coast_land(provincial,'east-combined',lines,historical_all)
    coastlines=unary_union(lines)
    zcurrent=[f for f in data['features'] if f['id'] in {r['id'] for r in previous['currentRegions']}]
    zrenderunion=unary_union([shape(f['geometry']) for f in zcurrent])
    zmaskdelta=zrenderunion.symmetric_difference(landmask.intersection(zjprov)).area
    assert zmaskdelta<1e-12,zmaskdelta
    rawsource=[];administrative=[];current=[];compositions=[]
    # Official roster has no county-level Industrial Park. Its five streets use
    # 320505/320506 county codes in the 2026 provincial government XLS. Compose
    # only those exact polygons; retain the unexplained park/street residual.
    street_ids={'虎丘区':[7363853,7363869],'吴中区':[7363875,7363883,7363893]}
    streetunion=unary_union([shape(bysource[i]['geometry']) for ids in street_ids.values() for i in ids])
    park=shape(bysource[7363894]['geometry']);park_residual=polygonal(park.difference(streetunion),empty=True)
    assert streetunion.difference(park).area<1e-12
    for slug,roster,features,province in [('jiangsu',js,fsjs,jsprov),('shanghai',sh,fssh,shprov)]:
        units=[f for f in features if f['properties']['tags']['admin_level']=='6' and f['properties']['tags'].get('name') in {r['name'] for r in roster}]
        assert len(units)==len(roster),(slug,len(units),len(roster))
        for record in roster:
            matches=[f for f in units if f['properties']['tags']['name']==record['name']]
            if len(matches)>1:
                pref=next(shape(f['geometry']) for f in features if f['properties']['tags'].get('name')==record['parentName'] and f['properties']['tags']['admin_level']=='5')
                matches=[f for f in matches if pref.covers(shape(f['geometry']).representative_point())]
            assert len(matches)==1,(record,matches)
            u=matches[0];rawsource.append(copy.deepcopy(u));tags=u['properties']['tags'];g=shape(u['geometry']);sid='OSM-CHN-relation-'+str(u['id'])
            component_ids=street_ids.get(record['name'],[]) if slug=='jiangsu' else []
            if component_ids:
                rawarea=g.area;g=polygonal(unary_union([g,*[shape(bysource[i]['geometry']) for i in component_ids]]))
                compositions.append({'id':sid,'name':record['name'],'code':record['code'],'sourceRelations':[u['id'],*component_ids],'officialEvidenceURL':JS,'originalAreaDeg2':rawarea,'composedAreaDeg2':g.area,'rule':'Exact union of original county management geometry and OSM street polygons assigned by 2026 official administrative codes. No inferred residual assignment.'})
            props={'id':sid,'name':record['name'],'originalName':tags.get('name:en',record['name']),'aliases':list(dict.fromkeys([record['name'],record['name'][:-1],record['parentName']+record['name'],tags.get('name:en',record['name'])])),'parentName':record['parentName'],'provinceName':record['provinceName'],'countryCode':'CHN','countryName':'中国','level':'local','adminLevel':'ADM3','adminCode':record['code'],'center':feature_center(g),'bbox':list(g.bounds),'year':'2026（OSM快照）','source':'© OpenStreetMap contributors · Geofabrik '+slug+'；'+SNAPSHOT,'sourceUrl':f'https://www.openstreetmap.org/relation/{u["id"]}','license':'ODbL 1.0','nameStatus':'verified','boundarySnapshot':SNAPSHOT,'officialNameCodeEvidenceURL':record['evidenceURL']}
            if component_ids:props.update({'sourceRelationIds':[u['id'],*component_ids],'administrativeComposition':'official-street-code-exact-union'})
            administrative.append({'type':'Feature','id':sid,'properties':copy.deepcopy(props),'geometry':mapping(g)})
            clipped=polygonal(g.intersection(landmask).intersection(province))
            props.update({'center':feature_center(clipped),'bbox':list(clipped.bounds),'coastlineSnapshotAt':SNAPSHOT,'source':props['source']+'；按同源OSM海岸线裁切陆域显示','geometryRole':'coastline-clipped-current-administrative-land'})
            current.append({'type':'Feature','id':sid,'properties':props,'geometry':mapping(clipped)})
    assert len(current)==111 and len({f['id'] for f in current})==111
    # Keep overlapping current OSM ownership claims in the provenance archive.
    # Rendering removes the exact intersection from both county click targets;
    # only source-supported enclosed inland residuals may appear as neutral land.
    source_conflicts=[];conflicts_by_id={};rawgs=[shape(f['geometry']) for f in current];rtree=STRtree(rawgs)
    for i,g in enumerate(rawgs):
        for j in rtree.query(g,predicate='intersects'):
            j=int(j)
            if j<=i:continue
            conflict=polygonal(g.intersection(rawgs[j]),empty=True)
            if conflict.area<=1e-12:continue
            source_conflicts.append({'a':current[i]['id'],'aName':current[i]['properties']['name'],'b':current[j]['id'],'bName':current[j]['properties']['name'],'areaDeg2':conflict.area,'rule':'Exact source intersection removed from both runtime ownership polygons; raw geometries archived. No winner selected.'})
            for n in [i,j]:conflicts_by_id.setdefault(n,[]).append(conflict)
    for i,conflicts in conflicts_by_id.items():
        g=polygonal(rawgs[i].difference(unary_union(conflicts)));current[i]['geometry']=mapping(g)
        current[i]['properties'].update({'center':feature_center(g),'bbox':list(g.bounds),'geometryRole':'coastline-clipped-current-administrative-land-source-conflicts-unassigned','geometryQualityNote':'源OSM相邻区县存在重叠，争议交叠片从双方点击面中扣除，保留原始行政几何归档；未推断县级归属。'})
    # The point in the mislabeled old Taixing polygon is explicitly verified by
    # a new official-name/code-matched OSM Yixing object. Old identity stays raw.
    point=Point(119.78,31.36);point_hits=[f for f in current if shape(f['geometry']).covers(point)]
    assert len(point_hits)==1 and point_hits[0]['properties']['adminCode']=='320282' and point_hits[0]['properties']['name']=='宜兴市'
    special_bad='GB-62558664B17826471634468'
    extra_huqiu='GB-62558664B76133789207928'
    huqiu=next(f for f in current if f['properties']['adminCode']=='320505')
    huqiu_old=original[extra_huqiu];huqiu_oldg=original_geoms[extra_huqiu];huqiu_newg=shape(huqiu['geometry'])
    assert huqiu_old['properties']['name']=='虎丘区' and huqiu_newg.covers(Point(*huqiu_old['properties']['center']))
    huqiu_old_match=huqiu_oldg.intersection(huqiu_newg).area/huqiu_oldg.area
    assert huqiu_old_match>.5,huqiu_old_match
    repairs[extra_huqiu]={'name':'虎丘区','parentName':'苏州市','status':'verified','aliases':['虎丘区'],'evidence':{'code':'320505','match':'exact Chinese name plus current official-code-matched OSM location and majority-area intersection (exact measured fraction in audit)'},'evidenceURLs':[JS,huqiu['properties']['sourceUrl']]}
    historical_ids={fid for fid in original if fid.startswith('GB-') and repairs.get(fid,{}).get('evidence',{}).get('code','').replace(' ','').startswith(('31','32'))}|{special_bad}
    historical=[original[fid] for fid in historical_ids]
    retired=copy.deepcopy(previous['retiredRegions']);suppressed=set(alignment['suppressedIds']);legacyaliases=alignment['legacyAliases']
    for fid in sorted(historical_ids):
        f=original[fid];repair=repairs.get(fid,{});verified=repair.get('status')=='verified';name=re.sub(r'（.*?）','',repair.get('name',f['properties']['name']))
        aliases=list(dict.fromkeys([name,f['properties'].get('originalName',name),*repair.get('aliases',[])]))
        note='保留2017年来源的完整历史多边形。现行地图使用2026-10-25 OSM江苏、上海陆域县界；名称代码与2026年官方名录核对。此标记表示几何版本更替，不表示该行政区已撤销。'
        if fid==special_bad:
            name='旧来源 Taixing City 记录（名称未核验）';aliases=['Taixing City'];note+='原来源误标：标签与所在位置不符，不把旧名称标为核验通过。坐标119.78,31.36现由官方名录匹配的宜兴市（320282）新OSM几何覆盖；旧记录不自动迁移为宜兴市。'
        retired[fid]={'name':name+'（2017年旧界）','aliases':aliases,'parentName':repair.get('parentName',''),'note':note,'evidenceURLs':list(dict.fromkeys([*repair.get('evidenceURLs',[]),JS,SH])),'lastValidYear':None,'retiredAt':VERIFIED,'sourceGeometryYear':'2017','retirementKind':'geometry-superseded','oldUnitNameVerified':verified,'status':'verified' if verified else 'unresolved','nameStatus':'verified' if verified else 'unresolved'}
        if fid==special_bad:retired[fid]['evidenceURLs']=[JS,point_hits[0]['properties']['sourceUrl']]
        suppressed.add(fid);legacyaliases[fid]=fid
    # Preserve every prior seam object. Rebuild surviving outside counties from
    # their original 2017 GB geometry against the complete updated 3-province
    # union, so the former ZJ seam copies cannot remain active in JS or SH.
    oldseams=[f for f in data['features'] if f['id'].startswith('SEAM-CHN-')]
    for f in oldseams:
        suppressed.add(f['id']);legacyaliases[f['id']]=f['id']
        old_seam_name=f['properties']['name'] if f['properties'].get('nameStatus')=='verified' else '旧来源接边记录（名称未核验）'
        retired[f['id']]={'name':old_seam_name+'（2026浙江接边旧副本）','aliases':f['properties'].get('aliases',[]),'parentName':f['properties'].get('parentName',''),'note':'保留上一版浙江接边显示副本。新显示使用当前江苏、上海县界，或根据三省统一边界重建外省接边副本；旧副本不自动迁移。','evidenceURLs':[JS,SH],'lastValidYear':None,'retiredAt':VERIFIED,'sourceGeometryYear':'2017','retirementKind':'cartographic-seam-superseded','oldUnitNameVerified':f['properties'].get('nameStatus')=='verified'}
    # Legacy GB originals behind surviving old seam copies must be reconsidered
    # even though the preceding manifest suppresses them. Fresh counties remain
    # suppressed; surviving outside counties receive a new 3-province seam copy.
    for f in oldseams:
        legacy=f['properties'].get('legacyGeometryId')
        if legacy and legacy not in historical_ids:suppressed.discard(legacy)
    seamfeatures=[];seamaudit=[]
    existing_currentids={f['id'] for f in zcurrent}
    for f in data['features']:
        fid=f['id']
        if fid in suppressed or fid in existing_currentids:continue
        g=original_geoms[fid];overlap=g.intersection(provincial).area
        if overlap<=1e-12:continue
        clipped=polygonal(g.difference(provincial),empty=True);suppressed.add(fid);legacyaliases[fid]=fid
        repair=repairs.get(fid,{});name=repair.get('name',f['properties']['name'])
        sid='SEAM-CHN-'+fid+'-EAST20261025'
        if not clipped.is_empty:
            seam=copy.deepcopy(f);seam.update({'id':sid,'geometry':mapping(clipped)})
            seam['properties'].update({'id':sid,'name':name,'aliases':list(dict.fromkeys([*repair.get('aliases',[]),*f['properties'].get('aliases',[]),name])),'parentName':repair.get('parentName',f['properties'].get('parentName','')),'center':feature_center(clipped),'bbox':list(clipped.bounds),'year':'2017区划；2026江浙沪接边','sourceGeometryYear':'2017','source':'geoBoundaries 2017；仅按2026-10-25 OSM江浙沪省界裁去重叠','legacyGeometryId':fid,'cartographicRepair':'subtract-verified-Jiangsu-Shanghai-Zhejiang-provinces','nameStatus':repair.get('status','unresolved')})
            seamfeatures.append(seam)
        retired[fid]={'name':name+'（2017年旧界）','aliases':list(dict.fromkeys([name,*repair.get('aliases',[])])),'parentName':repair.get('parentName',f['properties'].get('parentName','')),'note':'保留完整2017年原始几何。当前接边副本仅沿2026年OSM江苏、上海、浙江省界裁去重叠，其余外省县界未完成现行核验。','evidenceURLs':[*repair.get('evidenceURLs',[]),JS,SH],'lastValidYear':None,'retiredAt':VERIFIED,'sourceGeometryYear':'2017','retirementKind':'cartographic-seam-copy'}
        seamaudit.append({'legacyId':fid,'activeId':sid if not clipped.is_empty else None,'name':name,'beforeAreaDeg2':overlap,'afterAreaDeg2':clipped.intersection(provincial).area,'otherBoundaryChangesAreaDeg2':g.difference(clipped).symmetric_difference(g.intersection(provincial)).area})
    seam_by_legacy={f['properties']['legacyGeometryId']:f for f in seamfeatures};old_seam_preservation=[]
    for old in oldseams:
        legacy=old['properties']['legacyGeometryId'];expected=shape(old['geometry']).difference(provincial)
        if legacy in historical_ids:continue
        replacement=seam_by_legacy.get(legacy)
        if expected.area>1e-12:assert replacement is not None,legacy
        actual=shape(replacement['geometry']) if replacement else MultiPolygon([])
        delta=expected.symmetric_difference(actual).area
        assert delta<1e-12,(legacy,delta)
        old_seam_preservation.append({'oldSeamId':old['id'],'legacyId':legacy,'newSeamId':replacement['id'] if replacement else None,'outsideCurrentProvinceSymmetricDifferenceAreaDeg2':delta})
    data['features'].extend([*current,*seamfeatures]);by={f['id']:f for f in data['features']}
    assert len(by)==len(data['features'])
    for fid,f in original.items():assert by[fid]==f,fid
    activefeatures=[f for f in data['features'] if f['id'] not in suppressed];activegeoms=[polygonal(shape(f['geometry'])) for f in activefeatures]
    activeunion=unary_union(activegeoms)
    currentall=[*zcurrent,*current];cg=[shape(f['geometry']) for f in currentall];currentunion=unary_union(cg)
    tree=STRtree(cg);pairs=[]
    for i,g in enumerate(cg):
        for j in tree.query(g,predicate='intersects'):
            j=int(j)
            if j>i and (area:=g.intersection(cg[j]).area)>1e-12:pairs.append({'a':currentall[i]['id'],'b':currentall[j]['id'],'areaDeg2':area})
    assert not pairs,pairs
    assert currentunion.intersection(verifiedsea).area<1e-12
    assert activeunion.intersection(verifiedsea).area<1e-12
    # Only closed inland components of the historical source footprint can be
    # neutral fallback. Exclude verified sea and whole near-coast components.
    relevant_old=[original_geoms[fid] for fid in sorted(historical_ids|{r for r in previous['retiredRegions'] if r.startswith('GB-') and repairs.get(r,{}).get('evidence',{}).get('code','').replace(' ','').startswith('33')})]
    historical_footprint=unary_union(relevant_old)
    missing=historical_footprint.difference(activeunion)
    polys=list(activeunion.geoms) if activeunion.geom_type=='MultiPolygon' else [activeunion]
    holes=unary_union([Polygon(r) for p in polys for r in p.interiors])
    candidate=polygonal(missing.intersection(holes).difference(verifiedsea),empty=True)
    cps=list(candidate.geoms) if candidate.geom_type=='MultiPolygon' else [candidate]
    safe=[g for g in cps if not g.is_empty and g.distance(coastlines)>.01]
    fallback=polygonal(unary_union(safe),empty=True)
    assert fallback.intersection(activeunion).area<1e-12 and fallback.intersection(verifiedsea).area<1e-12
    countryunion=unary_union([activeunion,fallback])
    def outer_shell(g):
        ps=list(g.geoms) if g.geom_type=='MultiPolygon' else[g]
        return unary_union([Polygon(p.exterior) for p in ps])
    outerdelta=outer_shell(activeunion).symmetric_difference(outer_shell(countryunion)).area;assert outerdelta<1e-12
    assets={}
    assets['local']=pack('chn-east-current.geojson',data)
    for kind,g,role in [('land',activeunion,'exact-active-administrative-union'),('fallback',fallback,'neutral-historical-source-coverage'),('country',countryunion,'active-administrative-union-plus-neutral-inland-seams')]:
        assets[kind]=pack(f'chn-east-current-{kind}.geojson',{'type':'FeatureCollection','features':[{'type':'Feature','id':'CHN-'+kind,'properties':{'countryCode':'CHN','name':'中国' if kind!='fallback' else '旧来源封闭内陆残余（未分配现行区县）','role':role,**({'pickable':False,'sourceGeometryYear':'2017'} if kind=='fallback' else {})},'geometry':mapping(g)}]})
    adminasset=pack('chn-east-current-administrative.geojson',{'type':'FeatureCollection','features':administrative})
    rawsource.extend(copy.deepcopy(bysource[i]) for i in [7363894,7363853,7363869,7363875,7363883,7363893])
    sourceasset=pack('chn-east-current-source-administrative.geojson',{'type':'FeatureCollection','features':rawsource})
    for kind,a in assets.items():
        for suf,key in [('Url','url'),('GzipUrl','gzipUrl'),('Bytes','bytes'),('GzipBytes','gzipBytes')]:alignment[kind+suf]=a[key]
        alignment['sha256'][kind]=a['sha256']
    fixture_specs=[('Yixing',(119.78,31.36),True),('Nanjing',(118.8,32.05),True),('Suzhou',(120.6,31.3),True),('Shanghai',(121.47,31.23),True),('Chongming',(121.4,31.65),True),('Qidong',(121.66,31.81),True),('YellowSea',(121.1,33.0),False),('JiangsuOffshore',(120.1,34.9),False),('ShanghaiOffshore',(122.1,31.2),False),('HangzhouBay',(121.,30.42),False),('ZhejiangDonghai',(122.,28.5),False)]
    fixtures=[]
    for label,xy,expected in fixture_specs:
        point=Point(*xy);actual=landmask.covers(point)
        assert actual==expected,(label,xy,actual)
        assert expected or verifiedsea.covers(point),(label,'outside verified sea')
        fixtures.append({'name':label,'coordinates':list(xy),'expectedLand':expected,'landMaskCovers':actual,'activeCountyCovers':activeunion.covers(point)})
    provinceaudits={}
    for slug,province,code in [('jiangsu',jsprov,'32'),('shanghai',shprov,'31')]:
        af=[f for f in administrative if f['properties']['adminCode'].startswith(code)];rf=[f for f in current if f['properties']['adminCode'].startswith(code)];au=unary_union([shape(f['geometry']) for f in af]);ru=unary_union([shape(f['geometry']) for f in rf]);physical=landmask.intersection(province);gap=physical.difference(ru)
        provinceaudits[slug]={'officialCountyCount':len(af),'officialRosterExactMatch':{f['properties']['adminCode']:f['properties']['name']for f in current}=={r['code']:r['name']for r in [*js,*sh]},'rawAdministrativeGapAreaDeg2':province.difference(au).area,'rawAdministrativeOutsideProvinceAreaDeg2':au.difference(province).area,'physicalLandGapBeforeNeutralAreaDeg2':gap.area,'physicalLandGapAfterNeutralAreaDeg2':physical.difference(countryunion).area,'countyOverlapAreaDeg2':max(0,sum(shape(f['geometry']).area for f in rf)-ru.area),'currentCountyInVerifiedSeaAreaDeg2':ru.intersection(verifiedsea).area,'unassignedPhysicalLandCoveredByNeutralAreaDeg2':gap.intersection(fallback).area}
    audit={'baselineStoredCount':len(original),'baselineActiveCount':previous['alignment']['renderCount'],'currentJiangsuCount':95,'currentShanghaiCount':16,'preservedZhejiangCount':90,'newCountyCount':111,'historicalJiangsuShanghaiCount':len(historical_ids),'oldSeamArchiveCount':len(oldseams),'newSeamCount':len(seamfeatures),'oldOutsideSeamPreservation':old_seam_preservation,'storedCount':len(data['features']),'activeCount':len(activefeatures),'suppressedCount':len(suppressed),'pbfHeaderTimestamp':SNAPSHOT,'supplementalObjectsLastEditedAt':supplemental_times,'officialRosterExactMatch':{f['properties']['adminCode']:f['properties']['name']for f in current}=={r['code']:r['name']for r in [*js,*sh]},'sourceCountyCompositions':compositions,'sourceCountyOverlapConflicts':source_conflicts,'industrialParkUnassignedSourceResidualAreaDeg2':park_residual.area,'allOriginalObjectsRetainedUnchanged':True,'allZhejiangRenderObjectsRetainedUnchanged':all(by[f['id']]==f for f in zcurrent),'zhejiangMaskVsPreviousRenderAreaDeg2':zmaskdelta,'exactEdgeMatchingCurrentCoverageValid':bool(coverage_is_valid(cg)),'positiveOverlapPairs':pairs,'pairwiseOverlapToleranceDeg2':1e-12,'currentUnionInVerifiedSeaAreaDeg2':currentunion.intersection(verifiedsea).area,'allActiveChinaInVerifiedSeaAreaDeg2':activeunion.intersection(verifiedsea).area,'coastlineFixtureChecks':fixtures,'provinces':provinceaudits,'seamRepairs':seamaudit,'seamOverlapBeforeAreaDeg2':sum(a['beforeAreaDeg2'] for a in seamaudit),'seamOverlapAfterAreaDeg2':sum(a['afterAreaDeg2'] for a in seamaudit),'neutralEnclosedInlandFallbackAreaDeg2':fallback.area,'fallbackInVerifiedSeaAreaDeg2':fallback.intersection(verifiedsea).area,'countryOuterShellVsActiveOuterShellAreaDeg2':outerdelta,'everyActiveFeatureCenterInside':all(g.covers(Point(*f['properties']['center'])) for f,g in zip(activefeatures,activegeoms)),'additionalHistoricalIdentityChecks':{'huqiuLegacyId':extra_huqiu,'officialCode':'320505','exactChineseNameMatches':True,'oldCenterInsideCurrentGeometry':True,'oldGeometryInsideCurrentFraction':huqiu_old_match,'evidenceURLs':[JS,huqiu['properties']['sourceUrl']]},'falseTaixingFixture':{'legacyId':special_bad,'legacyNameVerified':False,'coordinates':[119.78,31.36],'currentId':point_hits[0]['id'],'currentName':'宜兴市','officialCode':'320282','officialEvidenceURL':JS}}
    assert audit['everyActiveFeatureCenterInside']
    alignment.update({'count':len(data['features']),'renderCount':len(activefeatures),'suppressedIds':sorted(suppressed),'legacyAliases':legacyaliases,'replaceWorldIds':[f['id']for f in read(ROOT/'public/data/world.geojson')['features']if f['properties']['countryCode']=='CHN'],'source':'geoBoundaries gbOpen (2017, outside Jiangsu/Shanghai/Zhejiang) · © OpenStreetMap contributors (江浙沪 2026)','sourceUrl':'https://download.geofabrik.de/asia/china/','sourceYear':'混合版本：江苏、上海、浙江2026-10-25；其余主体2017','sourceSHA256':sha((CACHE/'jiangsu-261025.osm.pbf').read_bytes()),'snapshotAt':SNAPSHOT,'verifiedAt':VERIFIED,'license':'Open Data Commons Open Database License 1.0','preparation':'Pinned 481e965 baseline. All original GB, Zhejiang OSM and previous seam objects retained byte-equivalent in the parsed feature superset. New JS95 and SH16 counties use stable OSM relation IDs; official 2026 name/code rosters. Two Suzhou county management geometries compose exact street polygons using official street codes. No inferred ownership for residuals. Exact directed same-snapshot physical coastline clipping; administrative sea never rendered as land. Outside old counties receive separate stable seam copies subtracting the 3-province raw union. Neutral fallback only historical-source enclosed inland residuals; exclude verified sea and whole components within .01 degree of physical coastline. No independent polygon simplification, buffering or artificial coast.','checks':audit,'coastlineEvidence':coastaudit})
    currentregions=[{**r,'id':next(f['id'] for f in current if f['properties']['adminCode']==r['code'])} for r in [*js,*sh]]
    sources=[]
    sourceurls={'jiangsu-261025.osm.pbf':'https://download.geofabrik.de/asia/china/jiangsu-261025.osm.pbf','shanghai-261025.osm.pbf':'https://download.geofabrik.de/asia/china/shanghai-261025.osm.pbf','jiangsu-official-2026.html':JS,'jiangsu-official-2026.xls':JSXLS,'shanghai-official-2026.html':SH}
    for name,url in sourceurls.items():
        p=CACHE/name;sources.append({'file':str(p.relative_to(ROOT)),'url':url,'bytes':p.stat().st_size,'sha256':sha(p.read_bytes())})
    limits=['江苏95县、上海16区名称代码与2026年官方名录逐项匹配；边界来自2026年OSM快照，官方名录未提供这些测绘多边形。','浙江90县ID、属性、渲染几何全部保留；其他省份主体仍为2017年来源，未声称全国现行核验完成。','苏州工业园区五个街道按官方代码分别归入虎丘、吴中两县级对象；源街道几何未覆盖的园区小片不推断行政归属，符合旧来源封闭内陆覆盖条件的部分使用灰色中性面。','京口、润州源OSM区界存在约0.0000101775平方度的交叠；交叠片从双方渲染点击面中扣除，原始源几何另作归档。满足旧来源封闭内陆条件的片段使用灰色中性面，未选择归属。','宝山、静安完整OSM关系包含OSM上海省界以外的地块。显示几何按同快照OSM省界裁切，不把这些源关系的省界外地块直接当作上海县界，原始关系另作归档。','江苏邳州市OSM县界有约0.0000015834平方度超出同源省界的微小面，渲染按省界和物理陆域裁切；完整原始几何保留在来源归档。','新旧来源接边副本仅裁去已更新省份，不声称相邻外省县界已按现行官方核验。','原始行政面含海域，仅作为来源归档。显示面使用同快照自然海岸线；旧全国来源在更新三省范围以外仍保留原始精度。']
    manifest={'version':1,'baselineCommit':BASELINE,'snapshotAt':SNAPSHOT,'verifiedAt':VERIFIED,'alignment':alignment,'retiredRegions':retired,'currentAdministrative':{**adminasset,'count':111,'runtime':False,'geometryRole':'uncropped-administrative-provenance-with-official-street-compositions'},'currentSourceAdministrative':{**sourceasset,'count':len(rawsource),'runtime':False,'geometryRole':'original-OSM-county-management-park-and-street-relations'},'coastlineEvidence':coastaudit,'suggestedFallback':{**assets['fallback'],'areaDeg2':fallback.area,'ownership':None,'purpose':'Neutral closed inland historical source residual only; no county pick target'},'seamRegions':[{'id':f['id'],'legacyId':f['properties']['legacyGeometryId'],'name':f['properties']['name'],'nameStatus':f['properties']['nameStatus'],'parentName':f['properties']['parentName']} for f in seamfeatures],'coveragePatch':{'count':len(data['features']),'source':alignment['source'],'sourceYear':alignment['sourceYear'],'coverageNote':'浙江90县、江苏95县和上海16区采用2026-10-25 OSM快照，名称代码按官方名录核对；显示面统一按同快照物理海岸线裁切。原始旧几何及前版接边副本完整保留为历史对象。相邻其他省份仅作新旧源接边裁切，未逐一核验现行县界。封闭内陆的旧来源残余以灰色中性面显示，不推断县级归属。其余全国主体仍为2017年来源。','license':alignment['license'],'sourceUrl':alignment['sourceUrl']},'evidenceURLs':[JS,SH,'https://www.jiangsu.gov.cn/col/col88749/index.html','https://www.sipac.gov.cn/szgyyq/xzqh/parkProfile.shtml','https://download.geofabrik.de/asia/china/jiangsu.html','https://download.geofabrik.de/asia/china/shanghai.html','https://www.openstreetmap.org/copyright'],'licensing':{'geometry':'© OpenStreetMap contributors, ODbL 1.0','licenseUrl':'https://opendatacommons.org/licenses/odbl/1-0/','officialNamesCodes':'Administrative facts from official provincial civil-affairs roster. Those pages do not supply these polygons.'},'officialRoster':[*js,*sh],'currentRegions':currentregions,'currentRegionsByProvince':{'江苏省':[r for r in currentregions if r['code'].startswith('32')],'上海市':[r for r in currentregions if r['code'].startswith('31')],'浙江省':previous['currentRegions']},'sourceCache':sources,'audit':audit,'limitations':limits,'assetTransport':{k:{'gzipBytes':v['gzipBytes'],'requiresMultipartTransport':v['requiresMultipartTransport']} for k,v in assets.items()}}
    write(ROOT/'public/data/current-east-china.json',manifest,True);write(ROOT/'outputs/east-china-current-audit.json',manifest,True)
    write(ROOT/'outputs/east-china-unassigned-park-residual.geojson',{'type':'Feature','properties':{'name':'Source park minus official-code street union; unassigned county ownership'},'geometry':mapping(park_residual)})
    print(json.dumps({'assets':assets,'audit':audit},ensure_ascii=False,indent=2),flush=True)

if __name__=='__main__':main()
