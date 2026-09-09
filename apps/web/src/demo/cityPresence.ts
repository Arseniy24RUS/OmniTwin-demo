import type { StaticDemoProvider } from './data';
import type { DemoContextV1, DemoLayout, DemoPresence, PublicFictionalPersonV1 } from './types';
import type { VisualEntity, WorldSceneMovementPayload } from '../renderer/types';
import type { LivingSceneMovementEntitySource } from '../renderer/living/sceneMovement';
import { hashSeed } from '../renderer/rng';
import { declutterVehicleGlyphs, type VehicleDeclutterDiagnostics } from './vehicleDeclutter';

export const CITY_PRESENTATION_EPOCH_SECONDS = Date.UTC(2026, 0, 1) / 1_000;
export const CITY_PRESENCE_RECONCILE_SECONDS = 5;
/** Display clock bucket, not a demographic/schedule time step. GPU motion remains continuous. */
export function cityPresenceAnchorMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) throw new Error('City presence needs finite presentation minutes');
  return Math.floor((minutes * 60 + 1e-7) / CITY_PRESENCE_RECONCILE_SECONDS) * CITY_PRESENCE_RECONCILE_SECONDS / 60;
}
export type CityPresenceProvider = Pick<StaticDemoProvider, 'getLayout' | 'getVisibleCandidates' | 'getPresence' | 'getPerson'>;
export interface CityPresenceOptions {
  maxPeople?: number;
  maxVehicles?: number;
  selectedId?: string | null;
  /** Optional caller-owned last-frame IDs; never shared globally or persisted. */
  previousVehicleIds?: ReadonlySet<string>;
  /** Continuous game instances; no change to provider routes, speeds or presence. */
  preserveActiveVehicleMembership?: boolean;
}
export interface CityPresenceFrame {
  entities: readonly VisualEntity[];
  movement: WorldSceneMovementPayload;
  movementEntities: readonly LivingSceneMovementEntitySource[];
  peopleCount: number;
  vehicleCount: number;
  /** Display-pool counts only; never a count of all cars or residents in the city. */
  vehicleDeclutter: VehicleDeclutterDiagnostics;
  sourceLabel: string;
  /** Exact shared five-second anchor; callers interpolate the clock from this frame. */
  presentationTimeSeconds: number;
}
type Position = readonly [number, number];
type Road = DemoLayout['roads'][number];
interface MeasuredRoad {
  source: Road;
  local: Position[];
  cumulative: number[];
  total: number;
  closed: boolean;
}
interface Candidate {
  id: string;
  profile: PublicFictionalPersonV1;
  presence: DemoPresence;
  vehicle: boolean;
  selected: boolean;
  road: MeasuredRoad;
  position: Position;
  progress: number;
  heading: number;
  distance: number;
  speed: number;
  direction: 'forward' | 'reverse';
  routeMode: 'loop' | 'ping_pong' | 'once';
}
const PERSON_COLORS = ['#53685e', '#b88062', '#75899b', '#baaf95', '#78687e', '#597581'];
const CAR_COLORS = ['#e4ded0', '#667479', '#a47b69', '#c4b490', '#587170'];

function pointIsValid(point: unknown): point is [number, number] {
  return Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)
    && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 85.05112878;
}
function localPoint(point: Position, origin: Position): Position {
  return [(((point[0] - origin[0] + 540) % 360) - 180) * Math.cos(origin[1] * Math.PI / 180) * 111_320,
    (point[1] - origin[1]) * 110_540];
}
function samePoint(a: Position, b: Position): boolean { return a[0] === b[0] && a[1] === b[1]; }
function actorLimit(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isFinite(value) || value < 0) throw new Error('City presence actor limit must be finite and non-negative');
  return Math.min(maximum, Math.floor(value));
}
function measuredRoad(source: Road, origin: Position): MeasuredRoad | null {
  if (!source.id || source.coordinates.length < 2 || source.coordinates.length > 2_048
    || !source.coordinates.every(pointIsValid)) return null;
  const local = source.coordinates.map((point) => localPoint(point, origin));
  const cumulative = [0];
  for (let index = 1; index < local.length; index += 1) {
    const length = Math.hypot(local[index]![0] - local[index - 1]![0], local[index]![1] - local[index - 1]![1]);
    if (!(length > 0)) return null;
    cumulative.push(cumulative.at(-1)! + length);
  }
  return { source, local, cumulative, total: cumulative.at(-1)!,
    closed: samePoint(source.coordinates[0]!, source.coordinates.at(-1)!) };
}

