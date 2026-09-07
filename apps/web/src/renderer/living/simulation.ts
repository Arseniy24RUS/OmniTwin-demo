import {
  type LivingPartition,
  type LivingRenderFrame,
  type LivingSimulation,
} from './types';
import { cloneCompiledLivingMovementGraph } from './movementGraph';
import { writeLivingActivitiesAtPresentationSeconds } from './activitySchedule';

export const LIVING_FIXED_STEP_SECONDS = 0.1;

export interface AdvanceLivingSimulationOptions {
  reducedMotion?: boolean;
  maxFixedSteps?: number;
}

export interface LivingAdvanceResult {
  steps: number;
  simulationTick: number;
  accumulatorSeconds: number;
  saturated: boolean;
}

function cloneFloat32(source: Float32Array): Float32Array {
  return new Float32Array(source);
}

export function cloneLivingPartition(partition: LivingPartition): LivingPartition {
  return {
    ...partition,
    identity: {
      ...partition.identity,
      ids: [...partition.identity.ids],
      idHash: new Uint32Array(partition.identity.idHash),
      seed: new Uint32Array(partition.identity.seed),
      kind: new Uint8Array(partition.identity.kind),
      representation: new Uint8Array(partition.identity.representation),
      activity: new Uint8Array(partition.identity.activity),
      representedCount: new Uint32Array(partition.identity.representedCount),
      colorRgba: new Uint32Array(partition.identity.colorRgba),
    },
    activitySchedule: partition.activitySchedule
      ? {
          descriptor: { ...partition.activitySchedule.descriptor },
          profile: new Uint8Array(partition.activitySchedule.profile),
        }
      : null,
    position: {
      baseX: cloneFloat32(partition.position.baseX),
      baseY: cloneFloat32(partition.position.baseY),
      previousX: cloneFloat32(partition.position.previousX),
      previousY: cloneFloat32(partition.position.previousY),
      currentX: cloneFloat32(partition.position.currentX),
      currentY: cloneFloat32(partition.position.currentY),
      previousHeading: cloneFloat32(partition.position.previousHeading),
      currentHeading: cloneFloat32(partition.position.currentHeading),
      baseHeading: cloneFloat32(partition.position.baseHeading),
      speedMetersPerSecond: cloneFloat32(partition.position.speedMetersPerSecond),
    },
    movement: {
      routeIndex: new Int32Array(partition.movement.routeIndex),
      currentEdgeIndex: new Int32Array(partition.movement.currentEdgeIndex),
      routePhaseOffsetSeconds: new Float64Array(partition.movement.routePhaseOffsetSeconds),
      routePhaseAnchorSeconds: new Float64Array(partition.movement.routePhaseAnchorSeconds),
    },
    movementGraph: partition.movementGraph
      ? cloneCompiledLivingMovementGraph(partition.movementGraph)
      : null,
    presentation: {
      lod: new Uint8Array(partition.presentation.lod),
      primaryRenderer: new Uint8Array(partition.presentation.primaryRenderer),
      visible: new Uint8Array(partition.presentation.visible),
      screenSizePixels: cloneFloat32(partition.presentation.screenSizePixels),
    },
  };
}

