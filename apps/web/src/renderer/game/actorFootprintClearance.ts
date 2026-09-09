import { MercatorCoordinate } from 'maplibre-gl';
import type { GameOrigin } from './cameraAdapter';
import type { VerifiedCityBuildingSnapshot } from '../verifiedCityBuildingTypes';
import type { WorldSceneMovementPayload } from '../types';
import type { CityRoadV2 } from '../../demo/data/CityPackV2';
import type { ActorPreviewRoadHint } from './actorColumnsBridge';
import { resolveGameRoadWidth } from './gameRoadWidth';

type Bounds = readonly [number, number, number, number];
export const ACTOR_CLEARANCE_LIMITS = Object.freeze({ polygons: 12_000, rings: 24_000, vertices: 200_000,
  gridCells: 65_536, gridEntries: 262_144, polygonCells: 4096, topologyChecks: 2_000_000, queryEdges: 8192 });
type Limits = { -readonly [K in keyof typeof ACTOR_CLEARANCE_LIMITS]: number };
interface IndexedPolygon { rings: Float64Array[]; west: number; north: number; east: number; south: number;
  x0: number; z0: number; x1: number; z1: number; conservative: boolean }
export interface ActorFootprintClearance {
  readonly isPointClear: (east: number, south: number, bodyRadiusMeters: number) => boolean;
  readonly diagnostics: Readonly<{ polygons: number; rings: number; vertices: number; gridCells: number;
    gridEntries: number; topologyChecks: number; indexBytes: number; cellSizeMeters: number; maximumBodyRadiusMeters: number;
    conservativePolygons: number; conservativeBuildingIds: readonly string[] }>;
}
export interface ActorFootprintClearanceOptions {
  readonly snapshot: VerifiedCityBuildingSnapshot | null | undefined;
  readonly origin: GameOrigin;
  /** EXACT viewport for which snapshot.coverage was computed, not a later camera bbox. */
  readonly viewportBounds: Bounds;
  /** Tests or low-memory clients may only tighten these immutable ceilings. */
  readonly limits?: Partial<Limits>;
}
const CELL = 32, MAX_RADIUS = 5, EPSILON = .001;

