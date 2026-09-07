import {
  createGpuTimerQuerySampler,
  type GpuTimerBoundary,
  type GpuTimerCapabilityStatus,
  type GpuTimerDiscardReason,
  type GpuTimerQueryContext,
  type GpuTimerQuerySampler,
} from './gpuTimerQuery';

const DEFAULT_SAMPLE_WINDOW = 120;
const DEFAULT_MAX_PENDING_QUERIES = 4;
const WHOLE_MAP_FRAME_LABEL = 'maplibre-shared-webgl2-frame';

export type MapGpuFrameTimerStatus =
  | GpuTimerCapabilityStatus
  | 'context_unavailable'
  | 'warming_up'
  | 'stalled';

export interface MapGpuFrameTimerSnapshot {
  readonly status: MapGpuFrameTimerStatus;
  /** Extension capability, independent of watchdog readiness. */
  readonly extensionSupported?: boolean;
  /** False only when the extension is unavailable/faulted or the watchdog stalled. */
  readonly supported: boolean;
  readonly readyForGovernor?: boolean;
  readonly active: boolean;
  readonly pendingCount: number;
  /** Lifetime count of accepted, non-disjoint GPU samples. */
  readonly sampleCount: number;
  /** Number of accepted samples currently represented by median/p95. */
  readonly windowSampleCount: number;
  readonly discardCount: number;
  readonly disjointDiscardCount: number;
  readonly contextLossDiscardCount: number;
  readonly apiErrorDiscardCount: number;
  readonly beginSkippedCount: number;
  readonly lastMilliseconds: number | null;
  readonly medianMilliseconds: number | null;
  readonly p95Milliseconds: number | null;
  /**
   * @deprecated Compatibility alias for the public render-event interval
   * fields below. MapLibre has no public `renderstart` event in 6.4.x.
   */
  readonly rendererSubmissionWallSampleCount: number;
  readonly rendererSubmissionWallWindowSampleCount: number;
  readonly rendererSubmissionWallLastMilliseconds: number | null;
  readonly rendererSubmissionWallMedianMilliseconds: number | null;
  readonly rendererSubmissionWallP95Milliseconds: number | null;
  readonly renderIntervalSampleCount?: number;
  readonly renderIntervalWindowSampleCount?: number;
  readonly renderIntervalLastMilliseconds?: number | null;
  readonly renderIntervalMedianMilliseconds?: number | null;
  readonly renderIntervalP95Milliseconds?: number | null;
  readonly measurementBoundary?: 'public_render_event_interval';
  readonly minimumReadySamples?: number;
  readonly sampleWatchdogMs?: number;
  readonly generationSampleCount?: number;
}

/** Minimal event surface used by MapLibre without coupling tests to a real map. */
export interface MapGpuFrameTimerMap {
  getCanvas(): HTMLCanvasElement;
  on(event: 'render', listener: () => void): unknown;
  off(event: 'render', listener: () => void): unknown;
}

export interface MapGpuFrameTimerOptions {
  readonly maxPendingQueries?: number;
  readonly sampleWindowSize?: number;
  /** Samples required before percentile values are governor-ready. */
  readonly minimumReadySamples?: number;
  /** Continuous render progress without a sample before fail-open fallback. */
  readonly sampleWatchdogMs?: number;
  /** Monotonic clock injection used for frame intervals and the watchdog. */
  readonly now?: () => number;
}

export interface MapGpuFrameTimer {
  snapshot(): MapGpuFrameTimerSnapshot;
  /** Starts a clean frame-interval epoch without discarding GPU lifetime evidence. */
  resetFrameIntervals?(): void;
  dispose(): void;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(value!)));
}

function percentile(sorted: readonly number[], quantile: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1),
  );
  return sorted[index] ?? null;
}

function isTimerContext(value: unknown): value is GpuTimerQueryContext {
  if (typeof value !== 'object' || value === null) return false;
  const context = value as Partial<GpuTimerQueryContext>;
  return Number.isFinite(context.QUERY_RESULT_AVAILABLE)
    && Number.isFinite(context.QUERY_RESULT)
    && typeof context.getExtension === 'function'
    && typeof context.createQuery === 'function'
    && typeof context.deleteQuery === 'function'
    && typeof context.beginQuery === 'function'
    && typeof context.endQuery === 'function'
    && typeof context.getQueryParameter === 'function'
    && typeof context.getParameter === 'function'
    && typeof context.isContextLost === 'function';
}