/** Reconcile the provider's exact coordinate to the renderer's camera-local metric. */
function sourceAnchor(road: MeasuredRoad, position: Position, origin: Position, reverse: boolean) {
  const point = localPoint(position, origin);
  let nearest = Infinity;
  let progress = 0;
  let heading = 0;
  for (let index = 1; index < road.local.length; index += 1) {
    const start = road.local[index - 1]!;
    const end = road.local[index]!;
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const fraction = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy)));
    const error = Math.hypot(start[0] + dx * fraction - point[0], start[1] + dy * fraction - point[1]);
    if (error < nearest) {
      nearest = error;
      progress = (road.cumulative[index - 1]! + fraction * (road.cumulative[index]! - road.cumulative[index - 1]!)) / road.total;
      heading = (Math.atan2(dx, dy) * 180 / Math.PI + (reverse ? 180 : 0) + 360) % 360;
    }
  }
  // The provider promises a point on the registered road. Do not snap unrelated positions.
  return nearest <= 0.05 ? { progress: Math.max(0, Math.min(1, progress)), heading,
    distance: Math.hypot(point[0], point[1]) } : null;
}

function inCohort(person: PublicFictionalPersonV1, context: DemoContextV1): boolean {
  const territoryMatches = ['RU-CHE-SET', 'chelyabinsk'].includes(context.territoryId)
    || person.territoryId === context.territoryId;
  return territoryMatches && (!context.cohort?.ageBand || person.ageBand === context.cohort.ageBand)
    && (!context.cohort?.sex || person.sex === context.cohort.sex)
    && (!context.cohort?.employment || person.employment === context.cohort.employment);
}

/**
 * The shared provider owns presence, household membership, routes and schedule.
 * This adapter retains only currently outdoor people and unique household cars;
 * indoor/unplaced residents remain available through the provider's rosters.
 * Reconcile once per five-second clock bucket/context/layout revision and let Living interpolate.
 */
