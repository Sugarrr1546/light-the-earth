'use client';

import { useEffect, useRef, useState } from 'react';
import type { ExpressionSpecification, GeoJSONSource, Map as LibreMap, MapGeoJSONFeature, StyleSpecification } from 'maplibre-gl';
import type { FeatureCollection, Geometry, Point, Polygon, MultiPolygon, Feature } from 'geojson';
import type { Coverage, MapController, Region, Visit, VisitStatus } from '@/lib/model';
import { createBoundaryLoader, prioritizeCountries } from '@/lib/boundary-loading';
import { primaryCountryBounds } from '@/lib/country-navigation';
import {presentRegion,canLabelRegion,type NameQualityCatalog} from '@/lib/region-presentation';
import {atlasResources} from '@/lib/atlas-resources';
import { createVisitedAreaLoader } from '@/lib/visited-areas';
import {syncSavedAreaVisibility} from '@/lib/saved-area-visibility';
import {chooseMapFeature,replacedWorldIds,polygonContainsPoint,replaceResidentCountyShapes,pointerOnSurface} from '@/lib/map-interaction';
import {createGeometryPartitionReader,type GeometryPartitionCatalog} from '@/lib/geometry-partitions';
import {fetchBoundaryBytes,readBoundaryAsset,mergeAreaAssets,type BoundaryAssetCatalog} from '@/lib/boundary-assets';
import {countyFeatures,detailedCountyFeatures,isRegionIndex,regionsFromIndex} from '@/lib/county-layer';
import type {ResolvedAppearance} from '@/lib/appearance';
import {countryFillColor,footprintCountries,mapPalette,themedMapPaint} from '@/lib/map-appearance';
import {desktopBridge} from '@/lib/runtime';
import {advanceStarfield,claimPulses,drawerRevealShift,localFocusZoom,mapPadding,overviewDiameter} from '@/lib/map-view-controls';
import {X} from 'lucide-react';
import {createGeometryDiskCache} from '@/lib/geometry-disk-cache';
import {countyRenderPolicy,countySourceSpecification,countyViewKey,countyRenderView,sameCountyView,type CountyRenderPolicy} from '@/lib/county-render-policy';
import {createCountySourceUpdates,usesCountySourceUpdates} from '@/lib/county-source-updates';
import {createGeometryRenderData,countryLandSource} from '@/lib/geometry-render-data';
import {createGeometryPreloader} from '@/lib/geometry-preload';

interface EarthMapProps {
  theme: ResolvedAppearance;
  sidebarVisible: boolean;
  showHints: boolean;
  timelineVisible: boolean;
  onHideHints:()=>void;
  onAttributionHeight:(height:number)=>void;
  visits: Visit[];
  selectedRegion: Region | null;
  mode: 'browse' | 'light';
  projection: 'globe' | 'mercator';
  onRegionClick: (region: Region) => void;
  onRegionsChange: (regions: Region[]) => void;
  onReady: (controller: MapController) => void;
  onError: (message: string) => void;
}

type RegionCollection = FeatureCollection<Geometry, Region>;
type CountryPayload={data:RegionCollection;bytes?:number;regions?:Region[];land?:FeatureCollection<Polygon|MultiPolygon>;fallback?:FeatureCollection<Polygon|MultiPolygon>;coarse?:boolean;renderPolicy?:CountyRenderPolicy};
type VisitPoint = Region & { status: VisitStatus };
type Hover = { name: string; detail: string; x: number; y: number };
type FeatureRef = { source: string; id: string | number };

const INITIAL_CENTER: [number, number] = [105, 30];
const INITIAL_ZOOM = 1.45;
// Vite's dependency optimizer relocates the main module without its sibling worker.
// Serve the matching official worker directly, in both development and production.
const MAPLIBRE_WORKER_URL = '/vendor/maplibre-gl-6.15.0/maplibre-gl-worker.mjs';
const LOCAL_MIN_ZOOM = 3.45;
// How long the globe view stays still before exact country geometry is released.
const RELEASE_IDLE_MS = 30_000;
// Local boundary lines stay light across a whole country, where thousands of them overlap, and firm up once a city fills the screen.
const LOCAL_BORDER_WIDTH: ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 3.45, 0.35, 7, 0.65, 10, 1.3, 13, 1.9];
const LOCAL_BORDER_OPACITY: ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 3.45, 0.18, 6, 0.45, 9, 0.9];
// The overview mesh stops where the densest countries show their exact boundaries.
const OVERVIEW_BORDER_MAX_ZOOM = 6.5;
const STATUS_PRIORITY: Record<VisitStatus, number> = { wishlist: 0, passed: 1, visited: 2, lived: 3 };
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };
const FONT = ['PingFang SC', 'Microsoft YaHei', 'sans-serif'];
// Place names are drawn with the system face: SF Pro for Latin text, PingFang SC for Chinese.
const LABEL_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif';
interface AlignedCountry {localUrl:string;landUrl:string;fallbackUrl?:string;countryUrl?:string;renderCount:number;legacyPaintUrl?:string;replaceWorldIds?:string[];retainedWorldIds?:string[];localBytes?:number;suppressedIds?:string[];legacyAliases?:Record<string,string>;source?:string;sourceUrl?:string;license?:string;sourceYear?:string;sourceAttribution?:string;}

function graticule(): FeatureCollection {
  const lines: number[][][] = [];
  for (let lng = -180; lng < 180; lng += 30) {
    const line = [];
    for (let lat = -84; lat <= 84; lat += 2) line.push([lng, lat]);
    lines.push(line);
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const line = [];
    for (let lng = -180; lng <= 180; lng += 2) line.push([lng, lat]);
    lines.push(line);
  }
  return { type: 'FeatureCollection', features: lines.map((coordinates) => ({
    type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates },
  })) };
}

function regionCollection(value: unknown,names:NameQualityCatalog={regions:{}}): RegionCollection {
  const collection = value as RegionCollection;
  if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    throw new Error('边界数据格式无效');
  }
  collection.features = collection.features.filter((feature) => {
    const region = feature.properties;
    if (!region || !region.id || !Array.isArray(region.center) || region.center.length !== 2) return false;
    if (!region.center.every(Number.isFinite)) return false;
    if (feature.geometry?.type !== 'Polygon' && feature.geometry?.type !== 'MultiPolygon') return false;
    feature.properties=presentRegion(region,names);
    feature.id = region.id;
    return true;
  });
  return collection;
}


function labelsFromRegions(regions:Region[]):FeatureCollection<Point,Region>{return{type:'FeatureCollection',features:regions.filter(canLabelRegion).map(region=>({type:'Feature',id:region.id,properties:region,geometry:{type:'Point',coordinates:region.center}}))};}

function labels(collection: RegionCollection): FeatureCollection<Point, Region> {
  return { type: 'FeatureCollection', features: collection.features.filter(feature=>canLabelRegion(feature.properties)).map((feature) => ({
    type: 'Feature', id: feature.id, properties: feature.properties,
    geometry: { type: 'Point', coordinates: feature.properties.center },
  })) };
}

function distinctVisits(visits: Visit[]): Map<string, Visit> {
  const result = new Map<string, Visit>();
  for (const visit of visits) {
    const current = result.get(visit.region.id);
    if (!current || STATUS_PRIORITY[visit.status] > STATUS_PRIORITY[current.status]) result.set(visit.region.id, visit);
  }
  return result;
}

function visitPoints(visits: Visit[]): FeatureCollection<Point, VisitPoint> {
  return { type: 'FeatureCollection', features: [...distinctVisits(visits).values()].map((visit) => ({
    type: 'Feature', id: visit.region.id, properties: { ...visit.region, status: visit.status },
    geometry: { type: 'Point', coordinates: visit.region.center },
  })) };
}