function webGl2Context(canvas: HTMLCanvasElement): GpuTimerQueryContext | null {
  try {
    const context = canvas.getContext('webgl2');
    return isTimerContext(context) ? context : null;
  } catch {
    return null;
  }
}

class AttachedMapGpuFrameTimer implements MapGpuFrameTimer {
  private readonly map: MapGpuFrameTimerMap;
  private readonly canvas: HTMLCanvasElement;
  private readonly maxPendingQueries: number;
  private readonly minimumReadySamples: number;
  private readonly sampleWatchdogMs: number;
  private readonly samples: Float32Array;
  private readonly rendererSubmissionWallSamples: Float32Array;
  private readonly now: () => number;
  private sampler: GpuTimerQuerySampler | null = null;
  private activeBoundary: GpuTimerBoundary | null = null;
  private pendingEstimate = 0;
  private status: MapGpuFrameTimerStatus = 'context_unavailable';
  private sampleCount = 0;
  private sampleWriteIndex = 0;
  private windowSampleCount = 0;
  private discardCount = 0;
  private disjointDiscardCount = 0;
  private contextLossDiscardCount = 0;
  private apiErrorDiscardCount = 0;
  private beginSkippedCount = 0;
  private lastMilliseconds: number | null = null;
  private lastRenderAtMs: number | null = null;
  private samplerGenerationSampleBaseline = 0;
  private samplerGenerationFirstRenderAtMs: number | null = null;
  private watchdogLatched = false;
  private rendererSubmissionWallSampleCount = 0;
  private rendererSubmissionWallWriteIndex = 0;
  private rendererSubmissionWallWindowSampleCount = 0;
  private rendererSubmissionWallLastMilliseconds: number | null = null;
  private disposed = false;

  constructor(map: MapGpuFrameTimerMap, options: MapGpuFrameTimerOptions) {
    this.map = map;
    this.canvas = map.getCanvas();
    this.maxPendingQueries = boundedInteger(
      options.maxPendingQueries,
      DEFAULT_MAX_PENDING_QUERIES,
      32,
    );
    this.minimumReadySamples = boundedInteger(
      options.minimumReadySamples,
      30,
      2_048,
    );
    this.sampleWatchdogMs = Math.max(
      100,
      Number.isFinite(options.sampleWatchdogMs) ? options.sampleWatchdogMs! : 1_000,
    );
    this.samples = new Float32Array(
      boundedInteger(options.sampleWindowSize, DEFAULT_SAMPLE_WINDOW, 2_048),
    );
    this.rendererSubmissionWallSamples = new Float32Array(this.samples.length);
    this.now = options.now ?? (() => performance.now());
    this.recreateSampler();
    this.map.on('render', this.handleRender);
    this.canvas.addEventListener('webglcontextlost', this.handleContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.handleContextRestored);
  }

  snapshot(): MapGpuFrameTimerSnapshot {
    const capability = this.sampler?.capability();
    const extensionSupported = !this.disposed && capability?.status === 'available';
    const nowMs = this.readNow();
    const status = this.effectiveStatus(capability?.status ?? this.status, nowMs);
    const generationSampleCount = this.sampleCount - this.samplerGenerationSampleBaseline;
    const readyForGovernor = status === 'available'
      && generationSampleCount >= this.minimumReadySamples;
    const sorted = Array.from(this.samples.subarray(0, this.windowSampleCount))
      .sort((left, right) => left - right);
    const rendererSubmissionWallSorted = Array.from(
      this.rendererSubmissionWallSamples.subarray(
        0,
        this.rendererSubmissionWallWindowSampleCount,
      ),
    ).sort((left, right) => left - right);
    return {
      status,
      extensionSupported,
      supported: extensionSupported && status !== 'stalled',
      readyForGovernor,
      active: !this.disposed && (capability?.active ?? false),
      pendingCount: this.disposed ? 0 : capability?.pendingCount ?? 0,
      sampleCount: this.sampleCount,
      windowSampleCount: this.windowSampleCount,
      discardCount: this.discardCount,
      disjointDiscardCount: this.disjointDiscardCount,
      contextLossDiscardCount: this.contextLossDiscardCount,
      apiErrorDiscardCount: this.apiErrorDiscardCount,
      beginSkippedCount: this.beginSkippedCount,
      lastMilliseconds: this.lastMilliseconds,
      medianMilliseconds: readyForGovernor ? percentile(sorted, 0.5) : null,
      p95Milliseconds: readyForGovernor ? percentile(sorted, 0.95) : null,
      rendererSubmissionWallSampleCount: this.rendererSubmissionWallSampleCount,
      rendererSubmissionWallWindowSampleCount: this.rendererSubmissionWallWindowSampleCount,
      rendererSubmissionWallLastMilliseconds: this.rendererSubmissionWallLastMilliseconds,
      rendererSubmissionWallMedianMilliseconds: percentile(rendererSubmissionWallSorted, 0.5),
      rendererSubmissionWallP95Milliseconds: percentile(rendererSubmissionWallSorted, 0.95),
      renderIntervalSampleCount: this.rendererSubmissionWallSampleCount,
      renderIntervalWindowSampleCount: this.rendererSubmissionWallWindowSampleCount,
      renderIntervalLastMilliseconds: this.rendererSubmissionWallLastMilliseconds,
      renderIntervalMedianMilliseconds: percentile(rendererSubmissionWallSorted, 0.5),
      renderIntervalP95Milliseconds: percentile(rendererSubmissionWallSorted, 0.95),
      measurementBoundary: 'public_render_event_interval',
      minimumReadySamples: this.minimumReadySamples,
      sampleWatchdogMs: this.sampleWatchdogMs,
      generationSampleCount,
    };
  }

