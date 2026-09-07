import type { VisualEntity, WorldSceneMovementPayload } from '../renderer/types';
import type { LivingSceneMovementEntitySource } from '../renderer/living/sceneMovement';
import { hashSeed } from '../renderer/rng';

type Position = readonly [longitude: number, latitude: number];
type Bounds = readonly [west: number, south: number, east: number, north: number];

/** Structural subset of MapLibre querySourceFeatures results; no browser dependency. */
export interface CityTransportationFeature {
  readonly id?: string | number;
  readonly sourceLayer?: string;
  readonly properties?: Readonly<Record<string, unknown>> | null;
  readonly geometry: { readonly type: string; readonly coordinates: unknown } | null;
}

export interface CityRoad {
  readonly id: string;
  readonly coordinates: readonly Position[];
  /** Direction relative to coordinates; zero is bidirectional. */
  readonly oneway: -1 | 0 | 1;
  readonly className: string;
  readonly walkable: boolean;
  readonly drivable: boolean;
}

export interface BuildCityRoadGraphOptions {
  readonly features: readonly CityTransportationFeature[];
  readonly origin: Position;
  readonly presentationTimeSeconds: number;
  /** Optional additional clipping window. Antimeridian-crossing bounds are unsupported. */
  readonly bounds?: Bounds;
  /** Maximum radius of the local display window, clamped to 50–5,000 metres. */
  readonly maxDistanceMeters?: number;
  readonly maxPeople?: number;
  readonly maxCars?: number;
  /** Optional static demo profile IDs. An explicitly empty array creates no such actors. */
  readonly peopleIds?: readonly string[];
  readonly vehicleIds?: readonly string[];
}

export interface CityRoadGraph {
  readonly movement: WorldSceneMovementPayload;
  readonly entities: readonly VisualEntity[];
  readonly movementEntities: readonly LivingSceneMovementEntitySource[];
  readonly roads: readonly CityRoad[];
  /** Independent of query order, duplicate tiles, and the presentation clock anchor. */
  readonly signature: string;
  readonly sourceLabel: string;
  readonly stats: {
    readonly inputFeatures: number;
    readonly acceptedRoads: number;
    readonly people: number;
    readonly cars: number;
  };
}

export const CITY_ROAD_SOURCE_LABEL = 'OpenStreetMap / OpenMapTiles road geometry; decorative demo actors and display-only speeds, not observed journeys or population.';
const MAX_FEATURES = 20_000;
const MAX_VERTICES = 200_000;
const MAX_LINE_VERTICES = 2_048;
const MAX_ROADS = 512;
const WALK_CLASSES = new Set(['path', 'pedestrian', 'footway', 'steps', 'track']);
const WALK_SUBCLASSES = new Set(['', 'path', 'pedestrian', 'footway', 'steps', 'corridor']);
const CAR_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'residential', 'living_street']);
const PERSON_COLORS = ['#53685e', '#b88062', '#75899b', '#baaf95', '#78687e', '#597581'];
const CAR_COLORS = ['#e4ded0', '#667479', '#a47b69', '#c4b490', '#587170'];

function stableKey(value: string): string {
  return `${hashSeed(value).toString(16).padStart(8, '0')}${hashSeed(`road:${value}`).toString(16).padStart(8, '0')}`;
}

function label(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).toLowerCase();
}

function denied(value: unknown): boolean {
  return ['no', 'private', 'false', '0'].includes(label(value));
}

function validPosition(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length >= 2
    && typeof value[0] === 'number' && Number.isFinite(value[0]) && Math.abs(value[0]) <= 180
    && typeof value[1] === 'number' && Number.isFinite(value[1]) && Math.abs(value[1]) <= 85.05112878;
}

function samePosition(left: Position, right: Position): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function budget(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) throw new Error('City road actor budget must be finite and non-negative');
  return Math.min(maximum, Math.floor(value));
}

