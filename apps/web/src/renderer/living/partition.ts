import { hashSeed } from '../rng';
import type { VisualEntity } from '../types';
import {
  mergeLivingDeviceCaps,
  primaryRendererForLod,
  selectLivingLod,
  type LivingRendererPolicy,
} from './lodSelection';
import {
  DEFAULT_LIVING_DEVICE_CAPS,
  LivingActivity,
  LivingKind,
  LivingLod,
  LivingPrimaryRenderer,
  LivingRepresentation,
  type LivingConservation,
  type LivingDeviceCaps,
  type LivingPartition,
} from './types';
import type { CompiledLivingMovementGraph } from './movementGraph';
import {
  LIVING_ROUTE_LOCKED_ACTIVITY_PROFILE,
  validateLivingActivityScheduleDescriptor,
} from './activitySchedule';
import type { LivingActivityScheduleDescriptor } from './types';

const METERS_PER_LATITUDE_DEGREE = 110_540;
const WEB_MERCATOR_MAX_LATITUDE = 85.05112878;

function wrappedLongitudeDelta(longitude: number, originLongitude: number): number {
  return ((longitude - originLongitude + 540) % 360) - 180;
}

export interface CreateLivingPartitionOptions {
  zoom: number;
  /** Universal rendering uses one Deck cohort; omitted keeps the legacy split. */
  rendererPolicy?: LivingRendererPolicy;
  /** Explicit camera/cell origin. Never inferred from a bbox or entity mean. */
  origin: readonly [longitude: number, latitude: number];
  /** Projected per-entity screen size or an explicit uniform test value. */
  screenSizePixels: number | ArrayLike<number>;
  previousLodById?: ReadonlyMap<string, LivingLod>;
  /** The only row promoted above ordinary screen-space LOD and near caps. */
  selectedId?: string | null;
  caps?: Partial<LivingDeviceCaps>;
  movementGraph?: CompiledLivingMovementGraph;
  routeIdByEntityId?: ReadonlyMap<string, string>;
  routePhaseByEntityId?: ReadonlyMap<string, LivingRoutePhaseAnchor>;
  /** Optional typed seam populated from one verified viewport synthesis descriptor. */
  activitySchedule?: {
    descriptor: LivingActivityScheduleDescriptor;
    profileByEntityId: ReadonlyMap<string, number | null>;
  };
}

export interface LivingRoutePhaseAnchor {
  edgeId: string;
  progress: number;
  speedMetersPerSecond: number;
  presentationTimeSeconds: number;
  direction: 'forward' | 'reverse';
}

function kindCode(entity: VisualEntity): LivingKind {
  if (entity.kind === 'vehicle') return LivingKind.VEHICLE;
  if (entity.kind === 'focus') return LivingKind.FOCUS;
  return LivingKind.PERSON;
}

function representationCode(entity: VisualEntity): LivingRepresentation {
  if (entity.representation === 'focus_person_1to1') return LivingRepresentation.FOCUS_1_TO_1;
  if (entity.representation === 'ambient_only') return LivingRepresentation.AMBIENT_ONLY;
  return LivingRepresentation.AGGREGATE_PROXY;
}

function activityCode(entity: VisualEntity): LivingActivity {
  if (entity.activity === 'walk') return LivingActivity.WALK;
  if (entity.activity === 'work') return LivingActivity.WORK;
  if (entity.activity === 'study') return LivingActivity.STUDY;
  // Legacy ambient-only transport shares the internal route activity code;
  // the object boundary retains its truthful `ambient` presentation variant.
  if (entity.activity === 'ambient') return LivingActivity.TRANSIT;
  if (entity.activity === 'transit') return LivingActivity.TRANSIT;
  if (entity.activity === 'leisure') return LivingActivity.LEISURE;
  return LivingActivity.HOME;
}

function colorToRgba(color: string): number {
  const normalized = color.startsWith('#') ? color.slice(1) : color;
  const rgb = Number.parseInt(normalized.padEnd(6, '0').slice(0, 6), 16);
  return ((rgb << 8) | 0xff) >>> 0;
}

