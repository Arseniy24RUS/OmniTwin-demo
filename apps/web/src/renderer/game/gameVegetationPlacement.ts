import { MercatorCoordinate } from 'maplibre-gl';
import { createDeterministicRng, hashSeed } from '../rng';
import { extractSourceVegetationFeatures, type QuerySourceVegetationFeatureLike } from '../universal/vegetation';
import type { VerifiedCityBuildingSnapshot } from '../verifiedCityBuildingTypes';
import { localToMercatorMatrix, type GameOrigin } from './cameraAdapter';
import { GAME_ROAD_CLASS_WIDTHS, resolveGameRoadWidth, type GameRoadWidthSource } from './gameRoadWidth';

export interface GameVegetationFeature extends QuerySourceVegetationFeatureLike {}
export interface GameVegetationRoad extends GameRoadWidthSource {
  readonly geometry?: unknown;
  /** Verified CityRoadV2 centerline; GeoJSON query rows instead use geometry. */
  readonly coordinates?: readonly (readonly [number, number])[];
  readonly properties?: Readonly<Record<string, unknown>> | null;
  readonly sourceAttributes?: Readonly<Record<string, unknown>>;
  readonly className?: string;
  readonly widthM?: number;
  readonly width?: unknown;
}
type Bounds = readonly [number, number, number, number];
type Point = readonly [number, number];
export interface GameVegetationOptions {
  origin: GameOrigin;
  /** Exact retained building-source coverage rectangle, not an unverified camera extent. */
  bounds: Bounds;
  buildings: VerifiedCityBuildingSnapshot | null;
  roads: readonly GameVegetationRoad[];
  qualityTier?: 'low' | 'medium' | 'high';
  sourceId?: string;
  datasetVersion?: string;
  loading?: boolean;
  /** Additional route/clearance policy in local East / South metres. */
  isPointClear?: (east: number, south: number, crownRadius: number) => boolean;
}
export interface GameTreePlacement {
  id: string;
  x: number; z: number; y: number;
  radius: number; height: number; rotation: number; color: number;
  sourceKey: string;
  geometryQuality: 'exact_tree_point' | 'area_derived';
  provenance: 'visual_synthesis';
}
export const GAME_VEGETATION_LIMITS = Object.freeze({
  instances: { low: 128, medium: 512, high: 900 }, features: 4096, sourceVertices: 131072,
  buildings: 12000, buildingVertices: 500000, roads: 8192, roadVertices: 131072,
  gridCandidates: 32768, operations: 8_000_000, indexEntries: 200000,
});
/** Metres are display clearance assumptions only, never claimed road measurements. */
export const GAME_VEGETATION_ROAD_WIDTHS = GAME_ROAD_CLASS_WIDTHS;
const CIRCUMFERENCE = 40075016.68557849;
const GRID = 30; // Fixed world Mercator metres, ~17m physical spacing in Chelyabinsk.
function areaDensity(gx:number,gz:number):number{
  const x=gx/4,z=gz/4,ix=Math.floor(x),iz=Math.floor(z),smooth=(v:number)=>v*v*(3-2*v),tx=smooth(x-ix),tz=smooth(z-iz);
  const value=(a:number,b:number)=>createDeterministicRng(`tree-density-v2:${a}:${b}`)();
  return .54+.4*((value(ix,iz)*(1-tx)+value(ix+1,iz)*tx)*(1-tz)+(value(ix,iz+1)*(1-tx)+value(ix+1,iz+1)*tx)*tz);
}
const EPS = 1e-5;
interface Polygon { rings: Point[][]; bounds: Bounds; sourceKey: string }
interface Segment { a: Point; b: Point; radius: number; bounds: Bounds }
const overlap = (a: Bounds, b: Bounds) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const around = (p: Point, radius: number): Bounds => [p[0] - radius, p[1] - radius, p[0] + radius, p[1] + radius];
function boundsOf(points: readonly Point[], radius = 0): Bounds {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of points) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  return [x0 - radius, z0 - radius, x1 + radius, z1 + radius];
}
function validPoint(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number'
    && Number.isFinite(value[0]) && Number.isFinite(value[1]) && Math.abs(value[0]) <= 180 && Math.abs(value[1]) < 85.051129;
}
function validBounds(b: Bounds) { return b.length === 4 && b.every(Number.isFinite) && b[0] < b[2] && b[1] < b[3]
  && Math.abs(b[0]) <= 180 && Math.abs(b[2]) <= 180 && Math.abs(b[1]) < 85.051129 && Math.abs(b[3]) < 85.051129; }
