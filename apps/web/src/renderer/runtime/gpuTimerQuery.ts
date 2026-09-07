const DISJOINT_TIMER_QUERY_EXTENSION = 'EXT_disjoint_timer_query_webgl2';

interface DisjointTimerQueryWebGl2Extension {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

/**
 * The minimal WebGL2 surface used by the sampler. Keeping this structural
 * makes the measurement boundary testable without creating a real context.
 */
export interface GpuTimerQueryContext {
  readonly QUERY_RESULT_AVAILABLE: number;
  readonly QUERY_RESULT: number;
  getExtension(name: string): unknown;
  createQuery(): WebGLQuery | null;
  deleteQuery(query: WebGLQuery | null): void;
  beginQuery(target: number, query: WebGLQuery): void;
  endQuery(target: number): void;
  getQueryParameter(query: WebGLQuery, pname: number): unknown;
  getParameter(pname: number): unknown;
  isContextLost(): boolean;
}

export type GpuTimerCapabilityStatus =
  | 'available'
  | 'extension_unavailable'
  | 'context_lost'
  | 'api_error'
  | 'disposed';

export type GpuTimerDiscardReason = 'gpu_disjoint' | 'context_lost' | 'api_error';

export interface GpuTimerBoundary {
  readonly id: number;
  readonly label: string;
}

export type GpuTimerBeginResult =
  | { readonly started: true; readonly boundary: GpuTimerBoundary }
  | {
    readonly started: false;
    readonly reason:
      | Exclude<GpuTimerCapabilityStatus, 'available'>
      | 'query_active'
      | 'backpressure'
      | 'query_allocation_failed';
  };

export type GpuTimerEndResult =
  | { readonly ended: true }
  | {
    readonly ended: false;
    readonly reason: Exclude<GpuTimerCapabilityStatus, 'available'> | 'boundary_mismatch';
  };

export type GpuTimerSample =
  | {
    readonly id: number;
    readonly label: string;
    readonly status: 'ready';
    readonly elapsedNanoseconds: number;
    readonly elapsedMilliseconds: number;
  }
  | {
    readonly id: number;
    readonly label: string;
    readonly status: 'discarded';
    readonly reason: GpuTimerDiscardReason;
  };

export interface GpuTimerCapabilitySnapshot {
  readonly status: GpuTimerCapabilityStatus;
  readonly supported: boolean;
  readonly active: boolean;
  readonly pendingCount: number;
}

export interface GpuTimerPollResult extends GpuTimerCapabilitySnapshot {
  readonly samples: readonly GpuTimerSample[];
}

export interface GpuTimerQuerySamplerOptions {
  /** Bounds retained WebGLQuery objects if the caller stops polling. */
  readonly maxPendingQueries?: number;
}

export interface GpuTimerQuerySampler {
  capability(): GpuTimerCapabilitySnapshot;
  begin(label: string): GpuTimerBeginResult;
  end(boundary: GpuTimerBoundary): GpuTimerEndResult;
  /**
   * Non-blocking by contract: QUERY_RESULT is read only after
   * QUERY_RESULT_AVAILABLE reports true. This method schedules no RAF/timer.
   */
  poll(): GpuTimerPollResult;
  dispose(): void;
}

interface ActiveQuery {
  readonly boundary: GpuTimerBoundary;
  readonly query: WebGLQuery;
  invalidReason?: GpuTimerDiscardReason;
}

interface PendingQuery extends ActiveQuery {}

function isExtension(value: unknown): value is DisjointTimerQueryWebGl2Extension {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<DisjointTimerQueryWebGl2Extension>;
  return Number.isFinite(candidate.TIME_ELAPSED_EXT) && Number.isFinite(candidate.GPU_DISJOINT_EXT);
}

function boundedPendingQueries(value: number | undefined): number {
  if (!Number.isFinite(value)) return 8;
  return Math.max(1, Math.min(64, Math.floor(value!)));
}

class WebGl2GpuTimerQuerySampler implements GpuTimerQuerySampler {
  private readonly context: GpuTimerQueryContext;
  private readonly extension: DisjointTimerQueryWebGl2Extension | null;
  private readonly maxPendingQueries: number;
  private status: GpuTimerCapabilityStatus;
  private nextBoundaryId = 1;
  private active: ActiveQuery | null = null;
  private readonly pending: PendingQuery[] = [];
  private readonly terminalSamples: GpuTimerSample[] = [];

