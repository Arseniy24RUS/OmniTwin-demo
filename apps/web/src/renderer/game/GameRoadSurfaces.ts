import { MercatorCoordinate } from 'maplibre-gl';
import { BufferAttribute, BufferGeometry, Group, Mesh, MeshStandardMaterial, Vector2 } from 'three';
import type { VerifiedCityBuildingSnapshot } from '../verifiedCityBuildingTypes';
import { localToMercatorMatrix, type GameOrigin } from './cameraAdapter';
import { resolveGameRoadWidth, type GameRoadWidthSource } from './gameRoadWidth';
import { triangulateSourceWater, WATER_REPAIR_LIMITS } from './waterTriangulation';
import {createActorFootprintClearance} from './actorFootprintClearance';
import {prepareGameLaneMarkings,type GameMarkingSegment} from './GameLaneMarkings';

type Point = readonly [number, number];
type Bounds = readonly [number, number, number, number];
type Surface = 'asphalt' | 'paving' | 'curb';
export interface GameRoadSurfaceSource extends GameRoadWidthSource {
  readonly id: string;
  readonly coordinates: readonly Point[];
  readonly bridge?: unknown;
  readonly tunnel?: unknown;
  readonly layer?: unknown;
  readonly walkable?: boolean;
  readonly oneway?: unknown;
}
export interface GameRoadSurfacesOptions {
  origin: GameOrigin;
  bounds: Bounds;
  buildings: VerifiedCityBuildingSnapshot | null;
  qualityTier?: 'low' | 'medium' | 'high';
  loading?: boolean;
  bridgeFeatures?: readonly GameBridgeDeckFeature[];
}
/** Exact source deck footprints, not an inferred bridge corridor or surveyed height. */
export interface GameBridgeDeckFeature {
  readonly id?: string | number;
  readonly sourceLayer?: string;
  readonly properties?: Readonly<Record<string, unknown>> | null;
  readonly geometry: { type: string; coordinates?: unknown } | null;
}
export const GAME_ROAD_SURFACE_LIMITS = Object.freeze({ roads: 8192, sourceVertices: 131072, segments: 12000,
  bridgeFeatures: 4096, bridgePolygons: 512, bridgeRings: 128,
  laneMarkings:{low:256,medium:1024,high:1536},
  vertices: { low: 65536, medium: 98304, high: 131072 }, operations: 4_000_000, bytes: 16 * 1024 * 1024 });
const EPS = 1e-6, CURB_WIDTH = .16, CIRCUMFERENCE = 40075016.68557849;
const TOP = { asphalt: .065, paving: .045, curb: .19 };
interface Capsule { key: string; points: Point[]; bounds: Bounds; material: 'asphalt' | 'paving'; curb?: boolean }
interface BridgeTriangle { key: string; deckKey: string; points: Point[]; bounds: Bounds; layer: number | null }
interface CurbEdge { a: Point; b: Point; outward: Point; material: 'asphalt' | 'paving' }
const cross = (a: Point, b: Point) => a[0] * b[1] - a[1] * b[0];
const subtract = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
const add = (a: Point, b: Point, scale = 1): Point => [a[0] + b[0] * scale, a[1] + b[1] * scale];
const overlap = (a: Bounds, b: Bounds) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
function boundsOf(points: readonly Point[]): Bounds {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of points) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
  return [x0, z0, x1, z1];
}
function validPoint(p: unknown): p is Point {
  return Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) < 85.051129;
}
const validBounds = (b: Bounds) => b.length === 4 && b.every(Number.isFinite) && b[0] < b[2] && b[1] < b[3]
  && validPoint([b[0], b[1]]) && validPoint([b[2], b[3]]);
const enabled = (v: unknown) => v === true || typeof v === 'string' && !['', 'no', 'false', '0'].includes(v.toLowerCase());

