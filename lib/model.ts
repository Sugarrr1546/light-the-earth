export type VisitStatus = 'visited' | 'lived' | 'passed' | 'wishlist';

export interface Region {
  id: string;
  name: string;
  originalName?: string;
  nameStatus?: 'source'|'verified'|'encoding-repaired'|'unresolved'|'boundary-undetermined';
  nameNote?: string;
  nameSourceUrl?: string;
  boundaryStatus?:'current'|'historical';
  aliases?: string[];
  countryCode: string;
  countryName: string;
  level: 'country' | 'local';
  adminLevel?: string;
  parentName?: string;
  center: [number, number];
  bbox?: [number, number, number, number];
  source?: string;
  year?: string;
}

export interface Photo {
  id: string;
  url: string;
  filename: string;
}

export interface Visit {
  id: string;
  region: Region;
  status: VisitStatus;
  visitedOn: string;
  title: string;
  notes: string;
  tripName: string;
  photos: Photo[];
  createdAt: string;
  updatedAt: string;
}

export interface Coverage {
  code: string;
  name: string;
  localUrl: string;
  adminLevel: string;
  label: string;
  year: string;
  source: string;
  license: string;
  coverageNote: string;
  count: number;
  displayCount?: number;
  sourceUrl?: string;
  center?: [number, number];
  bbox?: [number, number, number, number];
  canonical?: string;
  detailTier?: 'local' | 'regional';
  paintUrl?: string;
  legacyUrls?: string[];
  partial?: boolean;
}

export interface MapController {
  flyTo: (region: Region, showDetail?: boolean) => void;
  /** Keep the zoom; pan only if the detail drawer would cover the place. */
  reveal: (region: Region) => void;
  /** Light up a region with the soft save pulse the next time its saved area is drawn. */
  pulse: (regionId: string) => void;
  reset: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  /** Zoom by a number of levels, positive in, negative out. */
  zoomBy: (levels: number) => void;
  /** Halt any camera flight or glide. */
  stop: () => void;
  /** Move the map as an arrow key pressed on the map would. */
  keyboardMove: (event: KeyboardEvent) => void;
}

export const STATUS_LABEL: Record<VisitStatus, string> = {
  visited: '到访过', lived: '居住过', passed: '途经过', wishlist: '想去',
};
