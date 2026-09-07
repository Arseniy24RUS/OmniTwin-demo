import { hashSeed } from '../rng';
import { LivingMovementEdgeDirection } from './movementGraph';
import {
  LivingActivity,
  LivingKind,
  LivingLod,
  LivingPrimaryRenderer,
  LivingRepresentation,
  type LivingLodCounts,
  type LivingAvoidanceStatus,
  type LivingActualAdapterSnapshot,
  type LivingAdapterReconciliation,
  type LivingActivityQaSnapshot,
  type LivingPartition,
  type LivingQaSnapshot,
  type LivingRenderFrame,
  type LivingSimulation,
} from './types';
import { sceneLocalHourAtPresentationSeconds } from './activitySchedule';

function updateHash(hash: number, value: number): number {
  let next = hash ^ (value >>> 0);
  next = Math.imul(next, 16777619);
  return next >>> 0;
}

/** Stable hash of IDs and millimetre-quantized local render positions. */
export function livingStablePositionHash(
  partition: LivingPartition,
  frame: LivingRenderFrame,
): string {
  let hash = 2166136261;
  for (let index = 0; index < partition.count; index += 1) {
    hash = updateHash(hash, partition.identity.idHash[index] ?? hashSeed(partition.identity.ids[index]!));
    hash = updateHash(hash, Math.round(frame.x[index]! * 1_000));
    hash = updateHash(hash, Math.round(frame.y[index]! * 1_000));
  }
  return hash.toString(16).padStart(8, '0');
}

export function livingStableActivityHash(
  partition: LivingPartition,
  frame: LivingRenderFrame,
): string {
  if (frame.activity.length !== partition.count) {
    throw new Error('Living activity telemetry frame length does not match the partition');
  }
  let hash = 2166136261;
  for (let index = 0; index < partition.count; index += 1) {
    hash = updateHash(hash, partition.identity.idHash[index] ?? hashSeed(partition.identity.ids[index]!));
    hash = updateHash(hash, frame.activity[index]!);
  }
  return hash.toString(16).padStart(8, '0');
}

export function livingActivityQaSnapshot(
  partition: LivingPartition,
  frame: LivingRenderFrame,
  absolutePresentationSeconds: number,
): LivingActivityQaSnapshot {
  if (frame.activity.length !== partition.count) {
    throw new Error('Living activity telemetry frame length does not match the partition');
  }
  const counts = { home: 0, walk: 0, work: 0, transit: 0, leisure: 0, study: 0 };
  for (let index = 0; index < frame.activity.length; index += 1) {
    const activity = frame.activity[index]!;
    if (activity === LivingActivity.HOME) counts.home += 1;
    else if (activity === LivingActivity.WALK) counts.walk += 1;
    else if (activity === LivingActivity.WORK) counts.work += 1;
    else if (activity === LivingActivity.TRANSIT) counts.transit += 1;
    else if (activity === LivingActivity.LEISURE) counts.leisure += 1;
    else if (activity === LivingActivity.STUDY) counts.study += 1;
    else throw new Error(`Living activity telemetry received unsupported code: ${activity}`);
  }
  const descriptor = partition.activitySchedule?.descriptor ?? null;
  return {
    descriptor,
    localHour: descriptor
      ? sceneLocalHourAtPresentationSeconds(descriptor, absolutePresentationSeconds)
      : null,
    stableHash: livingStableActivityHash(partition, frame),
    counts,
  };
}

export function livingRouteAdherenceViolations(
  partition: LivingPartition,
  frame: LivingRenderFrame,
  toleranceMeters = 0.02,
): number {
  let violations = 0;
  const graph = partition.movementGraph;
  for (let index = 0; index < partition.count; index += 1) {
    const routeIndex = partition.movement.routeIndex[index]!;
    if (routeIndex < 0 || !graph) {
      const dx = frame.x[index]! - partition.position.baseX[index]!;
      const dy = frame.y[index]! - partition.position.baseY[index]!;
      if (Math.hypot(dx, dy) > toleranceMeters) violations += 1;
      continue;
    }
    const route = graph.routes[routeIndex]!;
    let nearestSquared = Number.POSITIVE_INFINITY;
    for (const edgeIndex of route.edgeIndices) {
      const start = graph.edgePointOffsets[edgeIndex]!;
      const end = graph.edgePointOffsets[edgeIndex + 1]!;
      for (let point = start; point < end - 1; point += 1) {
        const ax = graph.edgePointX[point]!;
        const ay = graph.edgePointY[point]!;
        const bx = graph.edgePointX[point + 1]!;
        const by = graph.edgePointY[point + 1]!;
        const abX = bx - ax;
        const abY = by - ay;
        const lengthSquared = abX * abX + abY * abY;
        const projection = Math.max(0, Math.min(1,
          ((frame.x[index]! - ax) * abX + (frame.y[index]! - ay) * abY) / lengthSquared,
        ));
        const dx = frame.x[index]! - (ax + abX * projection);
        const dy = frame.y[index]! - (ay + abY * projection);
        nearestSquared = Math.min(nearestSquared, dx * dx + dy * dy);
      }
    }
    if (Math.sqrt(nearestSquared) > toleranceMeters) violations += 1;
  }
  return violations;
}