function lineArrays(feature: CityTransportationFeature): readonly unknown[] {
  const geometry = feature.geometry;
  if (!geometry || !Array.isArray(geometry.coordinates)) return [];
  if (geometry.type === 'LineString') return [geometry.coordinates];
  if (geometry.type === 'MultiLineString' && geometry.coordinates.length <= 128) return geometry.coordinates;
  return [];
}

function localPoint(position: Position, origin: Position): Position {
  return [(position[0] - origin[0]) * 111_320 * Math.cos(origin[1] * Math.PI / 180),
    (position[1] - origin[1]) * 110_540];
}

function segmentDistance(point: Position, start: Position, end: Position): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1,
    ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared)) : 0;
  return Math.hypot(start[0] + t * dx - point[0], start[1] + t * dy - point[1]);
}

/** Liang–Barsky clips along the existing segment and introduces no connecting roads. */
function clipSegment(start: Position, end: Position, bounds: Bounds): readonly [Position, Position] | null {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const p = [-dx, dx, -dy, dy];
  const q = [start[0] - bounds[0], bounds[2] - start[0], start[1] - bounds[1], bounds[3] - start[1]];
  let from = 0;
  let to = 1;
  for (let index = 0; index < 4; index += 1) {
    if (p[index] === 0) {
      if (q[index]! < 0) return null;
    } else {
      const ratio = q[index]! / p[index]!;
      if (p[index]! < 0) from = Math.max(from, ratio);
      else to = Math.min(to, ratio);
      if (from >= to) return null;
    }
  }
  const at = (t: number): Position => {
    if (t === 0) return start;
    if (t === 1) return end;
    return [Math.max(bounds[0], Math.min(bounds[2], start[0] + t * dx)),
      Math.max(bounds[1], Math.min(bounds[3], start[1] + t * dy))];
  };
  const clipped = [at(from), at(to)] as const;
  return samePosition(clipped[0], clipped[1]) ? null : clipped;
}

function clipLine(line: readonly Position[], bounds: Bounds): Position[][] {
  const result: Position[][] = [];
  let current: Position[] = [];
  for (let index = 1; index < line.length; index += 1) {
    const segment = clipSegment(line[index - 1]!, line[index]!, bounds);
    if (!segment) {
      if (current.length > 1) result.push(current);
      current = [];
      continue;
    }
    if (!current.length || !samePosition(current.at(-1)!, segment[0])) {
      if (current.length > 1) result.push(current);
      current = [segment[0]];
    }
    current.push(segment[1]);
  }
  if (current.length > 1) result.push(current);
  return result;
}

interface Candidate extends CityRoad {
  readonly lengthMeters: number;
  readonly distanceMeters: number;
  readonly cumulativeMeters: readonly number[];
  readonly crosswalk: boolean;
}

