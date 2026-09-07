import type { LivingCellSliceV1 } from '@omnitwin/contracts';
import type { VisualEntity, WorldSceneMovementPayload } from '../types';
import { hashSeed } from '../rng';
import type { LivingSceneMovementEntitySource } from './sceneMovement';

export interface LivingCellRendererTelemetry {
  readonly projectionScope: 'focus_sample';
  readonly classification: 'visual_synthesis';
  readonly scientificClaim: false;
  readonly renderedPedestrians: number;
  readonly renderedVehicles: number;
  readonly omittedBuildingOccupants: number;
  readonly omittedVehiclePassengers: number;
  readonly omittedUnbound: number;
  readonly deduplicatedViewportIds: number;
}

export interface LivingCellRendererInput {
  readonly entities: readonly VisualEntity[];
  /** Separate mobility rows; these must never be cast to privacy-sensitive VisualEntityV2. */
  readonly mobilityMovementSources: readonly LivingSceneMovementEntitySource[];
  readonly telemetry: LivingCellRendererTelemetry;
}

interface AuthoredPhase {
  readonly id: string;
  readonly kind: 'focus' | 'vehicle';
  readonly routeId: string;
  readonly edgeId: string;
  readonly progress: number;
  readonly speedMps: number;
  readonly direction: 'forward' | 'reverse';
  readonly presentationTime: string;
}

interface MovementIndex {
  readonly routesById: ReadonlyMap<string, WorldSceneMovementPayload['routes'][number]>;
  readonly edgesById: ReadonlyMap<string, WorldSceneMovementPayload['edges'][number]>;
  readonly completeRouteIds: ReadonlySet<string>;
}

const PEOPLE_COLORS = ['#d7b89d', '#a9bdc8', '#c49383', '#9cae91'] as const;
const VEHICLE_COLORS = ['#d7a050', '#7899a8', '#b96f5e', '#b7b5ac'] as const;

function wrappedDelta(longitude: number, origin: number): number {
  return ((longitude - origin + 540) % 360) - 180;
}

function segmentMeters(
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const latitude = (a[1] + b[1]) * 0.5 * Math.PI / 180;
  const x = wrappedDelta(b[0], a[0]) * Math.cos(latitude) * 111_320;
  const y = (b[1] - a[1]) * 110_540;
  return Math.hypot(x, y);
}

/** Interpolates strictly on the authored edge polyline; no fallback road is invented. */
export function authoredEdgePose(
  geometry: readonly (readonly [number, number])[],
  progress: number,
  direction: 'forward' | 'reverse',
): { longitude: number; latitude: number; heading: number } | null {
  if (geometry.length < 2 || !Number.isFinite(progress) || progress < 0 || progress > 1) return null;
  const lengths = new Float64Array(geometry.length - 1);
  let total = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = segmentMeters(geometry[index]!, geometry[index + 1]!);
    if (!Number.isFinite(length)) return null;
    lengths[index] = length;
    total += length;
  }
  if (!(total > 0)) return null;
  let remaining = progress * total;
  let segment = lengths.length - 1;
  for (let index = 0; index < lengths.length; index += 1) {
    if (remaining <= lengths[index]!) {
      segment = index;
      break;
    }
    remaining -= lengths[index]!;
  }
  const a = geometry[segment]!;
  const b = geometry[segment + 1]!;
  const ratio = lengths[segment]! > 0 ? Math.min(1, remaining / lengths[segment]!) : 0;
  const unwrappedLongitude = a[0] + wrappedDelta(b[0], a[0]) * ratio;
  const longitude = ((unwrappedLongitude + 540) % 360) - 180;
  const latitude = a[1] + (b[1] - a[1]) * ratio;
  const dx = wrappedDelta(b[0], a[0]) * Math.cos(latitude * Math.PI / 180);
  const dy = b[1] - a[1];
  let heading = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  if (direction === 'reverse') heading = (heading + 180) % 360;
  return { longitude, latitude, heading };
}