/** Clip a segment against a convex CCW polygon, returning its original [0,1] interval. */
function clipInterval(a: Point, b: Point, polygon: readonly Point[], margin = 0): [number, number] | null {
  let lo = 0, hi = 1; const direction = subtract(b, a);
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i]!, q = polygon[(i + 1) % polygon.length]!, edge = subtract(q, p);
    const value = cross(edge, subtract(a, p)) + margin, change = cross(edge, direction);
    if (Math.abs(change) < 1e-10) { if (value < -EPS) return null; continue; }
    const t = -value / change;
    if (change > 0) lo = Math.max(lo, t); else hi = Math.min(hi, t);
    if (lo > hi) return null;
  }
  return [Math.max(0, lo), Math.min(1, hi)];
}
function clipPolygon(input: readonly Point[], bounds: Bounds): Point[] {
  let polygon = [...input];
  for (const [axis, edge, sign] of [[0, bounds[0], 1], [0, bounds[2], -1], [1, bounds[1], 1], [1, bounds[3], -1]]) {
    const output: Point[] = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!, insideA = sign! * (a[axis!]! - edge!) >= 0, insideB = sign! * (b[axis!]! - edge!) >= 0;
      if (insideA) output.push(a);
      if (insideA !== insideB) { const t = (edge! - a[axis!]!) / (b[axis!]! - a[axis!]!); output.push(add(a, subtract(b, a), t)); }
    }
    polygon = output; if (!polygon.length) break;
  }
  return polygon.filter((p, i) => Math.hypot(p[0] - polygon[(i + 1) % polygon.length]![0], p[1] - polygon[(i + 1) % polygon.length]![1]) > EPS);
}
function capsule(a: Point, b: Point, radius: number, steps: number): Point[] {
  const angle = Math.atan2(b[1] - a[1], b[0] - a[0]), result: Point[] = [];
  for (let end = 0; end < 2; end++) for (let i = 0; i <= steps; i++) {
    const theta = angle - Math.PI / 2 + Math.PI * end + Math.PI * i / steps, p = end ? a : b;
    result.push([p[0] + Math.cos(theta) * radius, p[1] + Math.sin(theta) * radius]);
  }
  return result;
}
/** Sutherland-Hodgman on a convex CCW source triangle; preserves exact deck holes and concavities. */
function clipConvex(input: readonly Point[], clip: readonly Point[]): Point[] {
  let polygon = [...input];
  for (let edge = 0; edge < clip.length; edge++) {
    const p = clip[edge]!, q = clip[(edge + 1) % clip.length]!, direction = subtract(q, p), output: Point[] = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!, ca = cross(direction, subtract(a, p)), cb = cross(direction, subtract(b, p));
      if (ca >= -EPS) output.push(a);
      if ((ca >= -EPS) !== (cb >= -EPS)) output.push(add(a, subtract(b, a), ca / (ca - cb)));
    }
    polygon = output; if (!polygon.length) break;
  }
  return polygon.filter((p, i) => Math.hypot(...subtract(p, polygon[(i + 1) % polygon.length]!)) > EPS);
}
function canonicalRing(input: readonly Point[]): Point[] {
  const ring = input.filter((p, i) => !i || Math.hypot(...subtract(p, input[i - 1]!)) > EPS);
  if (ring.length > 1 && Math.hypot(...subtract(ring[0]!, ring.at(-1)!)) < EPS) ring.pop();
  if (ring.length < 3) throw Error('Invalid source bridge deck ring');
  let first = 0;
  for (let i = 1; i < ring.length; i++) if (ring[i]![0] < ring[first]![0] || ring[i]![0] === ring[first]![0] && ring[i]![1] < ring[first]![1]) first = i;
  const forward = [...ring.slice(first), ...ring.slice(0, first)], backward = [forward[0]!, ...forward.slice(1).reverse()];
  return JSON.stringify(forward) < JSON.stringify(backward) ? forward : backward;
}