function screenSizeAt(source: number | ArrayLike<number>, index: number): number {
  if (typeof source === 'number') {
    if (!Number.isFinite(source) || source < 0) {
      throw new Error('Living partition screen-space size must be finite and non-negative');
    }
    return source;
  }
  const value = source?.[index];
  if (!Number.isFinite(value) || Number(value) < 0) {
    throw new Error(`Living partition is missing screen-space size for entity index ${index}`);
  }
  return Number(value);
}

function validateEntitySemantics(entities: readonly VisualEntity[]): void {
  const ids = new Set<string>();
  for (const entity of entities) {
    if (!entity.id || ids.has(entity.id)) throw new Error(`Living partition duplicate or empty logical id: ${entity.id}`);
    ids.add(entity.id);
    if (!Number.isFinite(entity.longitude) || entity.longitude < -180 || entity.longitude > 180
      || !Number.isFinite(entity.latitude)
      || entity.latitude < -90 || entity.latitude > 90) {
      throw new Error(`Living entity ${entity.id} has invalid coordinates`);
    }
    if (!Number.isFinite(entity.heading)) throw new Error(`Living entity ${entity.id} has invalid heading`);
    if (!Number.isSafeInteger(entity.seed) || entity.seed < 0 || entity.seed > 0xffffffff) {
      throw new Error(`Living entity ${entity.id} has invalid presentation seed`);
    }
    if (!Number.isSafeInteger(entity.representedCount)
      || entity.representedCount < 0
      || entity.representedCount > 0xffffffff) {
      throw new Error(`Living entity ${entity.id} has invalid representedCount`);
    }
    if (entity.representation === 'focus_person_1to1' && entity.representedCount !== 1) {
      throw new Error(`Focus entity ${entity.id} must represent exactly one person`);
    }
    if (entity.representation === 'ambient_only' && entity.representedCount !== 0) {
      throw new Error(`Ambient entity ${entity.id} must have representedCount=0`);
    }
    if (entity.representation === 'aggregate_proxy' && entity.representedCount < 1) {
      throw new Error(`Aggregate proxy ${entity.id} must represent at least one person`);
    }
    const focusKind = entity.kind === 'focus';
    const focusRepresentation = entity.representation === 'focus_person_1to1';
    // The legacy representation name describes one-to-one profile eligibility,
    // not visual emphasis. Ordinary people may be eligible without being focus.
    if ((focusKind && !focusRepresentation) || (entity.kind === 'vehicle' && focusRepresentation)) {
      throw new Error(`Living focus/profile kind/representation mismatch: ${entity.id}`);
    }
  }
}

interface Candidate {
  index: number;
  requestedLod: LivingLod;
  screenSizePixels: number;
  focus: boolean;
  vehicle: boolean;
  idHash: number;
}

function candidateOrder(left: Candidate, right: Candidate): number {
  if (left.focus !== right.focus) return left.focus ? -1 : 1;
  if (left.requestedLod !== right.requestedLod) return right.requestedLod - left.requestedLod;
  if (left.screenSizePixels !== right.screenSizePixels) return right.screenSizePixels - left.screenSizePixels;
  if (left.idHash !== right.idHash) return left.idHash - right.idHash;
  return left.index - right.index;
}