function normalizeRoads(options: BuildCityRoadGraphOptions, bounds: Bounds): Candidate[] {
  if (options.features.length > MAX_FEATURES) throw new Error('City road input exceeds the bounded feature limit');
  let vertices = 0;
  for (const feature of options.features) {
    for (const line of lineArrays(feature)) {
      if (Array.isArray(line)) vertices += line.length;
      if (vertices > MAX_VERTICES) throw new Error('City road input exceeds the bounded vertex limit');
    }
  }
  const roads = new Map<string, Candidate>();
  for (const feature of options.features) {
    if (feature.sourceLayer && feature.sourceLayer !== 'transportation') continue;
    const properties = feature.properties ?? {};
    // OMT transportation includes rail/ferry/construction and non-surface geometry.
    // https://openmaptiles.org/schema/#transportation
    const className = label(properties.class);
    const subclass = label(properties.subclass);
    if (denied(properties.access) || label(properties.brunnel) === 'tunnel'
      || label(properties.indoor) === '1' || label(properties.indoor) === 'true') continue;
    const walkable = WALK_CLASSES.has(className) && !denied(properties.foot)
      && (WALK_SUBCLASSES.has(subclass)
        || (subclass === 'cycleway' && ['yes', 'designated', 'permissive'].includes(label(properties.foot))));
    const drivable = CAR_CLASSES.has(className) && !denied(properties.motor_vehicle)
      && !denied(properties.motorcar) && !denied(properties.vehicle);
    if (!walkable && !drivable) continue;
    const crosswalk = walkable && (label(properties.footway) === 'crossing' || label(properties.highway) === 'crossing');
    const originalDirection = drivable && ['1', 'true', 'yes', '-1'].includes(label(properties.oneway))
      ? (label(properties.oneway) === '-1' ? -1 : 1) : 0;
    for (const input of lineArrays(feature)) {
      // Reject an invalid line as a whole: deleting bad vertices would invent shortcuts.
      if (!Array.isArray(input) || input.length < 2 || input.length > MAX_LINE_VERTICES
        || !input.every(validPosition)) continue;
      const line: Position[] = [];
      for (const point of input) {
        const position: Position = [point[0], point[1]];
        if (!line.length || !samePosition(line.at(-1)!, position)) line.push(position);
      }
      if (line.length < 2) continue;
      const forward = JSON.stringify(line);
      const backward = JSON.stringify([...line].reverse());
      const reversed = backward < forward;
      const canonical = reversed ? line.reverse() : line;
      const oneway = (reversed ? -originalDirection : originalDirection) as -1 | 0 | 1;
      for (const coordinates of clipLine(canonical, bounds)) {
        const local = coordinates.map((position) => localPoint(position, options.origin));
        const cumulativeMeters = [0];
        let distanceMeters = Infinity;
        for (let index = 1; index < local.length; index += 1) {
          const start = local[index - 1]!;
          const end = local[index]!;
          cumulativeMeters.push(cumulativeMeters.at(-1)! + Math.hypot(end[0] - start[0], end[1] - start[1]));
          distanceMeters = Math.min(distanceMeters, segmentDistance([0, 0], start, end));
        }
        const lengthMeters = cumulativeMeters.at(-1)!;
        if (lengthMeters < 3) continue;
        // Feature IDs can be missing/repeated in tiles; canonical geometry is the identity.
        const key = JSON.stringify([className, walkable, drivable, oneway, crosswalk,
          label(properties.layer), label(properties.brunnel), coordinates]);
        roads.set(key, {
          id: `omt-road-${stableKey(key)}`, coordinates, oneway, className, walkable, drivable,
          cumulativeMeters, lengthMeters, distanceMeters, crosswalk,
        });
      }
    }
  }
  return [...roads.values()].sort((a, b) => a.distanceMeters - b.distanceMeters || a.id.localeCompare(b.id)).slice(0, MAX_ROADS);
}

function locationAt(road: Candidate, progress: number, reverse: boolean): { position: Position; heading: number } {
  const distance = progress * road.lengthMeters;
  let index = 1;
  while (index < road.cumulativeMeters.length - 1 && road.cumulativeMeters[index]! < distance) index += 1;
  const start = road.coordinates[index - 1]!;
  const end = road.coordinates[index]!;
  const length = road.cumulativeMeters[index]! - road.cumulativeMeters[index - 1]!;
  const fraction = length ? (distance - road.cumulativeMeters[index - 1]!) / length : 0;
  const position: Position = [start[0] + (end[0] - start[0]) * fraction, start[1] + (end[1] - start[1]) * fraction];
  const heading = (Math.atan2((end[0] - start[0]) * Math.cos(position[1] * Math.PI / 180),
    end[1] - start[1]) * 180 / Math.PI + (reverse ? 180 : 0) + 360) % 360;
  return { position, heading };
}

/**
 * Turns currently supplied real road/path geometry into bounded decorative motion.
 * Road categories select display cohorts; they are not a legal routing/access model.
 * Each route follows one contiguous polyline. No crossings, lanes, sidewalks, links
 * between features, or missing source geometry are inferred. `sidewalk` is the
 * renderer's pedestrian edge category, including mapped paths and footways here.
 * Profile rows are fictional clickable demo people; their counts are visual only.
 */
