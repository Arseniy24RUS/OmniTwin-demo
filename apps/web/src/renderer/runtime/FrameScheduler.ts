import type { RendererFrameContext } from './sceneContribution';

export type FrameInvalidationReason =
  | 'adapter'
  | 'camera'
  | 'data'
  | 'performance'
  | 'resize'
  | 'timeline'
  | 'visibility'
  | 'weather';

export interface FrameSchedulerSnapshot {
  visible: boolean;
  repaintPending: boolean;
  cadenceScheduled: boolean;
  targetFramesPerSecond: number;
  minimumFrameIntervalMs: number;
  continuousReasons: FrameInvalidationReason[];
  pendingReason?: FrameInvalidationReason;
}

export type FrameScheduleHandle = unknown;

export interface FrameSchedulerOptions {
  repaint: () => void;
  onFrame?: (frame: RendererFrameContext) => void;
  readPresentationState: (nowMs: number) => Pick<
    RendererFrameContext,
    'presentationMinutes' | 'absolutePresentationSeconds' | 'paused' |
    'baseRateSecondsPerWallSecond' | 'speedMultiplier' |
    'reducedMotion' | 'sceneTimeZone' | 'environment'
  >;
  maximumDeltaMs?: number;
  /** Maximum requested cadence. Browser display cadence may be lower. */
  targetFramesPerSecond?: number;
  /** Small lead lets MapLibre enqueue its RAF before the target presentation frame. */
  cadenceLeadMs?: number;
  schedule?: (callback: () => void, delayMs: number) => FrameScheduleHandle;
  cancelSchedule?: (handle: FrameScheduleHandle) => void;
}

function boundedTargetFramesPerSecond(value: number | undefined): number {
  if (!Number.isFinite(value)) return 60;
  return Math.max(1, Math.min(240, value!));
}

function defaultSchedule(callback: () => void, delayMs: number): FrameScheduleHandle {
  return globalThis.setTimeout(callback, delayMs);
}

function defaultCancelSchedule(handle: FrameScheduleHandle): void {
  globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
}

/**
 * MapLibre remains the source of rendered frames. This scheduler only
 * coalesces invalidations, publishes bounded deltas to optional scene
 * contributions and keeps the explicit benchmark/animation loop alive.
 */
export class FrameScheduler {
  private readonly repaint: () => void;
  private readonly onFrame?: (frame: RendererFrameContext) => void;
  private readonly readPresentationState: FrameSchedulerOptions['readPresentationState'];
  private readonly maximumDeltaMs: number;
  private readonly cadenceLeadMs: number;
  private readonly schedule: NonNullable<FrameSchedulerOptions['schedule']>;
  private readonly cancelSchedule: NonNullable<FrameSchedulerOptions['cancelSchedule']>;
  private targetFramesPerSecond: number;
  private minimumFrameIntervalMs: number;
  private previousFrameMs: number | null = null;
  private repaintRequested = false;
  private cadenceHandle: FrameScheduleHandle | null = null;
  private cadenceRevision = 0;
  private readonly continuousReasons = new Set<FrameInvalidationReason>();
  private pendingReason: FrameInvalidationReason | undefined;
  private visible = true;
  private disposed = false;

  constructor({
    repaint,
    onFrame,
    readPresentationState,
    maximumDeltaMs = 100,
    targetFramesPerSecond = 60,
    cadenceLeadMs = 2,
    schedule = defaultSchedule,
    cancelSchedule = defaultCancelSchedule,
  }: FrameSchedulerOptions) {
    this.repaint = repaint;
    this.onFrame = onFrame;
    this.readPresentationState = readPresentationState;
    this.maximumDeltaMs = Math.max(0, maximumDeltaMs);
    this.targetFramesPerSecond = boundedTargetFramesPerSecond(targetFramesPerSecond);
    this.minimumFrameIntervalMs = 1_000 / this.targetFramesPerSecond;
    this.cadenceLeadMs = Math.max(
      0,
      Number.isFinite(cadenceLeadMs) ? cadenceLeadMs : 2,
    );
    this.schedule = schedule;
    this.cancelSchedule = cancelSchedule;
  }

