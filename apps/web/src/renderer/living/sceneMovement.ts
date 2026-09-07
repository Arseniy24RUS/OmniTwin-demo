import {
  compileLivingMovementGraph,
  type CompiledLivingMovementGraph,
  type LivingMovementEdgeInput,
  type LivingMovementRouteInput,
} from './movementGraph';
import type { VisualEntity } from '../types';
import { hashSeed } from '../rng';
import type { LivingRoutePhaseAnchor } from './partition';

export type LivingSceneRouteMode = 'pedestrian' | 'bicycle' | 'car' | 'transit';

export interface LivingSceneMovementNodeSource {
  nodeId: string;
  position: readonly [longitude: number, latitude: number];
}

export interface LivingSceneMovementEdgeSource {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  edgeKind: 'sidewalk' | 'crosswalk' | 'lane';
  crossesRoad: boolean;
  direction: 'bidirectional' | 'forward' | 'reverse';
  allowedModes: readonly LivingSceneRouteMode[];
  geometry: readonly (readonly [longitude: number, latitude: number])[];
  visualSpeedMetersPerSecond: Readonly<Record<LivingSceneRouteMode, number | null>>;
}

export interface LivingSceneMovementRouteSource {
  routeId: string;
  mode: LivingSceneRouteMode;
  edgeIds: readonly string[];
  traversal: 'loop' | 'ping_pong' | 'once';
}

export interface LivingSceneMovementEntitySource {
  id: string;
  entityKind: 'person' | 'vehicle' | 'bicycle' | 'transit_vehicle';
  motion: {
    mode: 'stationary' | 'network_edge' | 'cell_interpolation';
    routeId: string | null;
    edgeId: string | null;
    progress: number | null;
    speedMps: number;
    direction: 'forward' | 'reverse' | null;
  };
  presentationTime: string;
}

export interface CompileLivingSceneMovementOptions {
  /** Same explicit camera/cell origin passed to createLivingPartition. */
  origin: readonly [longitude: number, latitude: number];
  nodes: readonly LivingSceneMovementNodeSource[];
  edges: readonly LivingSceneMovementEdgeSource[];
  routes: readonly LivingSceneMovementRouteSource[];
  entities: readonly LivingSceneMovementEntitySource[];
  /** Exact epoch seconds represented by every entity presentationTime in this viewport. */
  presentationTimeSeconds: number;
}

export interface CompiledLivingSceneMovement {
  graph: CompiledLivingMovementGraph;
  routeIdByEntityId: ReadonlyMap<string, string>;
  routePhaseByEntityId: ReadonlyMap<string, LivingRoutePhaseAnchor>;
}

/** Explicit synthetic network used only by the browser performance ladder. */
export function createLivingPerformanceMovementFixture(
  entities: readonly Pick<VisualEntity, 'id' | 'kind'>[],
): CompiledLivingSceneMovement {
  const graph = compileLivingMovementGraph({
    nodes: [
      { id: 'perf-pw', x: -800, y: -40 }, { id: 'perf-pc1', x: -40, y: -40 },
      { id: 'perf-pc2', x: 40, y: -40 }, { id: 'perf-pe', x: 800, y: -40 },
      { id: 'perf-pw2', x: -800, y: 55 }, { id: 'perf-pc3', x: -40, y: 55 },
      { id: 'perf-pc4', x: 40, y: 55 }, { id: 'perf-pe2', x: 800, y: 55 },
      { id: 'perf-vw', x: -900, y: 0 }, { id: 'perf-ve', x: 900, y: 0 },
      { id: 'perf-vw2', x: -900, y: 18 }, { id: 'perf-ve2', x: 900, y: 18 },
    ],
    edges: [
      { id: 'perf-side-a', from: 'perf-pw', to: 'perf-pc1', mode: 'sidewalk', crossesRoad: false, direction: 'bidirectional', visualSpeedMetersPerSecond: 1.25 },
      { id: 'perf-cross-a', from: 'perf-pc1', to: 'perf-pc2', mode: 'crosswalk', crossesRoad: true, direction: 'bidirectional', visualSpeedMetersPerSecond: 1 },
      { id: 'perf-side-b', from: 'perf-pc2', to: 'perf-pe', mode: 'sidewalk', crossesRoad: false, direction: 'bidirectional', visualSpeedMetersPerSecond: 1.25 },
      { id: 'perf-side-c', from: 'perf-pw2', to: 'perf-pc3', mode: 'sidewalk', crossesRoad: false, direction: 'bidirectional', visualSpeedMetersPerSecond: 1.1 },
      { id: 'perf-cross-b', from: 'perf-pc3', to: 'perf-pc4', mode: 'crosswalk', crossesRoad: true, direction: 'bidirectional', visualSpeedMetersPerSecond: 0.9 },
      { id: 'perf-side-d', from: 'perf-pc4', to: 'perf-pe2', mode: 'sidewalk', crossesRoad: false, direction: 'bidirectional', visualSpeedMetersPerSecond: 1.1 },
      { id: 'perf-lane-a', from: 'perf-vw', to: 'perf-ve', mode: 'lane', crossesRoad: false, direction: 'bidirectional', visualSpeedMetersPerSecond: 12 },
      { id: 'perf-lane-b', from: 'perf-vw2', to: 'perf-ve2', mode: 'lane', crossesRoad: false, direction: 'bidirectional', visualSpeedMetersPerSecond: 9 },
    ],
    routes: [
      { id: 'perf-pedestrian-a', kind: 'pedestrian', traversal: 'ping_pong', edgeIds: ['perf-side-a', 'perf-cross-a', 'perf-side-b'] },
      { id: 'perf-pedestrian-b', kind: 'pedestrian', traversal: 'ping_pong', edgeIds: ['perf-side-c', 'perf-cross-b', 'perf-side-d'] },
      { id: 'perf-vehicle-a', kind: 'vehicle', traversal: 'ping_pong', edgeIds: ['perf-lane-a'] },
      { id: 'perf-vehicle-b', kind: 'vehicle', traversal: 'ping_pong', edgeIds: ['perf-lane-b'] },
    ],
  });
  const routeIdByEntityId = new Map<string, string>();
  for (const entity of entities) {
    const vehicle = entity.kind === 'vehicle';
    const alternate = (hashSeed(entity.id) & 1) === 1;
    routeIdByEntityId.set(
      entity.id,
      vehicle
        ? (alternate ? 'perf-vehicle-b' : 'perf-vehicle-a')
        : (alternate ? 'perf-pedestrian-b' : 'perf-pedestrian-a'),
    );
  }
  return { graph, routeIdByEntityId, routePhaseByEntityId: new Map() };
}