export function buildCityPresenceFrame(
  provider: CityPresenceProvider,
  context: DemoContextV1,
  options: CityPresenceOptions = {},
): CityPresenceFrame {
  const origin: Position = [context.camera.longitude, context.camera.latitude];
  if (!pointIsValid(origin) || !Number.isFinite(context.presentationMinutes)) throw new Error('City presence needs a finite camera and presentation minute');
  const minute = cityPresenceAnchorMinutes(context.presentationMinutes);
  const presentationTimeSeconds = CITY_PRESENTATION_EPOCH_SECONDS + minute * 60;
  const presentationTime = new Date(presentationTimeSeconds * 1_000).toISOString();
  const maxPeople = actorLimit(options.maxPeople, 1200);
  const maxVehicles = actorLimit(options.maxVehicles, 1800);
  const layout = provider.getLayout();
  const sourceRoads = new Map(layout.roads.map((road) => [road.id, road]));
  const roadCache = new Map<string, MeasuredRoad | null>();
  const people = provider.getVisibleCandidates(context.scenario, context.year, 5_000, {
    longitude: origin[0], latitude: origin[1], radiusMeters: 2_500, minutes: minute,
    territoryId: context.territoryId, ...context.cohort,
  });
  if (options.selectedId && !people.some(({ id }) => id === options.selectedId)) {
    const selected = provider.getPerson(options.selectedId, context.scenario, context.year);
    if (selected) people.push(selected);
  }
  const candidates = new Map<string, Candidate>();
  for (const profile of people) {
    if (profile.id !== options.selectedId && !inCohort(profile, context)) continue;
    const presence = provider.getPresence(profile.id, minute, context.scenario, context.year);
    if (!presence || presence.personId !== profile.id
      || (presence.state !== 'outdoor' && presence.state !== 'vehicle')
      || !presence.roadId || !pointIsValid(presence.position)) continue;
    const vehicle = presence.state === 'vehicle';
    const id = vehicle ? presence.vehicleId : profile.id;
    if (!id || !Number.isFinite(presence.routeProgress) || presence.routeProgress! < 0 || presence.routeProgress! > 1
      || !(presence.speedMps! > 0) || !Number.isFinite(presence.speedMps)
      || (presence.direction !== 'forward' && presence.direction !== 'reverse')) continue;
    const source = sourceRoads.get(presence.roadId);
    if (!source || (vehicle ? source.drivable === false : source.walkable === false)) continue;
    if (!roadCache.has(source.id)) roadCache.set(source.id, measuredRoad(source, origin));
    const road = roadCache.get(source.id);
    if (!road) continue;
    // New provider frames author traversal explicitly. Only legacy frames without
    // this optional field use the previous source-geometry interpretation.
    const routeMode = presence.routeMode ?? (road.closed ? 'loop' : vehicle && source.oneway ? 'once' : 'ping_pong');
    if (!['loop', 'ping_pong', 'once'].includes(routeMode) || routeMode === 'loop' && !road.closed
      || vehicle && source.oneway && routeMode === 'ping_pong'
      || (routeMode !== 'ping_pong' || vehicle && source.oneway) && presence.direction === 'reverse') continue;
    const anchor = sourceAnchor(road, presence.position, origin, presence.direction === 'reverse');
    const selected = id === options.selectedId || profile.id === options.selectedId;
    if (!anchor || (!selected && anchor.distance > 2_500)) continue;
    const candidate: Candidate = { id, profile, presence, vehicle, selected, road,
      position: presence.position, progress: anchor.progress, heading: anchor.heading, distance: anchor.distance,
      speed: presence.speedMps!, direction: presence.direction, routeMode };
    const previous = candidates.get(id);
    if (!previous || selected && !previous.selected || selected === previous.selected && profile.id < previous.profile.id) {
      candidates.set(id, candidate);
    }
  }
  const ordered = [...candidates.values()].sort((a, b) => Number(b.selected) - Number(a.selected)
    || a.distance - b.distance || a.id.localeCompare(b.id));
  const vehicleDisplay = declutterVehicleGlyphs(ordered.filter(candidate => candidate.vehicle).map(candidate => {
    const point = localPoint(candidate.position, origin);
    return { id: candidate.id, x: point[0], y: point[1], heading: candidate.heading, selected: candidate.selected };
  }), { maxVehicles, previousVehicleIds: options.previousVehicleIds, preserveActiveMembership: options.preserveActiveVehicleMembership });
  const retainedVehicles = new Set(vehicleDisplay.retained.map(candidate => candidate.id));
  const retained: Candidate[] = [];
  let peopleCount = 0;
  let vehicleCount = 0;
  for (const candidate of ordered) {
    if (candidate.vehicle && !retainedVehicles.has(candidate.id)) continue;
    if (candidate.vehicle ? vehicleCount >= maxVehicles : peopleCount >= maxPeople) continue;
    retained.push(candidate);
    if (candidate.vehicle) vehicleCount += 1;
    else peopleCount += 1;
  }
  const nodes = new Map<string, WorldSceneMovementPayload['nodes'][number]>();
  const edges = new Map<string, WorldSceneMovementPayload['edges'][number]>();
  const routes = new Map<string, WorldSceneMovementPayload['routes'][number]>();
  const entities: VisualEntity[] = [];
  const movementEntities: LivingSceneMovementEntitySource[] = [];
  for (const candidate of retained) {
    const { id, vehicle, road, position, progress, heading, speed, direction, routeMode } = candidate;
    const mode = vehicle ? 'car' : 'pedestrian';
    // Source-road identity stays intact; these derived renderer keys distinguish
    // the provider's exact physical speed buckets without altering their speeds.
    const graphKey = `presence:${road.source.id}:${mode}:speed-${speed}:${routeMode}`;
    const routeId = `${graphKey}:route`;
    const edgeId = `${graphKey}:edge`;
    const fromNodeId = `presence:${road.source.id}:start`;
    const toNodeId = road.closed ? fromNodeId : `presence:${road.source.id}:end`;
    const existing = edges.get(edgeId);
    if (!existing) {
      nodes.set(fromNodeId, { nodeId: fromNodeId, position: road.source.coordinates[0]! });
      if (!road.closed) nodes.set(toNodeId, { nodeId: toNodeId, position: road.source.coordinates.at(-1)! });
      edges.set(edgeId, { edgeId, fromNodeId, toNodeId, edgeKind: vehicle ? 'lane' : 'sidewalk',
        crossesRoad: false, direction: vehicle && road.source.oneway ? 'forward' : 'bidirectional',
        allowedModes: [mode], geometry: road.source.coordinates,
        visualSpeedMetersPerSecond: { pedestrian: vehicle ? null : speed, car: vehicle ? speed : null, bicycle: null, transit: null } });
      routes.set(routeId, { routeId, mode, edgeIds: [edgeId], traversal: routeMode });
    }
    const seed = hashSeed(id);
    const palette = vehicle ? CAR_COLORS : PERSON_COLORS;
    entities.push({ id, kind: vehicle ? 'vehicle' : candidate.selected ? 'focus' : 'person', representation: vehicle ? 'ambient_only' : 'focus_person_1to1',
      representedCount: vehicle ? 0 : 1, longitude: position[0], latitude: position[1], heading,
      activity: vehicle ? 'ambient' : 'walk', color: palette[seed % palette.length]!, seed });
    movementEntities.push({ id, entityKind: vehicle ? 'vehicle' : 'person', presentationTime,
      motion: { mode: 'network_edge', routeId, edgeId, progress, speedMps: speed, direction } });
  }
  entities.sort((a, b) => a.id.localeCompare(b.id));
  movementEntities.sort((a, b) => a.id.localeCompare(b.id));
  return { entities, movementEntities, peopleCount, vehicleCount, presentationTimeSeconds, vehicleDeclutter: vehicleDisplay.diagnostics,
    movement: { nodes: [...nodes.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
      edges: [...edges.values()].sort((a, b) => a.edgeId.localeCompare(b.edgeId)),
      routes: [...routes.values()].sort((a, b) => a.routeId.localeCompare(b.routeId)) },
    sourceLabel: 'OpenStreetMap / OpenMapTiles geometry; fictional demo presence, household vehicles and display-only movement.' };
}