  constructor(context: GpuTimerQueryContext, options: GpuTimerQuerySamplerOptions) {
    this.context = context;
    this.maxPendingQueries = boundedPendingQueries(options.maxPendingQueries);

    try {
      if (context.isContextLost()) {
        this.extension = null;
        this.status = 'context_lost';
        return;
      }
      const extension = context.getExtension(DISJOINT_TIMER_QUERY_EXTENSION);
      this.extension = isExtension(extension) ? extension : null;
      this.status = this.extension ? 'available' : 'extension_unavailable';
    } catch {
      this.extension = null;
      this.status = 'api_error';
    }
  }

  capability(): GpuTimerCapabilitySnapshot {
    this.observeContextLoss();
    return this.snapshot();
  }

  begin(label: string): GpuTimerBeginResult {
    this.observeContextLoss();
    if (this.status !== 'available') {
      return { started: false, reason: this.status };
    }
    if (!this.extension) {
      this.fail('api_error');
      return { started: false, reason: 'api_error' };
    }
    if (this.active) return { started: false, reason: 'query_active' };
    if (this.pending.length >= this.maxPendingQueries) {
      return { started: false, reason: 'backpressure' };
    }

    let query: WebGLQuery | null = null;
    try {
      query = this.context.createQuery();
      if (!query) return { started: false, reason: 'query_allocation_failed' };
      const boundary = Object.freeze({ id: this.nextBoundaryId++, label });
      this.context.beginQuery(this.extension.TIME_ELAPSED_EXT, query);
      this.active = { boundary, query };
      return { started: true, boundary };
    } catch {
      this.safeDelete(query);
      this.fail('api_error');
      return { started: false, reason: 'api_error' };
    }
  }

  end(boundary: GpuTimerBoundary): GpuTimerEndResult {
    this.observeContextLoss();
    if (this.status !== 'available') {
      return { ended: false, reason: this.status };
    }
    if (!this.extension) {
      this.fail('api_error');
      return { ended: false, reason: 'api_error' };
    }
    if (!this.active || this.active.boundary !== boundary) {
      return { ended: false, reason: 'boundary_mismatch' };
    }

    const active = this.active;
    try {
      this.context.endQuery(this.extension.TIME_ELAPSED_EXT);
      this.active = null;
      this.pending.push(active);
      return { ended: true };
    } catch {
      this.active = null;
      this.safeDelete(active.query);
      this.fail('api_error');
      return { ended: false, reason: 'api_error' };
    }
  }

  poll(): GpuTimerPollResult {
    this.observeContextLoss();
    if (this.status !== 'available' || !this.extension) return this.pollSnapshot();

    let disjoint: boolean;
    try {
      disjoint = Boolean(this.context.getParameter(this.extension.GPU_DISJOINT_EXT));
    } catch {
      this.fail('api_error');
      return this.pollSnapshot();
    }

    if (disjoint) {
      if (this.active) this.active.invalidReason = 'gpu_disjoint';
      this.discardPending('gpu_disjoint');
      return this.pollSnapshot();
    }

    while (this.pending.length > 0) {
      const current = this.pending[0]!;
      if (current.invalidReason) {
        this.pending.shift();
        this.safeDelete(current.query);
        this.terminalSamples.push({
          id: current.boundary.id,
          label: current.boundary.label,
          status: 'discarded',
          reason: current.invalidReason,
        });
        continue;
      }

      let available: boolean;
      try {
        available = Boolean(
          this.context.getQueryParameter(current.query, this.context.QUERY_RESULT_AVAILABLE),
        );
      } catch {
        this.fail('api_error');
        return this.pollSnapshot();
      }
      // GPU commands are ordered. If the oldest result is pending, later
      // queries cannot be consumed yet, and reading QUERY_RESULT would stall.
      if (!available) break;

      let elapsedNanoseconds: number;
      try {
        elapsedNanoseconds = Number(
          this.context.getQueryParameter(current.query, this.context.QUERY_RESULT),
        );
      } catch {
        this.fail('api_error');
        return this.pollSnapshot();
      }

      this.pending.shift();
      this.safeDelete(current.query);
      if (!Number.isFinite(elapsedNanoseconds) || elapsedNanoseconds < 0) {
        this.terminalSamples.push({
          id: current.boundary.id,
          label: current.boundary.label,
          status: 'discarded',
          reason: 'api_error',
        });
        continue;
      }
      this.terminalSamples.push({
        id: current.boundary.id,
        label: current.boundary.label,
        status: 'ready',
        elapsedNanoseconds,
        elapsedMilliseconds: elapsedNanoseconds / 1_000_000,
      });
    }

    return this.pollSnapshot();
  }