export function cloneLivingSimulation(simulation: LivingSimulation): LivingSimulation {
  return {
    ...simulation,
    partition: cloneLivingPartition(simulation.partition),
  };
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

export interface LivingRoutePose {
  x: number;
  y: number;
  heading: number;
  edgeIndex: number;
}

function sampleEdgePolylineInto(
  graph: NonNullable<LivingPartition['movementGraph']>,
  edgeIndex: number,
  progress: number,
  output: LivingRoutePose,
): LivingRoutePose {
  const start = graph.edgePointOffsets[edgeIndex]!;
  const end = graph.edgePointOffsets[edgeIndex + 1]!;
  const targetDistance = graph.edgeLengthMeters[edgeIndex]! * progress;
  let traversed = 0;
  for (let point = start; point < end - 1; point += 1) {
    const fromX = graph.edgePointX[point]!;
    const fromY = graph.edgePointY[point]!;
    const toX = graph.edgePointX[point + 1]!;
    const toY = graph.edgePointY[point + 1]!;
    const segmentLength = Math.hypot(toX - fromX, toY - fromY);
    if (traversed + segmentLength >= targetDistance || point === end - 2) {
      const segmentProgress = Math.max(0, Math.min(1, (targetDistance - traversed) / segmentLength));
      output.x = fromX + (toX - fromX) * segmentProgress;
      output.y = fromY + (toY - fromY) * segmentProgress;
      output.heading = ((Math.atan2(toX - fromX, toY - fromY) * 180) / Math.PI + 360) % 360;
      output.edgeIndex = edgeIndex;
      return output;
    }
    traversed += segmentLength;
  }
  throw new Error(`Living movement edge ${edgeIndex} has no sampleable segment`);
}

export function sampleLivingRoutePoseAtTime(
  partition: LivingPartition,
  index: number,
  presentationTimeSeconds: number,
  reducedMotion: boolean,
  output: LivingRoutePose,
): LivingRoutePose {
  const positions = partition.position;
  const baseX = positions.baseX[index]!;
  const baseY = positions.baseY[index]!;
  const baseHeading = positions.baseHeading[index]!;
  const routeIndex = partition.movement.routeIndex[index]!;
  const graph = partition.movementGraph;
  if (routeIndex < 0 || !graph) {
    output.x = baseX;
    output.y = baseY;
    output.heading = baseHeading;
    output.edgeIndex = -1;
    return output;
  }
  const route = graph.routes[routeIndex]!;
  const duration = route.durationSeconds;
  if (!(duration > 0)) {
    output.x = baseX;
    output.y = baseY;
    output.heading = baseHeading;
    output.edgeIndex = -1;
    return output;
  }
  const seed = partition.identity.seed[index]!;
  const routePhaseOffset = partition.movement.routePhaseOffsetSeconds[index]!;
  const routePhaseAnchor = partition.movement.routePhaseAnchorSeconds[index]!;
  const seededPhaseSeconds = ((seed >>> 0) / 0x1_0000_0000) * duration;
  const anchoredRouteTime = Number.isFinite(routePhaseOffset)
    ? routePhaseOffset + presentationTimeSeconds
    : seededPhaseSeconds + presentationTimeSeconds;
  let routeTime = reducedMotion
    ? (Number.isFinite(routePhaseAnchor) ? routePhaseAnchor : seededPhaseSeconds)
    : anchoredRouteTime;
  let direction = 1;
  if (route.traversal === 'loop') routeTime = positiveModulo(routeTime, duration);
  else if (route.traversal === 'ping_pong') {
    const pingPong = positiveModulo(routeTime, duration * 2);
    if (pingPong > duration) {
      routeTime = duration * 2 - pingPong;
      direction = -1;
    } else routeTime = pingPong;
  } else routeTime = Math.max(0, Math.min(duration, routeTime));
  let routeEdgeOffset = route.edgeIndices.length - 1;
  for (let candidate = 0; candidate < route.edgeIndices.length; candidate += 1) {
    if (routeTime <= route.cumulativeTravelSeconds[candidate + 1]!) {
      routeEdgeOffset = candidate;
      break;
    }
  }
  const edgeIndex = route.edgeIndices[routeEdgeOffset]!;
  const edgeStart = route.cumulativeTravelSeconds[routeEdgeOffset]!;
  const edgeDuration = route.cumulativeTravelSeconds[routeEdgeOffset + 1]! - edgeStart;
  const routeProgress = Math.max(0, Math.min(1, (routeTime - edgeStart) / edgeDuration));
  const edgeOrientation = route.edgeDirections[routeEdgeOffset]!;
  const authoredProgress = edgeOrientation === 1 ? routeProgress : 1 - routeProgress;
  sampleEdgePolylineInto(graph, edgeIndex, authoredProgress, output);
  const routeHeading = edgeOrientation === 1
    ? output.heading
    : (output.heading + 180) % 360;
  output.heading = direction === 1 ? routeHeading : (routeHeading + 180) % 360;
  return output;
}

/** Compatibility sampling API; hot loops use the caller-owned pose variant above. */
export function sampleLivingRouteAtTime(
  partition: LivingPartition,
  index: number,
  presentationTimeSeconds: number,
  reducedMotion: boolean,
): readonly [x: number, y: number, heading: number, edgeIndex: number] {
  const pose = sampleLivingRoutePoseAtTime(
    partition,
    index,
    presentationTimeSeconds,
    reducedMotion,
    { x: 0, y: 0, heading: 0, edgeIndex: -1 },
  );
  return [pose.x, pose.y, pose.heading, pose.edgeIndex];
}

function initializePositions(simulation: LivingSimulation, reducedMotion: boolean): void {
  const { partition } = simulation;
  const pose: LivingRoutePose = { x: 0, y: 0, heading: 0, edgeIndex: -1 };
  for (let index = 0; index < partition.count; index += 1) {
    sampleLivingRoutePoseAtTime(
      partition,
      index,
      simulation.presentationTimeSeconds,
      reducedMotion,
      pose,
    );
    partition.position.previousX[index] = pose.x;
    partition.position.previousY[index] = pose.y;
    partition.position.currentX[index] = pose.x;
    partition.position.currentY[index] = pose.y;
    partition.position.previousHeading[index] = pose.heading;
    partition.position.currentHeading[index] = pose.heading;
    partition.movement.currentEdgeIndex[index] = pose.edgeIndex;
  }
}

export function createLivingSimulation(
  sourcePartition: LivingPartition,
  options: { reducedMotion?: boolean; clone?: boolean; presentationTimeSeconds?: number } = {},
): LivingSimulation {
  const presentationTimeSeconds = Number.isFinite(options.presentationTimeSeconds)
    ? options.presentationTimeSeconds!
    : 0;
  const simulation: LivingSimulation = {
    partition: options.clone === false ? sourcePartition : cloneLivingPartition(sourcePartition),
    tick: 0,
    startPresentationTimeSeconds: presentationTimeSeconds,
    presentationTimeSeconds,
    accumulatorSeconds: 0,
    fixedStepCount: 0,
    interpolationCount: 0,
    reducedMotion: options.reducedMotion ?? false,
  };
  initializePositions(simulation, simulation.reducedMotion);
  return simulation;
}

function fixedStep(simulation: LivingSimulation, reducedMotion: boolean): void {
  const { partition } = simulation;
  const nextTick = simulation.tick + 1;
  const presentationTimeSeconds = simulation.presentationTimeSeconds + LIVING_FIXED_STEP_SECONDS;
  const pose: LivingRoutePose = { x: 0, y: 0, heading: 0, edgeIndex: -1 };
  for (let index = 0; index < partition.count; index += 1) {
    partition.position.previousX[index] = partition.position.currentX[index]!;
    partition.position.previousY[index] = partition.position.currentY[index]!;
    partition.position.previousHeading[index] = partition.position.currentHeading[index]!;
    sampleLivingRoutePoseAtTime(
      partition,
      index,
      presentationTimeSeconds,
      reducedMotion,
      pose,
    );
    partition.position.currentX[index] = pose.x;
    partition.position.currentY[index] = pose.y;
    partition.position.currentHeading[index] = pose.heading;
    partition.movement.currentEdgeIndex[index] = pose.edgeIndex;
  }
  simulation.tick = nextTick;
  simulation.presentationTimeSeconds = presentationTimeSeconds;
  simulation.fixedStepCount += 1;
}

/**
 * Advances one bounded 10 Hz wall-lane update while sampling the authored route
 * at an exact absolute presentation instant. Playback may cover many model
 * seconds between wall updates (120x base rate, then 1x/4x/16x UI speed), so
 * iterating every skipped presentation tenth would be both wasteful and
 * semantically wrong for this analytical presentation layer.
 */
export function advanceLivingSimulationToPresentationTime(
  simulation: LivingSimulation,
  presentationTimeSeconds: number,
  options: { reducedMotion?: boolean } = {},
): LivingAdvanceResult {
  if (!Number.isFinite(presentationTimeSeconds)) {
    throw new Error('Living absolute presentation time must be finite');
  }
  const currentTime = simulation.presentationTimeSeconds + simulation.accumulatorSeconds;
  if (presentationTimeSeconds < currentTime - 1e-9) {
    throw new Error('Living absolute presentation time cannot move backwards without an explicit seek');
  }
  simulation.reducedMotion = options.reducedMotion ?? simulation.reducedMotion;
  if (Math.abs(presentationTimeSeconds - currentTime) <= 1e-9) {
    return {
      steps: 0,
      simulationTick: simulation.tick,
      accumulatorSeconds: simulation.accumulatorSeconds,
      saturated: false,
    };
  }
  const { partition } = simulation;
  const pose: LivingRoutePose = { x: 0, y: 0, heading: 0, edgeIndex: -1 };
  for (let index = 0; index < partition.count; index += 1) {
    partition.position.previousX[index] = partition.position.currentX[index]!;
    partition.position.previousY[index] = partition.position.currentY[index]!;
    partition.position.previousHeading[index] = partition.position.currentHeading[index]!;
    sampleLivingRoutePoseAtTime(
      partition,
      index,
      presentationTimeSeconds,
      simulation.reducedMotion,
      pose,
    );
    partition.position.currentX[index] = pose.x;
    partition.position.currentY[index] = pose.y;
    partition.position.currentHeading[index] = pose.heading;
    partition.movement.currentEdgeIndex[index] = pose.edgeIndex;
  }
  simulation.tick += 1;
  simulation.startPresentationTimeSeconds = presentationTimeSeconds;
  simulation.presentationTimeSeconds = presentationTimeSeconds;
  simulation.accumulatorSeconds = 0;
  simulation.fixedStepCount += 1;
  return {
    steps: 1,
    simulationTick: simulation.tick,
    accumulatorSeconds: 0,
    saturated: false,
  };
}

export function seekLivingSimulation(
  simulation: LivingSimulation,
  presentationTimeSeconds: number,
  options: { reducedMotion?: boolean } = {},
): void {
  if (!Number.isFinite(presentationTimeSeconds)) throw new Error('Living presentation time must be finite');
  simulation.startPresentationTimeSeconds = presentationTimeSeconds;
  simulation.presentationTimeSeconds = presentationTimeSeconds;
  simulation.tick = 0;
  simulation.accumulatorSeconds = 0;
  simulation.reducedMotion = options.reducedMotion ?? simulation.reducedMotion;
  initializePositions(simulation, simulation.reducedMotion);
}

export function advanceLivingSimulation(
  simulation: LivingSimulation,
  deltaSeconds: number,
  options: AdvanceLivingSimulationOptions = {},
): LivingAdvanceResult {
  const safeDelta = Math.max(0, Number.isFinite(deltaSeconds) ? deltaSeconds : 0);
  simulation.reducedMotion = options.reducedMotion ?? simulation.reducedMotion;
  const maxFixedSteps = Math.max(1, Math.floor(options.maxFixedSteps ?? 1_000));
  simulation.accumulatorSeconds += safeDelta;
  const availableSteps = Math.floor((simulation.accumulatorSeconds + 1e-9) / LIVING_FIXED_STEP_SECONDS);
  const steps = Math.min(availableSteps, maxFixedSteps);
  for (let index = 0; index < steps; index += 1) {
    fixedStep(simulation, simulation.reducedMotion);
  }
  simulation.accumulatorSeconds -= steps * LIVING_FIXED_STEP_SECONDS;
  if (Math.abs(simulation.accumulatorSeconds) < 1e-9) simulation.accumulatorSeconds = 0;
  return {
    steps,
    simulationTick: simulation.tick,
    accumulatorSeconds: simulation.accumulatorSeconds,
    saturated: availableSteps > maxFixedSteps,
  };
}

function interpolateHeading(previous: number, current: number, alpha: number): number {
  const delta = ((current - previous + 540) % 360) - 180;
  return (previous + delta * alpha + 360) % 360;
}

export function interpolateLivingSimulation(
  simulation: LivingSimulation,
  output?: LivingRenderFrame,
): LivingRenderFrame {
  const { partition } = simulation;
  const alpha = Math.max(0, Math.min(1, simulation.accumulatorSeconds / LIVING_FIXED_STEP_SECONDS));
  const frame: LivingRenderFrame = output && output.x.length === partition.count
    && output.y.length === partition.count
    && output.heading.length === partition.count
    && output.activity.length === partition.count
    ? output
    : {
        x: new Float32Array(partition.count),
        y: new Float32Array(partition.count),
        heading: new Float32Array(partition.count),
        activity: new Uint8Array(partition.count),
        alpha,
        simulationTick: simulation.tick,
      };
  const renderPresentationTime = simulation.presentationTimeSeconds
    + Math.min(simulation.accumulatorSeconds, LIVING_FIXED_STEP_SECONDS);
  const pose: LivingRoutePose = { x: 0, y: 0, heading: 0, edgeIndex: -1 };
  for (let index = 0; index < partition.count; index += 1) {
    if (partition.movement.routeIndex[index]! >= 0) {
      sampleLivingRoutePoseAtTime(
        partition,
        index,
        renderPresentationTime,
        simulation.reducedMotion,
        pose,
      );
      frame.x[index] = pose.x;
      frame.y[index] = pose.y;
      frame.heading[index] = pose.heading;
    } else {
      const previousX = partition.position.previousX[index]!;
      const previousY = partition.position.previousY[index]!;
      frame.x[index] = previousX + (partition.position.currentX[index]! - previousX) * alpha;
      frame.y[index] = previousY + (partition.position.currentY[index]! - previousY) * alpha;
      frame.heading[index] = interpolateHeading(
        partition.position.previousHeading[index]!,
        partition.position.currentHeading[index]!,
        alpha,
      );
    }
  }
  if (partition.activitySchedule) {
    writeLivingActivitiesAtPresentationSeconds(
      partition.activitySchedule.descriptor,
      partition.activitySchedule.profile,
      renderPresentationTime,
      frame.activity,
    );
  } else frame.activity.set(partition.identity.activity);
  frame.alpha = alpha;
  frame.simulationTick = simulation.tick;
  simulation.interpolationCount += 1;
  return frame;
}

/**
 * Copies the worker-owned exact current pose without sampling every route a
 * second time. Persistent-worker advance/seek already wrote these columns for
 * the requested presentation instant; re-running the polyline walker here is
 * both redundant and allocation-heavy.
 */
export function currentLivingSimulationFrame(
  simulation: LivingSimulation,
  output?: LivingRenderFrame,
): LivingRenderFrame {
  const { partition } = simulation;
  const frame: LivingRenderFrame = output && output.x.length === partition.count
    && output.y.length === partition.count
    && output.heading.length === partition.count
    && output.activity.length === partition.count
    ? output
    : {
        x: new Float32Array(partition.count),
        y: new Float32Array(partition.count),
        heading: new Float32Array(partition.count),
        activity: new Uint8Array(partition.count),
        alpha: 0,
        simulationTick: simulation.tick,
      };
  frame.x.set(partition.position.currentX);
  frame.y.set(partition.position.currentY);
  frame.heading.set(partition.position.currentHeading);
  const presentationTimeSeconds = simulation.presentationTimeSeconds
    + simulation.accumulatorSeconds;
  if (partition.activitySchedule) {
    writeLivingActivitiesAtPresentationSeconds(
      partition.activitySchedule.descriptor,
      partition.activitySchedule.profile,
      presentationTimeSeconds,
      frame.activity,
    );
  } else frame.activity.set(partition.identity.activity);
  frame.alpha = 0;
  frame.simulationTick = simulation.tick;
  simulation.interpolationCount += 1;
  return frame;
}