function baseStyle(world: RegionCollection, projection: 'globe' | 'mercator',theme:ResolvedAppearance): StyleSpecification {
  const style:StyleSpecification = {
    version: 8,
    name: 'Light the Earth · Quiet Atlas',
    projection: { type: projection },
    transition: { duration: 350, delay: 0 },
    sky: {
      'sky-color': '#091115', 'horizon-color': '#334b4b', 'fog-color': '#0c171c',
      'sky-horizon-blend': 0.18, 'horizon-fog-blend': 0.15, 'fog-ground-blend': 0.3,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.6, 2, 0.45, 3.5, 0.12, 5, 0],
    },
    sources: {
      // promoteId makes each country addressable by feature-state; without it every country shares id 0 and hover and selection never show.
      world: { type: 'geojson', data: world, promoteId: 'id', tolerance: 0.3, attribution: '<a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth</a> · <a href="https://www.geoboundaries.org/" target="_blank" rel="noopener">geoBoundaries</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> · <a href="https://www.census.gov/" target="_blank" rel="noopener">US Census Bureau</a>' },
      graticule: { type: 'geojson', data: graticule() },
      'country-labels': { type: 'geojson', data: labels(world) },
      footprints: { type: 'geojson', data: EMPTY },
      // promoteId keeps each saved region addressable by feature-state (selection, lighting pulse).
      'saved-areas': { type: 'geojson', data: EMPTY, tolerance: 0.1, maxzoom: 14, promoteId: 'id' },
    },
    layers: [
      { id: 'ocean', type: 'background', paint: { 'background-color': '#0c171c' } },
      { id: 'grid', type: 'line', source: 'graticule', paint: {
        'line-color': '#7a9690', 'line-width': 0.45,
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0.13, 3, 0.08, 5, 0],
      } },
      { id: 'country-fill', type: 'fill', source: 'world', paint: {
        'fill-color': ['match', ['feature-state', 'status'], 'lived', '#b6904f', 'visited', '#9c8050', 'passed', '#52665d', 'wishlist', '#2d4d4b', '#203332'],
        'fill-opacity': 1,
      } },
      {id:'country-hit',type:'fill',source:'world',paint:{'fill-color':'#000000','fill-opacity':0.001}},
      { id: 'saved-area-fill', type: 'fill', source: 'saved-areas', layout: { 'fill-sort-key': ['get', 'paintOrder'] }, paint: {
        'fill-color': ['match', ['get', 'status'], 'lived', '#c99b53', 'visited', '#b69351', 'passed', '#698c7a', 'wishlist', '#417c78', '#b69351'],
        'fill-opacity': ['*', ['match', ['get', 'status'], 'wishlist', 0.6, 0.92], ['coalesce', ['feature-state', 'illumination'], 1]],
      } },
      { id: 'saved-area-glow', type: 'fill', source: 'saved-areas', layout: { 'fill-sort-key': ['get', 'paintOrder'] }, paint: {
        'fill-color': '#ffe0a0', 'fill-opacity': ['*', 0.55, ['coalesce', ['feature-state', 'glow'], 0]],
      } },
      { id: 'country-border', type: 'line', source: 'world', paint: {
        'line-color': '#648178', 'line-opacity': 0.4,
        'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.35, 4, 0.8, 8, 1.1],
      } },
      { id: 'country-hover', type: 'fill', source: 'world', paint: {
        'fill-color': '#90b8a5',
        'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.22, 0],
      } },
      { id: 'country-name', type: 'symbol', source: 'country-labels', minzoom: 1.8, maxzoom: 6,
        layout: { 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': ['interpolate', ['linear'], ['zoom'], 2, 12, 5, 15], 'text-max-width': 7, 'text-padding': 20 },
        paint: { 'text-color': '#9cb1a7', 'text-halo-color': '#172927', 'text-halo-width': 1.5, 'text-opacity': 0.76 },
      },
      { id: 'saved-area-border', type: 'line', source: 'saved-areas', layout: { 'line-sort-key': ['get', 'paintOrder'] }, paint: {
        'line-color': ['match', ['get', 'status'], 'wishlist', '#80c4bb', 'passed', '#a4c4ad', '#efd29a'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.6, 6, 1.2, 10, 1.8],
        // Wishes are not yet places you have been: a dashed edge keeps them apart from lit areas and water.
        'line-dasharray': ['match', ['get', 'status'], 'wishlist', ['literal', [2, 1.6]], ['literal', [1, 0]]],
        'line-opacity': ['*', 0.9, ['coalesce', ['feature-state', 'illumination'], 1]],
      } },
      // Selection sits above lit borders; the dark casing keeps the ivory core legible on gold and on pale land.
      { id: 'country-selection-casing', type: 'line', source: 'world', paint: {
        'line-color': '#02090b', 'line-width': 4.5, 'line-blur': 0.6,
        'line-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0.5, 0],
      } },
      { id: 'country-selection', type: 'line', source: 'world', paint: {
        'line-color': '#fffaf0', 'line-width': 1.8,
        'line-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 1, 0],
      } },
      // Historical lit areas exist only in saved-areas, so they carry their own selection outline.
      { id: 'saved-area-selection-casing', type: 'line', source: 'saved-areas', paint: {
        'line-color': '#02090b', 'line-width': 5, 'line-blur': 0.6,
        'line-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0.5, 0],
      } },
      { id: 'saved-area-selection', type: 'line', source: 'saved-areas', paint: {
        'line-color': '#fffaf0', 'line-width': 2.2,
        'line-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 1, 0],
      } },
      { id: 'footprint-halo', type: 'circle', source: 'footprints', maxzoom: 5, paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 12, 6, 18],
        'circle-color': ['match', ['get', 'status'], 'wishlist', '#b9adf0', 'passed', '#8fcdb0', '#f0bd6a'],
        'circle-blur': 0.9, 'circle-opacity': 0.28,
      } },
      { id: 'footprint-ring', type: 'circle', source: 'footprints', maxzoom: 5, paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 5.2, 6, 7],
        'circle-color': '#15221f', 'circle-opacity': 0.75,
        'circle-stroke-color': ['match', ['get', 'status'], 'wishlist', '#a99cf0', 'passed', '#7fc0a2', '#f0bd6a'],
        'circle-stroke-width': 1, 'circle-stroke-opacity': 0.8,
      } },
      { id: 'footprint-dot', type: 'circle', source: 'footprints', maxzoom: 5, paint: {
        'circle-radius': ['match', ['get', 'status'], 'lived', 3.3, 2.4],
        'circle-color': ['match', ['get', 'status'], 'wishlist', '#a99cf0', 'passed', '#7fc0a2', '#f8d28e'],
        'circle-opacity': ['match', ['get', 'status'], 'wishlist', 0.2, 1],
      } },
    ],
  };
  for(const layer of style.layers)Object.assign(layer.paint??={},themedMapPaint(layer.id,theme));
  const p=mapPalette(theme);Object.assign(style.sky!,{'sky-color':p.sky,'horizon-color':p.horizon,'fog-color':p.fog});
  return style;
}