export function createLivingPartition(
  entities: readonly VisualEntity[],
  options: CreateLivingPartitionOptions,
): LivingPartition {
  validateEntitySemantics(entities);
  if (!Number.isFinite(options.zoom) || options.zoom < 0 || options.zoom > 30) {
    throw new Error('Living partition requires a finite zoom in [0, 30]');
  }
  if (options.routeIdByEntityId) {
    const logicalIds = new Set(entities.map(({ id }) => id));
    for (const entityId of options.routeIdByEntityId.keys()) {
      if (!logicalIds.has(entityId)) {
        throw new Error(`Living route assignment references unknown logical id: ${entityId}`);
      }
    }
  }
  if (options.routePhaseByEntityId) {
    const assignedIds = options.routeIdByEntityId ?? new Map<string, string>();
    for (const entityId of options.routePhaseByEntityId.keys()) {
      if (!assignedIds.has(entityId)) {
        throw new Error(`Living route phase references an entity without an assigned route: ${entityId}`);
      }
    }
  }
  if (options.activitySchedule) {
    validateLivingActivityScheduleDescriptor(options.activitySchedule.descriptor);
    const logicalIds = new Set(entities.map(({ id }) => id));
    for (const entityId of options.activitySchedule.profileByEntityId.keys()) {
      if (!logicalIds.has(entityId)) {
        throw new Error(`Living activity schedule references unknown logical id: ${entityId}`);
      }
    }
  }
  const count = entities.length;
  const [originLongitude, originLatitude] = options.origin;
  if (!Number.isFinite(originLongitude) || originLongitude < -180 || originLongitude > 180
    || !Number.isFinite(originLatitude)
    || originLatitude < -WEB_MERCATOR_MAX_LATITUDE
    || originLatitude > WEB_MERCATOR_MAX_LATITUDE) {
    throw new Error('Living partition requires an explicit origin within WebMercator bounds');
  }
  const longitudeMeters = Math.cos((originLatitude * Math.PI) / 180) * 111_320;
  const caps = mergeLivingDeviceCaps(options.caps, DEFAULT_LIVING_DEVICE_CAPS);
  const ids = new Array<string>(count);
  const idHash = new Uint32Array(count);
  const seed = new Uint32Array(count);
  const kind = new Uint8Array(count);
  const representation = new Uint8Array(count);
  const activity = new Uint8Array(count);
  const activityScheduleProfile = options.activitySchedule ? new Uint8Array(count) : null;
  const representedCount = new Uint32Array(count);
  const colorRgba = new Uint32Array(count);
  const baseX = new Float32Array(count);
  const baseY = new Float32Array(count);
  const previousX = new Float32Array(count);
  const previousY = new Float32Array(count);
  const currentX = new Float32Array(count);
  const currentY = new Float32Array(count);
  const previousHeading = new Float32Array(count);
  const currentHeading = new Float32Array(count);
  const baseHeading = new Float32Array(count);
  const speedMetersPerSecond = new Float32Array(count);
  const routeIndex = new Int32Array(count).fill(-1);
  const currentEdgeIndex = new Int32Array(count).fill(-1);
  const routePhaseOffsetSeconds = new Float64Array(count).fill(Number.NaN);
  const routePhaseAnchorSeconds = new Float64Array(count).fill(Number.NaN);
  const lod = new Uint8Array(count);
  const primaryRenderer = new Uint8Array(count);
  const visible = new Uint8Array(count);
  const screenSizePixels = new Float32Array(count);
  const candidates = new Array<Candidate>(count);

  for (let index = 0; index < count; index += 1) {
    const entity = entities[index]!;
    const entityKind = kindCode(entity);
    const entityScreenSize = screenSizeAt(options.screenSizePixels, index);
    const hash = hashSeed(entity.id);
    const selection = selectLivingLod({
      zoom: options.zoom,
      screenSizePixels: entityScreenSize,
      previousLod: options.previousLodById?.get(entity.id),
      focus: options.selectedId === entity.id,
      rendererPolicy: options.rendererPolicy,
    });
    ids[index] = entity.id;
    idHash[index] = hash;
    seed[index] = entity.seed >>> 0;
    kind[index] = entityKind;
    representation[index] = representationCode(entity);
    activity[index] = activityCode(entity);
    if (activityScheduleProfile) {
      const profileByEntityId = options.activitySchedule!.profileByEntityId;
      if (!profileByEntityId.has(entity.id)) {
        throw new Error(`Living activity schedule is missing logical id: ${entity.id}`);
      }
      const profile = profileByEntityId.get(entity.id);
      if (profile === null) activityScheduleProfile[index] = LIVING_ROUTE_LOCKED_ACTIVITY_PROFILE;
      else {
        if (!Number.isSafeInteger(profile) || profile! < 0 || profile! > 11) {
          throw new Error(`Living activity schedule profile for ${entity.id} must be in [0, 11] or null`);
        }
        activityScheduleProfile[index] = profile!;
      }
    }
    representedCount[index] = Math.max(0, Math.floor(entity.representedCount));
    colorRgba[index] = colorToRgba(entity.color);
    baseX[index] = wrappedLongitudeDelta(entity.longitude, originLongitude) * longitudeMeters;
    baseY[index] = (entity.latitude - originLatitude) * METERS_PER_LATITUDE_DEGREE;
    previousX[index] = baseX[index]!;
    previousY[index] = baseY[index]!;
    currentX[index] = baseX[index]!;
    currentY[index] = baseY[index]!;
    previousHeading[index] = entity.heading;
    currentHeading[index] = entity.heading;
    baseHeading[index] = entity.heading;
    const unit = (entity.seed >>> 0) / 0xffffffff;
    speedMetersPerSecond[index] = entityKind === LivingKind.VEHICLE
      ? 8 + unit * 7
      : activity[index] === LivingActivity.WALK ? 0.8 + unit * 0.7 : 0;
    const routeId = options.routeIdByEntityId?.get(entity.id);
    if (routeId !== undefined) {
      if (!options.movementGraph) throw new Error(`Living entity ${entity.id} has a route without a movement graph`);
      const assignedRouteIndex = options.movementGraph.routeIndexById.get(routeId);
      if (assignedRouteIndex === undefined) throw new Error(`Living entity ${entity.id} references unknown route ${routeId}`);
      const route = options.movementGraph.routes[assignedRouteIndex]!;
      const expectedKind = entityKind === LivingKind.VEHICLE ? 'vehicle' : 'pedestrian';
      if (route.kind !== expectedKind) throw new Error(`Living entity ${entity.id} is assigned to incompatible route ${routeId}`);
      routeIndex[index] = assignedRouteIndex;
      speedMetersPerSecond[index] = route.lengthMeters / route.durationSeconds;
      const phase = options.routePhaseByEntityId?.get(entity.id);
      if (phase) {
        if (!Number.isFinite(phase.progress) || phase.progress < 0 || phase.progress > 1
          || !(phase.speedMetersPerSecond > 0) || !Number.isFinite(phase.speedMetersPerSecond)
          || !Number.isFinite(phase.presentationTimeSeconds)) {
          throw new Error(`Living entity ${entity.id} has invalid route phase anchor`);
        }
        if (phase.direction !== 'forward' && phase.direction !== 'reverse') {
          throw new Error(`Living entity ${entity.id} has invalid route direction`);
        }
        const matchingOffsets = [...route.edgeIndices]
          .map((edgeIndex, offset) => options.movementGraph!.edgeIds[edgeIndex] === phase.edgeId ? offset : -1)
          .filter((offset) => offset >= 0);
        if (matchingOffsets.length !== 1) {
          throw new Error(`Living entity ${entity.id} phase edge is missing or ambiguous on route ${routeId}`);
        }
        const edgeOffset = matchingOffsets[0]!;
        const edgeDuration = route.cumulativeTravelSeconds[edgeOffset + 1]!
          - route.cumulativeTravelSeconds[edgeOffset]!;
        const expectedSpeed = options.movementGraph.edgeLengthMeters[route.edgeIndices[edgeOffset]!]!
          / edgeDuration;
        if (Math.abs(expectedSpeed - phase.speedMetersPerSecond) > Math.max(0.001, expectedSpeed * 0.001)) {
          throw new Error(`Living entity ${entity.id} phase speed disagrees with its authored route`);
        }
        const edgeOrientation = route.edgeDirections[edgeOffset]!;
        const routeProgress = edgeOrientation === 1 ? phase.progress : 1 - phase.progress;
        const routeCoordinate = route.cumulativeTravelSeconds[edgeOffset]!
          + edgeDuration * routeProgress;
        const forwardDirection = edgeOrientation === 1 ? 'forward' : 'reverse';
        let routePhase = routeCoordinate;
        if (phase.direction !== forwardDirection) {
          if (route.traversal !== 'ping_pong') {
            throw new Error(`Living entity ${entity.id} direction is illegal for route ${routeId}`);
          }
          routePhase = route.durationSeconds * 2 - routeCoordinate;
        }
        routePhaseOffsetSeconds[index] = routePhase - phase.presentationTimeSeconds;
        routePhaseAnchorSeconds[index] = routePhase;
      }
    }
    screenSizePixels[index] = entityScreenSize;
    candidates[index] = {
      index,
      requestedLod: selection.lod,
      screenSizePixels: entityScreenSize,
      focus: options.selectedId === entity.id,
      vehicle: entityKind === LivingKind.VEHICLE,
      idHash: hash,
    };
  }

  let pedestrians = 0;
  let vehicles = 0;
  let detailed = 0;
  let detailedPedestrians = 0;
  let detailedVehicles = 0;
  let low = 0;
  let impostors = 0;
  for (const candidate of candidates.toSorted(candidateOrder)) {
    const kindAvailable = candidate.focus
      || (candidate.vehicle ? vehicles < caps.maxVehicles : pedestrians < caps.maxPedestrians);
    if (!kindAvailable || candidate.requestedLod === LivingLod.CULLED) continue;
    let assigned = candidate.requestedLod;
    const detailedKindAvailable = candidate.vehicle
      ? detailedVehicles < caps.maxDetailedVehicles
      : detailedPedestrians < caps.maxDetailedPedestrians;
    if (
      assigned === LivingLod.DETAILED
      && (detailed >= caps.maxDetailed || !detailedKindAvailable)
    ) assigned = LivingLod.LOW;
    if (assigned === LivingLod.LOW && low >= caps.maxLow) assigned = LivingLod.IMPOSTOR;
    if (assigned === LivingLod.IMPOSTOR && impostors >= caps.maxImpostors) continue;
    if (assigned === LivingLod.DETAILED) {
      detailed += 1;
      if (candidate.vehicle) detailedVehicles += 1;
      else detailedPedestrians += 1;
    }
    else if (assigned === LivingLod.LOW) low += 1;
    else impostors += 1;
    if (candidate.vehicle) vehicles += 1;
    else pedestrians += 1;
    lod[candidate.index] = assigned;
    primaryRenderer[candidate.index] = primaryRendererForLod(assigned, options.rendererPolicy);
    visible[candidate.index] = 1;
  }

  return {
    count,
    maxChunkEntities: caps.maxChunkEntities,
    originLongitude,
    originLatitude,
    identity: { ids, idHash, seed, kind, representation, activity, representedCount, colorRgba },
    activitySchedule: activityScheduleProfile && options.activitySchedule
      ? {
          descriptor: { ...options.activitySchedule.descriptor },
          profile: activityScheduleProfile,
        }
      : null,
    position: {
      baseX, baseY, previousX, previousY, currentX, currentY,
      previousHeading, currentHeading, baseHeading, speedMetersPerSecond,
    },
    movement: { routeIndex, currentEdgeIndex, routePhaseOffsetSeconds, routePhaseAnchorSeconds },
    movementGraph: options.movementGraph ?? null,
    presentation: { lod, primaryRenderer, visible, screenSizePixels },
  };
}

