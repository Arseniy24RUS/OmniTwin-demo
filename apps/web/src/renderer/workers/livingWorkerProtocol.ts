import {
  advanceLivingSimulation,
  advanceLivingSimulationToPresentationTime,
  cloneLivingSimulation,
  currentLivingSimulationFrame,
  interpolateLivingSimulation,
  seekLivingSimulation,
  type AdvanceLivingSimulationOptions,
} from '../living/simulation';
import {
  livingQaSnapshot,
  updateLivingQaSnapshotForAdvance,
  updateLivingQaSnapshotWithoutAudit,
} from '../living/telemetry';
import type {
  LivingQaSnapshot,
  LivingRenderFrame,
  LivingSimulation,
} from '../living/types';
import { LatestWinsBufferQueue } from './latestWins';

export interface LivingWorkerAdvanceRequest {
  type: 'living-advance';
  sequence: number;
  deltaSeconds: number;
  options: AdvanceLivingSimulationOptions;
  simulation: LivingSimulation;
}

export interface LivingWorkerAdvanceResponse {
  type: 'living-advanced';
  sequence: number;
  simulation: LivingSimulation;
  frame: LivingRenderFrame;
  telemetry: LivingQaSnapshot;
}

export interface LivingWorkerInitializeRequest {
  type: 'living-initialize';
  sequence: number;
  simulation: LivingSimulation;
}

export interface LivingWorkerAdvanceToRequest {
  type: 'living-advance-to';
  sequence: number;
  presentationTimeSeconds: number;
  reducedMotion: boolean;
  /** Caller-released output storage transferred back to the worker. */
  recycledFrame?: LivingRenderFrame;
  /** Full position/activity hashes are bounded to a low-frequency audit. */
  qaAudit?: boolean;
}

export interface LivingWorkerSeekRequest {
  type: 'living-seek';
  sequence: number;
  presentationTimeSeconds: number;
  reducedMotion: boolean;
  /** Caller-released output storage transferred back to the worker. */
  recycledFrame?: LivingRenderFrame;
  qaAudit?: boolean;
}

export type LivingPersistentWorkerRequest =
  | LivingWorkerInitializeRequest
  | LivingWorkerAdvanceToRequest
  | LivingWorkerSeekRequest;

export interface LivingWorkerFrameResponse {
  type: 'living-frame';
  sequence: number;
  operation: 'initialize' | 'advance' | 'seek';
  frame: LivingRenderFrame;
  telemetry: LivingQaSnapshot;
}

export function createLivingWorkerAdvanceRequest(
  sequence: number,
  simulation: LivingSimulation,
  deltaSeconds: number,
  options: AdvanceLivingSimulationOptions = {},
): LivingWorkerAdvanceRequest {
  return {
    type: 'living-advance',
    sequence,
    deltaSeconds,
    options,
    simulation: cloneLivingSimulation(simulation),
  };
}

export function processLivingWorkerAdvance(
  request: LivingWorkerAdvanceRequest,
): LivingWorkerAdvanceResponse {
  advanceLivingSimulation(request.simulation, request.deltaSeconds, request.options);
  const frame = interpolateLivingSimulation(request.simulation);
  return {
    type: 'living-advanced',
    sequence: request.sequence,
    simulation: request.simulation,
    frame,
    telemetry: livingQaSnapshot(request.simulation, frame),
  };
}

function uniqueTransferables(views: readonly ArrayBufferView[]): Transferable[] {
  const buffers = new Set<ArrayBuffer>();
  for (const view of views) {
    if (view.buffer instanceof ArrayBuffer) buffers.add(view.buffer);
  }
  return [...buffers];
}

function simulationViews(simulation: LivingSimulation): ArrayBufferView[] {
  const { identity, position, movement, presentation } = simulation.partition;
  const graph = simulation.partition.movementGraph;
  const views: ArrayBufferView[] = [
    identity.idHash, identity.seed, identity.kind, identity.representation,
    identity.activity, identity.representedCount, identity.colorRgba,
    position.baseX, position.baseY, position.previousX, position.previousY,
    position.currentX, position.currentY, position.previousHeading,
    position.currentHeading, position.baseHeading, position.speedMetersPerSecond,
    movement.routeIndex, movement.currentEdgeIndex,
    movement.routePhaseOffsetSeconds, movement.routePhaseAnchorSeconds,
    presentation.lod, presentation.primaryRenderer, presentation.visible,
    presentation.screenSizePixels,
  ];
  if (graph) {
    views.push(
      graph.nodeX, graph.nodeY, graph.edgeFrom, graph.edgeTo,
      graph.edgeMode, graph.edgeLengthMeters, graph.edgeVisualSpeedMetersPerSecond,
      graph.edgeDirection,
      graph.edgePointOffsets, graph.edgePointX, graph.edgePointY,
    );
    for (const route of graph.routes) {
      views.push(
        route.edgeIndices, route.edgeDirections,
        route.cumulativeLengthMeters, route.cumulativeTravelSeconds,
      );
    }
  }
  if (simulation.partition.activitySchedule) {
    views.push(simulation.partition.activitySchedule.profile);
  }
  return views;
}