const WEB_MERCATOR_MAX_LATITUDE = 85.05112878;

function wrappedLongitudeDelta(longitude: number, originLongitude: number): number {
  return ((longitude - originLongitude + 540) % 360) - 180;
}

function validateOrigin(origin: readonly [number, number]): void {
  if (!Number.isFinite(origin[0]) || origin[0] < -180 || origin[0] > 180
    || !Number.isFinite(origin[1])
    || origin[1] < -WEB_MERCATOR_MAX_LATITUDE
    || origin[1] > WEB_MERCATOR_MAX_LATITUDE) {
    throw new Error('Living scene movement requires an explicit origin within WebMercator bounds');
  }
}

function toLocal(
  position: readonly [number, number],
  origin: readonly [number, number],
): readonly [number, number] {
  if (!Number.isFinite(position[0]) || position[0] < -180 || position[0] > 180
    || !Number.isFinite(position[1]) || position[1] < -90 || position[1] > 90) {
    throw new Error('Living scene movement contains an invalid WGS84 position');
  }
  return [
    wrappedLongitudeDelta(position[0], origin[0])
      * Math.cos((origin[1] * Math.PI) / 180) * 111_320,
    (position[1] - origin[1]) * 110_540,
  ];
}

function entityRouteKind(entityKind: LivingSceneMovementEntitySource['entityKind']): 'pedestrian' | 'vehicle' {
  return entityKind === 'person' ? 'pedestrian' : 'vehicle';
}

/**
 * Compiles canonical authored WGS84 network data into the local SoA graph.
 * No route, crossing, speed, or free-space geometry is inferred.
 */