export function livingConservation(partition: LivingPartition): LivingConservation {
  let deck = 0;
  let three = 0;
  let culled = 0;
  let duplicatePrimary = 0;
  let representedLogical = 0;
  let representedDeck = 0;
  let representedThree = 0;
  let representedCulled = 0;
  for (let index = 0; index < partition.count; index += 1) {
    const renderer = partition.presentation.primaryRenderer[index];
    const represented = partition.identity.representedCount[index]!;
    representedLogical += represented;
    const isVisible = partition.presentation.visible[index] === 1;
    if (renderer === LivingPrimaryRenderer.DECK) {
      deck += 1;
      representedDeck += represented;
    } else if (renderer === LivingPrimaryRenderer.THREE) {
      three += 1;
      representedThree += represented;
    } else {
      culled += 1;
      representedCulled += represented;
    }
    if (isVisible !== (renderer !== LivingPrimaryRenderer.NONE)) duplicatePrimary += 1;
  }
  return {
    logical: partition.count,
    deck,
    three,
    culled,
    duplicatePrimary,
    representedLogical,
    representedDeck,
    representedThree,
    representedCulled,
  };
}

export function previousLivingLodMap(partition: LivingPartition): ReadonlyMap<string, LivingLod> {
  const result = new Map<string, LivingLod>();
  for (let index = 0; index < partition.count; index += 1) {
    result.set(partition.identity.ids[index]!, partition.presentation.lod[index] as LivingLod);
  }
  return result;
}
