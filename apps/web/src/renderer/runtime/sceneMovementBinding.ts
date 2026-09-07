import {
  compileLivingSceneMovement,
  type CompiledLivingSceneMovement,
  type LivingSceneMovementEntitySource,
  type LivingSceneMovementRouteSource,
} from '../living/sceneMovement';
import type {
  VisualEntity,
  VisualEntityV2,
  WorldSceneMovementPayload,
} from '../types';

export type RuntimeMovementStatus = 'ready' | 'partial' | 'unavailable' | 'invalid';

export interface RuntimeMovementTelemetry {
  status: RuntimeMovementStatus;
  routedEntities: number;
  unboundEntities: number;
  violations: number;
  reason: string | null;
}

export interface RuntimeMovementCompilation {
  compiled: CompiledLivingSceneMovement | null;
  telemetry: RuntimeMovementTelemetry;
}

export interface MergedSceneMovementPayload {
  payload: WorldSceneMovementPayload | null;
  conflicts: number;
}

function sameSourceValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Merges content-addressed halo rows by stable source ID and rejects conflicts. */
export function mergeSceneMovementPayloads(
  payloads: readonly WorldSceneMovementPayload[],
): MergedSceneMovementPayload {
  if (payloads.length === 0) return { payload: null, conflicts: 0 };
  let conflicts = 0;
  const mergeById = <T>(
    values: readonly T[],
    id: (value: T) => string,
  ): T[] => {
    const merged = new Map<string, T>();
    for (const value of values) {
      const key = id(value);
      const previous = merged.get(key);
      if (previous && !sameSourceValue(previous, value)) conflicts += 1;
      else if (!previous) merged.set(key, value);
    }
    return [...merged.values()];
  };
  const nodes = mergeById(payloads.flatMap(({ nodes }) => [...nodes]), (node) => node.nodeId);
  const edges = mergeById(payloads.flatMap(({ edges }) => [...edges]), (edge) => edge.edgeId);
  const routes = mergeById(payloads.flatMap(({ routes }) => [...routes]), (route) => route.routeId);
  return {
    payload: conflicts === 0 ? { nodes, edges, routes } : null,
    conflicts,
  };
}

function routeKind(route: LivingSceneMovementRouteSource): 'pedestrian' | 'vehicle' {
  return route.mode === 'pedestrian' ? 'pedestrian' : 'vehicle';
}

function entityKind(entity: VisualEntityV2): 'pedestrian' | 'vehicle' {
  return entity.entityKind === 'person' ? 'pedestrian' : 'vehicle';
}

function entityMotionDirection(
  entity: VisualEntityV2,
): 'forward' | 'reverse' | null {
  const direction = (entity.motion as typeof entity.motion & {
    direction?: unknown;
  }).direction;
  return direction === 'forward' || direction === 'reverse' ? direction : null;
}

/**
 * Selects only authored, complete, forward-connected active-cell routes before
 * invoking the strict Living compiler. Missing halo/cross-cell data never
 * causes inferred geometry: affected entities remain unbound in their existing
 * visual presentation instead of entering the route graph.
 */