export function livingWorkerRequestTransferables(
  request: LivingWorkerAdvanceRequest,
): Transferable[] {
  return uniqueTransferables(simulationViews(request.simulation));
}

export function livingWorkerInitializeTransferables(
  request: LivingWorkerInitializeRequest,
): Transferable[] {
  return uniqueTransferables(simulationViews(request.simulation));
}

export function livingWorkerCommandTransferables(
  request: LivingPersistentWorkerRequest,
): Transferable[] {
  if (request.type === 'living-initialize' || !request.recycledFrame) return [];
  return uniqueTransferables([
    request.recycledFrame.x,
    request.recycledFrame.y,
    request.recycledFrame.heading,
    request.recycledFrame.activity,
  ]);
}

export function livingWorkerResponseTransferables(
  response: LivingWorkerAdvanceResponse,
): Transferable[] {
  return uniqueTransferables([
    ...simulationViews(response.simulation),
    response.frame.x,
    response.frame.y,
    response.frame.heading,
    response.frame.activity,
  ]);
}

export function livingWorkerFrameTransferables(
  response: LivingWorkerFrameResponse,
): Transferable[] {
  return uniqueTransferables([
    response.frame.x,
    response.frame.y,
    response.frame.heading,
    response.frame.activity,
  ]);
}

export interface LivingPersistentWorkerProcessor {
  process(request: LivingPersistentWorkerRequest): LivingWorkerFrameResponse;
}

/** Persistent worker state: simulation buffers cross the boundary once at init. */
export function createLivingPersistentWorkerProcessor(): LivingPersistentWorkerProcessor {
  let simulation: LivingSimulation | null = null;
  let telemetry: LivingQaSnapshot | null = null;

  const respond = (
    sequence: number,
    operation: LivingWorkerFrameResponse['operation'],
    recycledFrame?: LivingRenderFrame,
    qaAudit = true,
  ): LivingWorkerFrameResponse => {
    if (!simulation) throw new Error('Living worker is not initialized');
    const frame = currentLivingSimulationFrame(simulation, recycledFrame);
    telemetry = operation === 'advance' && telemetry
      ? qaAudit
        ? updateLivingQaSnapshotForAdvance(telemetry, simulation, frame)
        : updateLivingQaSnapshotWithoutAudit(telemetry, simulation, frame)
      : livingQaSnapshot(simulation, frame);
    return {
      type: 'living-frame',
      sequence,
      operation,
      frame,
      telemetry,
    };
  };

  return {
    process(request) {
      if (request.type === 'living-initialize') {
        simulation = request.simulation;
        return respond(request.sequence, 'initialize');
      }
      if (!simulation) throw new Error('Living worker command received before initialization');
      if (!Number.isFinite(request.presentationTimeSeconds)) {
        throw new Error('Living worker presentation time must be finite');
      }
      if (request.type === 'living-seek') {
        seekLivingSimulation(simulation, request.presentationTimeSeconds, {
          reducedMotion: request.reducedMotion,
        });
        return respond(request.sequence, 'seek', request.recycledFrame, true);
      }
      const currentTime = simulation.presentationTimeSeconds + simulation.accumulatorSeconds;
      const deltaSeconds = request.presentationTimeSeconds - currentTime;
      if (deltaSeconds < -1e-9) {
        seekLivingSimulation(simulation, request.presentationTimeSeconds, {
          reducedMotion: request.reducedMotion,
        });
        return respond(request.sequence, 'seek', request.recycledFrame, true);
      }
      advanceLivingSimulationToPresentationTime(simulation, request.presentationTimeSeconds, {
        reducedMotion: request.reducedMotion,
      });
      return respond(
        request.sequence,
        'advance',
        request.recycledFrame,
        request.qaAudit !== false,
      );
    },
  };
}

export function createLatestWinsLivingWorkerQueue(): LatestWinsBufferQueue<
  LivingWorkerAdvanceRequest,
  LivingWorkerAdvanceResponse
> {
  return new LatestWinsBufferQueue(processLivingWorkerAdvance);
}