export default function EarthMap(props: EarthMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const starfieldRef=useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  const mapRef = useRef<LibreMap | null>(null);
  const paddingRef = useRef<(()=>ReturnType<typeof mapPadding>)|null>(null);
  const syncVisitsRef = useRef<(() => void) | null>(null);
  const syncSelectionRef = useRef<((region: Region | null) => void) | null>(null);
  const syncThemeRef=useRef<(()=>void)|null>(null);
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [loadingCountry, setLoadingCountry] = useState<string | null>(null);
  const [failedCountry, setFailedCountry] = useState<{ code: string; name: string } | null>(null);
  const retryCountryRef = useRef<((code: string) => void) | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [zoom, setZoom] = useState(INITIAL_ZOOM);
  const [deferredDetail,setDeferredDetail]=useState(false);
  const [detailZoom,setDetailZoom]=useState(LOCAL_MIN_ZOOM);
  const [overviewReady,setOverviewReady]=useState(false);
  const [preloading,setPreloading]=useState<string|null>(null);

  useEffect(() => { propsRef.current = props; }, [props]);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    const abort = new AbortController();
    let disposed = false;
    let attributionResize:ResizeObserver|null=null;
    let assetCatalog:BoundaryAssetCatalog={};
    let partitionReader:ReturnType<typeof createGeometryPartitionReader>|null=null;
    let detailAbort:AbortController|null=null;
    let preloader:ReturnType<typeof createGeometryPreloader>|null=null;
    let preloadTimer:ReturnType<typeof setTimeout>|undefined;
    const desktop=container.clientWidth>900;
    const deferredRegions=new Map<string,Region[]>();
    let nameCatalog:NameQualityCatalog={regions:{}};
    let worldOutline:RegionCollection|undefined;
    const refreshNames=()=>{
      if(disposed)return;
      for(const [id,region] of registry)registry.set(id,presentRegion(region,nameCatalog));
      for(const [id,region] of countryRegistry)countryRegistry.set(id,presentRegion(region,nameCatalog));
      if(worldOutline){for(const feature of worldOutline.features)feature.properties=presentRegion(feature.properties,nameCatalog);(map?.getSource('country-labels')as GeoJSONSource|undefined)?.setData(labels(worldOutline));}
      for(const code of loaded){
        const source=map?.getSource(`local-${code}`)as GeoJSONSource|undefined,labelSource=map?.getSource(`local-${code}-labels`)as GeoJSONSource|undefined;
        const display=displayedCountyViews.get(code);
        if(usesCountySourceUpdates(code)&&display&&source&&labelSource)setCountyDisplay(code,detailedCountyFeatures(display.features as Feature<Polygon|MultiPolygon>[],registry,new Set(alignment.get(code)?.suppressedIds??[])),source,labelSource);
        else{const ids=residentViewIds.get(code)??new Set<string>();const visible=[...ids].map(id=>registry.get(id)).filter((r):r is Region=>!!r);labelSource?.setData(labelsFromRegions(visible));}
      }
      publishRegions();
    };
    let resize: ResizeObserver | undefined;
    let map: LibreMap | undefined;
    let hoverRef: FeatureRef | null = null;
    let selectionRef: FeatureRef | null = null;
    let savedSelectionId: string | null = null;
    let resizeFrame = 0;
    let hoveredId = '';
    let lastError = '';
    let boundaryError = '';
    let viewTimer: ReturnType<typeof setTimeout> | undefined;
    let cameraRevision = 0;
    let clickSequence = 0;
    let focusCode: string | null = null;
    let focusRegion:Region|null=null;
    const upgradingCountries=new Set<string>();
    let viewCodes: string[] = [];
    const coarseCounty = new Map<string, RegionCollection>();
    const showingDetail = new Set<string>();
    const detailViewKey = new Map<string, string>();
    const detailReady = new Set<string>();
    const detailWaiters = new Map<number, { resolve: (features: Feature<Polygon | MultiPolygon>[]) => void; reject: (error: Error) => void }>();
    let detailSerial = 0;
    let detailView = 0;
    let detailWorker: Worker | null = null;
    const renderCleanups = new Set<() => void>();
    const countryRegistry = new Map<string, Region>();
    const countryNavigationBounds = new Map<string, [number, number, number, number]>();
    const countryByCode = new Map<string, Region[]>();
    const coverageOnlyRegions: Region[] = [];
    const registry = new Map<string, Region>();
    const residentShapes = new Map<string,Feature<Polygon|MultiPolygon>>();
    const residentShapeIds = new Map<string,Set<string>>();
    const residentViewIds=new Map<string,Set<string>>();
    let publishedRegions: Region[] = [];
    const sources = new Map<string, string>();
    const loaded = new Set<string>();
    const appliedVisits = new Map<string, VisitStatus>();
    let footprintTintKey: string | null = null;
    const coverage = new Map<string, Coverage>();
    const alignment=new Map<string,AlignedCountry>();
    const renderPolicies=new Map<string,CountyRenderPolicy>();
    const displayedCountyViews=new Map<string,RegionCollection>();
    const countySourceUpdates=new Map<string,{shape:ReturnType<typeof createCountySourceUpdates>;label:ReturnType<typeof createCountySourceUpdates>;needsInitialPaint:boolean}>();
    const landRenderData=new Map<string,ReturnType<typeof createGeometryRenderData>>();
    const retiredLandRenderData=new Set<ReturnType<typeof createGeometryRenderData>>();
    let recoveringContext=false;
    let coarseVisibilityKey='';
    // A light line mesh of every country's local boundaries (scripts/build-overview-borders.py). It shows from the zoom
    // where local boundaries first appear, for countries whose exact polygons are not on screen yet: large countries
    // below their detail zoom, and any country still waiting to be mounted.
    let overviewBorders:'idle'|'loading'|'ready'|'unavailable'='idle',overviewBorderKey:string|null=null;
    const overviewBorderLayers:string[]=[];
    const syncOverviewBorders=()=>{
      if(!map||disposed||overviewBorders!=='ready')return;
      const zoom=map.getZoom();
      // Hide the mesh wherever a country's own exact borders are drawn, so lines never double.
      const exact=[...loaded].filter(code=>{const policy=renderPolicies.get(code);return !!policy&&(policy.viewport?zoom>=policy.minZoom&&!!displayedCountyViews.get(code)?.features.length:!coarseCounty.has(code));}).sort();
      const key=exact.join(',');if(key===overviewBorderKey)return;overviewBorderKey=key;
      const filter=exact.length?['!',['in',['get','countryCode'],['literal',exact]]]:null;
      for(const id of overviewBorderLayers)map.setFilter(id,filter as Parameters<LibreMap['setFilter']>[1]);
    };
    const ensureOverviewBorders=()=>{
      // The mesh is a set of vector tiles: MapLibre fetches only the tiles on screen once the layer's zoom is reached,
      // so adding it costs nothing up front. The site waits until the approach to that zoom; the desktop app adds it when idle.
      if(!map||disposed||overviewBorders!=='idle'||(!desktopBridge()&&map.getZoom()<LOCAL_MIN_ZOOM-1))return;
      overviewBorders='loading';
      void fetch('/data/overview-borders.json',{cache:'no-cache'}).then(response=>response.ok?response.json() as Promise<{tiles?:{url:string;layer:string;minzoom:number;maxzoom:number};seams?:{url:string}}>:null).then(manifest=>{
        if(!map||disposed)return;
        if(!manifest?.tiles){overviewBorders='unavailable';return;}
        const palette=mapPalette(propsRef.current.theme),color=palette.line;
        // Land colour under every land border: neighbouring countries' exact outlines rarely meet, and the sea would show through the slivers.
        if(manifest.seams){
          map.addSource('border-seams',{type:'geojson',data:manifest.seams.url,tolerance:0.2,maxzoom:12});
          map.addLayer({id:'border-seam-fill',type:'fill',source:'border-seams',minzoom:LOCAL_MIN_ZOOM,paint:{'fill-color':palette.land}},'country-hit');
        }
        // The line mesh is skipped on narrow screens, whose memory budget is half the desktop one.
        if(desktop){
          const tiles=manifest.tiles;
          map.addSource('overview-borders',{type:'vector',tiles:[new URL(tiles.url,location.href).href.replace(/%7B/g,'{').replace(/%7D/g,'}')],minzoom:tiles.minzoom,maxzoom:tiles.maxzoom});
          map.addLayer({id:'overview-border',type:'line',source:'overview-borders','source-layer':tiles.layer,minzoom:LOCAL_MIN_ZOOM,maxzoom:OVERVIEW_BORDER_MAX_ZOOM,paint:{
            'line-color':color,'line-width':['interpolate',['linear'],['zoom'],3.45,0.35,7,0.65],'line-opacity':['interpolate',['linear'],['zoom'],3.45,0.18,6,0.45],
          }},'country-name');
          overviewBorderLayers.push('overview-border');
        }
        overviewBorders='ready';setOverviewReady(overviewBorderLayers.length>0);syncOverviewBorders();
      }).catch(()=>{overviewBorders='unavailable';});
    };
    let areaLoader: ReturnType<typeof createVisitedAreaLoader> | undefined;
    let areaFrame = 0;
    const areaPulses = new Map<string,number>();
    // Only a save or status change lights up; filters and tabs re-show areas quietly.
    const pendingPulses = new Map<string,number>();
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const duration = (ms: number) => reducedMotion.matches ? 0 : ms;
    const applyTheme=()=>{
      if(!map||disposed||!map.getLayer('country-fill'))return;
      for(const layer of map.getStyle().layers??[])for(const [key,value] of Object.entries(themedMapPaint(layer.id,propsRef.current.theme)))map.setPaintProperty(layer.id,key as Parameters<LibreMap['setPaintProperty']>[1],value as Parameters<LibreMap['setPaintProperty']>[2]);
      footprintTintKey=null; // The themed paint above replaced the footprint tint; applyVisits restores it.
      const p=mapPalette(propsRef.current.theme);map.setSky({'sky-color':p.sky,'horizon-color':p.horizon,'fog-color':p.fog,'sky-horizon-blend':0.18,'horizon-fog-blend':0.15,'fog-ground-blend':0.3,'atmosphere-blend':['interpolate',['linear'],['zoom'],0,0.6,2,0.45,3.5,0.12,5,0]});
    };
    const syncCoarseVisibility=()=>{
      if(!map||disposed||!map.getLayer('country-fill'))return;
      ensureOverviewBorders();syncOverviewBorders();
      const codes=map.getZoom()>=LOCAL_MIN_ZOOM?[...loaded].sort():[];
      const key=codes.join(',');if(key===coarseVisibilityKey)return;coarseVisibilityKey=key;
      const ids=codes.flatMap(code=>replacedWorldIds(alignment.get(code),(countryByCode.get(code)??[]).map(r=>r.id)));
      const filter=ids.length?['!', ['in',['get','id'],['literal',ids]]]:null;
      for(const id of ['country-fill','country-border','country-hover','country-selection-casing','country-selection'])map.setFilter(id,filter as Parameters<LibreMap['setFilter']>[1]);
    };
    const animateAreas = (now:number) => {
      areaFrame=0;
      if(disposed||!map)return;
      for(const [id,start] of areaPulses){
        const t=reducedMotion.matches?1:Math.min(1,Math.max(0,(now-start)/1100));
        map.setFeatureState({source:'saved-areas',id},{illumination:1-Math.pow(1-t,3),glow:Math.sin(Math.PI*t)});
        if(t===1)areaPulses.delete(id);
      }
      if(areaPulses.size)areaFrame=requestAnimationFrame(animateAreas);
    };
    // The timeline lies over the bottom of the map; the camera treats that strip as covered so the globe sits clear of it.
    const bottomInset = () => {
      const bar = document.getElementById('travel-timeline');
      return bar && !bar.hidden ? Math.max(0, container.getBoundingClientRect().bottom - bar.getBoundingClientRect().top + 12) : 0;
    };
    // The toolbar floats over the top of the map; the camera keeps the globe clear of that strip too.
    const topInset = () => {
      const bar = document.querySelector('.app-header');
      return bar ? Math.max(0, bar.getBoundingClientRect().bottom - container.getBoundingClientRect().top) : 0;
    };
    const padding = () => mapPadding(container.clientWidth, propsRef.current.sidebarVisible, bottomInset(), topInset());
    paddingRef.current = padding;
    const overviewZoom = () => {
      const diameter = overviewDiameter(container.clientWidth, container.clientHeight, bottomInset(), topInset());
      return Math.max(0.3, Math.min(1.9, INITIAL_ZOOM + Math.log2(Math.max(diameter, 160) / 440)));
    };
    const reportError = (message: string) => {
      if (disposed || message === lastError) return;
      lastError = message;
      propsRef.current.onError(message);
    };
    const publishRegions = () => {
      const available = new Map(registry);
      for (const visit of propsRef.current.visits) if (!available.has(visit.region.id)) available.set(visit.region.id, visit.region);
      const selected = propsRef.current.selectedRegion;
      if (selected && !available.has(selected.id)) available.set(selected.id, selected);
      const next = [...available.values()];
      if (next.length === publishedRegions.length && next.every((region, index) => region === publishedRegions[index])) return;
      publishedRegions = next;
      propsRef.current.onRegionsChange(next);
    };
    const register = (data: RegionCollection, source: string) => {
      for (const feature of data.features) {
        registry.set(feature.properties.id, feature.properties);
        sources.set(feature.properties.id, source);
      }
      publishRegions();
    };
    const featureRef = (region: Region): FeatureRef | null => {
      const source = sources.get(region.id);
      return source ? { source, id: region.id } : null;
    };
    const applyVisits = () => {
      if (!map || disposed || !map.getSource('footprints')) return;
      syncSavedAreaVisibility(map,propsRef.current.visits);
      const visits = distinctVisits(propsRef.current.visits);
      for (const id of appliedVisits.keys()) {
        const source = sources.get(id);
        if (source && !visits.has(id)) map.setFeatureState({ source, id }, { status: null });
      }
      appliedVisits.clear();
      for (const [id, visit] of visits) {
        const source = sources.get(id);
        if (source) map.setFeatureState({ source, id }, { status: visit.status });
        appliedVisits.set(id, visit.status);
      }
      // Countries with local footprints glow softly in the world view. Changing a data-driven colour re-tiles the world layer, so only do it when the set changes.
      const footprints=footprintCountries(propsRef.current.visits);
      const tintKey=propsRef.current.theme+'|'+[...footprints].map(([code,status])=>code+':'+status).sort().join(',');
      if(tintKey!==footprintTintKey){footprintTintKey=tintKey;map.setPaintProperty('country-fill','fill-color' as Parameters<LibreMap['setPaintProperty']>[1],countryFillColor(propsRef.current.theme,footprints) as Parameters<LibreMap['setPaintProperty']>[2]);}
      for(const code of loaded){
        const countryVisit=[...visits.values()].find(visit=>visit.region.level==='country'&&visit.region.countryCode===code);
        const gold=countryVisit?.status==='visited'||countryVisit?.status==='lived';
        const p=mapPalette(propsRef.current.theme);
        if(map.getLayer(`local-${code}-fallback`)){const status=countryVisit?.status;map.setPaintProperty(`local-${code}-fallback`,'fill-color',status==='lived'?p.areaLived:status==='visited'?p.areaVisited:status==='passed'?p.areaPassed:status==='wishlist'?p.areaWish:p.land);}
        map.setPaintProperty(`local-${code}-border`,'line-color',gold?p.goldBorder:p.line);
        map.setPaintProperty(`local-${code}-border`,'line-opacity',countryVisit?0.9:LOCAL_BORDER_OPACITY);
      }
      (map.getSource('footprints') as GeoJSONSource | undefined)?.setData(visitPoints(propsRef.current.visits));
      areaLoader?.setVisits(propsRef.current.visits);
      areaLoader?.prime([...visits.keys()].map(id=>residentShapes.get(id)).filter((feature):feature is Feature<Polygon|MultiPolygon>=>!!feature));
      // Saved points remain immediately available while related countries warm.
      publishRegions();
      schedulePreloads();
    };
    const select = (region: Region | null) => {
      if (!map || disposed) return;
      if (selectionRef && map.getSource(selectionRef.source)) map.setFeatureState(selectionRef, { selected: false });
      if (map.getSource('saved-areas')) {
        if (savedSelectionId) map.setFeatureState({ source: 'saved-areas', id: savedSelectionId }, { selected: false });
        savedSelectionId = region?.id ?? null;
        if (savedSelectionId) map.setFeatureState({ source: 'saved-areas', id: savedSelectionId }, { selected: true });
      }
      selectionRef = region ? featureRef(region) : null;
      if (selectionRef&&map.getSource(selectionRef.source)) map.setFeatureState(selectionRef, { selected: true });
      for(const code of loaded){const on=region?.level==='country'&&region.countryCode===code;for(const [layer,opacity] of [[`local-${code}-outline-casing`,0.5],[`local-${code}-outline`,1]] as const)if(map.getLayer(layer))map.setPaintProperty(layer,'line-opacity',on?opacity:0);}
    };
    const fly = (region: Region,showDetail=true) => {
      if (!map || disposed) return;
      focusRegion=region;
      focusCode = coverage.has(region.countryCode) ? region.countryCode : null;
      viewCodes = [];
      updateTargets();
      if (focusCode) void boundaryLoader.request(focusCode);
      const bounds = region.level === 'country' ? countryNavigationBounds.get(region.id) ?? region.bbox : region.bbox;
      const safeBounds = bounds && bounds.every(Number.isFinite) && bounds[2] > bounds[0] && bounds[3] > bounds[1] && bounds[2] - bounds[0] < 175;
      const insets = padding();
      const viewPadding = { top: 125, bottom: container.clientWidth < 900 ? 165 : 105, left: insets.left + 45, right: showDetail&&container.clientWidth>=900?(container.clientWidth>1190?410:370):45 };
      // Widely separated overseas territories must not pull the camera away from the selected country.
      if (safeBounds) {
        const targetBounds: [[number, number], [number, number]] = [[bounds[0], bounds[1]], [bounds[2], bounds[3]]];
        // Absolute padding replaces the previous viewport insets. Relative fit
        // padding also shifts camera.center, so applying it again in flyTo
        // would move successive country selections farther off screen.
        const camera = map.cameraForBounds(targetBounds, { padding: viewPadding, absolutePadding: true, maxZoom: region.level === 'local' ? 12 : 9 });
        if (region.level === 'country' && coverage.has(region.countryCode) && camera) {
          map.flyTo({ ...camera, zoom: Math.max(camera.zoom ?? LOCAL_MIN_ZOOM, LOCAL_MIN_ZOOM + 0.15),
            padding: viewPadding, duration: duration(1300), essential: false, pitch: 0, bearing: 0 });
          return;
        }
        if (region.level === 'local' && camera?.zoom !== undefined) {
          const detail = renderPolicies.get(region.countryCode)?.minZoom ?? LOCAL_MIN_ZOOM;
          map.flyTo({ ...camera, zoom: localFocusZoom(camera.zoom, detail),
            padding: viewPadding, duration: duration(1300), essential: false, pitch: 0, bearing: 0 });
          return;
        }
        map.fitBounds(targetBounds, {
          padding: viewPadding, absolutePadding: true, maxZoom: region.level === 'local' ? 12 : 9,
          duration: duration(1300), essential: false, pitch: 0, bearing: 0,
        });
      } else {
        map.flyTo({ center: region.center, zoom: region.level === 'local' ? 8 : 3.8, padding: insets,
          duration: duration(1300), essential: false, pitch: 0, bearing: 0 });
      }
    };
    // A map click keeps the user's zoom; only slide sideways when the detail drawer would cover the place.
    const reveal = (region: Region) => {
      if (!map || disposed || container.clientWidth < 900) return;
      const dx = drawerRevealShift(map.project(region.center).x, container.clientWidth, container.clientWidth > 1190 ? 410 : 370);
      if (dx > 0) map.panBy([dx, 0], { duration: duration(300), essential: false });
    };

    function updateTargets() {
      boundaryLoader.setTargets([...(focusCode ? [focusCode] : []), ...viewCodes].filter(code => coverage.has(code)));
      schedulePreloads();
    }
    async function upgradeCountry(code:string){
      if(!map||disposed||!partitionReader?.isCountryReady(code)||!loaded.has(code)||!coarseCounty.has(code)||upgradingCountries.has(code))return;
      // Exact full-country shapes remain warm in RAM; a county visit installs only its view.
      if(renderPolicies.get(code)?.viewport||(focusRegion?.level==='local'&&focusRegion.countryCode===code))return;
      upgradingCountries.add(code);
      try{const full=await partitionReader.readView(code,[-180,-90,180,90],abort.signal);if(!map||disposed||!loaded.has(code)||(focusRegion?.level==='local'&&focusRegion.countryCode===code))return;const source=map.getSource(`local-${code}`)as GeoJSONSource|undefined,labelSource=map.getSource(`local-${code}-labels`)as GeoJSONSource|undefined;if(!source||!labelSource)return;coarseCounty.delete(code);deferredRegions.delete(code);detailViewKey.delete(code);showingDetail.delete(code);setCountyDisplay(code,detailedCountyFeatures(full.features,registry,new Set(alignment.get(code)?.suppressedIds??[])),source,labelSource);}
      catch{/* The exact initial viewport remains usable; a later view can retry. */}finally{upgradingCountries.delete(code);}
    }
    function schedulePreloads(){
      if(!preloader||disposed)return;
      const counts=new Map<string,number>();for(const visit of propsRef.current.visits)counts.set(visit.region.countryCode,(counts.get(visit.region.countryCode)??0)+1);
      const saved=[...counts].sort((a,b)=>b[1]-a[1]).map(([code])=>code);
      preloader.setTargets([...new Set([...(focusCode?[focusCode]:[]),...viewCodes,'CHN',...saved])].filter(code=>coverage.has(code)).slice(0,8));
    }
    function unloadCountry(code: string) {
      if (!map) return;
      const source = `local-${code}`;
      const updates=countySourceUpdates.get(code);updates?.shape.dispose();updates?.label.dispose();countySourceUpdates.delete(code);
      if (hoverRef?.source === source) clearHover();
      if (selectionRef?.source === source) selectionRef = null;
      for (const suffix of ['name', 'selection', 'selection-casing', 'outline', 'outline-casing', 'hover', 'border', 'fill', 'fallback', 'land-fill']) {
        const id = `${source}-${suffix}`;
        if (map.getLayer(id)) map.removeLayer(id);
      }
      for (const id of [`${source}-labels`, `${source}-land`, `${source}-fallback`, source]) if (map.getSource(id)) map.removeSource(id);
      const renderData=landRenderData.get(code);
      if(renderData){if(recoveringContext)retiredLandRenderData.add(renderData);else renderData.dispose();landRenderData.delete(code);}
      for (const [id, mappedSource] of sources) if (mappedSource === source) { sources.delete(id); registry.delete(id); residentShapes.delete(id); }
      for (const id of residentShapeIds.get(code) ?? []) { if(!countryRegistry.has(id))registry.delete(id); residentShapes.delete(id); }
      residentShapeIds.delete(code);residentViewIds.delete(code);
      coarseCounty.delete(code);deferredRegions.delete(code);renderPolicies.delete(code);displayedCountyViews.delete(code);
      showingDetail.delete(code);
      detailViewKey.delete(code);
      detailReady.delete(code);
      detailWorker?.postMessage({ type: 'drop', id: 0, key: code });
      loaded.delete(code);
      syncCoarseVisibility();
      if (!disposed) publishRegions();
    }
    function mountCountry(code: string, payload: CountryPayload) {
      if (!map || disposed) return;
      try {
    const original=payload.data;
    const policy=payload.renderPolicy??{viewport:false,minZoom:LOCAL_MIN_ZOOM};
    renderPolicies.set(code,policy);
    const suppressed=new Set(alignment.get(code)?.suppressedIds??[]);
    const data:RegionCollection={...original,features:original.features.filter(f=>!suppressed.has(f.properties.id))};
    const source = `local-${code}`;
    const item=coverage.get(code);
    const escape=(text:string)=>text.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
    const sourceUrl=alignment.get(code)?.sourceUrl||item?.sourceUrl;
    const credit=alignedCredit();
    function alignedCredit(){return alignment.get(code)?.sourceAttribution||(code==='HKG'?'香港特别行政区政府 · 民政事务总署 · DATA.GOV.HK':`${item?.name??code}边界来源`);}
    const attribution=sourceUrl&&/^https:\/\//.test(sourceUrl)?`<a href="${escape(sourceUrl)}" target="_blank" rel="noopener">${escape(credit)}</a>`:undefined;
    const initial=usesCountySourceUpdates(code)?{type:'FeatureCollection'as const,features:[]}:data;
    map.addSource(source,countySourceSpecification(initial,attribution));
    map.addSource(`${source}-labels`, { type: 'geojson', data: labels(initial) });
    if(usesCountySourceUpdates(code))ensureCountySourceUpdates(code);
    if(payload.fallback){map.addSource(`${source}-fallback`,{type:'geojson',data:payload.fallback,tolerance:0.1,maxzoom:14});map.addLayer({id:`${source}-fallback`,type:'fill',source:`${source}-fallback`,minzoom:LOCAL_MIN_ZOOM,paint:{'fill-color':mapPalette(propsRef.current.theme).land}},'saved-area-fill');}

    if(payload.land){const renderData=createGeometryRenderData();landRenderData.set(code,renderData);map.addSource(`${source}-land`,{type:'geojson',data:countryLandSource(code,payload.land,renderData),tolerance:0.1,maxzoom:14});map.addLayer({id:`${source}-land-fill`,type:'fill',source:`${source}-land`,minzoom:LOCAL_MIN_ZOOM,paint:{'fill-color':mapPalette(propsRef.current.theme).land}},'saved-area-fill');map.addLayer({id:`${source}-outline-casing`,type:'line',source:`${source}-land`,minzoom:LOCAL_MIN_ZOOM,paint:{'line-color':mapPalette(propsRef.current.theme).selectionCasing,'line-width':5,'line-blur':0.6,'line-opacity':0}},'footprint-halo');map.addLayer({id:`${source}-outline`,type:'line',source:`${source}-land`,minzoom:LOCAL_MIN_ZOOM,paint:{'line-color':mapPalette(propsRef.current.theme).selection,'line-width':2,'line-opacity':0}},'footprint-halo');}
    map.addLayer({ id: `${source}-fill`, type: 'fill', source, minzoom: policy.minZoom, paint: {
      'fill-color': mapPalette(propsRef.current.theme).land, 'fill-opacity': 1,
    } }, 'saved-area-fill');
    map.addLayer({ id: `${source}-border`, type: 'line', source, minzoom: policy.minZoom, paint: {
      'line-color': '#81958b', 'line-width': LOCAL_BORDER_WIDTH, 'line-opacity': LOCAL_BORDER_OPACITY,
    } }, 'country-name');
    map.addLayer({ id: `${source}-hover`, type: 'fill', source, minzoom: policy.minZoom, paint: {
      'fill-color': '#a5c6ac', 'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.22, 0],
    } }, 'country-name');
    // Above saved-area borders, below local labels: a lit place stays visibly selected.
    map.addLayer({ id: `${source}-selection-casing`, type: 'line', source, minzoom: LOCAL_MIN_ZOOM, paint: {
      'line-color': mapPalette(propsRef.current.theme).selectionCasing, 'line-width': 5, 'line-blur': 0.6,
      'line-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0.5, 0],
    } }, 'footprint-halo');
    map.addLayer({ id: `${source}-selection`, type: 'line', source, minzoom: LOCAL_MIN_ZOOM, paint: {
      'line-color': mapPalette(propsRef.current.theme).selection, 'line-width': 2.2,
      'line-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 1, 0],
    } }, 'footprint-halo');
    map.addLayer({ id: `${source}-name`, type: 'symbol', source: `${source}-labels`, minzoom: Math.max(6,policy.minZoom),
      layout: { 'text-field': ['case',['==',['get','nameStatus'],'boundary-undetermined'],'归属未定地',['get','name']], 'text-font': FONT, 'text-size': 13, 'text-padding': 12, 'text-max-width': 8 },
      paint: { 'text-color': '#a9b8ac', 'text-halo-color': '#1c2d2a', 'text-halo-width': 1.5, 'text-opacity': 0.9 },
    }, 'footprint-halo');
        loaded.add(code);
        const shapeIds=new Set(original.features.map(f=>f.properties.id));
        residentShapeIds.set(code,shapeIds);
        for(const feature of original.features)if(!payload.coarse)residentShapes.set(feature.properties.id,feature as Feature<Polygon|MultiPolygon>);
        residentViewIds.set(code,new Set(original.features.filter(()=>!payload.coarse).map(f=>f.properties.id)));
        const country=countryByCode.get(code)?.[0];
        const land=payload.land?.features[0];
        if(country&&land){residentShapes.set(country.id,{...land,id:country.id,properties:country});shapeIds.add(country.id);}
        register(data, source);
        if(payload.regions){const active=payload.regions.filter(r=>!suppressed.has(r.id));deferredRegions.set(code,active);for(const r of active){registry.set(r.id,r);sources.set(r.id,source);shapeIds.add(r.id);}}
        if (payload.coarse) {coarseCounty.set(code, data);if(data.features.length)showingDetail.add(code);}
        syncDetailHint();
        if(usesCountySourceUpdates(code))setCountyDisplay(code,data,map.getSource(source)as GeoJSONSource,map.getSource(`${source}-labels`)as GeoJSONSource);
        publishRegions();
        void refreshCountyDetail();
        if(payload.coarse)void upgradeCountry(code);
        applyTheme();
        syncCoarseVisibility();
        applyVisits();
        select(propsRef.current.selectedRegion);
        setFailedCountry(current => current?.code === code ? null : current);
        if (boundaryError) { boundaryError = ''; reportError(''); }
      } catch (error) {
        // A failed layer installation must not leave partial sources behind for retry.
        unloadCountry(code);
        throw error;
      }
    }
    const boundaryLoader = createBoundaryLoader<CountryPayload>({
      capacity: desktop?12:6,
      concurrency: 4,
      maxWeight:(desktop?160:128)*1024*1024,
      weight:payload=>payload.bytes??0,
      load: async (code, signal) => {
        const item = coverage.get(code);
        if (!item) throw new Error('未找到地区目录');
        const aligned=alignment.get(code);
        const landPromise=aligned?.landUrl?readBoundaryAsset(aligned.countryUrl||aligned.landUrl,signal,assetCatalog):Promise.resolve(undefined);
        const fallbackPromise=aligned?.fallbackUrl?readBoundaryAsset(aligned.fallbackUrl,signal,assetCatalog):Promise.resolve(undefined);
        const indexUrl=`/data/region-index/${code.toLowerCase()}.json`;
        const [index,land,fallback]=await Promise.all([
          readBoundaryAsset(indexUrl,signal,assetCatalog).catch(error=>{if(signal.aborted)throw error;return null;}),
          landPromise,
          fallbackPromise,
        ]);
        if(isRegionIndex(index)&&index.geometry){
          const regions=regionsFromIndex(index).map(region=>presentRegion(region,nameCatalog));
          const primaryUrl=aligned?.localUrl||item.localUrl;
          const policy=countyRenderPolicy(aligned?.localBytes??assetCatalog[primaryUrl]?.decodedBytes??0,regions.length,code);
          const selected=focusRegion?.countryCode===code&&focusRegion.level==='local'?focusRegion:null;
          const bounds=map&&map.getZoom()>=policy.minZoom?map.getBounds():null;
          const initialView:[number,number,number,number]|undefined=selected?.bbox??(bounds?countyRenderView(bounds.getWest(),bounds.getSouth(),bounds.getEast(),bounds.getNorth()):undefined);
          const partial=!!partitionReader&&(policy.viewport||!!initialView&&(!partitionReader.isCountryReady(code)||!!selected));
          // Preload retains all exact shards; only visible detail enters MapLibre.
          const geometry=selected&&partitionReader?await partitionReader.readIDs(code,[selected.id],signal):partial&&!initialView?EMPTY:partitionReader?await partitionReader.readView(code,partial?initialView!:[-180,-90,180,90],signal):await readBoundaryAsset(primaryUrl,signal,assetCatalog);
          const data=countyFeatures(regions,geometry as FeatureCollection<Polygon|MultiPolygon>,index.extras??[]);
          return {data,bytes:aligned?.localBytes??assetCatalog[primaryUrl]?.decodedBytes??0,regions:partial?regions:undefined,land:land as FeatureCollection<Polygon|MultiPolygon>|undefined,fallback:fallback as FeatureCollection<Polygon|MultiPolygon>|undefined,coarse:partial,renderPolicy:policy};
        }
        const raw=await readBoundaryAsset(aligned?.localUrl||item.localUrl,signal,assetCatalog);
        const data=regionCollection(raw,nameCatalog);if(!data.features.length)throw new Error('地区边界为空');
        return {data,bytes:aligned?.localBytes??assetCatalog[item.localUrl]?.decodedBytes??0,land:land as FeatureCollection<Polygon|MultiPolygon>|undefined,fallback:fallback as FeatureCollection<Polygon|MultiPolygon>|undefined};
      },
      mount: mountCountry,
      unmount: unloadCountry,
      onLoading: codes => { if (!disposed) setLoadingCountry(codes.length ? coverage.get(codes[0])?.name ?? codes[0] : null); },
      onError: (code, error) => {
        const item = coverage.get(code);
        if (!item || disposed) return;
        setFailedCountry({ code, name: item.name });
        boundaryError = `${item.name}的${item.label || '地区'}边界暂时无法载入，可以点击地图下方的“重试”。${error instanceof Error ? `（${error.message}）` : ''}`;
        reportError(boundaryError);
      },
    });
    retryCountryRef.current = code => {
      focusCode = code;
      updateTargets();
      void boundaryLoader.request(code);
    };

    // Back at the globe, local boundaries are hidden. After a quiet spell the exact geometry of countries out of
    // view is let go (several hundred megabytes after a tour of a few countries); the disk cache keeps their bytes,
    // so zooming back in reads them again. A focused place's country stays.
    let releaseTimer:ReturnType<typeof setTimeout>|undefined;
    const cancelRelease=()=>{clearTimeout(releaseTimer);releaseTimer=undefined;};
    const scheduleRelease=()=>{
      cancelRelease();
      releaseTimer=setTimeout(()=>{
        releaseTimer=undefined;
        if(!map||disposed||map.isMoving()||map.getZoom()>=LOCAL_MIN_ZOOM-0.3)return;
        boundaryLoader.release();partitionReader?.releaseMemory();
        // The desktop app exposes gc(): a memory-reducing collection returns the freed pages (about 350 MB after a
        // tour of a few countries) in some 30 ms. The site has no gc() and leaves it to the browser.
        releaseTimer=setTimeout(()=>{releaseTimer=undefined;(globalThis as {gc?:(options?:object)=>unknown}).gc?.({type:'major',execution:'sync',flavor:'last-resort'});},2000);
      },RELEASE_IDLE_MS);
    };
    function updateVisibleCountries() {
      if (!map || disposed || !map.getLayer('country-hit')) return;
      setZoom(map.getZoom());
      if (map.getZoom() < LOCAL_MIN_ZOOM - 0.3) { viewCodes = []; syncDetailHint();updateTargets();scheduleRelease(); return; }
      cancelRelease();
      const center = map.project(map.getCenter());
      const candidates: { code: string; distance: number }[] = [];
      const screenDistance = (region: Region) => {
        const point = map!.project(region.center);
        return Math.hypot(point.x - center.x, point.y - center.y);
      };
      const visible = map.queryRenderedFeatures({ layers: ['country-hit'] });
      for (const feature of visible) {
        const code = String(feature.properties?.countryCode ?? '');
        if (!coverage.has(code)) continue;
        const regions = countryByCode.get(code) ?? [];
        candidates.push({ code, distance: Math.min(...regions.map(screenDistance)) });
      }
      // Some overseas territories have their own source data but no separate world feature.
      for (const region of coverageOnlyRegions) {
        const point = map.project(region.center);
        if (map.getBounds().contains(region.center)&&point.x >= 0 && point.x <= container.clientWidth && point.y >= 0 && point.y <= container.clientHeight) {
          candidates.push({ code: region.countryCode, distance: screenDistance(region) });
        }
      }
      const underCenter = map.queryRenderedFeatures(center, { layers: ['country-hit'] })[0]?.properties?.countryCode;
      viewCodes = prioritizeCountries(candidates, typeof underCenter === 'string' ? underCenter : undefined, desktop?4:3);
      syncDetailHint();
      updateTargets();
    }
    function syncDetailHint(){
      const code=focusCode??viewCodes[0];
      setDetailZoom(renderPolicies.get(code)?.minZoom??LOCAL_MIN_ZOOM);
      setDeferredDetail(!!code&&loaded.has(code)&&deferredRegions.has(code));
    }
    function scheduleVisibleCountries() {
      clearTimeout(viewTimer);
      viewTimer = setTimeout(() => { updateVisibleCountries(); void refreshCountyDetail().then(syncOverviewBorders); }, 80);
    }
    function ensureCountySourceUpdates(code:string){
      if(!usesCountySourceUpdates(code)||recoveringContext||countySourceUpdates.has(code)||!map)return countySourceUpdates.get(code);
      const countySource=map.getSource(`local-${code}`)as GeoJSONSource|undefined,labelSource=map.getSource(`local-${code}-labels`)as GeoJSONSource|undefined;
      if(!countySource||!labelSource)return;
      const snapshot=(source:GeoJSONSource)=>{const data=source.serialize().data;return typeof data==='object'&&data.type==='FeatureCollection'?data:undefined;};
      const fallback=(source:GeoJSONSource,latest:FeatureCollection)=>{if(disposed||!loaded.has(code))return;void source.setData(latest).catch(error=>{if(!disposed)reportError(`精细边界更新失败：${error instanceof Error?error.message:String(error)}`);});};
      // Independent acknowledgements/snapshots keep labels and polygons convergent after recovery.
      const initialShape=snapshot(countySource);
      const updates={
        needsInitialPaint:!initialShape?.features.length||['fill','border','hover','selection-casing','selection','name'].some(suffix=>map!.getLayer(`local-${code}-${suffix}`)&&map!.getLayoutProperty(`local-${code}-${suffix}`,'visibility')==='none'),
        shape:createCountySourceUpdates({initial:initialShape,apply:diff=>countySource.updateData(diff),onError:(_error,latest)=>fallback(countySource,latest)}),
        label:createCountySourceUpdates({initial:snapshot(labelSource),apply:diff=>labelSource.updateData(diff),onError:(_error,latest)=>fallback(labelSource,latest)}),
      };
      countySourceUpdates.set(code,updates);return updates;
    }

    function updateCountySources(code:string,data:RegionCollection){
      const updates=ensureCountySourceUpdates(code);if(!updates)return;
      const firstPaint=updates.needsInitialPaint&&data.features.length>0;
      const layers=['fill','border','hover','selection-casing','selection','name'].map(suffix=>`local-${code}-${suffix}`);
      if(firstPaint){updates.needsInitialPaint=false;for(const layer of layers)if(map?.getLayer(layer))map.setLayoutProperty(layer,'visibility','none');}
      const complete=Promise.all([updates.shape.update(data),updates.label.update(labels(data))]);
      // Avoid rebuilding visible tiles after every warm-up batch. Subsequent views stay visible.
      if(firstPaint)void complete.then(()=>{
        if(disposed||countySourceUpdates.get(code)!==updates)return;
        for(const layer of layers)if(map?.getLayer(layer))map.setLayoutProperty(layer,'visibility','visible');
      });
    }
    // Use the identical displayed polygons for saved colors and interactive outlines at each level of detail.
    function setCountyDisplay(code:string,data:RegionCollection,source:GeoJSONSource,labelSource:GeoJSONSource){
      if(sameCountyView(displayedCountyViews.get(code)?.features,data.features))return;
      displayedCountyViews.set(code,data);syncOverviewBorders();
      const updates=ensureCountySourceUpdates(code);
      if(updates)updateCountySources(code,data);else if(!usesCountySourceUpdates(code)){source.setData(data);labelSource.setData(labels(data));}
      const ids=residentShapeIds.get(code);
      residentViewIds.set(code,replaceResidentCountyShapes(residentShapes,residentViewIds.get(code)??new Set(),data.features as Feature<Polygon|MultiPolygon>[]));
      for(const feature of data.features)ids?.add(feature.properties.id);
      applyVisits();
    }
    function ensureDetailWorker() {
      if (detailWorker) return detailWorker;
      detailWorker = new Worker(new URL('../lib/boundary-detail.worker.ts', import.meta.url), { type: 'module' });
      detailWorker.onmessage = (event: MessageEvent<{ type: string; id: number; key?: string; features?: Feature<Polygon | MultiPolygon>[]; message?: string }>) => {
        if (event.data.type === 'loaded' && event.data.key && loaded.has(event.data.key)) detailReady.add(event.data.key);
        const waiter = detailWaiters.get(event.data.id);
        if (!waiter) return;
        detailWaiters.delete(event.data.id);
        if (event.data.type === 'error') waiter.reject(new Error(event.data.message || '精细边界解析失败'));
        else waiter.resolve(event.data.features ?? []);
      };
      detailWorker.onerror=()=>{
        for(const waiter of detailWaiters.values())waiter.reject(new Error('精细边界解析失败'));
        detailWaiters.clear();detailReady.clear();detailWorker?.terminate();detailWorker=null;
      };
      return detailWorker;
    }
    function askDetail(body: { type: 'load' | 'view'; key: string; buffer?: ArrayBuffer; view?: [number, number, number, number]; extraIds?: string[] }, transfer?: ArrayBuffer) {
      const id = ++detailSerial;
      return new Promise<Feature<Polygon | MultiPolygon>[]>((resolve, reject) => {
        detailWaiters.set(id, { resolve, reject });
        ensureDetailWorker().postMessage({ ...body, id }, transfer ? [transfer] : []);
      });
    }
    async function refreshCountyDetail() {
      if (!map || disposed || map.getZoom() < LOCAL_MIN_ZOOM) return;
      const token = ++detailView;detailAbort?.abort();const viewAbort=new AbortController();detailAbort=viewAbort;
      const bounds = map.getBounds();
      const view = countyRenderView(bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth());
      const zoom = map.getZoom();
      for (const code of [...loaded]) {
        const coarse = coarseCounty.get(code);
        if (!coarse) continue;
        if(!renderPolicies.get(code)?.viewport&&partitionReader?.isCountryReady(code)&&focusRegion?.level!=='local'){await upgradeCountry(code);if(!coarseCounty.has(code))continue;}
        const source = map.getSource(`local-${code}`) as GeoJSONSource | undefined;
        const labelSource = map.getSource(`local-${code}-labels`) as GeoJSONSource | undefined;
        if (!source || !labelSource) continue;
        const policy=renderPolicies.get(code)??{viewport:false,minZoom:LOCAL_MIN_ZOOM};
        const selected=focusRegion?.level==='local'&&focusRegion.countryCode===code&&propsRef.current.selectedRegion?.id===focusRegion.id?focusRegion:null;
        const viewKey = countyViewKey(policy,zoom,view,selected?.id);
        if (detailViewKey.get(code) === viewKey) continue;
        try {
          if (zoom < policy.minZoom) {
            if(selected&&partitionReader){
              // Keep the complete searched county outlined without tiling its neighbors.
              const features=(await partitionReader.readIDs(code,[selected.id],viewAbort.signal)).features;
              if(disposed||token!==detailView||viewAbort.signal.aborted)return;
              if(!loaded.has(code)||!coarseCounty.has(code))continue;
              setCountyDisplay(code,detailedCountyFeatures(features,registry,new Set(alignment.get(code)?.suppressedIds??[])),source,labelSource);
              showingDetail.add(code);select(propsRef.current.selectedRegion);
            }else if(showingDetail.delete(code))setCountyDisplay(code,{type:'FeatureCollection',features:[]},source,labelSource);
            detailViewKey.set(code,viewKey);continue;
          }
          if(partitionReader){
            const features=(await partitionReader.readView(code,view,viewAbort.signal)).features;
            if(disposed||token!==detailView)return;if(!loaded.has(code)||!coarseCounty.has(code))continue;
            const detailed=detailedCountyFeatures(features,registry,new Set(alignment.get(code)?.suppressedIds??[]));
            setCountyDisplay(code,detailed,source,labelSource);showingDetail.add(code);detailViewKey.set(code,viewKey);continue;
          }
          if (!detailReady.has(code)) {
            const item = coverage.get(code);
            const url = alignment.get(code)?.localUrl || item?.localUrl;
            if (!url) continue;
            const bytes = await fetchBoundaryBytes(url, viewAbort.signal, assetCatalog);
            if (disposed || token !== detailView) return;
            const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
            await askDetail({ type: 'load', key: code, buffer }, buffer);
            if(!loaded.has(code))continue;
            detailReady.add(code);
          }
          const workerSelected = propsRef.current.selectedRegion;
          const features = await askDetail({ type: 'view', key: code, view, extraIds: workerSelected?.countryCode === code ? [workerSelected.id] : [] });
          if (disposed || token !== detailView || map.getZoom() < policy.minZoom) return;
          if (!loaded.has(code)) continue;
          const detailed=detailedCountyFeatures(features,registry,new Set(alignment.get(code)?.suppressedIds??[]));
          if (!detailed.features.length) continue;
          setCountyDisplay(code,detailed,source,labelSource);
          showingDetail.add(code);
          detailViewKey.set(code, viewKey);
        } catch {
          if(viewAbort.signal.aborted)continue;
          if (loaded.has(code)&&!policy.viewport) { setCountyDisplay(code,coarse,source,labelSource); }
          reportError('当前视野的区划较多，请继续放大以查看精细边界。');
        }
      }
    }
    function whenCountryDrawn(code: string, callback: () => void) {
      if (!map || disposed) return;
      const currentMap = map;
      const finish = () => { cleanup(); if (!disposed) callback(); };
      const onRender = () => { if (currentMap.getSource(`local-${code}`) && currentMap.isSourceLoaded(`local-${code}`)) finish(); };
      const timer = setTimeout(finish, 3000);
      const cleanup = () => { clearTimeout(timer); currentMap.off('render', onRender); renderCleanups.delete(cleanup); };
      renderCleanups.add(cleanup);
      currentMap.on('render', onRender);
      currentMap.triggerRepaint();
    }

    const regionForFeature = (feature: MapGeoJSONFeature): Region | undefined => {
      const id = String(feature.properties?.id ?? feature.id ?? '');
      const known = registry.get(id) ?? propsRef.current.visits.find((visit) => visit.region.id === id)?.region
        ?? (propsRef.current.selectedRegion?.id === id ? propsRef.current.selectedRegion : undefined);
      if (known) return known;
      // Feature properties can outlive the country cache, particularly saved footprint points.
      const properties = feature.properties;
      if (!properties || !id || typeof properties.name !== 'string' || typeof properties.countryCode !== 'string') return;
      try {
        const center = typeof properties.center === 'string' ? JSON.parse(properties.center) : properties.center;
        const bbox = typeof properties.bbox === 'string' ? JSON.parse(properties.bbox) : properties.bbox;
        if (!Array.isArray(center) || center.length !== 2 || !center.every(Number.isFinite)) return;
        if (properties.level !== 'country' && properties.level !== 'local') return;
        return { ...properties, id, center, ...(Array.isArray(bbox) ? { bbox } : {}) } as Region;
      } catch { return; }
    };
    const interactiveLayers = () => [
      'footprint-ring', 'saved-area-fill',
      ...[...loaded].map((code) => `local-${code}-fill`),
      'country-hit',
    ].filter(id=>!!map?.getLayer(id));
    const getFeature = (point: { x: number; y: number }): MapGeoJSONFeature | undefined => {
      if (!map || disposed || !map.getLayer('country-hit')) return;
      // Space beside the globe is not a place: no hover card and no click there.
      if (!pointerOnSurface(map, point)) return;
      const features = map.queryRenderedFeatures([point.x, point.y], { layers: interactiveLayers() });
      return chooseMapFeature(features);
    };
    async function exactClickedRegion(feature:MapGeoJSONFeature|undefined,point:[number,number],signal:AbortSignal):Promise<Region|undefined>{
      const region=feature&&regionForFeature(feature);
      if(!region||feature?.layer.id==='footprint-ring'||feature?.layer.id==='saved-area-fill'||!partitionReader||!loaded.has(region.countryCode))return region;
      // Where the overview mesh draws local boundaries, a click inside one resolves to that exact area.
      if(region.level==='country'&&map&&map.getZoom()<(overviewBorderLayers.length?LOCAL_MIN_ZOOM:renderPolicies.get(region.countryCode)?.minZoom??LOCAL_MIN_ZOOM))return region;
      const suppressed=new Set(alignment.get(region.countryCode)?.suppressedIds??[]);
      const candidates=(await partitionReader.readPoint(region.countryCode,point,signal)).features;
      const exact=candidates.find(f=>!suppressed.has(String(f.id??f.properties?.id))&&polygonContainsPoint(f.geometry,point));
      return exact?registry.get(String(exact.id??exact.properties?.id))??presentRegion(exact.properties as unknown as Region,nameCatalog):region.level==='country'?region:undefined;
    }
    const clearHover = () => {
      if (hoverRef && map?.getSource(hoverRef.source)) map.setFeatureState(hoverRef, { hover: false });
      hoverRef = null;
      hoveredId = '';
      setHover(null);
      if (map) map.getCanvas().style.cursor = '';
    };
    const onVisibility = () => {
      if (!map || disposed) return;
      if (document.hidden) map.stop();
      else map.resize();
    };

    async function initialize() {
      try {
        const resources=atlasResources();
        void resources.read<NameQualityCatalog>('/data/name-quality.json').then(catalog=>{if(disposed||!catalog?.regions)return;nameCatalog=catalog;refreshNames();}).catch(()=>{});
        const [catalog,partitions]=await Promise.all([resources.read<{assets:BoundaryAssetCatalog}>('/data/geometry-assets.json'),resources.read<GeometryPartitionCatalog>('/data/geometry-partitions.json').catch(()=>null)]);
        if(disposed)return;assetCatalog=catalog.assets??{};
        if(partitions)partitionReader=createGeometryPartitionReader({catalog:partitions,concurrency:6,keepInFlight:true,cacheBytes:(desktop?192:96)*1024*1024,manifestCacheBytes:(desktop?32:24)*1024*1024,maxReadBytes:96*1024*1024,maxReadShards:256,persistentCache:createGeometryDiskCache()});
        const [maplibre,worldData,coverageData,alignedManifest]=await Promise.all([
          import('maplibre-gl'),readBoundaryAsset('/data/world.geojson',abort.signal,assetCatalog),resources.read<Coverage[]>('/data/coverage.json'),resources.read<{countries?:Record<string,AlignedCountry>}>('/data/geometry-alignment.json'),
        ]);
        if(disposed)return;
        const world=regionCollection(worldData,nameCatalog);
        worldOutline=world;
        for(const [code,item] of Object.entries(alignedManifest.countries??{}))alignment.set(code,item);
        if (!world.features.length) throw new Error('世界边界数据为空');
        if (!Array.isArray(coverageData)) throw new Error('地区覆盖目录格式无效');
        for (const item of coverageData) coverage.set(item.code, item);
        for (const feature of world.features) {
          const region = feature.properties;
          countryRegistry.set(region.id, region);
          const navigationBounds = primaryCountryBounds(feature.geometry, region.center);
          if (navigationBounds) countryNavigationBounds.set(region.id, navigationBounds);
          const group = countryByCode.get(region.countryCode) ?? [];
          group.push(region);
          countryByCode.set(region.countryCode, group);
        }
        for (const item of coverageData) {
          if (countryByCode.has(item.code) || !item.center || item.center.length !== 2 || !item.center.every(Number.isFinite)) continue;
          const region: Region = { id: `coverage-${item.code}`, level: 'country', adminLevel: 'ADM0', name: item.name,
            countryName: item.name, countryCode: item.code, center: item.center, bbox: item.bbox, year: item.year, source: item.source };
          countryRegistry.set(region.id, region);
          countryByCode.set(item.code, [region]);
          coverageOnlyRegions.push(region);
        }
        if (disposed) return;
        maplibre.setWorkerUrl(MAPLIBRE_WORKER_URL);
        map = new maplibre.Map({ container, style: baseStyle(world, propsRef.current.projection,propsRef.current.theme),
          center: INITIAL_CENTER, zoom: overviewZoom(), minZoom: 0.3, maxZoom: 16,
          pitch: 0, maxPitch: 45, renderWorldCopies: false, fadeDuration: duration(250),
          canvasContextAttributes: { antialias: true }, localIdeographFontFamily: LABEL_FONT,
          attributionControl: { compact: true }, dragRotate: false, touchPitch: false,
        });
        mapRef.current = map;
        const attribution=container.querySelector<HTMLElement>('.maplibregl-ctrl-attrib');
        if(attribution){const measure=()=>{if(!disposed)propsRef.current.onAttributionHeight(Math.ceil(attribution.getBoundingClientRect().height));};attributionResize=new ResizeObserver(measure);attributionResize.observe(attribution);measure();}
        map.getCanvas().setAttribute('aria-label', '可交互世界地图，使用方向键移动，加减键缩放；按问号键查看全部快捷键');
        // As in Google Earth, double-clicking with the right button zooms out around the pointer.
        const canvasContainer = map.getCanvasContainer();
        let rightPress = 0;
        canvasContainer.addEventListener('contextmenu', event => event.preventDefault());
        canvasContainer.addEventListener('mousedown', event => {
          if (event.button !== 2 || !map) return;
          const now = performance.now();
          if (now - rightPress > 400) { rightPress = now; return; }
          rightPress = 0;
          const box = canvasContainer.getBoundingClientRect();
          // The globe cannot ease around a point, so there it zooms out about the centre.
          const around = propsRef.current.projection === 'globe' ? undefined : map.unproject([event.clientX - box.left, event.clientY - box.top]);
          map.easeTo({ zoom: map.getZoom() - 1, around, duration: duration(350) });
        });
        map.getCanvas().setAttribute('role', 'application');
        map.on('error', (event) => {
          if (disposed) return;
          const sourceId=(event as unknown as {sourceId?:string}).sourceId;
          if(sourceId==='local-FRA'||sourceId==='local-FRA-labels'){const updates=countySourceUpdates.get('FRA'),updater=sourceId.endsWith('-labels')?updates?.label:updates?.shape;if(updater?.fail(event.error))return;}
          if(sourceId?.startsWith('local-')&&sourceId.endsWith('-land')){
            const source=map?.getSource(sourceId) as GeoJSONSource|undefined;
            const data=source?.serialize().data;
            if(source&&typeof data==='string'){
              const original=[...landRenderData.values(),...retiredLandRenderData].map(pool=>pool.original(data)).find(Boolean);
              // A browser policy may reject Blob fetching despite allowing URL creation.
              if(original){void source.setData(original).catch(()=>{});return;}
            }
          }
          const message = event.error?.message ?? '地图渲染遇到问题';
          console.error('[EarthMap]', event.error);
          reportError(`地图渲染遇到问题：${message}`);
        });
        map.on('webglcontextlost', () => {recoveringContext=true;for(const updates of countySourceUpdates.values()){updates.shape.dispose();updates.label.dispose();}countySourceUpdates.clear();reportError('地图图形上下文已中断，正在等待浏览器恢复。');});
        map.on('webglcontextrestored', () => { reportError(''); map?.resize(); });
        map.on('idle',()=>{
          if(!map||disposed)return;const restored=recoveringContext;recoveringContext=false;
          if(restored){applyTheme();applyVisits();select(propsRef.current.selectedRegion);scheduleVisibleCountries();}
          for(const code of loaded)if(usesCountySourceUpdates(code)&&!countySourceUpdates.has(code)){const data=displayedCountyViews.get(code);if(data)updateCountySources(code,data);}
          if(!retiredLandRenderData.size)return;
          // A recovery style may own URLs after the live sources have disappeared.
          const urls=Object.values(map.getStyle()?.sources??{}).flatMap(source=>source.type==='geojson'&&typeof source.data==='string'?[source.data]:[]);
          for(const pool of retiredLandRenderData)if(pool.disposeUnlessReferenced(urls))retiredLandRenderData.delete(pool);
        });
        map.on('load', () => {
          if (disposed || !map) return;
          map.setProjection({ type: propsRef.current.projection });
          map.setPadding(padding());
          for (const [id, region] of countryRegistry) registry.set(id, region);
          register(world, 'world');
          refreshNames();
          areaLoader=createVisitedAreaLoader({
            countries: world.features as Feature<Polygon|MultiPolygon>[],
            refineCountryIds: new Set([...alignment.keys()].map(code=>countryByCode.get(code)?.[0]?.id).filter((id):id is string=>!!id)),
            load: async (code,signal,ids) => {
              const item=coverage.get(code);
              if(!item)throw new Error('缺少已保存区域的边界目录');
              const read=async(url:string)=>await readBoundaryAsset(url,signal,assetCatalog) as FeatureCollection<Polygon|MultiPolygon>;
              const aligned=alignment.get(code);
              const localIds=(ids??[]).filter(id=>!countryRegistry.has(id)&&!id.startsWith('coverage-'));
              let areas:FeatureCollection<Polygon|MultiPolygon>;
              if(partitionReader)areas=await partitionReader.readIDs(code,localIds,signal);
              else{const original=await read(aligned?.legacyPaintUrl||item.paintUrl||item.localUrl);const primary=await read(aligned?.localUrl||item.localUrl);areas=mergeAreaAssets(original,primary);}
              const features=new Map(areas.features.map(f=>[String(f.id??f.properties?.id),f]));
              const country=countryByCode.get(code)?.[0];
              if(aligned&&country&&(ids??[]).includes(country.id)){const land=(await read(aligned.countryUrl||aligned.landUrl)).features[0];if(land)features.set(country.id,{...land,id:country.id,properties:country});}
              return {type:'FeatureCollection',features:[...features.values()]};
            },
            publish: data => {
              if(!map||disposed)return;
              (map.getSource('saved-areas') as GeoJSONSource).setData(data);
              const now=performance.now(),present=new Set(data.features.map(feature=>String(feature.id)));
              for(const id of claimPulses(pendingPulses,present,now)){
                if(reducedMotion.matches)map.setFeatureState({source:'saved-areas',id},{illumination:1,glow:0});
                else {areaPulses.set(id,now);map.setFeatureState({source:'saved-areas',id},{illumination:0,glow:0});}
              }
              for(const id of areaPulses.keys())if(!present.has(id))areaPulses.delete(id);
              if(areaPulses.size&&!areaFrame)areaFrame=requestAnimationFrame(animateAreas);
            },
            onError: code => reportError(`${coverage.get(code)?.name??code}的回忆已保存，区域颜色暂时未能载入；可以重新打开页面重试。`),
          });
          syncVisitsRef.current = applyVisits;
          syncThemeRef.current=()=>{applyTheme();applyVisits();};
          applyTheme();
          // Selecting only highlights; camera moves come from explicit flyTo (search, lists) or reveal (map clicks).
          syncSelectionRef.current = select;
          applyVisits();
          select(propsRef.current.selectedRegion);
          // A place chosen before the map was ready still deserves its flight.
          if (propsRef.current.selectedRegion) fly(propsRef.current.selectedRegion);
          if(partitionReader){
            preloader=createGeometryPreloader({load:(code,signal,onProgress)=>partitionReader!.preloadCountry(code,{signal,onProgress}),publish:progress=>{if(disposed)return;if(!progress){setPreloading(null);return;}if(progress.done===progress.total)void upgradeCountry(progress.code);const percent=progress.total?Math.floor(progress.done/progress.total*10)*10:0;setPreloading(`正在提前加载${coverage.get(progress.code)?.name??progress.code}区界 · ${percent}%`);}});
            preloadTimer=setTimeout(schedulePreloads,300);
          }
          setReady(true);
          setZoom(map.getZoom());
          propsRef.current.onReady({
            flyTo: fly,
            reveal,
            pulse: regionId => { pendingPulses.set(regionId, performance.now()); },
            reset: () => { focusCode = null; viewCodes = []; updateTargets(); map?.flyTo({ center: INITIAL_CENTER, zoom: overviewZoom(), bearing: 0, pitch: 0, padding: padding(), duration: duration(1300), essential: false }); },
            zoomIn: () => map?.zoomIn({ duration: duration(350) }),
            zoomOut: () => map?.zoomOut({ duration: duration(350) }),
            zoomBy: levels => { if (map) map.easeTo({ zoom: map.getZoom() + levels, duration: duration(350) }); },
            stop: () => { map?.stop(); },
          });
          scheduleVisibleCountries();
          map.on('click', (event) => {
            const sequence=++clickSequence,revision=cameraRevision,point={x:event.point.x,y:event.point.y},lnglat:[number,number]=[event.lngLat.lng,event.lngLat.lat];
            const initial=getFeature(point),region=initial&&regionForFeature(initial);if(!region||!map)return;
            const mode=propsRef.current.mode,independent=mode==='light'&&region.level==='local';
            // Each visible county click is a save intent. A later click must not cancel its exact lookup.
            const active=()=>!disposed&&revision===cameraRevision&&mode===propsRef.current.mode&&(independent||sequence===clickSequence);
            void(async()=>{
              try{
                if(region.level==='country'&&coverage.has(region.countryCode)&&!loaded.has(region.countryCode)&&map!.getZoom()>=LOCAL_MIN_ZOOM){focusCode=region.countryCode;updateTargets();await boundaryLoader.request(region.countryCode);}
                if(!active())return;
                const hit=getFeature(point)??initial;
                const exact=await exactClickedRegion(hit,lnglat,abort.signal);
                if(exact&&active())propsRef.current.onRegionClick(exact);
              }catch{if(active())reportError('此处精细边界暂时未能载入，请稍后重试。');}
            })();
          });
          map.on('mousemove', (event) => {
            if (!map || map.isMoving()) return;
            const feature = getFeature(event.point);
            const region = feature && regionForFeature(feature);
            if (!region || !feature) { if (hoveredId) clearHover(); return; }
            map.getCanvas().style.cursor = 'pointer';
            if (region.id !== hoveredId) {
              if (hoverRef) map.setFeatureState(hoverRef, { hover: false });
              hoverRef = featureRef(region);
              if (hoverRef) map.setFeatureState(hoverRef, { hover: true });
              hoveredId = region.id;
            }
            setHover({ name: region.name, detail: region.level === 'country' ? '国家 / 地区' : [region.parentName, region.countryName].filter(Boolean).join(' · '), x: Math.max(8, Math.min(event.point.x + 15, container.clientWidth - 205)), y: Math.max(8, Math.min(event.point.y + 17, container.clientHeight - 78)) });
          });
          map.on('movestart', event => {
            cameraRevision++;detailAbort?.abort();cancelRelease();
            clearHover();
            clearTimeout(viewTimer);
            if (event.originalEvent) { focusCode = null; viewCodes = []; updateTargets(); }
          });
          let starCamera={lng:map.getCenter().lng,lat:map.getCenter().lat,x:0,y:0};
          map.on('move',()=>{
            if(!map)return;
            const center=map.getCenter();starCamera=advanceStarfield(starCamera,center.lng,center.lat,reducedMotion.matches||propsRef.current.projection!=='globe');
            starfieldRef.current?.style.setProperty('--star-x',`${starCamera.x}px`);
            starfieldRef.current?.style.setProperty('--star-y',`${starCamera.y}px`);
          });
          map.on('moveend', scheduleVisibleCountries);
          map.on('zoom',syncCoarseVisibility);
          map.once('idle',ensureOverviewBorders);
          container.addEventListener('mouseleave', clearHover);
        });
        resize = new ResizeObserver(() => {
          cancelAnimationFrame(resizeFrame);
          resizeFrame = requestAnimationFrame(() => { if (!disposed && map) { map.resize(); map.setPadding(padding()); } });
        });
        resize.observe(container);
        document.addEventListener('visibilitychange', onVisibility);
      } catch (error) {
        if (disposed || abort.signal.aborted) return;
        const message = error instanceof Error ? error.message : '地图未能载入';
        setFailure(message);
        reportError(message);
      }
    }
    void initialize();
    return () => {
      disposed = true;
      abort.abort();detailAbort?.abort();preloader?.dispose();partitionReader?.clear();
      clearTimeout(preloadTimer);
      clearTimeout(viewTimer);
      for (const cleanup of renderCleanups) cleanup();
      boundaryLoader.dispose();
      detailWorker?.terminate();
      for (const waiter of detailWaiters.values()) waiter.reject(new Error('地图已关闭'));
      areaLoader?.dispose();
      cancelAnimationFrame(areaFrame);
      retryCountryRef.current = null;
      resize?.disconnect();attributionResize?.disconnect();cancelRelease();
      cancelAnimationFrame(resizeFrame);
      document.removeEventListener('visibilitychange', onVisibility);
      container.removeEventListener('mouseleave', clearHover);
      syncVisitsRef.current = null;
      syncThemeRef.current=null;
      syncSelectionRef.current = null;
      mapRef.current = null;
      map?.remove();
      for(const updates of countySourceUpdates.values()){updates.shape.dispose();updates.label.dispose();}countySourceUpdates.clear();
      for(const pool of [...landRenderData.values(),...retiredLandRenderData])pool.dispose();landRenderData.clear();retiredLandRenderData.clear();
    };
  }, []);

  useEffect(()=>{const map=mapRef.current;if(map&&ready&&paddingRef.current)map.setPadding(paddingRef.current());},[props.sidebarVisible,props.timelineVisible,props.showHints,ready]);
  useEffect(() => { syncVisitsRef.current?.(); }, [props.visits]);
  useEffect(()=>{syncThemeRef.current?.();},[props.theme]);
  useEffect(() => { syncSelectionRef.current?.(props.selectedRegion); }, [props.selectedRegion]);
  useEffect(() => {
    const map = mapRef.current;
    if (map && ready) map.setProjection({ type: props.projection });
  }, [props.projection, ready]);

  return (
    <div className="earth-map-shell" data-ready={ready} data-projection={props.projection} style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: props.projection==='globe'?mapPalette(props.theme).space:mapPalette(props.theme).ocean }}>
      <div ref={starfieldRef} hidden={props.projection!=='globe'} className="earth-starfield" aria-hidden="true"/>
      <div ref={containerRef} className="earth-map-canvas" style={{ position: 'absolute', inset: 0 }} />
      <div aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: 'var(--map-shade)' }} />
      {!ready && !failure && <div role="status" className="earth-map-loading" style={{ position: 'absolute', top: '48%', left: '55%', transform: 'translate(-50%,-50%)', textAlign: 'center', color: 'var(--muted)', fontSize: 13, pointerEvents: 'none' }}>
        <span style={{ display: 'block', marginBottom: 12, fontSize: 28, color: 'var(--gold)' }}>◎</span>正在展开世界
      </div>}
      {failure && <div role="alert" style={{ position: 'absolute', inset: '40% 15% auto 35%', padding: 22, borderRadius: 22, background: 'var(--panel)', color: 'var(--ink)', fontSize: 13, lineHeight: 1.6 }}>
        <strong style={{ display: 'block', marginBottom: 8 }}>地图暂时无法显示</strong>{failure}
      </div>}
      {hover && ready && <div className="earth-map-hover" style={{ position: 'absolute', left: hover.x, top: hover.y }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{hover.name}</div>
        <div style={{ marginTop: 2, fontSize: 12, color: 'var(--muted)' }}>{hover.detail}</div>
        {props.mode === 'light' && <div style={{ marginTop: 6, fontSize: 11, fontWeight: 500, color: 'var(--gold)' }}>点击，点亮整片区域</div>}
      </div>}
      {ready && (props.showHints||!!loadingCountry||!!failedCountry) && <div className="earth-map-status" role="status" aria-live="polite">
        <span style={{ width: 4, height: 4, borderRadius: '50%', background: loadingCountry ? '#d1b175' : '#799e8b' }} />
        {loadingCountry ? `正在载入${loadingCountry}地区边界` : failedCountry ? <>{failedCountry.name}边界未载入 <button type="button" className="text-link" style={{ pointerEvents: 'auto', fontSize: 'inherit' }} onClick={() => retryCountryRef.current?.(failedCountry.code)}>重试</button></> : preloading ? preloading : !overviewReady&&deferredDetail&&zoom>=LOCAL_MIN_ZOOM&&zoom<detailZoom ? '继续放大查看县市边界，也可以搜索具体地区' : zoom >= LOCAL_MIN_ZOOM ? '点击边界内的区域，记录这一站' : '拖动探索地球 · 滚动放大至城市与区县'}
        {props.showHints&&<button type="button" className="panel-close" aria-label="关闭地图状态提示" title="关闭地图提示" onClick={props.onHideHints}><X size={15}/></button>}
      </div>}
    </div>
  );
}