  dispose(): void {
    if (this.status === 'disposed') return;
    const contextLost = this.contextIsLost();
    if (this.active && this.extension && !contextLost) {
      try {
        this.context.endQuery(this.extension.TIME_ELAPSED_EXT);
      } catch {
        // The sampler is being discarded; do not perturb the shared context.
      }
      this.safeDelete(this.active.query);
    }
    this.active = null;
    if (!contextLost) {
      for (const item of this.pending) this.safeDelete(item.query);
    }
    this.pending.length = 0;
    this.terminalSamples.length = 0;
    this.status = 'disposed';
  }

  private snapshot(): GpuTimerCapabilitySnapshot {
    return {
      status: this.status,
      supported: this.status === 'available',
      active: this.active !== null,
      pendingCount: this.pending.length,
    };
  }

  private pollSnapshot(): GpuTimerPollResult {
    const samples = this.terminalSamples.splice(0);
    return { ...this.snapshot(), samples };
  }

  private observeContextLoss(): void {
    if (this.status === 'disposed' || this.status === 'context_lost') return;
    if (this.contextIsLost()) this.fail('context_lost');
  }

  private contextIsLost(): boolean {
    try {
      return this.context.isContextLost();
    } catch {
      return true;
    }
  }

  private discardPending(reason: GpuTimerDiscardReason): void {
    for (const current of this.pending.splice(0)) {
      this.safeDelete(current.query);
      this.terminalSamples.push({
        id: current.boundary.id,
        label: current.boundary.label,
        status: 'discarded',
        reason,
      });
    }
  }

  private fail(reason: Extract<GpuTimerCapabilityStatus, 'context_lost' | 'api_error'>): void {
    if (this.status === 'disposed') return;
    const canDelete = reason !== 'context_lost';
    if (this.active) {
      if (canDelete && this.extension) {
        try {
          this.context.endQuery(this.extension.TIME_ELAPSED_EXT);
        } catch {
          // The API is already faulted; best-effort cleanup only.
        }
        this.safeDelete(this.active.query);
      }
      this.active = null;
    }
    for (const current of this.pending.splice(0)) {
      if (canDelete) this.safeDelete(current.query);
      this.terminalSamples.push({
        id: current.boundary.id,
        label: current.boundary.label,
        status: 'discarded',
        reason,
      });
    }
    this.status = reason;
  }

  private safeDelete(query: WebGLQuery | null): void {
    if (!query) return;
    try {
      this.context.deleteQuery(query);
    } catch {
      // Cleanup must never turn a valid result into a renderer failure.
    }
  }
}

/**
 * Creates a fail-closed sampler. A new sampler must be created after WebGL
 * context restoration because extension/query objects do not survive loss.
 */
export function createGpuTimerQuerySampler(
  context: GpuTimerQueryContext,
  options: GpuTimerQuerySamplerOptions = {},
): GpuTimerQuerySampler {
  return new WebGl2GpuTimerQuerySampler(context, options);
}
