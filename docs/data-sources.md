# 地图边界与地名来源

首次采集与核验日期：2026-10-22；全球地方层扩充日期：2026-10-25；本轮补充与区域着色复核日期：2026-10-26。数据文件随应用同源提供，地图无需向边界提供方发送旅行记录。

## 覆盖范围

| 文件 | 实载区域数 | 层级 | 源数据代表年份 | 未压缩大小 |
| --- | ---: | --- | --- | ---: |
| `public/data/world.geojson` | 242 | Natural Earth 国家及地区 | 源文件提交于 2022-05-13；没有统一的区划有效年份 | 2.36 MB |
| `public/data/chn.geojson` | 2,864 | geoBoundaries ADM3，县、县级市、市辖区等 | 2017 | 3.34 MB |
| `public/data/jpn.geojson` | 1,742 | geoBoundaries ADM2，市町村等地方区域 | 2017 | 3.00 MB |
| `public/data/usa.geojson` | 3,233 | geoBoundaries ADM2，县及县级等同区域 | 2018 | 3.76 MB |
| `public/data/global/fra-adm3.geojson` | 320 | Arrondissement，ADM3 | 2022 | 1.24 MB |
| `public/data/global/deu-adm3.geojson` | 428 | Independent City or District，ADM3 | 2021 | 1.15 MB |
| `public/data/global/ind-adm3.geojson` | 6,822 | Sub-District，ADM3 | 2018 | 4.61 MB |
| `public/data/global/bra-adm2.geojson` | 5,570 | Municipality，ADM2 | 2020 | 4.85 MB |
| `public/data/global/aus-adm2.geojson` | 547 | Local Government Areas，ADM2 | 2022 | 1.83 MB |

表中保留基础及首轮全球扩充示例。当前覆盖 **230个国家与地区、109,211个单元**。本轮为原37个缺口补入22个地区，升级6个已有地方层，并核实13个原ADM1地区已是基层市镇、教区或村。层级号不等同于行政粒度。

较粗细分4项：巴林4省、利比亚22个历史行政区、圣赫勒拿3个岛屿属地、法属南部和南极领地4个源载地区。另15个地区暂未接入独立地方边界；原因包括未核验到可再分发的地方面、单个市镇及不适用常规县市划分等，不能统一解释为不存在行政细分。逐项原因与来源保留在 `sources-supplements.json` 的58项audit。

`coverage.json` 是当前界面目录；`sources-global.json` 保留首轮gbOpen来源快照，`sources-supplements.json` 记录本轮变更、上游许可、来源hash及选层方法。旧文件保留在 `legacyUrls`，换源前记录的真实多边形可继续独立着色。

全球概览包含国家和属地等地理实体，242 不能解释为主权国家数量。世界层与地方源对属地归并和代码的口径不同，例如部分法国属地有独立的地方层，世界层却未单列；因此地方覆盖数与缺口数不应直接与242相加对照。源代码 `XKX` 与地图代码 `KOS` 的对应关系显式记录在缺口文件中。

各国行政体系不同，ADM 层级号不能直接等同于中国的县级。构建脚本优先选择适合旅行收藏的县、市镇、区等已发布单元，保留来源的实际名称；只能核验较粗细分时明确标注；一级已是市镇、教区或村级的地区按其真实含义分类。这些是有明确年份的历史可视化边界，不能表述为现行官方区划，也不能声称已覆盖全球所有县级区域。

中国、日本 API 元数据分别记载 2,867、1,745 个区域；提供方的 `simplifiedGeometryGeoJSON` 实际分别只有 2,864、1,742 个。应用保留下载文件的全部要素，未补画缺失边界。日本原始 `boundaryCanonical` 写为 `Subprefectures`，实际名称中包含 Sapporo、Shinjuku、Ine 等，粒度并不完全一致；其中 24 个要素的 `shapeName` 为空，显示“未命名区域”并附源 ID 尾部。美国数据包含来源收录的属地区域，常见同名县保留不同的稳定 ID。