export function livingRouteDirectionViolations(partition: LivingPartition): number {
  const graph = partition.movementGraph;
  if (!graph) return 0;
  let violations = 0;
  for (const route of graph.routes) {
    route.edgeIndices.forEach((edgeIndex, offset) => {
      const direction = graph.edgeDirection[edgeIndex];
      const orientation = route.edgeDirections[offset];
      if (direction === LivingMovementEdgeDirection.FORWARD && orientation !== 1) violations += 1;
      else if (direction === LivingMovementEdgeDirection.REVERSE && orientation !== -1) violations += 1;
      if (route.traversal === 'ping_pong' && direction !== LivingMovementEdgeDirection.BIDIRECTIONAL) {
        violations += 1;
      }
    });
  }
  return violations;
}

export function livingQaSnapshot(
  simulation: LivingSimulation,
  frame: LivingRenderFrame,
  avoidance: { status: LivingAvoidanceStatus; reason: string | null } = {
    status: 'unavailable',
    reason: 'recast_navigation_not_configured',
  },
): LivingQaSnapshot {
  const { partition } = simulation;
  let pedestrians = 0;
  let vehicles = 0;
  let deck = 0;
  let three = 0;
  let culled = 0;
  let duplicates = 0;
  let focus = 0;
  let aggregateProxy = 0;
  let ambientOnly = 0;
  let representedLogical = 0;
  let representedDeck = 0;
  let representedThree = 0;
  let representedCulled = 0;
  const lod: LivingLodCounts = { culled: 0, impostor: 0, low: 0, detailed: 0, focus: 0 };
  for (let index = 0; index < partition.count; index += 1) {
    if (partition.identity.kind[index] === LivingKind.VEHICLE) vehicles += 1;
    else pedestrians += 1;
    const representation = partition.identity.representation[index];
    if (representation === LivingRepresentation.FOCUS_1_TO_1) focus += 1;
    else if (representation === LivingRepresentation.AGGREGATE_PROXY) aggregateProxy += 1;
    else ambientOnly += 1;
    const represented = partition.identity.representedCount[index]!;
    representedLogical += represented;
    const renderer = partition.presentation.primaryRenderer[index];
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
    const visible = partition.presentation.visible[index] === 1;
    if (visible !== (renderer !== LivingPrimaryRenderer.NONE)) duplicates += 1;
    const entityLod = partition.presentation.lod[index];
    if (entityLod === LivingLod.IMPOSTOR) lod.impostor += 1;
    else if (entityLod === LivingLod.LOW) lod.low += 1;
    else if (entityLod === LivingLod.DETAILED) lod.detailed += 1;
    else if (entityLod === LivingLod.FOCUS) lod.focus += 1;
    else lod.culled += 1;
  }
  return {
    logical: { total: partition.count, pedestrians, vehicles },
    representation: { focus, aggregateProxy, ambientOnly },
    represented: {
      logical: representedLogical,
      deck: representedDeck,
      three: representedThree,
      culled: representedCulled,
    },
    primaryRenderer: { deck, three, culled, duplicates },
    lod,
    activity: livingActivityQaSnapshot(
      partition,
      frame,
      simulation.presentationTimeSeconds + simulation.accumulatorSeconds,
    ),
    stablePositionHash: livingStablePositionHash(partition, frame),
    routeAdherenceViolations: livingRouteAdherenceViolations(partition, frame),
    routeDirectionViolations: livingRouteDirectionViolations(partition),
    avoidanceStatus: avoidance.status,
    avoidanceReason: avoidance.reason,
    simulationTick: simulation.tick,
    fixedStepCount: simulation.fixedStepCount,
    interpolationCount: simulation.interpolationCount,
    interpolationAlpha: frame.alpha,
    presentationTimeSeconds: simulation.presentationTimeSeconds + simulation.accumulatorSeconds,
  };
}

/**
 * Updates only values that can change during an ordinary deterministic route
 * advance. Structural conservation, LOD and route-geometry validation remain
 * from the most recent full initialize/seek audit.
 */
export function updateLivingQaSnapshotForAdvance(
  previous: LivingQaSnapshot,
  simulation: LivingSimulation,
  frame: LivingRenderFrame,
): LivingQaSnapshot {
  const presentationTimeSeconds = simulation.presentationTimeSeconds
    + simulation.accumulatorSeconds;
  return {
    ...previous,
    activity: livingActivityQaSnapshot(
      simulation.partition,
      frame,
      presentationTimeSeconds,
    ),
    stablePositionHash: livingStablePositionHash(simulation.partition, frame),
    simulationTick: simulation.tick,
    fixedStepCount: simulation.fixedStepCount,
    interpolationCount: simulation.interpolationCount,
    interpolationAlpha: frame.alpha,
    presentationTimeSeconds,
  };
}