/** Source-only road union. Coincident opaque top fragments share identical world-space material values. */
export function prepareGameRoadSurfaces(roads: readonly GameRoadSurfaceSource[], options: GameRoadSurfacesOptions) {
  const source = options.buildings;
  if (!source || source.coverage !== 'complete_viewport' || source.invalidBuildings || source.omittedBuildings || !validBounds(options.bounds)) {
    throw Error('Road surfaces require complete verified building coverage');
  }
  localToMercatorMatrix(options.origin);
  if (roads.length > GAME_ROAD_SURFACE_LIMITS.roads) throw Error('Road surface source feature budget exceeded');
  const tier = options.qualityTier ?? 'medium';let vertexLimit:number=GAME_ROAD_SURFACE_LIMITS.vertices[tier];
  if (!vertexLimit) throw Error('Invalid road surface quality tier');
  let coverage = options.bounds;
  if (source.coverageBounds) {
    if (!validBounds(source.coverageBounds)) throw Error('Invalid verified road surface bounds');
    coverage = [Math.max(coverage[0], source.coverageBounds[0]), Math.max(coverage[1], source.coverageBounds[1]),
      Math.min(coverage[2], source.coverageBounds[2]), Math.min(coverage[3], source.coverageBounds[3])];
    if (!validBounds(coverage)) throw Error('Road surface bounds do not intersect verified source coverage');
  }
  const anchor = MercatorCoordinate.fromLngLat([options.origin.longitude, options.origin.latitude]), meter = anchor.meterInMercatorCoordinateUnits();
  const local = (p: Point): Point => { const m = MercatorCoordinate.fromLngLat([p[0], p[1]]); return [(m.x - anchor.x) / meter, (m.y - anchor.y) / meter]; };
  const nw = local([coverage[0], coverage[3]]), se = local([coverage[2], coverage[1]]), bounds: Bounds = [nw[0], nw[1], se[0], se[1]];
  if (bounds[2] - bounds[0] > 20000 || bounds[3] - bounds[1] > 20000) throw Error('Road surface coverage exceeds the local 20km budget');
  const rectangle: Point[] = [[bounds[0], bounds[1]], [bounds[2], bounds[1]], [bounds[2], bounds[3]], [bounds[0], bounds[3]]];
  const diagnostics = { sourceWidthRoads: 0, laneWidthRoads: 0, classWidthRoads: 0, omittedElevatedRoads: 0, skippedNonTraversable: 0,
    bridgeDeckPolygons: 0, bridgeDeckTriangles: 0, confirmedBridgeRoads: 0, bridgeRoadSegments: 0,
    laneMarkings:0,skippedJunctionMarks:0,skippedClearanceMarks:0,markingsTruncated:false,markingClearanceBytes:0,markingClearanceUnavailable:false,
    laneMarkingPolicy:'source_width_and_lanes_else_visual_two_way_class' as const,
    duplicateSegments: 0, retainedSegments: 0, vertexCount: 0, curbEdges: 0, operations: 0, partial: false,
    widthPolicy: 'source_width_else_visual_lanes_3m_plus_0_6m_else_visual_class_width' as const,
    elevationPolicy: 'source_bridge_deck_at_visual_surface_height_other_unmeasured_elevations_omitted' as const,
    provenance: 'visual_synthesis' as const };
  const shapes = new Map<string, Capsule>(); let sourceVertices = 0, operations = 0;
  const spend = (n = 1) => { operations += n; if (operations > GAME_ROAD_SURFACE_LIMITS.operations) throw Error('Road surface geometry work budget exceeded'); };
  const put = (shape: Capsule) => {
    if (!shapes.has(shape.key) && shapes.size >= GAME_ROAD_SURFACE_LIMITS.segments) throw Error('Road surface segment budget exceeded');
    shapes.set(shape.key, shape);
  };
  const deckPolygons = new Map<string, { rings: Point[][]; layer: number | null }>();
  const bridgeFeatures = options.bridgeFeatures ?? [];
  if (bridgeFeatures.length > GAME_ROAD_SURFACE_LIMITS.bridgeFeatures) throw Error('Bridge source feature budget exceeded');
  for (const feature of bridgeFeatures) {
    const properties = feature.properties;
    if (feature.sourceLayer && feature.sourceLayer !== 'transportation' || properties?.class !== 'bridge'
      || properties.brunnel !== 'bridge' && !enabled(properties.bridge)) continue;
    if (feature.geometry?.type !== 'Polygon' && feature.geometry?.type !== 'MultiPolygon') continue;
    const raw = feature.geometry.coordinates;
    if (!Array.isArray(raw) || !raw.length) throw Error('Invalid source bridge deck polygon');
    const polygons = feature.geometry.type === 'Polygon' ? [raw] : raw;
    if (polygons.length > GAME_ROAD_SURFACE_LIMITS.bridgePolygons) throw Error('Bridge source polygon budget exceeded');
    const layer = properties.layer === undefined || properties.layer === null ? null : Number(properties.layer);
    if (layer !== null && !Number.isFinite(layer)) throw Error('Invalid source bridge deck layer');
    for (const polygon of polygons) {
      if (!Array.isArray(polygon) || !polygon.length || polygon.length > GAME_ROAD_SURFACE_LIMITS.bridgeRings) throw Error('Invalid source bridge deck rings');
      const rings: Point[][] = polygon.map((ring: unknown) => {
        if (!Array.isArray(ring) || (sourceVertices += ring.length) > GAME_ROAD_SURFACE_LIMITS.sourceVertices || !ring.every(validPoint)) throw Error('Invalid or oversized source bridge deck coordinates');
        return canonicalRing(ring.map(local));
      });
      if (!overlap(bounds, boundsOf(rings[0]!))) continue;
      rings.splice(1, rings.length - 1, ...rings.slice(1).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
      const key = JSON.stringify([layer, rings]);
      if (!deckPolygons.has(key) && deckPolygons.size >= GAME_ROAD_SURFACE_LIMITS.bridgePolygons) throw Error('Bridge source polygon budget exceeded');
      deckPolygons.set(key, { rings, layer });
    }
  }
  const bridgeTriangles: BridgeTriangle[] = [], repairBudget = { remaining: WATER_REPAIR_LIMITS.pairChecks };
  for (const [ordinal, [, deck]] of [...deckPolygons].sort(([a], [b]) => a.localeCompare(b)).entries()) {
    const result = triangulateSourceWater(deck.rings.map(ring => ring.map(p => new Vector2(...p))), repairBudget);
    if (!result) throw Error('Source bridge deck cannot be triangulated with its holes intact');
    diagnostics.bridgeDeckPolygons++;
    for (const [index, triangle] of result.triangles.entries()) {
      const points = triangle.map(i => [result.points[i]!.x, result.points[i]!.y] as Point);
      if (cross(subtract(points[1]!, points[0]!), subtract(points[2]!, points[0]!)) < 0) points.reverse();
      const box = boundsOf(points); if (!overlap(bounds, box)) continue;
      const part = { key: `deck:${ordinal}:${index}`, deckKey: String(ordinal), points, bounds: box, layer: deck.layer };
      bridgeTriangles.push(part); put({ ...part, material: 'paving', curb: false });
    }
  }
  spend(WATER_REPAIR_LIMITS.pairChecks - repairBudget.remaining);
  diagnostics.bridgeDeckTriangles = bridgeTriangles.length;
  const seenSegments = new Set<string>(),markingSegments=new Map<string,GameMarkingSegment>();
  for (const road of roads) {
    if (!road || typeof road.id !== 'string' || !road.id || !Array.isArray(road.coordinates) || road.coordinates.length < 2
      || (sourceVertices += road.coordinates.length) > GAME_ROAD_SURFACE_LIMITS.sourceVertices || !road.coordinates.every(validPoint)) throw Error('Invalid or oversized source road coordinates');
    const layer = road.layer === undefined || road.layer === null ? 0 : Number(road.layer);
    if (!Number.isFinite(layer)) throw Error('Invalid source road layer');
    const isBridge = enabled(road.bridge);
    if (enabled(road.tunnel) || !isBridge && layer !== 0 || isBridge && !bridgeTriangles.length) { diagnostics.omittedElevatedRoads++; continue; }
    if (road.drivable === false && road.walkable === false) { diagnostics.skippedNonTraversable++; continue; }
    const info = resolveGameRoadWidth(road);
    diagnostics[info.source === 'source' ? 'sourceWidthRoads' : info.source === 'lanes' ? 'laneWidthRoads' : 'classWidthRoads']++;
    const material = road.drivable === false || ['footway', 'path', 'pedestrian', 'steps', 'cycleway', 'corridor', 'platform'].includes(road.className ?? '') ? 'paving' : 'asphalt';
    let bridgeConfirmed = false;
    for (let i = 1; i < road.coordinates.length; i++) {
      let a = local(road.coordinates[i - 1]!), b = local(road.coordinates[i]!);
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < .05) continue;
      if (a[0] > b[0] || a[0] === b[0] && a[1] > b[1]) [a, b] = [b, a];
      const key = JSON.stringify([a, b, info.width, isBridge]);
      if (isBridge && seenSegments.has(key)) { diagnostics.duplicateSegments++; bridgeConfirmed = true; continue; }
      const prior = shapes.get(key);
      if (prior) { diagnostics.duplicateSegments++; if (material === 'asphalt') prior.material = material; continue; }
      const points = capsule(a, b, info.width / 2, tier === 'low' ? 4 : 6), shapeBounds = boundsOf(points);
      if (!overlap(bounds, shapeBounds)) continue;
      const recordMarking=(clips?:readonly(readonly Point[])[])=>{
        if(material!=='asphalt')return;
        const raw=road.lanes??road.properties?.lanes??road.sourceAttributes?.lanes;
        const lanes=raw===undefined||raw===null?(enabled(road.oneway??road.properties?.oneway)?1:2):Number(raw);
        markingSegments.set(key,{key,a,b,width:info.width,level:layer,lanes:Number.isInteger(lanes)?lanes:0,
          eligible:/^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|road)$/.test(road.className??String(road.properties?.class??'')),clips});
      };
      if (isBridge) {
        let retained = false;
        const candidates: BridgeTriangle[] = [], confirmedDecks = new Set<string>();
        for (const deck of bridgeTriangles) {
          spend(); if (deck.layer !== null && deck.layer !== layer || !overlap(shapeBounds, deck.bounds)) continue;
          candidates.push(deck); spend(deck.points.length);
          const center = clipInterval(a, b, deck.points); if (center && center[1] - center[0] >= EPS) confirmedDecks.add(deck.deckKey);
        }
        for (const deck of candidates) {
          if (!confirmedDecks.has(deck.deckKey)) continue;
          spend(points.length * deck.points.length);
          const clipped = clipConvex(points, deck.points); if (clipped.length < 3) continue;
          put({ key: `bridge:${key}:${deck.key}`, points: clipped, bounds: boundsOf(clipped), material, curb: false }); retained = true;
        }
        if (retained) { seenSegments.add(key); diagnostics.bridgeRoadSegments++; bridgeConfirmed = true;recordMarking(candidates.filter(deck=>confirmedDecks.has(deck.deckKey)).map(deck=>deck.points)); }
      } else {put({ key, points, bounds: shapeBounds, material });recordMarking();}
    }
    if (isBridge) { if (bridgeConfirmed) diagnostics.confirmedBridgeRoads++; else diagnostics.omittedElevatedRoads++; }
  }
  const capsules = [...shapes.values()].sort((a, b) => a.key.localeCompare(b.key));
  diagnostics.retainedSegments = capsules.filter(shape => !shape.key.startsWith('deck:') && !shape.key.startsWith('bridge:')).length + diagnostics.bridgeRoadSegments;
  const markingClearance=createActorFootprintClearance({snapshot:source,origin:options.origin,viewportBounds:coverage,
    limits:{polygons:8192,rings:16384,vertices:65536,gridCells:32768,gridEntries:131072,topologyChecks:500000}});
  diagnostics.markingClearanceBytes=markingClearance?.diagnostics.indexBytes??0;diagnostics.markingClearanceUnavailable=!markingClearance;
  // Also reserve the packed double staging arrays, alongside old/new CPU+GPU
  // generations and the temporary exact building clearance index.
  vertexLimit=Math.min(vertexLimit,Math.floor((GAME_ROAD_SURFACE_LIMITS.bytes-diagnostics.markingClearanceBytes)/(6*24)));
  const positions: Record<Surface, number[]> = { asphalt: [], paving: [], curb: [] }, normals: Record<Surface, number[]> = { asphalt: [], paving: [], curb: [] };
  const yOffset = -(options.origin.altitude ?? 0);
  function triangle(material: Surface, a: readonly number[], b: readonly number[], c: readonly number[]) {
    if (diagnostics.vertexCount + 3 > vertexLimit) return false;
    const ux = b[0]! - a[0]!, uy = b[1]! - a[1]!, uz = b[2]! - a[2]!, vx = c[0]! - a[0]!, vy = c[1]! - a[1]!, vz = c[2]! - a[2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, length = Math.hypot(nx, ny, nz);
    if (length < 1e-10) return true;
    for (const p of [a, b, c]) { positions[material].push(p[0]!, p[1]! + yOffset, p[2]!); normals[material].push(nx / length, ny / length, nz / length); }
    diagnostics.vertexCount += 3; return true;
  }
  function top(points: readonly Point[], material: Surface, height: number): boolean {
    const polygon = clipPolygon(points, bounds);
    if (diagnostics.vertexCount + Math.max(0, polygon.length - 2) * 3 > vertexLimit) return false;
    for (let i = 1; i < polygon.length - 1; i++) {
      const a = polygon[0]!, b = polygon[i]!, c = polygon[i + 1]!;
      triangle(material, [a[0], height, a[1]], [c[0], height, c[1]], [b[0], height, b[1]]);
    }
    return true;
  }
  // Ground continuity has priority: decoration may be omitted, road bodies may not be partly committed.
  for (const shape of capsules) if (!top(shape.points, shape.material, TOP[shape.material])) throw Error('Road surface vertex budget exceeded before complete body geometry');
  if(markingClearance){
    const result=prepareGameLaneMarkings([...markingSegments.values()],{center:[(bounds[0]+bounds[2])/2,(bounds[1]+bounds[3])/2],
      phaseOrigin:[anchor.x/meter,anchor.y/meter],maxMarks:GAME_ROAD_SURFACE_LIMITS.laneMarkings[tier],spend,isPointClear:markingClearance.isPointClear});
    Object.assign(diagnostics,{skippedJunctionMarks:result.diagnostics.skippedJunctionMarks,skippedClearanceMarks:result.diagnostics.skippedClearanceMarks,
      markingsTruncated:result.diagnostics.truncated});
    for(const mark of result.markings){
      const pieces=mark.clips?mark.clips.map(clip=>clipConvex(mark.points,clip)).filter(p=>p.length>=3):[mark.points];
      const needed=pieces.reduce((sum,p)=>sum+Math.max(0,clipPolygon(p,bounds).length-2)*3,0);
      if(diagnostics.vertexCount+needed>vertexLimit){diagnostics.markingsTruncated=true;break}
      if(!pieces.length)continue;for(const piece of pieces)top(piece,'paving',.078);diagnostics.laneMarkings++;
    }
  }
  const curbEdges: CurbEdge[] = [];
  if (tier !== 'low') {
    const buckets = new Map<string, Capsule[]>(), large: Capsule[] = []; let entries = 0;
    for (const shape of capsules) {
      const [x0, z0, x1, z1] = shape.bounds.map(v => Math.floor(v / 64));
      if ((x1! - x0! + 1) * (z1! - z0! + 1) > 512) { large.push(shape); continue; }
      for (let z = z0!; z <= z1!; z++) for (let x = x0!; x <= x1!; x++) {
        if (++entries > 150000) throw Error('Road surface spatial index budget exceeded');
        const key = `${x}:${z}`, bucket = buckets.get(key) ?? []; bucket.push(shape); buckets.set(key, bucket);
      }
    }
    const exposed = (shape: Capsule, a: Point, b: Point): [number, number][] => {
      const delta = subtract(b, a), length = Math.hypot(...delta), outward: Point = [delta[1] / length, -delta[0] / length];
      const edgeBounds = boundsOf([a, b]), nearby = new Set(large), [x0, z0, x1, z1] = edgeBounds.map(v => Math.floor(v / 64));
      for (let z = z0!; z <= z1!; z++) for (let x = x0!; x <= x1!; x++) for (const other of buckets.get(`${x}:${z}`) ?? []) nearby.add(other);
      let intervals: [number, number][] = [[0, 1]];
      for (const other of nearby) {
        if (other === shape || !overlap(other.bounds, edgeBounds)) continue; spend(other.points.length);
        // Outward probe removes internal joins. Lexical owner resolves coincident exterior edges once.
        const offset = other.key < shape.key ? 0 : EPS * 8;
        const clip = clipInterval(add(a, outward, offset), add(b, outward, offset), other.points);
        if (!clip || clip[1] - clip[0] < EPS) continue;
        intervals = intervals.flatMap(([lo, hi]) => {
          if (clip[1] <= lo || clip[0] >= hi) return [[lo, hi]];
          const parts: [number, number][] = [];
          if (clip[0] > lo + EPS) parts.push([lo, clip[0]]); if (clip[1] < hi - EPS) parts.push([clip[1], hi]); return parts;
        });
        if (!intervals.length) break;
      }
      return intervals;
    };
    outer: for (const shape of capsules) { if (shape.curb === false) continue; for (let i = 0; i < shape.points.length; i++) {
      const p = shape.points[i]!, q = shape.points[(i + 1) % shape.points.length]!, clipped = clipInterval(p, q, rectangle);
      if (!clipped) continue;
      const a = add(p, subtract(q, p), clipped[0]), b = add(p, subtract(q, p), clipped[1]), delta = subtract(b, a), length = Math.hypot(...delta);
      if (length < .01) continue;
      const outward: Point = [delta[1] / length, -delta[0] / length];
      for (const [lo, hi] of exposed(shape, a, b)) {
        if (diagnostics.vertexCount + 18 > vertexLimit) { diagnostics.partial = true; break outer; }
        const c = add(a, delta, lo), d = add(a, delta, hi), outC = add(c, outward, CURB_WIDTH), outD = add(d, outward, CURB_WIDTH);
        const ring = clipPolygon([c, outC, outD, d], bounds); if (ring.length < 3) continue;
        const height = shape.material === 'paving' ? .10 : TOP.curb;
        top(ring, 'curb', height);
        // Only the two longitudinal faces: no repeated end walls at joins or clip boundaries.
        for (const [left, right] of [[c, d], [outD, outC]]) {
          const wallClip = clipInterval(left!, right!, rectangle); if (!wallClip) continue;
          const u = add(left!, subtract(right!, left!), wallClip[0]), v = add(left!, subtract(right!, left!), wallClip[1]);
          triangle('curb', [u[0], TOP[shape.material], u[1]], [v[0], TOP[shape.material], v[1]], [v[0], height, v[1]]);
          triangle('curb', [u[0], TOP[shape.material], u[1]], [v[0], height, v[1]], [u[0], height, u[1]]);
        }
        curbEdges.push({ a: c, b: d, outward, material: shape.material });
      }
    } }
  }
  diagnostics.curbEdges = curbEdges.length; diagnostics.operations = operations;
  const batches = Object.fromEntries((['asphalt', 'paving', 'curb'] as const).map(material => [material,
    { positions: new Float32Array(positions[material]), normals: new Float32Array(normals[material]) }])) as Record<Surface, { positions: Float32Array; normals: Float32Array }>;
  const geometryBytes = Object.values(batches).reduce((sum, batch) => sum + batch.positions.byteLength + batch.normals.byteLength, 0);
  if (geometryBytes * 6+diagnostics.markingClearanceBytes > GAME_ROAD_SURFACE_LIMITS.bytes) throw Error('Road surface CPU/GPU memory budget exceeded');
  return { batches, curbEdges, diagnostics, geometryBytes };
}