## 一手发布来源与授权

### 全球底图

- 数据：[Natural Earth 官方仓库的 1:50m Admin 0 Countries](https://github.com/nvkelso/natural-earth-vector/blob/9380cca83db5f9aef52d5e762765100745f84b27/geojson/ne_50m_admin_0_countries.geojson)。固定提交 `9380cca83db5f9aef52d5e762765100745f84b27`，避免 `master` 更新影响复现。
- 发布说明：[Natural Earth 50m countries](https://www.naturalearthdata.com/downloads/50m-cultural-vectors/50m-admin-0-countries-2/)。该系列采用提供方的事实控制边界口径。
- 授权：[Natural Earth Terms of Use](https://www.naturalearthdata.com/about/terms-of-use/)，Public Domain。
- 中文显示名直接取该数据中的 `NAME_ZH`，英文原名、繁体名与国家代码作为搜索辅助信息保留。

### 地方边界

- [geoBoundaries 官方 API 文档](https://www.geoboundaries.org/api.html)说明了 ADM 层级、年份和下载字段。
- [中国 ADM3 元数据](https://www.geoboundaries.org/api/current/gbOpen/CHN/ADM3/)：原始来源 Lee Beryman、OpenStreetMap；原始许可 Open Data Commons Open Database License 1.0。
- [日本 ADM2 元数据](https://www.geoboundaries.org/api/current/gbOpen/JPN/ADM2/)：原始来源 OpenStreetMap、Wambacher；原始许可 Creative Commons Attribution-ShareAlike 2.0。
- [美国 ADM2 元数据](https://www.geoboundaries.org/api/current/gbOpen/USA/ADM2/)：原始来源 United States Census Bureau、MAF/TIGER Database；原始许可 Public Domain。
- geoBoundaries 发布层按 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 提供，[官方署名说明](https://www.geoboundaries.org/index.html)要求网页显著标出并链接 `geoBoundaries`。原始来源许可同时保留，不能把全部原始数据统一改称公共领域。
- 原始许可链接：[OpenStreetMap copyright / ODbL](https://www.openstreetmap.org/copyright)、[CC BY-SA 2.0](https://creativecommons.org/licenses/by-sa/2.0/)。下载文件中相应的改编边界应保留原始授权及署名。

推荐地图署名：**Natural Earth · geoBoundaries · © OpenStreetMap contributors · US Census Bureau**，分别链接发布方；数据说明保留上述各层许可。geoBoundaries 学术引用：Runfola, D. et al. (2020), *geoBoundaries: A global database of political administrative boundaries*, PLoS ONE 15(4), e0231866，[DOI](https://doi.org/10.1371/journal.pone.0231866)。

原有三国的 API 响应、固定下载 URL、构建日期与原始许可见 `public/data/sources.json`；新增 205 个国家与地区的完整来源目录、选层理由、原始下载 URL、校验和、实际要素数、简化参数及修复记录见 `public/data/sources-global.json`。目录来自 [geoBoundaries gbOpen 全层级 API](https://www.geoboundaries.org/api/current/gbOpen/ALL/ALL/)。本次地方源固定在 geoBoundaries 提交 `9469f09`；API 的源信息更新日期与构建日期均不能替代 `boundaryYearRepresented`。新增数据的逐项原始许可也需与文件一同保留，不以页面的简短署名代替完整来源清单。

## 中文地名与搜索

大部分地方源只带拉丁字母名称，且缺少行政代码与父级字段。应用原样保留这些名称，不根据拼音反推汉字。少量源文件本身含汉字的名称直接保留。

以下四个常用区域补充了可追溯中文名：

| 显示名 | 原名 | 名称依据 | 地理核验 |
| --- | --- | --- | --- |
| 海淀区 | Haidian District | [Wikidata Q393454](https://www.wikidata.org/wiki/Q393454) | 坐标 116.29214, 39.95812 位于对应源多边形内 |
| 浦东新区 | Pudong New District | [Wikidata Q125378](https://www.wikidata.org/wiki/Q125378) | 坐标 121.539722, 31.223056 位于对应源多边形内 |
| 西湖区（杭州市） | Xihu District | [Wikidata Q155441](https://www.wikidata.org/wiki/Q155441) | 坐标 120.12549, 30.2619 位于杭州对应多边形内，排除其他同名区域 |
| 大理市 | Dali City | [Wikidata Q855228](https://www.wikidata.org/wiki/Q855228) | 坐标 100.300278, 25.681111 位于对应源多边形内 |

该小型地名对照源自 Wikidata 的结构化事实数据（CC0），不是官方地名库；名称与所属城市及坐标共同匹配。早期四条样例仍在 `public/data/name-enrichment.json`。

2026-10-27 起，中国县级单元的显示名改由 `scripts/prepare-china-names.py` 生成，写入 `public/data/china-name-repairs.json`，并叠进 `name-quality.json`。匹配使用 Wikidata 的中国行政区划代码（P442）和坐标：坐标落在多边形内，或英文名唯一对应。显示层不改写已保存的旅行记录。没有对上的单元仍显示来源英文名。这不是民政部地名库，也不能据此声称区界已经全部更新。

2026-10-27 复核后，杭州现行13个区县市统一采用 Geofabrik 浙江 OpenStreetMap 快照（数据截至2026-10-25T21:21:21Z），各单位均用独立 OSM 关系 ID。2021年区划调整依据[杭州市人民政府公报](https://zfgb.hangzhou.gov.cn/18/106220253/t106220253064/528872.shtml)。原13个杭州 GB ID 和旧几何完整保留，供历史旅行记录着色，当前地图不再点选旧界。底图土地面重新从全部可见地方多边形求并集，县界与点亮层在每个缩放级别使用同一显示几何。旧界记忆会标明来源年份。OSM 采用 ODbL 1.0，© OpenStreetMap contributors。审计见 `public/data/hangzhou-boundary-patch.json`。其余中国地区主体仍为2017年数据，不能视为全球区划已更新到2026年。

地方数据按视野载入，最多并发 2 个请求、保留 6 个国家的地方图层，离开视野后按缓存次序释放。先搜索国家或在“全球覆盖”中点击“查看地方地图”，载入后可搜索其地方名称；已保存记录仍保留搜索入口。初次打开页面不会一次下载十万余个区域，也不把用户的旅行内容提交给边界数据源。

## 转换、稳定标识与精度

基础图层与全球扩充使用两条构建流程；均需 Python 3、Node.js 和 npm，全球流程还需要 Shapely 2.1.2。建议在项目根目录建立独立环境：

```sh
python3 -m venv outputs/geodata-venv
outputs/geodata-venv/bin/python -m pip install shapely==2.1.2
```

当前版本的常规恢复与验证：

```sh
npm test
npm run typecheck
npm run build
```

构建从已审计gzip恢复源文件并校验哈希，按当前目录生成检索索引，执行历史对象保留证明，再生成内容地址几何分片。不要把早期的 `prepare-geodata.py` 或 `prepare-global-geodata.py` 当作当前完整重建入口；它们仅用于隔离目录中的最初来源复现，会重写世界层及覆盖目录。

有意更新离线边界后，按下列顺序整合（需要Shapely环境及已核验的来源缓存）：

```sh
node scripts/prepare-boundary-transports.mjs public/data/current-central-china.json public/data/current-nordic.json
outputs/geodata-venv/bin/python scripts/apply-review-china-geometry.py
python3 scripts/apply-current-boundaries.py
outputs/geodata-venv/bin/python scripts/prepare-display-meshes.py --codes CHN FIN SWE NOR RUS
node scripts/build-region-index.mjs
npm test
```

`apply-current-boundaries.py`最后重放名称审查与来源修复，防止再生把撤销标签或法国派生旧区带回运行时。所有原始身份与几何必须保留；省级源整体升级后，重新运行中国撤销身份中性覆盖步骤。早期`--validate`脚本只审计其原批次，不能替代当前全套测试。

全球脚本默认复用 `public/data/sources-global.json` 中的目录快照，下载 URL 固定到源提交，并用固定的 `mapshaper@0.7.95` 处理几何；缓存目录可以复用下载与已通过校验的结果。只有主动传入 `--refresh-catalog` 才更新官方目录，此时属于数据升级，应重新检查边界年份、ID 兼容性、许可和覆盖差异。构建缓存保存在忽略目录 `outputs/`，不应随源码发布。

离线校验已提交的文件：

```sh
outputs/geodata-venv/bin/python scripts/prepare-geodata.py --validate
outputs/geodata-venv/bin/python scripts/prepare-global-geodata.py --validate
npm test
```

1. 世界层保留 Natural Earth 1:50m 几何，属性缩减为应用所需字段；ID 为 `NE-{NE_ID}`。
2. 地方层首先采用来源提供的简化 GeoJSON，再用固定的 `mapshaper@0.7.95` 建立共享拓扑并进行 weighted Visvalingam 简化，启用 `keep-shapes` 和默认交叉修复。中国、日本、美国分别保留 10%、45%、60% 的可简化顶点；新增各国根据来源大小选择比例，目标单文件不超过 5 MB，硬上限 10 MB。通常输出坐标精度为 0.00001 度。这保留所有源要素 ID，但部分细小岛屿或内环会因显示尺度简化而消失，不能用于测量或精确地块定位。
3. 地方 ID 为 `GB-{shapeID}`。名称重复不影响记录身份。GeoJSON 的 `feature.id` 与 `properties.id` 一致。
4. 坐标为 WGS84 经度、纬度。`center` 采用最大多边形的内部代表点；国家采用 Natural Earth 原始标签点。`bbox` 为完整几何的经纬度包络。跨日期变更线及多地块国家可能拥有很宽的包络，地图取景应优先采用 `center` 并限制缩放范围。
5. 图形采用原始来源形状及可复现的简化处理，没有用规则多边形、格网或猜测形状替代行政边界。
6. 新增全球层使用 Shapely `make_valid` 修复无效简化几何，并保留其中的多边形部分。若进一步简化导致小区域完全塌缩，则恢复该区域在下载源中的完整几何，逐项记入 `restoredSourceGeometryIDs`；本次印度 Longmai 的一个区域采用此处理。这类恢复保留源坐标精度，不强制舍入为 0.00001 度。原有三国文件及全部稳定 ID 保持不变。

## 已执行校验

`public/data/validation.json` 记录世界层与原有三国的文件数、字节数和 SHA-256；`public/data/validation-global.json` 记录当前全部230个地方文件的数量、字节数与 SHA-256。准备脚本校验全局 ID 唯一、GeoJSON 类型、数值有限、中心与包络结构，以及 coverage 数量与实际文件一致；基础流程另查线环闭合、面积非零和经纬度范围，全球流程检查全部地方几何有效且非空。转换前后的地方源 ID 集合完全相同。中文名称的坐标包含核验使用简化前的来源文件，避免因本项目进一步简化导致误匹配。

首次构建使用 Shapely 2.2.0 / GEOS `is_valid` 对世界层及原有三国的 8,081 个多边形要素进行了独立有效性检查，无效几何 0 个。首轮全球扩充由 Shapely 2.1.2 检查107,117个地方要素，本轮再检查当前109,211个地方要素，全部为有效、非空多边形；对应文件校验和保存在全球报告中。应用测试还检查所有覆盖文件可被记录接口接收、ID 不重复、原有常用区域的 ID 持续存在，以及加载并发、取消、重试和缓存淘汰行为。

这些校验验证文件结构与可复现转换；不代表已逐条审定历史区划完整性，也不解决源数据自身的遗漏或不同数据集的边界口径差异。


## 2026-10-26 补充来源与局限

| 来源 | 本轮主要用途 | 许可与局限 |
| --- | --- | --- |
| Natural Earth 1:10m Admin1，固定提交117488dc884bad03366ff727eca013e434615127 | HKG18、AIA15、BMU11、SHN3、SPM2、WLF3、TCA6、ATF4、MSR3及TTO15 | Public Domain；2022来源快照，概化几何。AIA部分无名；MSR为历史教区；ATF4为部分覆盖。TTO原源16面按官方辖区合并Tobago东/西面为15，补Arima。 |
| OSM、Geofabrik、Nominatim与OSM relation API | MDA982市镇/乡、MNE25市镇、JEY12教区、GGY12教区/岛屿、IMN24教区/镇、FRO29市镇、MAC8堂区/路氹、CYM6区、COK15岛屿/地方单元 | ODbL1.0，©OpenStreetMap contributors；2026下载快照。IMN包含历史教区；GGY/COK为源载混合地方层级，不能当作当前地方政府总数。 |
| OSM部分地方覆盖 | ARE375城区/社区、MUS164村委会区/市镇 | ARE有少量源重叠；MUS四组同级VCA重叠，保留原面并明确部分覆盖，不静默编造裁剪线。不能称官方375/164个县市全覆盖。 |
| geoBoundaries子集 | ALA16市镇、显示范围内CYN203区及SOL19区 | 保留原始许可；SUB-地区代码-GB源ID稳定别名避免与FIN/CYP/SOM重复。CYN/SOL按原面超过50%位于现有显示轮廓选取，保留完整原面，部分覆盖，不表示主权判断。 |
| 新喀里多尼亚政府 data.gouv.nc | 33个市镇陆地边界 | 明确Licence Ouverte v2.0；code_com稳定编号，nom_minus保留原名；数据集更新2024-12-06，下载快照2026-10-26。 |
| 法属波利尼西亚Cadastre-Topographie，经API Géo | 48个市镇 | 来源声明Creative Commons Attribution；下载快照与原始几何日期区分。 |
| SPC Statistics for Development / OCHA HDX | MHL152个地方细分面 | CC BY-IGO；HDX年份2021，SHP实际152、目录153并明示缺MH0609，部分覆盖。文件创建/修改时间另列，不视为统一区划有效日。 |
| VROMI / geoBoundaries gbHumanitarian | SXM8区 | CC BY3.0 IGO；原几何代表年份2018。 |

详细下载URL、许可原文、hash及筛选说明在 `public/data/sources-supplements.json`。排除许可未澄清的GADM来源，以及农场/产权面等不适合冒称行政县市的数据。

### 补充与着色资产重建

先重建基础与gbOpen层，再应用补充。缓存目录为忽略的 `outputs/boundary-supplements/`；所需文件、URL和原始hash见补充manifest。OSM抽取需PyOsmium，HDX SHP转换需pyshp；方法保留在 `scripts/source-research/`。动态latest/API源可能改变，hash不一致会停止，需重新审查后更新。部分缓存是按记录方法提取的子集，不能直接将PBF/ZIP下载内容冒作GeoJSON。

```sh
outputs/geodata-venv/bin/python scripts/prepare-boundary-supplements.py
# 仅重建当前及旧版地区的着色资产
outputs/geodata-venv/bin/python scripts/prepare-boundary-supplements.py --paint-only
# 当前全部地方面的离线检查
outputs/geodata-venv/bin/python scripts/prepare-global-geodata.py --validate
```

`public/data/paint/` 按国家分包，保留当前及旧图层ID。它使用真实多边形显示简化，最长容差0.01度并按小区域尺寸收紧；没有ADM0的5个法国海外地区使用本地面的真实union作为整体轮廓。运行时只保留当前筛选记录需要的形状，至多2个下载并发；放大加载详细边界后以详细源面替换对应形状。较粗历史面先画、较细面后画，国家级回忆先于地方级回忆。

着色图层独立于六国探索缓存，释放图层不会移除已保存颜色。它不进入D1或备份，不含私人文字、照片。`validation-paint.json` 记录数量/字节/hash，测试逐项要求当前及legacy地区ID存在；`validation-global.json` 检查全部地方面ID、国别/层级、有效非空Polygon/MultiPolygon及坐标结构。这些检查不等同于逐条行政区现状认证。

## 2026-10-26 白天模式及同源轮廓重绘

`geometry-alignment.json` 为230个已接入国家与地区分别记录地方面与合并陆地轮廓的同源配对、字节数和SHA-256。概览继续使用Natural Earth；放大并载入细地图后，隐藏该国概览填充及描边，使用地方多边形显示陆地、行政线及交互。已保存的地方填色优先采用详细面；详细国界轮廓也用于国家级回忆。离屏保存的形状独立保留，不随探索缓存淘汰。历史着色包继续保留旧版ID。

中国、日本和美国从固定geoBoundaries完整源重建共享拓扑，分别保留完整源12%的可简化顶点、15米和25米简化间隔，坐标精度0.000001度。顶点量约为旧显示文件的3.27、3.55、1.99倍；保持全部原ID，单个发布资产小于10MB。更细几何仍继承来源代表年份，不能理解为2026年现行区划。

香港18区来自[民政事务总署官方边界](https://www.had.gov.hk/psi/hong-kong-administrative-boundaries/hksar_18_district_boundary.json)，按原英文区名保留18个既有NE1 ID。官方辖区包含水域，使用[Geofabrik香港OSM快照](https://download.geofabrik.de/asia/china/hong-kong.html)中有向海岸线（陆地在左侧）构建陆地，并与辖区相交；避免把维多利亚港等水域整片填色。下载快照为2026年，官方原始几何日期未明示。须保留“香港特别行政区政府、民政事务总署、DATA.GOV.HK”署名，并遵守[DATA.GOV.HK条款](https://data.gov.hk/en/terms-and-conditions)及[OpenStreetMap ODbL及署名要求](https://www.openstreetmap.org/copyright)。逐源hash和许可在配对清单中。

中国旧地方源内10个香港及4个澳门重复单元仅隐藏显示与拾取，完整ID仍存在，并映射到相应现行显示面供旧回忆着色。相邻内地区域裁去重复覆盖，CHN与HKG陆地交叠面积验证为0。香港通过4个陆地点及2个海域点控制检查；全部230份陆地轮廓与其地方面合并结果的对称差面积小于1e-9平方度。其他地区源载水域、历史区划或重叠口径仍保留，无法据此宣称全球海岸线均达到同样精度。

重建命令（需Shapely、PyOsmium及固定mapshaper版本）：

```sh
outputs/geodata-venv/bin/python scripts/prepare-aligned-geodata.py
npm test
```

忽略目录`outputs/aligned-geodata-cache/`保留原始快照；首次获取后按manifest中的hash固定输入，动态源变化即停止，需另行审查再更新。原有基础、补充及着色脚本先执行，最后运行本脚本。客户端配对资产无需外部地图服务或运行时第三方请求。

部分覆盖地区另生成`fallbackUrl`：只保留概览陆地扣除已知地方面后的区域，避免阿联酋等来源未覆盖处变成海洋；该部分仍继承概览精度。`countryUrl`合并已知地方陆地与上述补底，用于国家级选择和回忆。拥有多个独立世界要素的国家，仅替换主世界要素，额外领地继续显示，避免澳大利亚Ashmore等未被地方源包含的小岛消失。fallback与country资产同样记录字节数及SHA-256。

## 2026-10-27 其他国家精度与法国市镇

`precision-countries.json`记录24国38,408个地方单元从固定完整源重建后的证据：GBR、DEU、ITA、ESP、PRT、NLD、CHE、AUT、GRC、SWE、NOR、FIN、IRL、CAN、AUS、NZL、KOR、THA、VNM、MYS、IDN、TUR、ZAF、BRA。全部原ID及属性（center/bbox除外）保留，顶点989,671→3,392,681。23国固定完整提交9469f09592ced973a3448cf66b6100b741b64c0d；葡萄牙按原目录使用90a1d5290ede3adc147c5a2351472fd000412e72。各国完整源SHA另与公开媒体ETag核对。维持来源的历史代表年份，不推断为当前区划。

`precision-france.json`保留法国ADM5固定来源、许可原文和实际35,010个源单元；显示本土与科西嘉34,881个，海外129个按原有GLP/GUF/MTQ/REU/MYT单独条目显示。原目录称ODC Attribution1.0，但许可来源指向Etalab Licence Ouverte；两项均保留，未擅自改写许可。来源混用市镇及municipal arrondissement，Paris20、Lyon9、Marseille16按原实际面显示。

法国旧320个ADM3回忆继续保留ID，并从 `/data/global/fra-adm3.geojson` 的原始2022年历史来源读取完整原几何。`precision-france-legacy.json` 的市镇交叠分配结果标为 `runtime:false`，只保留推导审计，运行时不再使用它着色。Lorient等旧区不再由2020年市镇轮廓合并替代。历史区界与不同年份的市镇界可能交叉，点击历史足迹优先返回其历史身份；记录的原年份、区名及ID保持不变。

挪威及澳大利亚的`fallbackUrl`恢复详细源未覆盖的原概览陆地，`countryUrl`合并详细陆地及补底；只在有明确替代的`replaceWorldIds`上隐藏粗图。澳大利亚三个world要素均有明确替代，Ashmore及外岛继续显示。其他既有partial配对沿用此前规则。

精度原始GeoJSON在工作区由`restore-precision-geometry.mjs`按SHA-256从Git中的gzip文件逐字节还原，避免超大单一Git对象；这些可还原工作副本不提交。`npm test`及`npm run build`自动执行还原与完整性检查。生产构建以`pack-geometry.mjs`对全部GeoJSON逐字节gzip，生成`geometry-assets.json`逻辑URL映射，并删除发布目录中的未压缩副本；来源说明JSON继续普通分发。读图先选择目录地址，检测gzip魔数以兼容自动Content-Encoding解码，展开流超过64MiB立即中止；失败保留可重试提示。数据不向外部服务发送私人回忆。原始ID、有效非空面、中心、bbox、同源union和压缩回解均有脚本及测试核验。

重建顺序：先执行既有基础/补充/同源脚本，再运行以下精度步骤，最后构建发布。原始下载缓存均在忽略目录outputs；动态文件不匹配固定hash时需人工审查新快照，不能冒充原源。

```sh
outputs/geodata-venv/bin/python scripts/prepare-precision-countries.py
outputs/geodata-venv/bin/python scripts/prepare-france-communes.py
outputs/geodata-venv/bin/python scripts/prepare-france-legacy-aligned.py
python3 scripts/merge-precision-manifests.py
npm test
npm run typecheck
npm run build
```

剩余区域级来源仍如实保留：BHR区块的可复用许可尚未澄清；LBY候选市镇源目前仅点数据；SHN区界来源标注受限；ATF官方为5个领地区且无普通市镇层，本项目来源只含4个，保持partial。没有把无许可数据、点位、自然岛屿或产权地块伪称完整县市行政边界。

## 2026-10-27 地名全量核验及第二批35国

`precision-remaining.json`再收录POL、HUN、ROU、SVK、CZE、BGR、HRV、SVN、CYP、LVA、ARG、CHL、COL、BOL、MEX、EGY、PRY、PHL、KEN、RUS、LKA、PAK、NPL、BGD、IRN、UKR、DZA、MNG、GTM、VEN、SLV、HND、ECU、IND、BEL，共44,044个原有地方单元。顶点1,358,551→4,395,670，逐国最低2.08倍。ROU/COL/PHL明确采用固定provider-simplified输入；IND/ECU完整导出各缺一个既有ID，使用校验hash的原提供方几何保留，分别记录两个快照及组合输入hash。没有降低层级或丢弃既有记录ID。35国有效性、内部中心、bbox、精确land union、gzip逐字节回解及hash全部通过，脚本`prepare-remaining-precision.py --validate`提供离线复核。

`japan-name-repairs.json`据国土交通省国土数値情報N03的2017及2025两版核验26项。东京湾面GB-22064153B42729341445185在两版均为「所属未定地」，对官方面覆盖比例约87.4%，不分配邻近市名；另一处GB-22064153B45156088025009为富士吉田市，对官方面约99.7%。其余缺名对应明确官方市町村。26个原锚点均在自身最大地块及相应官方区域内，未移位，也未用2025几何覆盖2017边界。使用CC BY4.0，保留国土交通省署名、加工说明、下载URL及归档SHA。

`hungary-name-repairs.json`核验15项。14个市镇按GISCO2024 LAU唯一主要面匹配，覆盖约89.4%—99.0%，再与KSH2025官方代码、地名精确连接。Újlipótváros为布达佩斯第十三区街区，通过官方区政府出版物第2页边界说明及警方嵌入地图点核验，不冒称独立市镇。GISCO几何仅用于审核，不再分发至客户端地图。原2017几何、ID和年份保持。

`name-quality.json`审计144,143个当前世界及地方源要素：共679个缺损、占位或编码损坏的源名称，修复41项有官方证据的名称及582项可逆编码损坏（合计623项）；剩余56项不猜名，在详情标明待核实并抑制地图文字。可逆转换要求严格Latin-1/Windows-1252→UTF-8、逐步往返一致，最多3层，保留原字符串和转换证据。Nan、Nan'an、Nan'ao等合法名称不会被误判。地图、搜索、记录列表、详情和足迹提示采用同一显示层；原GeoJSON字节及原已存回忆、备份不因显示修复而重写。10个点位在自身原多边形外，改取最大地块内部代表点；日志记录前后位置。地图点位校正不等同于真实海岸线测绘更新。

重建精度与地名时，在前述步骤后执行：

```sh
outputs/geodata-venv/bin/python scripts/prepare-remaining-precision.py
python3 scripts/merge-precision-manifests.py
node scripts/restore-precision-geometry.mjs
outputs/geodata-venv/bin/python scripts/audit-japanese-names.py
outputs/geodata-venv/bin/python scripts/audit-hungarian-names.py
outputs/geodata-venv/bin/python scripts/prepare-name-quality.py
npm test
npm run typecheck
```


### 2026-10-27 后续行政区与接边批次

当前英国361个LAD、挪威357个市镇和浙江90个县级区划覆盖旧批次；完整年份、海岸掩膜、许可、保留的历史范围及数值验收见本批复核。英国和挪威旧精细面作为 `legacyPaintUrl` 留存。浙江采用同快照真实海岸线裁海，行政含海原面另存溯源档。

`display-meshes.json` 取代旧paint作为现行概览来源。主图层哈希变化后，先离线重新生成相关显示面；构建会拒绝过期概览。边界和县级搜索索引在生产包中统一无损gzip传输。


### 2026-10-29江苏、上海与太平洋批次

`current-east-china.json` 作为最新中国主网格入口，继承浙江90单位并新增江苏95、上海16单位；前批资料及所有旧对象仍保留。`current-pacific.json` 新增ABS 2026 LGA和Stats NZ 2026 TA。许可、海岸版本、残余中性区、岛屿保护及指纹分片协议见本批验收。

## 2026-10-29 安徽、江西及芬兰

安徽104与江西100县市区逐项匹配2026-06-30官方名录，几何使用与江浙沪相同的2026-10-25 OSM快照，累计405个现行单位。芬兰按2026全国308市镇名录分为FIN本土292和独立ALA16，几何取自NLS现行WFS，物理海岸仍明确为2017。瑞典、挪威、俄罗斯仅在芬兰一侧生成23个有来源证据的接边副本，原始对象与历史身份不变；其他区域没有宣称最新。来源、跨国交叠及发布包去重证明见验收记录。

`legacyAliases` 为来源审计映射，运行时不据此迁移旅行记录或推断行政继承；实际保存区界按稳定ID在主来源和历史来源中读取。