export function compileLivingSceneMovement(
  options: CompileLivingSceneMovementOptions,
): CompiledLivingSceneMovement {
  validateOrigin(options.origin);
  if (!Number.isFinite(options.presentationTimeSeconds)) {
    throw new Error('Living scene movement requires a finite absolute presentation epoch');
  }
  const edgesById = new Map(options.edges.map((edge) => [edge.edgeId, edge]));
  if (edgesById.size !== options.edges.length) throw new Error('Living scene movement has duplicate edge IDs');
  const routesById = new Map(options.routes.map((route) => [route.routeId, route]));
  if (routesById.size !== options.routes.length) throw new Error('Living scene movement has duplicate route IDs');

  const edges: LivingMovementEdgeInput[] = options.edges.map((edge) => {
    const modes: readonly LivingSceneRouteMode[] = ['pedestrian', 'bicycle', 'car', 'transit'];
    if (edge.edgeKind === 'lane' ? edge.allowedModes.includes('pedestrian') : (
      edge.allowedModes.length !== 1 || edge.allowedModes[0] !== 'pedestrian'
    )) {
      throw new Error(`Living scene edge ${edge.edgeId} has incompatible allowed modes`);
    }
    for (const mode of modes) {
      const speed = edge.visualSpeedMetersPerSecond[mode];
      if (edge.allowedModes.includes(mode) !== (speed !== null)) {
        throw new Error(`Living scene edge ${edge.edgeId} speed availability does not match allowed modes`);
      }
    }
    const defaultMode: LivingSceneRouteMode = edge.edgeKind === 'lane'
      ? (edge.allowedModes.find((mode) => mode !== 'pedestrian') ?? 'car')
      : 'pedestrian';
    const defaultSpeed = edge.visualSpeedMetersPerSecond[defaultMode];
    if (!edge.allowedModes.includes(defaultMode) || !(defaultSpeed && defaultSpeed > 0)) {
      throw new Error(`Living scene edge ${edge.edgeId} has no valid speed for its allowed graph mode`);
    }
    if (edge.geometry.length < 2) throw new Error(`Living scene edge ${edge.edgeId} has no authored polyline`);
    return {
      id: edge.edgeId,
      from: edge.fromNodeId,
      to: edge.toNodeId,
      mode: edge.edgeKind,
      crossesRoad: edge.crossesRoad,
      visualSpeedMetersPerSecond: defaultSpeed,
      direction: edge.direction,
      points: edge.geometry.map((position) => toLocal(position, options.origin)),
    };
  });

  const routes: LivingMovementRouteInput[] = options.routes.map((route) => {
    if (route.edgeIds.length === 0) throw new Error(`Living scene route ${route.routeId} is empty`);
    const routeSpeeds = route.edgeIds.map((edgeId) => {
      const edge = edgesById.get(edgeId);
      if (!edge) throw new Error(`Living scene route ${route.routeId} references missing edge ${edgeId}`);
      if (!edge.allowedModes.includes(route.mode)) {
        throw new Error(`Living scene route ${route.routeId} uses a mode not allowed by edge ${edgeId}`);
      }
      const speed = edge.visualSpeedMetersPerSecond[route.mode];
      if (!(speed && speed > 0) || !Number.isFinite(speed)) {
        throw new Error(`Living scene route ${route.routeId} has no visual speed for edge ${edgeId}`);
      }
      return speed;
    });
    return {
      id: route.routeId,
      kind: route.mode === 'pedestrian' ? 'pedestrian' : 'vehicle',
      edgeIds: route.edgeIds,
      visualSpeedMetersPerSecondByEdge: routeSpeeds,
      traversal: route.traversal,
    };
  });

  const graph = compileLivingMovementGraph({
    nodes: options.nodes.map((node) => {
      const [x, y] = toLocal(node.position, options.origin);
      return { id: node.nodeId, x, y };
    }),
    edges,
    routes,
  });

  const routeIdByEntityId = new Map<string, string>();
  const routePhaseByEntityId = new Map<string, LivingRoutePhaseAnchor>();
  const entityIds = new Set<string>();
  for (const entity of options.entities) {
    if (!entity.id || entityIds.has(entity.id)) {
      throw new Error(`Living scene movement has duplicate or empty entity ID: ${entity.id}`);
    }
    entityIds.add(entity.id);
    const entityEpochSeconds = Date.parse(entity.presentationTime) / 1_000;
    if (!Number.isFinite(entityEpochSeconds)
      || Math.abs(entityEpochSeconds - options.presentationTimeSeconds) > 0.001) {
      throw new Error(`Living scene entity ${entity.id} presentation epoch does not match the runtime clock`);
    }
    if (entity.motion.mode !== 'network_edge') {
      if (entity.motion.routeId !== null || entity.motion.edgeId !== null
        || entity.motion.progress !== null || entity.motion.direction !== null) {
        throw new Error(`Living scene entity ${entity.id} has route metadata without network motion`);
      }
      if (entity.motion.speedMps !== 0) throw new Error(`Stationary living scene entity ${entity.id} has non-zero speed`);
      continue;
    }
    if (!entity.motion.routeId || !entity.motion.edgeId
      || entity.motion.progress === null || entity.motion.direction === null) {
      throw new Error(`Living scene entity ${entity.id} has incomplete network motion`);
    }
    const route = routesById.get(entity.motion.routeId);
    if (!route) throw new Error(`Living scene entity ${entity.id} references missing route ${entity.motion.routeId}`);
    if (!route.edgeIds.includes(entity.motion.edgeId)) {
      throw new Error(`Living scene entity ${entity.id} references an edge outside its route`);
    }
    const expectedKind = entityRouteKind(entity.entityKind);
    const routeKind = route.mode === 'pedestrian' ? 'pedestrian' : 'vehicle';
    if (routeKind !== expectedKind) {
      throw new Error(`Living scene entity ${entity.id} is incompatible with route ${route.routeId}`);
    }
    routeIdByEntityId.set(entity.id, entity.motion.routeId);
    routePhaseByEntityId.set(entity.id, {
      edgeId: entity.motion.edgeId,
      progress: entity.motion.progress,
      speedMetersPerSecond: entity.motion.speedMps,
      presentationTimeSeconds: options.presentationTimeSeconds,
      direction: entity.motion.direction,
    });
  }
  return { graph, routeIdByEntityId, routePhaseByEntityId };
}