export function buildCityRoadGraph(options: BuildCityRoadGraphOptions): CityRoadGraph {
  if (!validPosition(options.origin)) throw new Error('City road origin must be finite WGS84 within WebMercator bounds');
  if (!Number.isFinite(options.presentationTimeSeconds)
    || !Number.isFinite(new Date(options.presentationTimeSeconds * 1_000).getTime())) {
    throw new Error('City road presentation epoch must be finite and representable');
  }
  const maxPeople = budget(options.maxPeople, 500, 500);
  const maxCars = budget(options.maxCars, 100, 100);
  const radius = options.maxDistanceMeters ?? 1_800;
  if (!Number.isFinite(radius) || radius <= 0) throw new Error('City road distance budget must be finite and positive');
  const ids = [...(options.peopleIds ?? []), ...(options.vehicleIds ?? [])];
  if (ids.some((id) => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) {
    throw new Error('City road supplied profile IDs must be nonempty and unique across actor kinds');
  }
  // Inscribed square guarantees that all retained geometry remains within the radius.
  const halfWindow = Math.max(50, Math.min(5_000, radius)) / Math.SQRT2;
  const longitudeRadius = halfWindow / (111_320 * Math.cos(options.origin[1] * Math.PI / 180));
  const latitudeRadius = halfWindow / 110_540;
  let bounds: Bounds = [Math.max(-180, options.origin[0] - longitudeRadius),
    Math.max(-85.05112878, options.origin[1] - latitudeRadius),
    Math.min(180, options.origin[0] + longitudeRadius), Math.min(85.05112878, options.origin[1] + latitudeRadius)];
  if (options.bounds) {
    const supplied = options.bounds;
    if (!validPosition([supplied[0], supplied[1]]) || !validPosition([supplied[2], supplied[3]])
      || supplied[0] >= supplied[2] || supplied[1] >= supplied[3]) throw new Error('City road bounds must have ordered finite WGS84 corners');
    bounds = [Math.max(bounds[0], supplied[0]), Math.max(bounds[1], supplied[1]),
      Math.min(bounds[2], supplied[2]), Math.min(bounds[3], supplied[3])];
  }
  const candidates = bounds[0] < bounds[2] && bounds[1] < bounds[3] ? normalizeRoads(options, bounds) : [];
  const nodes: WorldSceneMovementPayload['nodes'][number][] = [];
  const edges: WorldSceneMovementPayload['edges'][number][] = [];
  const routes: WorldSceneMovementPayload['routes'][number][] = [];
  const entities: VisualEntity[] = [];
  const movementEntities: LivingSceneMovementEntitySource[] = [];
  const presentationTime = new Date(options.presentationTimeSeconds * 1_000).toISOString();
  const roadsWithNodes = new Set<string>();
  const createdRouteIds = new Set<string>();

  for (const mode of ['pedestrian', 'car'] as const) {
    const vehicle = mode === 'car';
    const limit = vehicle ? maxCars : maxPeople;
    const profileIds = vehicle ? options.vehicleIds : options.peopleIds;
    const eligible = candidates.filter((road) => vehicle ? road.drivable : road.walkable);
    const slots: { road: Candidate; slot: number }[] = [];
    // Interleave slots across nearest roads before adding another actor to each road.
    for (let slot = 0; slot < (vehicle ? 12 : 24) && slots.length < limit; slot += 1) {
      for (const road of eligible) {
        if (slot >= Math.max(1, Math.floor(road.lengthMeters / (vehicle ? 30 : 14)))) continue;
        slots.push({ road, slot });
        if (slots.length >= limit) break;
      }
    }
    const selectedIds = profileIds ? [...profileIds].sort().slice(0, Math.min(limit, slots.length)) : null;
    const count = selectedIds?.length ?? slots.length;
    for (let index = 0; index < count; index += 1) {
      const { road, slot } = slots[index]!;
      const id = selectedIds?.[index] ?? `demo:${vehicle ? 'car' : 'person'}:${road.id}:${slot}`;
      const seed = hashSeed(id);
      const progress = 0.08 + ((hashSeed(`${id}:phase`) >>> 0) / 0xffffffff) * 0.84;
      const closed = samePosition(road.coordinates[0]!, road.coordinates.at(-1)!);
      const reverse = vehicle && road.oneway !== 0 ? road.oneway === -1 : !closed && (seed & 1) === 1;
      const routeId = `${road.id}:${mode}:route`;
      const edgeId = `${road.id}:${mode}:edge`;
      // Speeds are intentionally display-only constants, never learned or observed.
      const speedMps = vehicle ? 6 : 1.25;
      if (!createdRouteIds.has(routeId)) {
        createdRouteIds.add(routeId);
        const fromNodeId = `${road.id}:start`;
        const toNodeId = closed ? fromNodeId : `${road.id}:end`;
        if (!roadsWithNodes.has(road.id)) {
          roadsWithNodes.add(road.id);
          nodes.push({ nodeId: fromNodeId, position: road.coordinates[0]! });
          if (!closed) nodes.push({ nodeId: toNodeId, position: road.coordinates.at(-1)! });
        }
        edges.push({
          edgeId, fromNodeId, toNodeId, edgeKind: vehicle ? 'lane' : road.crosswalk ? 'crosswalk' : 'sidewalk',
          crossesRoad: road.crosswalk,
          direction: vehicle && road.oneway ? (road.oneway === 1 ? 'forward' : 'reverse') : 'bidirectional',
          allowedModes: [mode], geometry: road.coordinates,
          visualSpeedMetersPerSecond: { pedestrian: vehicle ? null : speedMps, car: vehicle ? speedMps : null, bicycle: null, transit: null },
        });
        routes.push({ routeId, mode, edgeIds: [edgeId],
          traversal: closed ? 'loop' : vehicle && road.oneway ? 'once' : 'ping_pong' });
      }
      const pose = locationAt(road, progress, reverse);
      entities.push({
        id, kind: vehicle ? 'vehicle' : 'focus',
        representation: vehicle ? 'ambient_only' : 'focus_person_1to1',
        representedCount: vehicle ? 0 : 1, longitude: pose.position[0], latitude: pose.position[1],
        heading: pose.heading, activity: vehicle ? 'ambient' : 'walk', seed,
        color: (vehicle ? CAR_COLORS : PERSON_COLORS)[seed % (vehicle ? CAR_COLORS.length : PERSON_COLORS.length)]!,
      });
      movementEntities.push({ id, entityKind: vehicle ? 'vehicle' : 'person', presentationTime,
        motion: { mode: 'network_edge', routeId, edgeId, progress, speedMps, direction: reverse ? 'reverse' : 'forward' } });
    }
  }
  const roads = candidates.map(({ id, coordinates, oneway, className, walkable, drivable }) =>
    ({ id, coordinates, oneway, className, walkable, drivable })).sort((a, b) => a.id.localeCompare(b.id));
  nodes.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  edges.sort((a, b) => a.edgeId.localeCompare(b.edgeId));
  routes.sort((a, b) => a.routeId.localeCompare(b.routeId));
  entities.sort((a, b) => a.id.localeCompare(b.id));
  movementEntities.sort((a, b) => a.id.localeCompare(b.id));
  return {
    movement: { nodes, edges, routes }, entities, movementEntities, roads,
    signature: stableKey(JSON.stringify([roads, entities.map(({ id }) => id),
      movementEntities.map(({ id, motion }) => [id, motion])])),
    sourceLabel: CITY_ROAD_SOURCE_LABEL,
    stats: { inputFeatures: options.features.length, acceptedRoads: roads.length,
      people: entities.filter(({ kind }) => kind !== 'vehicle').length,
      cars: entities.filter(({ kind }) => kind === 'vehicle').length },
  };
}