  resetFrameIntervals(): void {
    if (this.disposed) return;
    this.rendererSubmissionWallSamples.fill(0);
    this.rendererSubmissionWallSampleCount = 0;
    this.rendererSubmissionWallWriteIndex = 0;
    this.rendererSubmissionWallWindowSampleCount = 0;
    this.rendererSubmissionWallLastMilliseconds = null;
    this.lastRenderAtMs = null;
    this.samplerGenerationFirstRenderAtMs = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.map.off('render', this.handleRender);
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
    this.sampler?.dispose();
    this.sampler = null;
    this.activeBoundary = null;
    this.lastRenderAtMs = null;
    this.pendingEstimate = 0;
    this.status = 'disposed';
  }

  private readonly handleRender = (): void => {
    if (this.disposed) return;
    const nowMs = this.readNow();
    this.recordRenderInterval(nowMs);
    if (!this.sampler) return;

    // MapLibre 6.4.x exposes a public `render` event but no public
    // `renderstart`. Close the query opened after render N, poll older work,
    // then open the next interval after render N+1. This never reaches into a
    // private painter API and never owns a second RAF.
    const poll = this.sampler.poll();
    this.status = poll.status;
    let disjointObserved = false;
    for (const sample of poll.samples) {
      this.pendingEstimate = Math.max(0, this.pendingEstimate - 1);
      if (sample.status === 'ready') {
        this.recordSample(sample.elapsedMilliseconds);
      } else {
        this.recordDiscard(sample.reason);
        disjointObserved ||= sample.reason === 'gpu_disjoint';
      }
    }

    if (this.activeBoundary) {
      const boundary = this.activeBoundary;
      this.activeBoundary = null;
      const end = this.sampler.end(boundary);
      if (end.ended) {
        this.pendingEstimate += 1;
      } else if (end.reason === 'context_lost') {
        this.recordDiscard('context_lost');
      } else if (end.reason === 'api_error' || end.reason === 'boundary_mismatch') {
        this.recordDiscard('api_error');
        this.status = 'api_error';
      } else {
        this.status = end.reason;
      }
    }

    // A disjoint flag invalidates this interval. Wait for the next real map
    // frame before opening another query.
    if (disjointObserved || poll.status !== 'available' || this.activeBoundary) return;
    const begin = this.sampler.begin(WHOLE_MAP_FRAME_LABEL);
    if (begin.started) {
      this.activeBoundary = begin.boundary;
      return;
    }
    this.beginSkippedCount += 1;
    if (
      begin.reason === 'context_lost'
      || begin.reason === 'api_error'
      || begin.reason === 'extension_unavailable'
      || begin.reason === 'disposed'
    ) this.status = begin.reason;
  };

  private readonly handleContextLost = (): void => {
    if (this.disposed) return;
    if (this.activeBoundary) {
      this.recordDiscard('context_lost');
      this.activeBoundary = null;
    }
    for (let index = 0; index < this.pendingEstimate; index += 1) {
      this.recordDiscard('context_lost');
    }
    this.pendingEstimate = 0;
    this.sampler?.dispose();
    this.sampler = null;
    this.status = 'context_lost';
    this.watchdogLatched = false;
  };

