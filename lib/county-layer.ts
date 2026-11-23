import type { Feature, FeatureCollection, Geometry, Polygon, MultiPolygon } from 'geojson';
import type { Region } from './model';

export const REGION_INDEX_FIELDS = ['id', 'name', 'originalName', 'aliases', 'parentName', 'countryCode', 'countryName', 'level', 'adminLevel', 'center', 'bbox', 'year', 'source'] as const;
export type ViewBox = [number, number, number, number];

export interface RegionIndex {
  v: 1;
  fields: string[];
  rows: unknown[][];
  sources?:string[];
  geometry?: string;
  extras?: Feature<Polygon | MultiPolygon>[];
}

export function isRegionIndex(value: unknown): value is RegionIndex {
  return !!value && typeof value === 'object' && (value as RegionIndex).v === 1 && Array.isArray((value as RegionIndex).rows) && Array.isArray((value as RegionIndex).fields);
}

export function regionsFromIndex(index: RegionIndex): Region[] {
  return index.rows.map((row) => {
    const region: Record<string, unknown> = {};
    index.fields.forEach((field, position) => {
      const value = row[position];
      if (value != null && value !== '') region[field] = field==='source'&&typeof value==='number'?index.sources?.[value]:value;
    });
    return region as unknown as Region;
  }).filter((region) => typeof region.id === 'string' && Array.isArray(region.center) && region.center.length === 2);
}

export function countyFeatures(regions: Region[], paint: FeatureCollection, extras: Feature[] = []): FeatureCollection<Polygon | MultiPolygon, Region> {
  const geometry = new Map<string, Polygon | MultiPolygon>();
  for (const feature of [...paint.features, ...extras]) {
    const id = String(feature.id ?? (feature.properties as { id?: string } | null)?.id ?? '');
    if (id && (feature.geometry?.type === 'Polygon' || feature.geometry?.type === 'MultiPolygon')) geometry.set(id, feature.geometry);
  }
  return {
    type: 'FeatureCollection',
    features: regions.flatMap((region) => {
      const shape = geometry.get(region.id);
      return shape ? [{ type: 'Feature' as const, id: region.id, properties: region, geometry: shape }] : [];
    }),
  };
}

function ranges(box: ViewBox): Array<[number, number]> {
  const width=box[2]>=box[0]?box[2]-box[0]:box[2]+360-box[0];
  if(width>=360)return [[-180,180]];
  const west=((box[0]+180)%360+360)%360-180;
  const east=west+width;
  return east<=180?[[west,east]]:[[west,180],[-180,east-360]];
}

export function boxesOverlap(feature: ViewBox, view: ViewBox): boolean {
  if (feature[3] < view[1] || feature[1] > view[3]) return false;
  const across = ranges(feature);
  return ranges(view).some(([west, east]) => across.some(([left, right]) => right >= west && left <= east));
}

export function featuresInView<T extends Feature>(features: T[], view: ViewBox, extraIds: Iterable<string> = []): T[] {
  const forced = new Set(extraIds);
  return features.filter((feature) => {
    const id = String(feature.id ?? (feature.properties as { id?: string } | null)?.id ?? '');
    if (forced.has(id)) return true;
    const box = (feature.properties as { bbox?: ViewBox } | null)?.bbox;
    if (!box || box.length !== 4) return true;
    return boxesOverlap(box, view);
  });
}

export function paddedView(west: number, south: number, east: number, north: number): ViewBox {
  const lon = Math.abs(east - west);
  const lat = Math.abs(north - south);
  const padLon = Math.max(lon * 0.35, 0.4);
  const padLat = Math.max(lat * 0.35, 0.3);
  return [west - padLon, Math.max(-85, south - padLat), east + padLon, Math.min(85, north + padLat)];
}

/** Resolve the current pickable layer; historical/suppressed IDs never re-enter at high zoom. */
export function detailedCountyFeatures(features: Feature<Polygon|MultiPolygon>[], registry: Map<string,Region>, suppressed: Set<string>): FeatureCollection<Polygon|MultiPolygon,Region> {
 return {type:'FeatureCollection',features:features.flatMap(feature=>{
  const id=String(feature.id??feature.properties?.id??'');
  const region=registry.get(id);
  return region&&!suppressed.has(id)?[{type:'Feature' as const,id,properties:region,geometry:feature.geometry}]:[];
 })};
}