export function compileRuntimeSceneMovement(
  origin: readonly [longitude: number, latitude: number],
  payload: WorldSceneMovementPayload | null,
  visualEntities: readonly VisualEntity[],
  entitiesV2: readonly VisualEntityV2[],
  presentationTimeSeconds: number,
  sourceConflicts = 0,
  mobilityPresentationMovement: readonly LivingSceneMovementEntitySource[] = [],
): RuntimeMovementCompilation {
  if (sourceConflicts > 0) {
    return {
      compiled: null,
      telemetry: {
        status: 'invalid',
        routedEntities: 0,
        unboundEntities: visualEntities.length,
        violations: sourceConflicts,
        reason: 'movement_halo_content_conflict',
      },
    };
  }
  if (!payload) {
    return {
      compiled: null,
      telemetry: {
        status: 'unavailable',
        routedEntities: 0,
        unboundEntities: visualEntities.length,
        violations: 0,
        reason: 'movement_payload_unavailable',
      },
    };
  }

  const nodesById = new Map(payload.nodes.map((node) => [node.nodeId, node]));
  const edgesById = new Map(payload.edges.map((edge) => [edge.edgeId, edge]));
  const routesById = new Map(payload.routes.map((route) => [route.routeId, route]));
  if (
    nodesById.size !== payload.nodes.length ||
    edgesById.size !== payload.edges.length ||
    routesById.size !== payload.routes.length
  ) {
    return {
      compiled: null,
      telemetry: {
        status: 'invalid',
        routedEntities: 0,
        unboundEntities: visualEntities.length,
        violations: 1,
        reason: 'movement_duplicate_source_ids',
      },
    };
  }

  let violations = 0;
  const completeRoutes: LivingSceneMovementRouteSource[] = [];
  for (const route of payload.routes) {
    const edges = route.edgeIds.map((edgeId) => edgesById.get(edgeId));
    const orientedFrom = (edge: NonNullable<(typeof edges)[number]>) =>
      edge.direction === 'reverse' ? edge.toNodeId : edge.fromNodeId;
    const orientedTo = (edge: NonNullable<(typeof edges)[number]>) =>
      edge.direction === 'reverse' ? edge.fromNodeId : edge.toNodeId;
    const complete = route.edgeIds.length > 0 && edges.every((edge) => Boolean(
      edge &&
      nodesById.has(edge.fromNodeId) &&
      nodesById.has(edge.toNodeId) &&
      edge.geometry.length >= 2 &&
      edge.crossesRoad === (edge.edgeKind === 'crosswalk') &&
      edge.allowedModes.includes(route.mode) &&
      Number.isFinite(edge.visualSpeedMetersPerSecond[route.mode]) &&
      Number(edge.visualSpeedMetersPerSecond[route.mode]) > 0
    )) && edges.every((edge, index) => (
      index === 0 || Boolean(
        edge && edges[index - 1] &&
        orientedTo(edges[index - 1]!) === orientedFrom(edge)
      )
    )) && (
      route.traversal !== 'ping_pong' ||
      edges.every((edge) => edge?.direction === 'bidirectional')
    ) && (
      route.traversal !== 'loop' || Boolean(
        edges[0] && edges.at(-1) &&
        orientedTo(edges.at(-1)!) === orientedFrom(edges[0]!)
      )
    );
    if (complete) completeRoutes.push(route);
    else violations += 1;
  }

  const completeRouteById = new Map(completeRoutes.map((route) => [route.routeId, route]));
  const selectedEdgeIds = new Set(completeRoutes.flatMap((route) => [...route.edgeIds]));
  const selectedEdges = payload.edges.filter((edge) => selectedEdgeIds.has(edge.edgeId));
  const selectedNodeIds = new Set(selectedEdges.flatMap((edge) => [edge.fromNodeId, edge.toNodeId]));
  const selectedNodes = payload.nodes.filter((node) => selectedNodeIds.has(node.nodeId));
  const visibleIds = new Set(visualEntities.map((entity) => entity.id));
  const seenEntityIds = new Set<string>();
  const v2CompilerEntities: LivingSceneMovementEntitySource[] = [];
  for (const entity of entitiesV2) {
    if (!visibleIds.has(entity.id)) continue;
    if (seenEntityIds.has(entity.id)) {
      violations += 1;
      continue;
    }
    seenEntityIds.add(entity.id);
    if (entity.motion.mode !== 'network_edge') {
      if (entity.motion.routeId !== null || entity.motion.edgeId !== null) violations += 1;
      // Unrouted base/aggregate entities stay visible but have no authored
      // movement binding. Sending them through the strict route compiler would
      // make an irrelevant, stale source epoch invalidate every routed living
      // actor in the viewport.
      continue;
    }
    const route = entity.motion.routeId
      ? completeRouteById.get(entity.motion.routeId)
      : undefined;
    const phaseEdgeId = entity.motion.edgeId;
    const phaseEdge = phaseEdgeId
      ? edgesById.get(phaseEdgeId)
      : undefined;
    const phaseDirection = entityMotionDirection(entity);
    if (
      !route ||
      !phaseEdge ||
      !phaseEdgeId ||
      !route.edgeIds.includes(phaseEdgeId) ||
      routeKind(route) !== entityKind(entity) ||
      phaseDirection === null ||
      (phaseDirection === 'forward' && phaseEdge.direction === 'reverse') ||
      (phaseDirection === 'reverse' && phaseEdge.direction === 'forward')
    ) {
      violations += 1;
      continue;
    }
    const entityEpochSeconds = Date.parse(entity.presentationTime) / 1_000;
    if (!Number.isFinite(entityEpochSeconds)
      || Math.abs(entityEpochSeconds - presentationTimeSeconds) > 0.001) {
      violations += 1;
      continue;
    }
    v2CompilerEntities.push({
      id: entity.id,
      entityKind: entity.entityKind,
      motion: {
        mode: entity.motion.mode,
        routeId: entity.motion.routeId,
        edgeId: entity.motion.edgeId,
        progress: entity.motion.progress,
        speedMps: entity.motion.speedMps,
        direction: phaseDirection,
      },
      presentationTime: entity.presentationTime,
    });
  }
  const mobilityCompilerEntities: LivingSceneMovementEntitySource[] = [];
  let mobilityEpochSeconds: number | null = null;
  for (const entity of mobilityPresentationMovement) {
    if (!visibleIds.has(entity.id)) continue;
    if (seenEntityIds.has(entity.id)) {
      violations += 1;
      continue;
    }
    seenEntityIds.add(entity.id);
    const route = entity.motion.routeId
      ? completeRouteById.get(entity.motion.routeId)
      : undefined;
    const phaseEdge = entity.motion.edgeId
      ? edgesById.get(entity.motion.edgeId)
      : undefined;
    const expectedKind = entity.entityKind === 'person' ? 'pedestrian' : 'vehicle';
    if (
      entity.motion.mode !== 'network_edge' ||
      !route ||
      !phaseEdge ||
      !entity.motion.edgeId ||
      entity.motion.progress === null ||
      entity.motion.direction === null ||
      !route.edgeIds.includes(entity.motion.edgeId) ||
      routeKind(route) !== expectedKind ||
      (entity.motion.direction === 'forward' && phaseEdge.direction === 'reverse') ||
      (entity.motion.direction === 'reverse' && phaseEdge.direction === 'forward')
    ) {
      violations += 1;
      continue;
    }
    const entityEpochSeconds = Date.parse(entity.presentationTime) / 1_000;
    if (!Number.isFinite(entityEpochSeconds)) {
      violations += 1;
      continue;
    }
    if (mobilityEpochSeconds === null) mobilityEpochSeconds = entityEpochSeconds;
    else if (Math.abs(entityEpochSeconds - mobilityEpochSeconds) > 0.001) {
      violations += 1;
      continue;
    }
    mobilityCompilerEntities.push(entity);
  }

  if (completeRoutes.length === 0) {
    return {
      compiled: null,
      telemetry: {
        status: payload.routes.length === 0 ? 'unavailable' : 'partial',
        routedEntities: 0,
        unboundEntities: visualEntities.length,
        violations,
        reason: payload.routes.length === 0
          ? 'movement_routes_unavailable'
          : 'movement_routes_incomplete',
      },
    };
  }

  try {
    const compile = (
      entities: readonly LivingSceneMovementEntitySource[],
      epochSeconds: number,
    ) => compileLivingSceneMovement({
      origin,
      nodes: selectedNodes,
      edges: selectedEdges,
      routes: completeRoutes,
      entities,
      presentationTimeSeconds: epochSeconds,
    });
    const v2Compiled = compile(v2CompilerEntities, presentationTimeSeconds);
    const mobilityCompiled = mobilityCompilerEntities.length > 0
      ? compile(mobilityCompilerEntities, mobilityEpochSeconds!)
      : null;
    const routeIdByEntityId = new Map(v2Compiled.routeIdByEntityId);
    const routePhaseByEntityId = new Map(v2Compiled.routePhaseByEntityId);
    for (const [id, routeId] of mobilityCompiled?.routeIdByEntityId ?? []) {
      routeIdByEntityId.set(id, routeId);
    }
    for (const [id, phase] of mobilityCompiled?.routePhaseByEntityId ?? []) {
      routePhaseByEntityId.set(id, phase);
    }
    const compiled: CompiledLivingSceneMovement = {
      graph: v2Compiled.graph,
      routeIdByEntityId,
      routePhaseByEntityId,
    };
    const routedEntities = compiled.routeIdByEntityId.size;
    return {
      compiled,
      telemetry: {
        status: violations === 0 ? 'ready' : 'partial',
        routedEntities,
        unboundEntities: Math.max(0, visualEntities.length - routedEntities),
        violations,
        reason: violations === 0 ? null : 'movement_bindings_incomplete',
      },
    };
  } catch {
    return {
      compiled: null,
      telemetry: {
        status: 'invalid',
        routedEntities: 0,
        unboundEntities: visualEntities.length,
        violations: violations + 1,
        reason: 'movement_compile_failed_closed',
      },
    };
  }
}