  private readonly handleContextRestored = (): void => {
    if (this.disposed) return;
    this.recreateSampler();
  };

  private recreateSampler(): void {
    this.sampler?.dispose();
    this.sampler = null;
    this.activeBoundary = null;
    this.pendingEstimate = 0;
    const context = webGl2Context(this.canvas);
    if (!context) {
      this.status = 'context_unavailable';
      return;
    }
    this.sampler = createGpuTimerQuerySampler(context, {
      maxPendingQueries: this.maxPendingQueries,
    });
    this.samplerGenerationSampleBaseline = this.sampleCount;
    this.samplerGenerationFirstRenderAtMs = null;
    this.watchdogLatched = false;
    this.status = this.sampler.capability().status;
  }

  private recordSample(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      this.recordDiscard('api_error');
      return;
    }
    this.samples[this.sampleWriteIndex] = milliseconds;
    this.sampleWriteIndex = (this.sampleWriteIndex + 1) % this.samples.length;
    this.windowSampleCount = Math.min(this.samples.length, this.windowSampleCount + 1);
    this.sampleCount += 1;
    this.lastMilliseconds = milliseconds;
    if (this.sampleCount - this.samplerGenerationSampleBaseline >= this.minimumReadySamples) {
      this.watchdogLatched = false;
    }
  }

  private readNow(): number | null {
    try {
      const value = this.now();
      return Number.isFinite(value) && value >= 0 ? value : null;
    } catch {
      return null;
    }
  }

  private recordRenderInterval(nowMs: number | null): void {
    if (nowMs === null) return;
    if (this.samplerGenerationFirstRenderAtMs === null) {
      this.samplerGenerationFirstRenderAtMs = nowMs;
    }
    const previous = this.lastRenderAtMs;
    this.lastRenderAtMs = nowMs;
    if (previous === null || nowMs <= previous) return;
    const milliseconds = nowMs - previous;
    // Sparse event-driven renders are not a continuous frame-time sample.
    if (milliseconds > 1_000) return;
    this.rendererSubmissionWallSamples[this.rendererSubmissionWallWriteIndex] = milliseconds;
    this.rendererSubmissionWallWriteIndex = (
      this.rendererSubmissionWallWriteIndex + 1
    ) % this.rendererSubmissionWallSamples.length;
    this.rendererSubmissionWallWindowSampleCount = Math.min(
      this.rendererSubmissionWallSamples.length,
      this.rendererSubmissionWallWindowSampleCount + 1,
    );
    this.rendererSubmissionWallSampleCount += 1;
    this.rendererSubmissionWallLastMilliseconds = milliseconds;
  }

  private effectiveStatus(
    capabilityStatus: MapGpuFrameTimerStatus,
    nowMs: number | null,
  ): MapGpuFrameTimerStatus {
    if (this.disposed) return 'disposed';
    if (capabilityStatus !== 'available') return capabilityStatus;
    const lastRenderAtMs = this.lastRenderAtMs;
    const activelyRendering = nowMs !== null
      && lastRenderAtMs !== null
      && nowMs - lastRenderAtMs < this.sampleWatchdogMs;
    const generationSampleCount = this.sampleCount - this.samplerGenerationSampleBaseline;
    if (
      activelyRendering
      && nowMs !== null
      && this.samplerGenerationFirstRenderAtMs !== null
      && nowMs - this.samplerGenerationFirstRenderAtMs >= this.sampleWatchdogMs
      && generationSampleCount < this.minimumReadySamples
    ) this.watchdogLatched = true;
    if (generationSampleCount >= this.minimumReadySamples) {
      this.watchdogLatched = false;
      return 'available';
    }
    return this.watchdogLatched ? 'stalled' : 'warming_up';
  }

  private recordDiscard(reason: GpuTimerDiscardReason): void {
    this.discardCount += 1;
    if (reason === 'gpu_disjoint') this.disjointDiscardCount += 1;
    if (reason === 'context_lost') this.contextLossDiscardCount += 1;
    if (reason === 'api_error') this.apiErrorDiscardCount += 1;
  }
}

/**
 * Measures consecutive intervals on the shared MapLibre/WebGL2 context using
 * only MapLibre's public `render` event. Polling never owns an RAF/timer and
 * never requests a repaint merely to obtain a query result.
 */
export function attachMapGpuFrameTimer(
  map: MapGpuFrameTimerMap,
  options: MapGpuFrameTimerOptions = {},
): MapGpuFrameTimer {
  return new AttachedMapGpuFrameTimer(map, options);
}