function validPhase(
  phase: AuthoredPhase,
  movement: MovementIndex,
): { entity: VisualEntity; movement: LivingSceneMovementEntitySource } | null {
  const route = movement.routesById.get(phase.routeId);
  const edge = movement.edgesById.get(phase.edgeId);
  const expectedMode = phase.kind === 'focus' ? 'pedestrian' : 'car';
  if (!route || !edge || route.mode !== expectedMode || !route.edgeIds.includes(edge.edgeId)
    || !edge.allowedModes.includes(expectedMode)
    || !movement.completeRouteIds.has(route.routeId)
    || (phase.direction === 'forward' && edge.direction === 'reverse')
    || (phase.direction === 'reverse' && edge.direction === 'forward')) return null;
  const pose = authoredEdgePose(edge.geometry, phase.progress, phase.direction);
  if (!pose) return null;
  const seed = hashSeed(phase.id);
  const person = phase.kind === 'focus';
  return {
    entity: {
      id: phase.id,
      kind: phase.kind,
      representation: person ? 'focus_person_1to1' : 'ambient_only',
      longitude: pose.longitude,
      latitude: pose.latitude,
      heading: pose.heading,
      representedCount: person ? 1 : 0,
      activity: person ? 'walk' : 'transit',
      color: (person ? PEOPLE_COLORS : VEHICLE_COLORS)[seed % 4]!,
      seed,
    },
    movement: {
      id: phase.id,
      entityKind: person ? 'person' : 'vehicle',
      motion: {
        mode: 'network_edge',
        routeId: phase.routeId,
        edgeId: phase.edgeId,
        progress: phase.progress,
        speedMps: phase.speedMps,
        direction: phase.direction,
      },
      presentationTime: phase.presentationTime,
    },
  };
}

export function compileLivingCellRendererInput(options: {
  readonly slices: readonly LivingCellSliceV1[];
  readonly movement: WorldSceneMovementPayload | null;
  readonly existingEntityIds?: ReadonlySet<string>;
}): LivingCellRendererInput {
  const entities: VisualEntity[] = [];
  const mobilityMovementSources: LivingSceneMovementEntitySource[] = [];
  const seen = new Set(options.existingEntityIds ?? []);
  let omittedBuildingOccupants = 0;
  let omittedVehiclePassengers = 0;
  let omittedUnbound = 0;
  let deduplicatedViewportIds = 0;
  let renderedPedestrians = 0;
  let renderedVehicles = 0;
  const routesById = new Map(options.movement?.routes.map((route) => [route.routeId, route]) ?? []);
  const edgesById = new Map(options.movement?.edges.map((edge) => [edge.edgeId, edge]) ?? []);
  const completeRouteIds = new Set<string>();
  for (const route of routesById.values()) {
    if (route.edgeIds.length > 0 && route.edgeIds.every((edgeId) => {
      const edge = edgesById.get(edgeId);
      return Boolean(edge && edge.geometry.length >= 2 && edge.allowedModes.includes(route.mode));
    })) completeRouteIds.add(route.routeId);
  }
  const movementIndex: MovementIndex = { routesById, edgesById, completeRouteIds };

  const add = (phase: AuthoredPhase) => {
    if (seen.has(phase.id)) {
      deduplicatedViewportIds += 1;
      return;
    }
    const resolved = options.movement ? validPhase(phase, movementIndex) : null;
    if (!resolved) {
      omittedUnbound += 1;
      return;
    }
    seen.add(phase.id);
    entities.push(resolved.entity);
    mobilityMovementSources.push(resolved.movement);
    if (phase.kind === 'focus') renderedPedestrians += 1;
    else renderedVehicles += 1;
  };

  for (const slice of options.slices) {
    for (const agent of slice.agents) {
      if (agent.presenceKind === 'building') {
        omittedBuildingOccupants += 1;
        continue;
      }
      if (agent.presenceKind === 'vehicle') {
        omittedVehiclePassengers += 1;
        continue;
      }
      if (!agent.routeId || !agent.edgeId || agent.motion.state !== 'moving'
        || agent.motion.progress === null || agent.motion.speedMps === null
        || agent.motion.direction === null) {
        omittedUnbound += 1;
        continue;
      }
      add({
        id: agent.opaqueId,
        kind: 'focus',
        routeId: agent.routeId,
        edgeId: agent.edgeId,
        progress: agent.motion.progress,
        speedMps: agent.motion.speedMps,
        direction: agent.motion.direction,
        presentationTime: slice.presentationTime,
      });
    }
    for (const vehicle of slice.vehicles) {
      add({
        id: vehicle.vehicleId,
        kind: 'vehicle',
        routeId: vehicle.routeId,
        edgeId: vehicle.edgeId,
        progress: vehicle.progress,
        speedMps: vehicle.speedMps,
        direction: vehicle.direction,
        presentationTime: slice.presentationTime,
      });
    }
  }
  return {
    entities,
    mobilityMovementSources,
    telemetry: {
      projectionScope: 'focus_sample',
      classification: 'visual_synthesis',
      scientificClaim: false,
      renderedPedestrians,
      renderedVehicles,
      omittedBuildingOccupants,
      omittedVehiclePassengers,
      omittedUnbound,
      deduplicatedViewportIds,
    },
  };
}