  setContinuous(continuous: boolean): void {
    this.setReasonActive('performance', continuous);
  }

  setReasonActive(reason: FrameInvalidationReason, active: boolean): void {
    if (this.disposed) return;
    const changed = active
      ? !this.continuousReasons.has(reason)
      : this.continuousReasons.has(reason);
    if (!changed) return;
    if (active) this.continuousReasons.add(reason);
    else this.continuousReasons.delete(reason);
    if (active) this.invalidate(reason);
    else if (this.continuousReasons.size === 0) this.cancelCadence();
  }

  /**
   * Changes the sole continuous repaint cadence without creating a second RAF
   * owner. Tier/motion governors should call this instead of scheduling their
   * own repaint loops.
   */
  setTargetFramesPerSecond(targetFramesPerSecond: number): void {
    if (this.disposed) return;
    const next = boundedTargetFramesPerSecond(targetFramesPerSecond);
    if (Math.abs(next - this.targetFramesPerSecond) < 0.001) return;
    this.targetFramesPerSecond = next;
    this.minimumFrameIntervalMs = 1_000 / next;
    this.cancelCadence();
    this.scheduleContinuousRepaint();
  }

  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    if (!visible) {
      this.cancelCadence();
      this.repaintRequested = false;
    }
    if (visible && this.continuousReasons.size > 0) this.invalidate('visibility');
  }

  invalidate(reason: FrameInvalidationReason = 'data'): void {
    if (this.disposed || !this.visible || this.repaintRequested) return;
    this.cancelCadence();
    this.requestRepaint(reason);
  }

  private requestRepaint(reason: FrameInvalidationReason): void {
    this.repaintRequested = true;
    this.pendingReason = reason;
    this.repaint();
  }

  recordRender(nowMs: number): void {
    if (this.disposed) return;
    this.cancelCadence();
    this.repaintRequested = false;
    const rawDelta = this.previousFrameMs === null ? 0 : Math.max(0, nowMs - this.previousFrameMs);
    const deltaMs = Math.min(this.maximumDeltaMs, rawDelta);
    this.previousFrameMs = nowMs;
    this.onFrame?.({ nowMs, deltaMs, ...this.readPresentationState(nowMs) });
    this.scheduleContinuousRepaint();
  }

  snapshot(): FrameSchedulerSnapshot {
    return {
      visible: this.visible,
      repaintPending: this.repaintRequested,
      cadenceScheduled: this.cadenceHandle !== null,
      targetFramesPerSecond: this.targetFramesPerSecond,
      minimumFrameIntervalMs: this.minimumFrameIntervalMs,
      continuousReasons: [...this.continuousReasons].sort(),
      ...(this.pendingReason ? { pendingReason: this.pendingReason } : {}),
    };
  }

  dispose(): void {
    this.disposed = true;
    this.cancelCadence();
    this.continuousReasons.clear();
    this.repaintRequested = false;
    this.pendingReason = undefined;
    this.previousFrameMs = null;
  }

  private scheduleContinuousRepaint(): void {
    if (
      this.disposed
      || !this.visible
      || this.repaintRequested
      || this.cadenceHandle !== null
      || this.continuousReasons.size === 0
    ) return;
    const revision = ++this.cadenceRevision;
    const delayMs = Math.max(0, this.minimumFrameIntervalMs - this.cadenceLeadMs);
    this.cadenceHandle = this.schedule(() => {
      if (this.disposed || revision !== this.cadenceRevision) return;
      this.cadenceHandle = null;
      if (!this.visible || this.continuousReasons.size === 0 || this.repaintRequested) return;
      this.requestRepaint(this.continuousReasons.values().next().value ?? 'data');
    }, delayMs);
  }

  private cancelCadence(): void {
    this.cadenceRevision += 1;
    if (this.cadenceHandle === null) return;
    this.cancelSchedule(this.cadenceHandle);
    this.cadenceHandle = null;
  }
}
