import type { Geometry, Position } from 'geojson';

type Bounds = [number, number, number, number];

function contains(ring: Position[], [lng, lat]: [number, number]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x, y] = ring[i], [previousX, previousY] = ring[j];
    if ((y > lat) !== (previousY > lat)
      && lng < (previousX - x) * (lat - y) / (previousY - y) + x) inside = !inside;
  }
  return inside;
}

/** Frame the landmass containing the country's representative center.
 * Whole-country bounds can include overseas territories thousands of miles away.
 * Keep the ordinary center-based camera fallback for dateline-spanning geometry.
 */
export function primaryCountryBounds(geometry: Geometry, center: [number, number]): Bounds | undefined {
  const rings = geometry.type === 'Polygon' ? [geometry.coordinates[0]]
    : geometry.type === 'MultiPolygon' ? geometry.coordinates.map(polygon => polygon[0]) : [];
  const candidates = rings.filter((ring): ring is Position[] => !!ring && ring.length >= 4
    && ring.every(point => Number.isFinite(point[0]) && Number.isFinite(point[1]))).map(ring => {
    const bounds: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
    let twiceArea = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x, y] = ring[i], [nextX, nextY] = ring[(i + 1) % ring.length];
      bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y);
      bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], y);
      twiceArea += x * nextY - nextX * y;
    }
    return { bounds, containsCenter: contains(ring, center), area: Math.abs(twiceArea) };
  });
  candidates.sort((a, b) => Number(b.containsCenter) - Number(a.containsCenter) || b.area - a.area);
  const bounds = candidates[0]?.bounds;
  return bounds && bounds[2] > bounds[0] && bounds[3] > bounds[1] && bounds[2] - bounds[0] < 175
    ? bounds : undefined;
}