function requireVerified(options: GameVegetationOptions): VerifiedCityBuildingSnapshot {
  const source = options.buildings;
  if (!source || source.coverage !== 'complete_viewport' || source.invalidBuildings || source.omittedBuildings
    || !validBounds(options.bounds)) throw Error('Vegetation requires complete verified building coverage');
  if (source.data.features.length > GAME_VEGETATION_LIMITS.buildings) throw Error('Vegetation building budget exceeded');
  return source;
}
function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0], dz = b[1] - a[1], length = dx * dx + dz * dz;
  const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / length)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz);
}
function inRing(p: Point, ring: readonly Point[], spend: (n: number) => void): boolean {
  spend(ring.length); let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function inside(p: Point, polygon: Polygon, spend: (n: number) => void): boolean {
  return overlap(around(p, 0), polygon.bounds) && inRing(p, polygon.rings[0]!, spend)
    && !polygon.rings.slice(1).some(ring => inRing(p, ring, spend));
}
function edges(polygon: Polygon): [Point, Point][] {
  return polygon.rings.flatMap(ring => ring.map((p, i) => [p, ring[(i + 1) % ring.length]!] as [Point, Point]));
}
class SpatialIndex<T extends { bounds: Bounds }> {
  private readonly buckets = new Map<string, number[]>();
  private readonly large: number[] = [];
  private entries = 0;
  constructor(private readonly items: readonly T[]) {
    items.forEach((item, index) => {
      const [x0, z0, x1, z1] = item.bounds.map(v => Math.floor(v / 100));
      if ((x1! - x0! + 1) * (z1! - z0! + 1) > 1024) { this.large.push(index); return; }
      for (let z = z0!; z <= z1!; z++) for (let x = x0!; x <= x1!; x++) {
        if (++this.entries > GAME_VEGETATION_LIMITS.indexEntries) throw Error('Vegetation spatial index budget exceeded');
        const key = `${x}:${z}`, bucket = this.buckets.get(key) ?? []; bucket.push(index); this.buckets.set(key, bucket);
      }
    });
  }
  query(bounds: Bounds): T[] {
    const indices = new Set(this.large), [x0, z0, x1, z1] = bounds.map(v => Math.floor(v / 100));
    for (let z = z0!; z <= z1!; z++) for (let x = x0!; x <= x1!; x++) {
      for (const index of this.buckets.get(`${x}:${z}`) ?? []) indices.add(index);
    }
    return [...indices].map(i => this.items[i]!).filter(item => overlap(bounds, item.bounds));
  }
}

/** Circle containment in a union, removing internal tile edges but preserving real shores and holes. */
function fitsAreaUnion(p: Point, radius: number, polygons: readonly Polygon[], spend: (n: number) => void): boolean {
  const contains = (point: Point) => polygons.some(polygon => inside(point, polygon, spend));
  if (!contains(p)) return false;
  // The common interior case needs no edge clipping.
  for (const polygon of polygons) {
    if (!inside(p, polygon, spend)) continue;
    const boundary = edges(polygon); spend(boundary.length);
    if (boundary.every(([a, b]) => segmentDistance(p, a, b) >= radius)) return true;
  }
  const segments = polygons.flatMap(edges).filter(([a, b]) => { spend(1); return segmentDistance(p, a, b) < radius; });
  for (const [a, b] of segments) {
    const dx = b[0] - a[0], dz = b[1] - a[1], length2 = dx * dx + dz * dz;
    if (length2 < EPS * EPS) continue;
    const projection = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / length2;
    const perpendicular2 = (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2 - projection ** 2 * length2;
    const half = Math.sqrt(Math.max(0, radius * radius - perpendicular2) / length2);
    const lo = Math.max(0, projection - half), hi = Math.min(1, projection + half), cuts = [lo, hi];
    // Every crossing partitions the edge into intervals with constant union membership.
    for (const [c, d] of segments) {
      spend(1); const ex = d[0] - c[0], ez = d[1] - c[1], determinant = dx * ez - dz * ex;
      if (Math.abs(determinant) < 1e-9) {
        if (Math.abs((c[0] - a[0]) * dz - (c[1] - a[1]) * dx) < EPS) {
          for (const v of [c, d]) { const t = ((v[0] - a[0]) * dx + (v[1] - a[1]) * dz) / length2; if (t > lo && t < hi) cuts.push(t); }
        }
        continue;
      }
      const cx = c[0] - a[0], cz = c[1] - a[1], t = (cx * ez - cz * ex) / determinant, u = (cx * dz - cz * dx) / determinant;
      if (t > lo && t < hi && u >= 0 && u <= 1) cuts.push(t);
    }
    cuts.sort((a, b) => a - b);
    const length = Math.sqrt(length2), nx = -dz / length * EPS, nz = dx / length * EPS;
    for (let i = 1; i < cuts.length; i++) {
      if (cuts[i]! - cuts[i - 1]! < 1e-10) continue;
      const t = (cuts[i]! + cuts[i - 1]!) / 2, x = a[0] + dx * t, z = a[1] + dz * t;
      if (!contains([x + nx, z + nz]) || !contains([x - nx, z - nz])) return false;
    }
  }
  return true;
}

export function prepareGameVegetation(features: readonly GameVegetationFeature[], options: GameVegetationOptions) {
  const verified = requireVerified(options); localToMercatorMatrix(options.origin);
  if (features.length > GAME_VEGETATION_LIMITS.features || options.roads.length > GAME_VEGETATION_LIMITS.roads) throw Error('Vegetation source feature budget exceeded');
  const tier = options.qualityTier ?? 'medium', capacity = GAME_VEGETATION_LIMITS.instances[tier];
  if (!capacity) throw Error('Invalid vegetation quality tier');
  let operations = 0;
  const spend = (n: number) => { operations += n; if (operations > GAME_VEGETATION_LIMITS.operations) throw Error('Vegetation geometry work budget exceeded'); };
  const anchor = MercatorCoordinate.fromLngLat([options.origin.longitude, options.origin.latitude]);
  const meter = anchor.meterInMercatorCoordinateUnits(), scale = meter * CIRCUMFERENCE;
  const local = (p: Point): Point => { const m = MercatorCoordinate.fromLngLat([p[0], p[1]]); return [(m.x - anchor.x) / meter, (m.y - anchor.y) / meter]; };
  const parsePolygons = (geometry: unknown, budget: { remaining: number }, sourceKey: string): Polygon[] => {
    const g = geometry as { type?: string; coordinates?: unknown } | null;
    const polygons = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : null;
    if (!Array.isArray(polygons) || !polygons.length) throw Error('Invalid vegetation polygon source');
    return polygons.map(polygon => {
      if (!Array.isArray(polygon) || !polygon.length) throw Error('Invalid vegetation source rings');
      const rings = polygon.map(ring => {
        if (!Array.isArray(ring) || ring.length < 4 || (budget.remaining -= ring.length) < 0 || !ring.every(validPoint)) throw Error('Invalid or oversized vegetation ring');
        const points = ring.map(p => local(p as Point));
        if (Math.hypot(points[0]![0] - points.at(-1)![0], points[0]![1] - points.at(-1)![1]) > EPS) throw Error('Unclosed vegetation source ring');
        points.pop();
        const offset = points[0]!;
        const area = points.reduce((sum, p, i) => { const q = points[(i + 1) % points.length]!;
          return sum + (p[0] - offset[0]) * (q[1] - offset[1]) - (q[0] - offset[0]) * (p[1] - offset[1]); }, 0);
        if (Math.abs(area) < EPS * EPS) throw Error('Degenerate vegetation source ring');
        return points;
      });
      return { rings, bounds: boundsOf(rings[0]!), sourceKey };
    });
  };
  let coverage = options.bounds;
  if (verified.coverageBounds) {
    if (!validBounds(verified.coverageBounds)) throw Error('Invalid verified vegetation coverage');
    coverage = [Math.max(coverage[0], verified.coverageBounds[0]), Math.max(coverage[1], verified.coverageBounds[1]),
      Math.min(coverage[2], verified.coverageBounds[2]), Math.min(coverage[3], verified.coverageBounds[3])];
    if (!validBounds(coverage)) throw Error('No verified vegetation coverage intersection');
  }
  const nw = local([coverage[0], coverage[3]]), se = local([coverage[2], coverage[1]]), bounds: Bounds = [nw[0], nw[1], se[0], se[1]];
  const acceptable = features.filter(feature => {
    const tags = feature.properties ?? {}, values = ['natural', 'class', 'subclass', 'landuse', 'leisure', 'forest_class', 'type']
      .map(key => typeof tags[key] === 'string' ? (tags[key] as string).toLowerCase() : '');
    return feature.geometry?.type === 'Point' ? values.includes('tree')
      : ['landuse', 'landcover'].includes(String(feature.sourceLayer)) && values.some(v => ['wood', 'forest', 'park', 'garden'].includes(v));
  });
  // Validate before the shared extractor copies/hash-normalizes coordinates.
  const sourceBudget = { remaining: GAME_VEGETATION_LIMITS.sourceVertices };
  for (const feature of acceptable) {
    if (feature.geometry?.type === 'Point') { if (!validPoint(feature.geometry.coordinates)) throw Error('Invalid source tree point'); }
    else parsePolygons(feature.geometry, sourceBudget, 'preflight');
  }
  const sourceId = options.sourceId ?? 'openmaptiles', datasetVersion = options.datasetVersion ?? 'basemap-source';
  const extracted = extractSourceVegetationFeatures(acceptable, { sourceId, datasetVersion });
  const areas: Polygon[] = [], exact: { p: Point; key: string }[] = [];
  for (const feature of extracted) {
    const key = `${feature.sourceId}:${feature.datasetVersion}:${feature.sourceFeatureId}`;
    if (feature.kind === 'tree') exact.push({ p: local(feature.coordinate), key });
    else areas.push(...parsePolygons({ type: 'MultiPolygon', coordinates: feature.polygons }, { remaining: GAME_VEGETATION_LIMITS.sourceVertices }, key));
  }
  const obstacles: Polygon[] = [], buildingBudget = { remaining: GAME_VEGETATION_LIMITS.buildingVertices };
  for (const feature of verified.data.features) {
    const id = feature.properties?.canonical_id;
    if (typeof id !== 'string' || !verified.canonicalIds.has(id)) throw Error('Unverified vegetation building identity');
    obstacles.push(...parsePolygons(feature.geometry, buildingBudget, id)
      .filter(p => overlap([bounds[0] - 6, bounds[1] - 6, bounds[2] + 6, bounds[3] + 6], p.bounds)));
  }
  const diagnostics = { representation: 'visual_synthesis' as const, sourceAreas: areas.length, sourceTrees: exact.length,
    sourceWidthRoads: 0, laneWidthRoads: 0, classWidthRoads: 0, roadWidthPolicy: 'source_width_else_visual_lanes_3m_plus_0_6m_else_visual_class_width' as const,
    collisionPolicy: 'crown_radius_plus_2_5m' as const,placementPolicy:'world_cell_scatter_with_density_v2' as const,
    rejectedCandidates: 0, gridCandidates: 0,densitySkippedCandidates:0, truncated: false, operations: 0 };
  const roadSegments: Segment[] = [], roadKeys = new Set<string>(); let roadVertices = GAME_VEGETATION_LIMITS.roadVertices;
  for (const road of options.roads) {
    if (!road || typeof road !== 'object') throw Error('Missing vegetation road geometry');
    const geometry = (road.geometry ?? (road.coordinates === undefined ? null : { type: 'LineString', coordinates: road.coordinates })) as
      { type?: string; coordinates?: unknown } | null;
    const lines = Array.isArray(geometry) ? [geometry] : geometry?.type === 'LineString' ? [geometry.coordinates]
      : geometry?.type === 'MultiLineString' ? geometry.coordinates : null;
    if (!Array.isArray(lines) || !lines.length) throw Error('Missing or unsupported vegetation road geometry');
    const info = resolveGameRoadWidth(road), radius = info.width / 2 + 2.5;
    for (const line of lines) {
      if (!Array.isArray(line) || line.length < 2 || (roadVertices -= line.length) < 0 || !line.every(validPoint)) throw Error('Invalid or oversized vegetation road');
      const key = JSON.stringify([radius, line]); if (roadKeys.has(key)) continue; roadKeys.add(key);
      diagnostics[info.source === 'source' ? 'sourceWidthRoads' : info.source === 'lanes' ? 'laneWidthRoads' : 'classWidthRoads']++;
      const points = line.map(p => local(p as Point));
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1]!, b = points[i]!, box = boundsOf([a, b], radius);
        if (overlap(box, bounds)) roadSegments.push({ a, b, radius, bounds: box });
      }
    }
  }
  const areaIndex = new SpatialIndex(areas), buildingIndex = new SpatialIndex(obstacles), roadIndex = new SpatialIndex(roadSegments);
  const candidates = new Map<string, { id: string; p: Point; sourceKey: string; exact: boolean; priority: number }>();
  const center: Point = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
  const priority = (p: Point) => Math.hypot(p[0] - center[0], p[1] - center[1]);
  for (const point of exact.sort((a, b) => a.key.localeCompare(b.key))) {
    const geographic = new MercatorCoordinate(anchor.x + point.p[0] * meter, anchor.y + point.p[1] * meter).toLngLat();
    const id = `tree-point:${geographic.lng.toFixed(9)}:${geographic.lat.toFixed(9)}`;
    if (!candidates.has(id)) candidates.set(id, { id, p: point.p, sourceKey: point.key, exact: true, priority: priority(point.p) });
  }
  const minX = Math.floor((bounds[0] * scale + anchor.x * CIRCUMFERENCE) / GRID), maxX = Math.floor((bounds[2] * scale + anchor.x * CIRCUMFERENCE) / GRID);
  const minZ = Math.floor((bounds[1] * scale + anchor.y * CIRCUMFERENCE) / GRID), maxZ = Math.floor((bounds[3] * scale + anchor.y * CIRCUMFERENCE) / GRID);
  let stride = 1;
  while (Math.ceil((maxX - minX + 1) / stride) * Math.ceil((maxZ - minZ + 1) / stride) > GAME_VEGETATION_LIMITS.gridCandidates) stride *= 2;
  diagnostics.truncated = stride > 1;
  for (let gz = Math.ceil(minZ / stride) * stride; gz <= maxZ; gz += stride) for (let gx = Math.ceil(minX / stride) * stride; gx <= maxX; gx += stride) {
    const id = `tree-area-v2:${gx}:${gz}`, rng = createDeterministicRng(id);
    diagnostics.gridCandidates++;
    // World cells are only a deterministic bounded candidate index. Full-cell
    // jitter and smoothly varying density avoid orchard-like rows. Exact source
    // tree points above never enter this synthesis path or change position.
    if(rng()>areaDensity(gx,gz)){diagnostics.densitySkippedCandidates++;continue;}
    const p: Point = [((gx + .02 + rng() * .96) * GRID - anchor.x * CIRCUMFERENCE) / scale,
      ((gz + .02 + rng() * .96) * GRID - anchor.y * CIRCUMFERENCE) / scale];
    const source = areaIndex.query(around(p, 0)).filter(polygon => inside(p, polygon, spend)).sort((a, b) => a.sourceKey.localeCompare(b.sourceKey))[0];
    if (source) candidates.set(id, { id, p, sourceKey: source.sourceKey, exact: false, priority: priority(p) });
  }
  const placements: GameTreePlacement[] = [], occupied = new Map<string, GameTreePlacement[]>();
  for (const candidate of [...candidates.values()].sort((a, b) => Number(b.exact) - Number(a.exact) || a.priority - b.priority || a.id.localeCompare(b.id))) {
    if (placements.length >= capacity) { diagnostics.truncated = true; break; }
    const rng = createDeterministicRng(`${candidate.id}:shape`), radius = 2.15 + rng() * 1.15, height = 7.2 + rng() * 3.8;
    const p = candidate.p, box = around(p, radius), collisionRadius = radius + 2.5;
    // Reserve building clearance at the proven coverage boundary too: unseen
    // buildings beyond that rectangle cannot be assumed absent.
    let clear = box[0] - 2.5 >= bounds[0] && box[1] - 2.5 >= bounds[1] && box[2] + 2.5 <= bounds[2] && box[3] + 2.5 <= bounds[3];
    if (clear && !candidate.exact) clear = fitsAreaUnion(p, radius, areaIndex.query(box), spend);
    if (clear) for (const polygon of buildingIndex.query(around(p, collisionRadius))) {
      if (inside(p, polygon, spend) || edges(polygon).some(([a, b]) => { spend(1); return segmentDistance(p, a, b) < collisionRadius; })) { clear = false; break; }
    }
    if (clear) for (const segment of roadIndex.query(box)) { spend(1); if (segmentDistance(p, segment.a, segment.b) < radius + segment.radius) { clear = false; break; } }
    if (clear && options.isPointClear) clear = options.isPointClear(p[0], p[1], radius);
    const cx = Math.floor(p[0] / 10), cz = Math.floor(p[1] / 10);
    if (clear) for (let z = cz - 1; z <= cz + 1; z++) for (let x = cx - 1; x <= cx + 1; x++) {
      if ((occupied.get(`${x}:${z}`) ?? []).some(tree => Math.hypot(tree.x - p[0], tree.z - p[1]) < radius + tree.radius + .4)) clear = false;
    }
    if (!clear) { diagnostics.rejectedCandidates++; continue; }
    const placement: GameTreePlacement = { id: candidate.id, x: p[0], z: p[1], y: -(options.origin.altitude ?? 0), radius, height,
      rotation: rng() * Math.PI * 2, color: hashSeed(candidate.id) % 5, sourceKey: candidate.sourceKey,
      geometryQuality: candidate.exact ? 'exact_tree_point' : 'area_derived', provenance: 'visual_synthesis' };
    placements.push(placement); const key = `${cx}:${cz}`, bucket = occupied.get(key) ?? []; bucket.push(placement); occupied.set(key, bucket);
  }
  diagnostics.operations = operations;
  return { placements, diagnostics };
}