function distanceSquared(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az, length = dx * dx + dz * dz;
  const t = length ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / length)) : 0;
  return (x - ax - dx * t) ** 2 + (z - az - dz * t) ** 2;
}
function contains(ring: Float64Array, x: number, z: number): boolean {
  let inside = false;
  for (let i = 2; i < ring.length; i += 2) {
    const ax = ring[i - 2]!, az = ring[i - 1]!, bx = ring[i]!, bz = ring[i + 1]!;
    if ((az > z) !== (bz > z) && x < (bx - ax) * (z - az) / (bz - az) + ax) inside = !inside;
  }
  return inside;
}
function cross(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number {
  return (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
}
function touches(a: Float64Array, i: number, b: Float64Array, j: number): boolean {
  const ax = a[i]!, az = a[i + 1]!, bx = a[i + 2]!, bz = a[i + 3]!;
  const cx = b[j]!, cz = b[j + 1]!, dx = b[j + 2]!, dz = b[j + 3]!;
  if (Math.max(ax, bx) < Math.min(cx, dx) || Math.max(cx, dx) < Math.min(ax, bx)
    || Math.max(az, bz) < Math.min(cz, dz) || Math.max(cz, dz) < Math.min(az, bz)) return false;
  const abC = cross(ax, az, bx, bz, cx, cz), abD = cross(ax, az, bx, bz, dx, dz);
  const cdA = cross(cx, cz, dx, dz, ax, az), cdB = cross(cx, cz, dx, dz, bx, bz);
  return ((abC <= 0 && abD >= 0) || (abC >= 0 && abD <= 0)) && ((cdA <= 0 && cdB >= 0) || (cdA >= 0 && cdB <= 0));
}

/** Independent closure retains only copied metre geometry and a bounded typed CSR index. */
function guardFor(polygons: IndexedPolygon[], offsets: Uint32Array, entries: Uint32Array,
  west: number, north: number, east: number, south: number, columns: number, queryEdges: number): ActorFootprintClearance['isPointClear'] {
  return (x, z, radius) => {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius < 0 || radius > MAX_RADIUS) return false;
    const margin = radius + EPSILON, squared = margin * margin;
    // A complete viewport says nothing about the unverified halo beyond it.
    if (x - margin < west || x + margin > east || z - margin < north || z + margin > south) return false;
    const cell = Math.floor((z - north) / CELL) * columns + Math.floor((x - west) / CELL);
    let inspected = 0;
    for (let at = offsets[cell]!; at < offsets[cell + 1]!; at++) {
      const polygon = polygons[entries[at]!]!;
      if (x < polygon.west - margin || x > polygon.east + margin || z < polygon.north - margin || z > polygon.south + margin) continue;
      // A finite but topologically ambiguous footprint is an obstacle over its
      // entire envelope; never interpret its self-crossing rings as free space.
      if (polygon.conservative) return false;
      let outer = false, hole = false;
      for (let r = 0; r < polygon.rings.length; r++) {
        const ring = polygon.rings[r]!; let inside = false;
        for (let i = 2; i < ring.length; i += 2) {
          if (++inspected > queryEdges) return false;
          const ax = ring[i - 2]!, az = ring[i - 1]!, bx = ring[i]!, bz = ring[i + 1]!;
          if (distanceSquared(x, z, ax, az, bx, bz) <= squared) return false;
          if ((az > z) !== (bz > z) && x < (bx - ax) * (z - az) / (bz - az) + ax) inside = !inside;
        }
        if (r === 0) outer = inside; else if (inside) hole = true;
      }
      if (outer && !hole) return false;
    }
    return true;
  };
}

/**
 * Point/body-disk clearance against verified footprints only. Not surveyed sidewalks,
 * elevation clearance, a swept-segment certificate, or a collision-free simulation.
 * Cache by snapshot + origin + EXACT verified bbox; signature alone omits coverage.
 * Null means disable synthetic displacement, never replace it with an always-true guard.
 */
export function createActorFootprintClearance(options: ActorFootprintClearanceOptions): ActorFootprintClearance | null {
  const { snapshot, origin, viewportBounds: box } = options;
  const limits = { ...ACTOR_CLEARANCE_LIMITS } as Limits;
  for (const key of Object.keys(limits) as (keyof Limits)[]) {
    const value = options.limits?.[key];
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || value < 1) return null;
      limits[key] = Math.min(value, limits[key]);
    }
  }
  if (!snapshot || snapshot.coverage !== 'complete_viewport' || snapshot.invalidBuildings !== 0 || snapshot.omittedBuildings !== 0
    || !Number.isSafeInteger(snapshot.vertexCount) || snapshot.vertexCount < 0 || snapshot.vertexCount > limits.vertices
    || !snapshot.data || snapshot.data.type !== 'FeatureCollection' || !Array.isArray(snapshot.data.features)
    || snapshot.data.features.length > limits.polygons || snapshot.canonicalIds?.size !== snapshot.data.features.length
    || typeof snapshot.canonicalIds?.has !== 'function'
    || ![origin.longitude, origin.latitude, origin.altitude ?? 0].every(Number.isFinite)
    || Math.abs(origin.longitude) > 180 || Math.abs(origin.latitude) >= 85.051129
    || !Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)
    || box[0] < -180 || box[2] > 180 || box[1] <= -85.051129 || box[3] >= 85.051129 || box[0] >= box[2] || box[1] >= box[3]) return null;
  const anchor = MercatorCoordinate.fromLngLat([origin.longitude, origin.latitude], origin.altitude ?? 0);
  const meter = anchor.meterInMercatorCoordinateUnits();
  const northwest = MercatorCoordinate.fromLngLat([box[0], box[3]]), southeast = MercatorCoordinate.fromLngLat([box[2], box[1]]);
  const west = (northwest.x - anchor.x) / meter, north = (northwest.y - anchor.y) / meter;
  const east = (southeast.x - anchor.x) / meter, south = (southeast.y - anchor.y) / meter;
  const columns = Math.ceil((east - west) / CELL), rows = Math.ceil((south - north) / CELL), gridCells = columns * rows;
  if (!Number.isSafeInteger(gridCells) || gridCells < 1 || gridCells > limits.gridCells) return null;
  const polygons: IndexedPolygon[] = [], seen = new Set<string>();
  let vertices = 0, ringCount = 0, topologyChecks = 0, conservativePolygons = 0;
  const conservativeBuildingIds: string[] = [];
  for (const feature of snapshot.data.features) {
    if (!feature || feature.type !== 'Feature' || typeof feature.id !== 'string' || feature.id.length > 256
      || seen.has(feature.id) || !snapshot.canonicalIds.has(feature.id) || !feature.geometry) return null;
    seen.add(feature.id);
    const geometry = feature.geometry;
    if ((geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') || !Array.isArray(geometry.coordinates) || !geometry.coordinates.length) return null;
    const parts = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    if (polygons.length + parts.length > limits.polygons) return null;
    for (const part of parts) {
      if (!Array.isArray(part) || !part.length || ringCount + part.length > limits.rings) return null;
      const polygon: IndexedPolygon = { rings: [], west: Infinity, north: Infinity, east: -Infinity, south: -Infinity, x0: 0, z0: 0, x1: -1, z1: -1, conservative: false };
      for (const sourceRing of part) {
        if (!Array.isArray(sourceRing) || sourceRing.length < 4 || vertices + sourceRing.length > limits.vertices) return null;
        const ring = new Float64Array(sourceRing.length * 2); let area = 0;
        for (let i = 0; i < sourceRing.length; i++) {
          const point = sourceRing[i]!;
          if (!Array.isArray(point) || point.length < 2 || point.length > 3 || !point.every(Number.isFinite)
            || Math.abs(point[0]!) > 180 || Math.abs(point[1]!) >= 85.051129) return null;
          const mercator = MercatorCoordinate.fromLngLat([point[0]!, point[1]!]);
          const x = (mercator.x - anchor.x) / meter, z = (mercator.y - anchor.y) / meter;
          ring[i * 2] = x; ring[i * 2 + 1] = z;
          if (i > 0) {
            if (x === ring[i * 2 - 2] && z === ring[i * 2 - 1]) polygon.conservative = true;
            area += (ring[i * 2 - 2]! - ring[0]!) * (z - ring[1]!) - (x - ring[0]!) * (ring[i * 2 - 1]! - ring[1]!);
          }
          polygon.west = Math.min(polygon.west, x); polygon.east = Math.max(polygon.east, x);
          polygon.north = Math.min(polygon.north, z); polygon.south = Math.max(polygon.south, z);
        }
        const first = sourceRing[0]!, last = sourceRing.at(-1)!;
        if (first.length !== last.length || !first.every((v, i) => v === last[i]) || !Number.isFinite(area) || Math.abs(area) < 1e-8) return null;
        const end = ring.length - 2;
        for (let i = 0; i < end && !polygon.conservative; i += 2) {
          const previous = (i + end - 2) % end, next = (i + 2) % end;
          const ax = ring[i]! - ring[previous]!, az = ring[i + 1]! - ring[previous + 1]!;
          const bx = ring[next]! - ring[i]!, bz = ring[next + 1]! - ring[i + 1]!;
          if (Math.abs(ax * bz - az * bx) < 1e-8 && ax * bx + az * bz < 0) { polygon.conservative = true; break; }
          for (let j = i + 4; j < end; j += 2) {
            if (i === 0 && j === end - 2) continue;
            if (++topologyChecks > limits.topologyChecks) return null;
            if (touches(ring, i, ring, j)) { polygon.conservative = true; break; }
          }
        }
        for (let r = 0; r < polygon.rings.length && !polygon.conservative; r++) {
          const other = polygon.rings[r]!;
          for (let i = 0; i < end && !polygon.conservative; i += 2) for (let j = 0; j < other.length - 2; j += 2) {
            if (++topologyChecks > limits.topologyChecks) return null;
            if (touches(ring, i, other, j)) { polygon.conservative = true; break; }
          }
          if (r === 0 ? !contains(other, ring[0]!, ring[1]!) : contains(other, ring[0]!, ring[1]!) || contains(ring, other[0]!, other[1]!)) polygon.conservative = true;
        }
        vertices += sourceRing.length; ringCount++; polygon.rings.push(ring);
      }
      if (polygon.conservative) {
        conservativePolygons++;
        if (conservativeBuildingIds.length < 64 && !conservativeBuildingIds.includes(feature.id)) conservativeBuildingIds.push(feature.id);
      }
      polygons.push(polygon);
    }
  }
  if (vertices !== snapshot.vertexCount) return null;
  const counts = new Uint32Array(gridCells); let gridEntries = 0;
  for (const polygon of polygons) {
    const padding = MAX_RADIUS + EPSILON;
    if (polygon.east + padding < west || polygon.west - padding > east || polygon.south + padding < north || polygon.north - padding > south) continue;
    polygon.x0 = Math.max(0, Math.floor((polygon.west - padding - west) / CELL));
    polygon.z0 = Math.max(0, Math.floor((polygon.north - padding - north) / CELL));
    polygon.x1 = Math.min(columns - 1, Math.floor((polygon.east + padding - west) / CELL));
    polygon.z1 = Math.min(rows - 1, Math.floor((polygon.south + padding - north) / CELL));
    const fanout = (polygon.x1 - polygon.x0 + 1) * (polygon.z1 - polygon.z0 + 1);
    if (fanout > limits.polygonCells || gridEntries + fanout > limits.gridEntries) return null;
    gridEntries += fanout;
    for (let z = polygon.z0; z <= polygon.z1; z++) for (let x = polygon.x0; x <= polygon.x1; x++) counts[z * columns + x]++;
  }
  const offsets = new Uint32Array(gridCells + 1), entries = new Uint32Array(gridEntries);
  for (let cell = 0; cell < gridCells; cell++) offsets[cell + 1] = offsets[cell]! + counts[cell]!;
  counts.fill(0);
  for (let p = 0; p < polygons.length; p++) {
    const polygon = polygons[p]!;
    for (let z = polygon.z0; z <= polygon.z1; z++) for (let x = polygon.x0; x <= polygon.x1; x++) {
      const cell = z * columns + x; entries[offsets[cell]! + counts[cell]!] = p; counts[cell]++;
    }
  }
  return { isPointClear: guardFor(polygons, offsets, entries, west, north, east, south, columns, limits.queryEdges),
    diagnostics: Object.freeze({ polygons: polygons.length, rings: ringCount, vertices, gridCells, gridEntries,
      topologyChecks, indexBytes: vertices * 16 + offsets.byteLength + entries.byteLength,
      cellSizeMeters: CELL, maximumBodyRadiusMeters: MAX_RADIUS, conservativePolygons,
      conservativeBuildingIds: Object.freeze(conservativeBuildingIds) }) };
}

export interface ActorSourceCorridor {
  readonly id:string;readonly oneway?:boolean;readonly drivable?:boolean;
  readonly sourceRoadIds?:readonly string[];
  readonly segments?:readonly {readonly roadId?:string}[];
}
/** Exact authored from-node and constituent-ID equality only; no ID parsing,
 * nearest-road search or network reads. Mixed corridors use their narrowest
 * verified source class and never synthesize survey width or grade metadata. */
export function buildActorRoadHints(movement: WorldSceneMovementPayload | null | undefined,
  roads: readonly CityRoadV2[],corridors:readonly ActorSourceCorridor[]=[]): ReadonlyMap<string, ActorPreviewRoadHint & { readonly atGrade: boolean }> {
  type Hint = ActorPreviewRoadHint & { readonly atGrade: boolean };
  const result = new Map<string, Hint>();
  if (!movement || roads.length > 20_000 || movement.edges.length > 20_000 || corridors.length>20_000) return result;
  const excluded: Hint = Object.freeze({ atGrade: false });
  const pedestrianClasses = new Set(['footway', 'pedestrian', 'path', 'steps', 'corridor', 'platform']);
  const carriagewayClasses = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'road', 'living_street', 'service', 'track']);
  const byNode = new Map<string, Hint>();
  for (const road of roads) {
    if (!road || typeof road.id !== 'string' || !road.id || road.id.length > 256) continue;
    const key = `presence:${road.id}:start`;
    let hint = excluded;
    if (road.bridge === false && road.tunnel === false && road.layer === 0
      && typeof road.className === 'string' && /^[a-z_]{1,40}$/.test(road.className)
      && (road.lanes === null || Number.isInteger(road.lanes) && road.lanes >= 1 && road.lanes <= 12)) {
      // Legal walking access alone does not prove a separate sidewalk. Unknown
      // or contradictory source geometry cannot authorize synthetic displacement.
      const pedestrian = pedestrianClasses.has(road.className);
      if (!(pedestrian && road.drivable)) {
        const geometryKind = pedestrian && road.walkable && !road.drivable ? 'pedestrian_centerline'
          : carriagewayClasses.has(road.className) && road.drivable ? 'carriageway_centerline' : undefined;
        hint = Object.freeze({ atGrade: true, className: road.className,oneway:road.oneway,drivable:road.drivable, ...(road.lanes !== null ? { lanes: road.lanes } : {}),
          ...(geometryKind ? { geometryKind } : {}) });
      }
    }
    const previous = byNode.get(key);
    if (byNode.has(key) && (previous?.atGrade !== hint.atGrade || previous?.className !== hint.className || previous?.lanes !== hint.lanes || previous?.geometryKind !== hint.geometryKind||previous?.oneway!==hint.oneway||previous?.drivable!==hint.drivable)) byNode.set(key, excluded);
    else if (!byNode.has(key)) byNode.set(key, hint);
  }
  const separated=new Set(roads.filter(road=>road.bridge===true||road.tunnel===true||Number.isFinite(road.layer)&&road.layer!==0).map(road=>road.id));
  for(const corridor of corridors){
    if(!corridor.id||corridor.id.length>2048)continue;
    const segmentIds=corridor.segments?.map(segment=>segment.roadId),ids=corridor.sourceRoadIds??segmentIds;
    if(!ids?.length)continue;
    const key=`presence:${corridor.id}:start`;
    const invalid=ids.length>256||ids.some(id=>typeof id!=='string'||!id||id.length>256)
      ||segmentIds?.some(id=>!id||!ids.includes(id));
    if(invalid){byNode.set(key,{atGrade:false,gradeUnverified:true});continue;}
    const sourceRoadIds=[...new Set(ids as readonly string[])].sort();
    const hints=sourceRoadIds.map(id=>byNode.get(`presence:${id}:start`));
    if(hints.some(hint=>hint?.atGrade!==true)){
      byNode.set(key,{atGrade:false,gradeUnverified:!sourceRoadIds.some(id=>separated.has(id)),sourceRoadIds});continue;
    }
    const verified=hints as Hint[];
    const narrowest=[...verified].sort((a,b)=>resolveGameRoadWidth(a).width-resolveGameRoadWidth(b).width||String(a.className).localeCompare(String(b.className)))[0]!;
    const geometryKind=verified.every(hint=>hint.geometryKind===narrowest.geometryKind)?narrowest.geometryKind:undefined;
    const sameLanes=verified.every(hint=>hint.lanes===narrowest.lanes);
    const hint:Hint={atGrade:true,className:narrowest.className,sourceRoadIds,widthScope:'minimum_constituent_corridor',
      oneway:corridor.oneway??verified.some(hint=>hint.oneway),drivable:corridor.drivable??verified.every(hint=>hint.drivable),
      ...(geometryKind?{geometryKind}:{}),...(sameLanes&&narrowest.lanes!==undefined?{lanes:narrowest.lanes}:{})};
    const existing=byNode.get(key);
    if(existing&&JSON.stringify(existing)!==JSON.stringify(hint))byNode.set(key,{atGrade:false,gradeUnverified:true});
    else byNode.set(key,hint);
  }
  const seen = new Set<string>();
  for (const edge of movement.edges) {
    if (seen.has(edge.edgeId)) { result.set(edge.edgeId, excluded); continue; }
    seen.add(edge.edgeId);
    const hint = byNode.get(edge.fromNodeId);
    if (hint) result.set(edge.edgeId, hint);
  }
  return result;
}