/**
 * Advances only scalar counters between bounded QA audits. Position/activity
 * hashes intentionally remain the last audited values for at most one second.
 */
export function updateLivingQaSnapshotWithoutAudit(
  previous: LivingQaSnapshot,
  simulation: LivingSimulation,
  frame: LivingRenderFrame,
): LivingQaSnapshot {
  return {
    ...previous,
    simulationTick: simulation.tick,
    fixedStepCount: simulation.fixedStepCount,
    interpolationCount: simulation.interpolationCount,
    interpolationAlpha: frame.alpha,
    presentationTimeSeconds: simulation.presentationTimeSeconds
      + simulation.accumulatorSeconds,
  };
}

export function sampleLivingPositions(
  partition: LivingPartition,
  frame: LivingRenderFrame,
  count = 10,
): ReadonlyArray<{ id: string; x: number; y: number; heading: number }> {
  const sampleCount = Math.max(0, Math.min(partition.count, Math.floor(count)));
  const result = new Array<{ id: string; x: number; y: number; heading: number }>(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    result[index] = {
      id: partition.identity.ids[index]!,
      x: frame.x[index]!,
      y: frame.y[index]!,
      heading: frame.heading[index]!,
    };
  }
  return result;
}

/** Reconciles actual adapter submissions with the exactly-one planned primary renderer. */
export function livingAdapterReconciliation(
  partition: LivingPartition,
  actual: LivingActualAdapterSnapshot,
): LivingAdapterReconciliation {
  const indexById = new Map<string, number>();
  for (let index = 0; index < partition.count; index += 1) {
    indexById.set(partition.identity.ids[index]!, index);
  }
  const seen = new Set<string>();
  let duplicateActualIds = 0;
  let wrongPrimaryRenderer = 0;
  let unexpectedOrCulledIds = 0;
  let representedDeck = 0;
  let representedThree = 0;
  const consume = (ids: readonly string[], renderer: LivingPrimaryRenderer) => {
    for (const id of ids) {
      if (seen.has(id)) duplicateActualIds += 1;
      else seen.add(id);
      const index = indexById.get(id);
      if (index === undefined) {
        unexpectedOrCulledIds += 1;
        continue;
      }
      const planned = partition.presentation.primaryRenderer[index];
      if (planned === LivingPrimaryRenderer.NONE) unexpectedOrCulledIds += 1;
      else if (planned !== renderer) wrongPrimaryRenderer += 1;
      if (renderer === LivingPrimaryRenderer.DECK) {
        representedDeck += partition.identity.representedCount[index]!;
      } else {
        representedThree += partition.identity.representedCount[index]!;
      }
    }
  };
  consume(actual.deckIds, LivingPrimaryRenderer.DECK);
  consume(actual.threeIds, LivingPrimaryRenderer.THREE);
  let plannedDeck = 0;
  let plannedThree = 0;
  let plannedCulled = 0;
  let missingVisibleIds = 0;
  for (let index = 0; index < partition.count; index += 1) {
    const renderer = partition.presentation.primaryRenderer[index];
    if (renderer === LivingPrimaryRenderer.DECK) plannedDeck += 1;
    else if (renderer === LivingPrimaryRenderer.THREE) plannedThree += 1;
    else plannedCulled += 1;
    if (renderer !== LivingPrimaryRenderer.NONE && !seen.has(partition.identity.ids[index]!)) {
      missingVisibleIds += 1;
    }
  }
  const reportedIntentionalOmissions = Math.max(
    0,
    Math.floor(actual.intentionalDeckOmissions ?? 0),
  );
  const intentionalMissingVisibleIds = Math.min(
    missingVisibleIds,
    reportedIntentionalOmissions,
  );
  const unaccountedMissingVisibleIds = missingVisibleIds - intentionalMissingVisibleIds;
  const intentionalOmissionMismatch = reportedIntentionalOmissions
    !== intentionalMissingVisibleIds;
  return {
    planned: { deck: plannedDeck, three: plannedThree, culled: plannedCulled },
    actual: { deck: actual.deckIds.length, three: actual.threeIds.length, unique: seen.size },
    representedActual: { deck: representedDeck, three: representedThree },
    duplicateActualIds,
    wrongPrimaryRenderer,
    missingVisibleIds,
    intentionalMissingVisibleIds,
    unaccountedMissingVisibleIds,
    intentionalOmissionMismatch,
    unexpectedOrCulledIds,
    exact: duplicateActualIds === 0
      && wrongPrimaryRenderer === 0
      && unaccountedMissingVisibleIds === 0
      && !intentionalOmissionMismatch
      && unexpectedOrCulledIds === 0,
  };
}
