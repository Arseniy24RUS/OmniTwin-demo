import { cloneLivingSimulation } from '../living/simulation';
import type { LivingRenderFrame, LivingSimulation } from '../living/types';
import {
  createLivingPersistentWorkerProcessor,
  livingWorkerCommandTransferables,
  livingWorkerInitializeTransferables,
  type LivingPersistentWorkerRequest,
  type LivingWorkerFrameResponse,
} from './livingWorkerProtocol';
import type { LatestWinsResult } from './latestWins';

export type LivingWorkerMode = 'worker' | 'inline_fallback';

export interface LivingWorkerControllerTelemetry {
  mode: LivingWorkerMode;
  fallbackReason: string | null;
  submitted: number;
  executed: number;
  processed: number;
  superseded: number;
  failed: number;
  initialized: boolean;
  fatalError: string | null;
  lastPresentationTimeSeconds: number | null;
  lastOperation: LivingWorkerFrameResponse['operation'] | null;
  advanceOperations: number;
  seekOperations: number;
  framePoolCapacity: number;
  recycledFrames: number;
  reusedFrames: number;
  droppedRecycledFrames: number;
  fullQaAudits: number;
  deferredQaUpdates: number;
}

export interface LivingWorkerLike {
  /** Worker messages are an untrusted structured-clone boundary. */
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: LivingPersistentWorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
}

export interface CreateLivingSimulationControllerOptions {
  /** Null explicitly exercises Worker-unavailable handling. */
  workerFactory?: (() => LivingWorkerLike) | null;
  /** Test/dev-only. Product callers must fail closed when a Worker is unavailable. */
  allowInlineFallback?: boolean;
  /** Monotonic test seam for the bounded QA audit cadence. */
  now?: () => number;
  qaAuditIntervalMs?: number;
}

interface ControllerJob {
  request: LivingPersistentWorkerRequest;
  resolve: (result: LatestWinsResult<LivingWorkerFrameResponse>) => void;
  reject: (reason: unknown) => void;
}

export interface LivingSimulationController {
  ready: Promise<LivingWorkerFrameResponse>;
  advanceTo(
    presentationTimeSeconds: number,
    reducedMotion?: boolean,
  ): Promise<LatestWinsResult<LivingWorkerFrameResponse>>;
  seek(
    presentationTimeSeconds: number,
    reducedMotion?: boolean,
  ): Promise<LatestWinsResult<LivingWorkerFrameResponse>>;
  /**
   * Releases a frame only after every renderer stopped referencing it. At most
   * three frames remain available for the next worker round-trip.
   */
  releaseFrame(frame: LivingRenderFrame): boolean;
  telemetry(): LivingWorkerControllerTelemetry;
  dispose(): void;
}

const VALIDATED_LIVING_WORKER_FRAME = Symbol('validated-living-worker-frame');
const LIVING_FRAME_POOL_CAPACITY = 3;

type ValidatedLivingWorkerFrameResponse = LivingWorkerFrameResponse & {
  readonly [VALIDATED_LIVING_WORKER_FRAME]: true;
};

/** True only after the main-thread controller completed the untrusted worker scan. */
export function isValidatedLivingWorkerFrameResponse(
  value: LivingWorkerFrameResponse,
): value is ValidatedLivingWorkerFrameResponse {
  return (value as Partial<ValidatedLivingWorkerFrameResponse>)[VALIDATED_LIVING_WORKER_FRAME]
    === true;
}

function defaultWorkerFactory(): LivingWorkerLike {
  return new Worker(new URL('./livingSimulation.worker.ts', import.meta.url), { type: 'module' });
}