function materialFor(surface: Surface) {
  const material = new MeshStandardMaterial({ color: surface === 'asphalt' ? '#777c7c' : surface === 'paving' ? '#c6c2b4' : '#cecabf', roughness: .96 });
  const origin = { value: new Vector2() }, scale = { value: 1 };
  material.userData.roadOrigin = origin; material.userData.roadScale = scale;
  material.onBeforeCompile = shader => {
    shader.uniforms.roadOrigin = origin; shader.uniforms.roadScale = scale;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nuniform vec2 roadOrigin; uniform float roadScale; varying vec2 roadSurface;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nroadSurface = (modelMatrix * vec4(transformed, 1.0)).xz * roadScale + roadOrigin;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 roadSurface;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec2 grainCell = floor(mod(roadSurface, 256.0) * 16.0);
        float grain = fract(sin(dot(grainCell, vec2(127.1, 311.7))) * 43758.5453);
        float grainFade = 1.0 - smoothstep(0.04, 0.3, max(length(dFdx(roadSurface)), length(dFdy(roadSurface))));
        diffuseColor.rgb *= 1.0 + (grain - 0.5) * ${surface === 'asphalt' ? '0.10' : '0.045'} * grainFade;
        ${surface === 'paving' ? 'vec2 joint = min(fract(roadSurface * 2.0), 1.0 - fract(roadSurface * 2.0)); float line = 1.0 - smoothstep(0.01, 0.025, min(joint.x, joint.y)); diffuseColor.rgb *= 1.0 - line * 0.08 * grainFade;' : ''}
      `);
  };
  material.customProgramCacheKey = () => `source-metric-road-${surface}-v1`;
  return material;
}

/** Bounded geometry fingerprint; never retain full source coordinates a second time. */
function geometryFingerprint(batches: ReturnType<typeof prepareGameRoadSurfaces>['batches'], origin: GameOrigin): string {
  let a = 2166136261, b = 0x9e3779b9, count = 0;
  for (const surface of ['asphalt', 'paving', 'curb'] as const) for (const array of [batches[surface].positions, batches[surface].normals]) {
    const words = new Uint32Array(array.buffer, array.byteOffset, array.length);
    a = Math.imul(a ^ words.length, 16777619); b = Math.imul(b ^ words.length, 2246822519);
    for (const word of words) { a = Math.imul(a ^ word, 16777619); b = Math.imul(b ^ word ^ count++, 2246822519); }
  }
  return JSON.stringify([origin.longitude, origin.latitude, origin.altitude ?? 0, count, a >>> 0, b >>> 0]);
}

/** One retained road owner attached to the shared Three scene and public camera. */
export class GameRoadSurfaces {
  readonly object = new Group();
  readonly telemetry = { state: 'empty' as 'empty' | 'ready' | 'loading_retained' | 'unverified_retained' | 'error_retained' | 'disposed',
    provenance: 'visual_synthesis' as const, geometryUpdates: 0, geometryBytes: 0, retainedBytes: 0, draws: 0,
    sourceWidthRoads: 0, laneWidthRoads: 0, classWidthRoads: 0, omittedElevatedRoads: 0, retainedSegments: 0, curbEdges: 0,
    bridgeDeckPolygons: 0, bridgeDeckTriangles: 0, confirmedBridgeRoads: 0, bridgeRoadSegments: 0,
    laneMarkings:0,skippedJunctionMarks:0,skippedClearanceMarks:0,markingsTruncated:false,markingClearanceBytes:0,markingClearanceUnavailable:false,
    vertexCount: 0, partial: false, lastError: null as string | null };
  private meshes: Mesh<BufferGeometry, MeshStandardMaterial>[] = [];
  private signature = '';
  private origin: GameOrigin | null = null;
  private disposed = false;
  constructor() { this.object.name = 'source-metric-road-surfaces'; this.object.userData.provenance = 'visual_synthesis'; this.object.matrixAutoUpdate = false; }
  private retain(origin: GameOrigin) {
    if (!this.origin) return;
    try { this.object.matrix.copy(localToMercatorMatrix(origin).invert().multiply(localToMercatorMatrix(this.origin))); this.object.matrixWorldNeedsUpdate = true; } catch {}
  }
  update(roads: readonly GameRoadSurfaceSource[], options: GameRoadSurfacesOptions): void {
    if (this.disposed) return;
    if (options.loading) { this.telemetry.state = 'loading_retained'; this.retain(options.origin); return; }
    if (!options.buildings || options.buildings.coverage !== 'complete_viewport' || options.buildings.invalidBuildings || options.buildings.omittedBuildings) {
      this.telemetry.state = 'unverified_retained'; this.retain(options.origin); return;
    }
    try {
      const result = prepareGameRoadSurfaces(roads, options);
      const signature = geometryFingerprint(result.batches, options.origin);
      if (signature !== this.signature) {
        const prepared: Mesh<BufferGeometry, MeshStandardMaterial>[] = [];
        try {
          for (const surface of ['asphalt', 'paving', 'curb'] as const) {
            const data = result.batches[surface]; if (!data.positions.length) continue;
            const geometry = new BufferGeometry(); geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
            geometry.setAttribute('normal', new BufferAttribute(data.normals, 3)); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
            const material = materialFor(surface), anchor = MercatorCoordinate.fromLngLat([options.origin.longitude, options.origin.latitude]);
            (material.userData.roadOrigin as { value: Vector2 }).value.set(anchor.x * CIRCUMFERENCE % 256, anchor.y * CIRCUMFERENCE % 256);
            (material.userData.roadScale as { value: number }).value = anchor.meterInMercatorCoordinateUnits() * CIRCUMFERENCE;
            const mesh = new Mesh(geometry, material); mesh.name = `metric-road-${surface}`; mesh.receiveShadow = true; mesh.castShadow = surface === 'curb';
            mesh.userData.provenance = 'visual_synthesis'; prepared.push(mesh);
          }
        } catch (error) { for (const mesh of prepared) { mesh.geometry.dispose(); mesh.material.dispose(); } throw error; }
        for (const mesh of this.meshes) { this.object.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); }
        this.meshes = prepared; this.object.add(...prepared); this.signature = signature; this.telemetry.geometryUpdates++;
      }
      this.origin = { ...options.origin }; this.object.matrix.identity(); this.object.matrixWorldNeedsUpdate = true;
      Object.assign(this.telemetry, result.diagnostics, { state: 'ready', geometryBytes: result.geometryBytes,
        retainedBytes: result.geometryBytes * 2 + this.signature.length * 2, draws: this.meshes.length, lastError: null });
    } catch (error) { this.telemetry.state = 'error_retained'; this.telemetry.lastError = error instanceof Error ? error.message.slice(0, 160) : 'Road surface preparation failed'; this.retain(options.origin); }
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    for (const mesh of this.meshes) { mesh.geometry.dispose(); mesh.material.dispose(); }
    this.meshes = []; this.signature = ''; this.origin = null; this.object.clear();
    Object.assign(this.telemetry, { state: 'disposed', geometryBytes: 0, retainedBytes: 0, draws: 0, vertexCount: 0 });
  }
}