export function createLivingSimulationController(
  sourceSimulation: LivingSimulation,
  options: CreateLivingSimulationControllerOptions = {},
): LivingSimulationController {
  let sequence = 0;
  let active: ControllerJob | null = null;
  let pending: ControllerJob | null = null;
  let disposed = false;
  const now = options.now ?? (() => (
    typeof performance !== 'undefined' ? performance.now() : Date.now()
  ));
  const qaAuditIntervalMs = Math.max(100, Math.floor(options.qaAuditIntervalMs ?? 1_000));
  let lastQaAuditMs = Number.NEGATIVE_INFINITY;
  const recycledFrames: LivingRenderFrame[] = [];
  const counts: LivingWorkerControllerTelemetry = {
    mode: 'worker',
    fallbackReason: null,
    submitted: 0,
    executed: 0,
    processed: 0,
    superseded: 0,
    failed: 0,
    initialized: false,
    fatalError: null,
    lastPresentationTimeSeconds: null,
    lastOperation: null,
    advanceOperations: 0,
    seekOperations: 0,
    framePoolCapacity: LIVING_FRAME_POOL_CAPACITY,
    recycledFrames: 0,
    reusedFrames: 0,
    droppedRecycledFrames: 0,
    fullQaAudits: 0,
    deferredQaUpdates: 0,
  };
  const inlineProcessor = createLivingPersistentWorkerProcessor();
  let worker: LivingWorkerLike | null = null;
  let failedClosed = false;
  const expectedEntityCount = sourceSimulation.partition.count;
  let startupFailureReason: string | null = null;

  const releaseFrame = (frame: LivingRenderFrame): boolean => {
    if (disposed
      || !(frame.x instanceof Float32Array)
      || !(frame.y instanceof Float32Array)
      || !(frame.heading instanceof Float32Array)
      || !(frame.activity instanceof Uint8Array)
      || frame.x.length !== expectedEntityCount
      || frame.y.length !== expectedEntityCount
      || frame.heading.length !== expectedEntityCount
      || frame.activity.length !== expectedEntityCount
      || frame.x.byteLength === 0
      || frame.y.byteLength === 0
      || frame.heading.byteLength === 0
      || frame.activity.byteLength === 0
      || recycledFrames.includes(frame)) return false;
    if (recycledFrames.length >= LIVING_FRAME_POOL_CAPACITY) {
      counts.droppedRecycledFrames += 1;
      return false;
    }
    recycledFrames.push(frame);
    counts.recycledFrames += 1;
    return true;
  };
  const configuredFactory = options.workerFactory === undefined
    ? (typeof Worker === 'undefined' ? null : defaultWorkerFactory)
    : options.workerFactory;
  if (!configuredFactory) {
    if (options.allowInlineFallback === true) {
      counts.mode = 'inline_fallback';
      counts.fallbackReason = 'worker_api_unavailable';
    } else startupFailureReason = 'worker_api_unavailable';
  } else {
    try {
      worker = configuredFactory();
    } catch (error) {
      const reason = error instanceof Error
        ? `worker_creation_failed:${error.message}`
        : 'worker_creation_failed';
      if (options.allowInlineFallback === true) {
        counts.mode = 'inline_fallback';
        counts.fallbackReason = reason;
      } else startupFailureReason = reason;
    }
  }

  const validatedResponse = (
    value: unknown,
    request: LivingPersistentWorkerRequest,
  ): ValidatedLivingWorkerFrameResponse => {
    if (!value || typeof value !== 'object') {
      throw new Error('worker_response_invalid');
    }
    const response = value as Record<string, unknown>;
    if (response.type !== 'living-frame') {
      throw new Error('worker_response_type_invalid');
    }
    if (!Number.isSafeInteger(response.sequence)) {
      throw new Error('worker_response_sequence_invalid');
    }
    const validOperation = request.type === 'living-initialize'
      ? response.operation === 'initialize'
      : request.type === 'living-seek'
        ? response.operation === 'seek'
        : response.operation === 'advance' || response.operation === 'seek';
    if (!validOperation) throw new Error('worker_response_operation_invalid');
    const frame = response.frame;
    if (!frame || typeof frame !== 'object') throw new Error('worker_response_frame_invalid');
    const frameRecord = frame as Record<string, unknown>;
    for (const columnName of ['x', 'y', 'heading'] as const) {
      const column = frameRecord[columnName];
      if (!(column instanceof Float32Array)) {
        throw new Error(`worker_response_${columnName}_type_invalid`);
      }
      if (column.length !== expectedEntityCount) {
        throw new Error(`worker_response_${columnName}_length_invalid`);
      }
      for (let index = 0; index < column.length; index += 1) {
        if (!Number.isFinite(column[index])) {
          throw new Error(`worker_response_${columnName}_non_finite`);
        }
      }
    }
    if (!(frameRecord.activity instanceof Uint8Array)) {
      throw new Error('worker_response_activity_type_invalid');
    }
    if (frameRecord.activity.length !== expectedEntityCount) {
      throw new Error('worker_response_activity_length_invalid');
    }
    for (let index = 0; index < frameRecord.activity.length; index += 1) {
      if (frameRecord.activity[index]! > 5) {
        throw new Error('worker_response_activity_value_invalid');
      }
    }
    if (
      typeof frameRecord.alpha !== 'number'
      || !Number.isFinite(frameRecord.alpha)
      || frameRecord.alpha < 0
      || frameRecord.alpha > 1
      || typeof frameRecord.simulationTick !== 'number'
      || !Number.isSafeInteger(frameRecord.simulationTick)
      || frameRecord.simulationTick < 0
    ) throw new Error('worker_response_frame_metadata_invalid');
    const telemetry = response.telemetry;
    if (!telemetry || typeof telemetry !== 'object') {
      throw new Error('worker_response_telemetry_invalid');
    }
    const presentationTimeSeconds = (telemetry as Record<string, unknown>)
      .presentationTimeSeconds;
    if (typeof presentationTimeSeconds !== 'number' || !Number.isFinite(presentationTimeSeconds)) {
      throw new Error('worker_response_presentation_time_invalid');
    }
    const expectedPresentationTime = request.type === 'living-initialize'
      ? request.simulation.presentationTimeSeconds + request.simulation.accumulatorSeconds
      : request.presentationTimeSeconds;
    const tolerance = Math.max(
      1e-6,
      Math.abs(expectedPresentationTime) * Number.EPSILON * 8,
    );
    if (Math.abs(presentationTimeSeconds - expectedPresentationTime) > tolerance) {
      throw new Error('worker_response_presentation_time_mismatch');
    }
    Object.defineProperty(value, VALIDATED_LIVING_WORKER_FRAME, {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    return value as ValidatedLivingWorkerFrameResponse;
  };

  const finish = (value: unknown) => {
    const job = active;
    if (!job) return;
    const response = validatedResponse(value, job.request);
    if (response.sequence !== job.request.sequence) {
      failClosed(`worker_sequence_mismatch:${response.sequence}:${job.request.sequence}`);
      return;
    }
    counts.executed += 1;
    counts.lastPresentationTimeSeconds = response.telemetry.presentationTimeSeconds;
    counts.lastOperation = response.operation;
    if (response.operation === 'advance') counts.advanceOperations += 1;
    else if (response.operation === 'seek') counts.seekOperations += 1;
    const audited = job.request.type === 'living-initialize'
      || job.request.type === 'living-seek'
      || job.request.qaAudit !== false;
    if (audited) {
      counts.fullQaAudits += 1;
      lastQaAuditMs = now();
    } else counts.deferredQaUpdates += 1;
    active = null;
    if (pending) {
      counts.superseded += 1;
      releaseFrame(response.frame);
      job.resolve({ status: 'superseded', sequence: job.request.sequence });
      const next = pending;
      pending = null;
      dispatch(next);
    } else {
      counts.processed += 1;
      job.resolve({ status: 'processed', sequence: job.request.sequence, value: response });
    }
  };

  const fail = (reason: unknown) => {
    const job = active;
    if (!job) return;
    active = null;
    counts.failed += 1;
    job.reject(reason);
    if (pending) {
      const next = pending;
      pending = null;
      dispatch(next);
    }
  };

  const failClosed = (reason: string) => {
    if (failedClosed) return;
    failedClosed = true;
    counts.failed += 1;
    counts.fatalError = reason;
    worker?.terminate();
    worker = null;
    const error = new Error(`Living simulation worker failed closed: ${reason}`);
    active?.reject(error);
    pending?.reject(error);
    active = null;
    pending = null;
  };

  if (worker) {
    worker.onmessage = (event) => {
      try {
        finish(event.data);
      } catch (error) {
        failClosed(error instanceof Error ? error.message : 'worker_response_validation_failed');
      }
    };
    worker.onerror = (event) => failClosed(event.message || 'worker_error');
  }
  if (startupFailureReason) failClosed(startupFailureReason);

  function dispatch(job: ControllerJob): void {
    if (disposed || failedClosed) {
      job.reject(new Error(disposed
        ? 'Living simulation controller is disposed'
        : `Living simulation worker failed closed: ${counts.fatalError}`));
      return;
    }
    if (job.request.type !== 'living-initialize'
      && !job.request.recycledFrame
      && recycledFrames.length > 0) {
      job.request = {
        ...job.request,
        recycledFrame: recycledFrames.pop()!,
      };
      counts.reusedFrames += 1;
    }
    active = job;
    if (worker) {
      const transfer = job.request.type === 'living-initialize'
        ? livingWorkerInitializeTransferables(job.request)
        : livingWorkerCommandTransferables(job.request);
      try {
        worker.postMessage(job.request, transfer);
      } catch (error) {
        failClosed(error instanceof Error ? error.message : 'worker_post_message_failed');
      }
      return;
    }
    queueMicrotask(() => {
      try {
        finish(inlineProcessor.process(job.request));
      } catch (error) {
        fail(error);
      }
    });
  }

  function submit(request: LivingPersistentWorkerRequest): Promise<LatestWinsResult<LivingWorkerFrameResponse>> {
    counts.submitted += 1;
    return new Promise((resolve, reject) => {
      const job: ControllerJob = { request, resolve, reject };
      if (!active) {
        dispatch(job);
        return;
      }
      // An explicit seek is a semantic barrier, not an ordinary stale frame.
      // Keep it as the sole pending job and discard forward samples submitted
      // before the authoritative seek has been applied.
      if (pending?.request.type === 'living-seek'
        && request.type === 'living-advance-to') {
        counts.superseded += 1;
        resolve({ status: 'superseded', sequence: request.sequence });
        return;
      }
      if (pending) {
        counts.superseded += 1;
        pending.resolve({ status: 'superseded', sequence: pending.request.sequence });
      }
      pending = job;
    });
  }

  const initialSimulation = cloneLivingSimulation(sourceSimulation);
  const readyResult = submit({
    type: 'living-initialize',
    sequence: ++sequence,
    simulation: initialSimulation,
  });
  const ready = readyResult.then((result) => {
    if (result.status !== 'processed') throw new Error('Living worker initialization was superseded');
    counts.initialized = true;
    return result.value;
  });

  const command = (
    type: 'living-advance-to' | 'living-seek',
    presentationTimeSeconds: number,
    reducedMotion = false,
  ) => {
    if (!Number.isFinite(presentationTimeSeconds)) {
      return Promise.reject(new Error('Living controller presentation time must be finite'));
    }
    const request = {
      type,
      sequence: ++sequence,
      presentationTimeSeconds,
      reducedMotion,
      qaAudit: type === 'living-seek' || now() - lastQaAuditMs >= qaAuditIntervalMs,
    } as const;
    return ready.then(() => submit(request));
  };

  return {
    ready,
    advanceTo: (presentationTimeSeconds, reducedMotion) => command(
      'living-advance-to', presentationTimeSeconds, reducedMotion,
    ),
    seek: (presentationTimeSeconds, reducedMotion) => command(
      'living-seek', presentationTimeSeconds, reducedMotion,
    ),
    releaseFrame,
    telemetry: () => ({ ...counts }),
    dispose() {
      if (disposed) return;
      disposed = true;
      worker?.terminate();
      recycledFrames.length = 0;
      if (pending) {
        pending.reject(new Error('Living simulation controller is disposed'));
        pending = null;
      }
      if (active) {
        active.reject(new Error('Living simulation controller is disposed'));
        active = null;
      }
    },
  };
}
