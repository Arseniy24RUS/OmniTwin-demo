import type { RendererAdapter, WorldLayer } from '../types';
import type {
  LivingActivityQaSnapshot,
  LivingAdapterReconciliation,
  LivingQaSnapshot,
} from '../living/types';
import type { LivingWorkerControllerTelemetry } from '../workers/livingSimulationController';
import type { MapStyleOwnershipSnapshot } from '../mapStyleController';
import type { SceneStreamerSnapshot } from '../sceneStreamer';
import type { CameraTelemetryState } from './InteractionController';
import type { MapGpuFrameTimerSnapshot } from './mapGpuFrameTimer';
import type {
  RendererPerformanceDecisionKind,
  RendererPerformanceGovernorSnapshot,
} from './performanceGovernor';
import type { RuntimeMovementTelemetry } from './sceneMovementBinding';
import type { SceneAssetCacheSnapshot } from './sceneAssetCache';
import { MIXED_SOURCE_APPEARANCE_LABEL_RU } from './sceneContribution';

export interface ContributionState {
  count: number;
  ready: number;
  cameraOccluded: boolean | null;
}

export interface SceneIdentityTelemetry {
  sceneId: string;
  sceneVersion: string;
  manifestSha256: string;
  manifestVerified: boolean;
}

export interface LivingLifecycleTelemetry {
  partitionReplacements: number;
  workerGeneration: number;
  requestedSeekRevision: number;
  appliedSeekRevision: number;
}

export interface MapProviderTelemetry {
  requested: 'openfreemap' | 'pmtiles' | 'scene_only';
  status: 'checking' | 'ready' | 'unavailable';
}

export type RendererPerformanceGovernorStatus =
  | 'disabled'
  | 'waiting_gpu_sample'
  | 'active'
  | 'unsupported_fallback'
  | 'timer_stalled_fallback';

export interface RendererPerformanceGovernorTelemetry {
  readonly status: RendererPerformanceGovernorStatus;
  readonly snapshot: RendererPerformanceGovernorSnapshot | null;
  readonly lastDecision: RendererPerformanceDecisionKind | null;
  readonly cpuInput: 'renderer_submission_wall_median' | 'render_interval_p95' | 'none';
  readonly gpuInput: 'disjoint_timer_query_median' | 'none';
}

export interface UniversalDecorationTelemetry {
  materialAtlasVersion: string;
  materialAtlasReady: boolean;
  decorationTier: 'low' | 'mid' | 'high';
  shadowMode: 'contact_ao' | 'contact_ao_projected_flat';
  waterMode: 'static_directional_gloss';
  vegetationMode: 'forest_fill' | 'canopy_only' | 'canopy_billboards';
  vegetationCount: number;
  vegetationOverlayReady: boolean;
  presentationHeightClampPolicy: 'zoom_lod_180_to_500m';
  presentationHeightClampCount: number;
}

export interface TelemetryBusOptions {
  root: HTMLElement;
  getAdapters: () => readonly RendererAdapter[];
  intervalMs?: number;
}

export type RendererActivityMode = 'continuous' | 'event_driven';
export type PerformancePhaseMetadataValue = string | number | boolean | null;
export type PerformancePhaseMetadata = Readonly<
  Record<string, PerformancePhaseMetadataValue>
>;

export interface PerformanceMeasurementEpochOptions {
  readonly targetFramesPerSecond?: number;
  readonly phaseMetadata?: PerformancePhaseMetadata;
}

export interface PerformanceMeasurementEpochSnapshot {
  readonly name: string;
  readonly status: 'active' | 'complete';
  readonly startedAtMs: number;
  readonly stoppedAtMs: number | null;
  readonly durationMs: number;
  readonly frameCount: number;
  readonly frameIntervalCount: number;
  readonly fps: number | null;
  readonly p50FrameMs: number | null;
  readonly p95FrameMs: number | null;
  readonly p99FrameMs: number | null;
  readonly onePercentLowFps: number | null;
  readonly longestBelowTargetDurationMs: number;
  readonly targetFramesPerSecond: number;
  readonly frameTimestampsMs: readonly number[];
  readonly frameDeltasMs: readonly number[];
  readonly truncated: boolean;
  readonly phaseMetadata: PerformancePhaseMetadata;
  readonly gpuFrameTimingStart: MapGpuFrameTimerSnapshot | null;
  readonly gpuFrameTimingEnd: MapGpuFrameTimerSnapshot | null;
}

interface MutablePerformanceMeasurementEpoch {
  readonly name: string;
  readonly startedAtMs: number;
  readonly targetFramesPerSecond: number;
  readonly phaseMetadata: PerformancePhaseMetadata;
  readonly gpuFrameTimingStart: MapGpuFrameTimerSnapshot | null;
  readonly frameTimestampsMs: number[];
  readonly frameDeltasMs: number[];
  truncated: boolean;
}

const EMPTY_STREAMER: SceneStreamerSnapshot = {
  currentCell: null,
  desiredCells: 0,
  activeCells: 0,
  loadedCells: 0,
  pendingCells: 0,
  failedCells: 0,
  budgetCells: 0,
  loadedBytes: 0,
  memoryBudgetBytes: null,
  cachePolicy: 'auto',
  deviceTier: null,
  evictedCells: 0,
  rejectedCells: 0,
  budgetDisposition: 'not-configured',
  revision: 0,
  cameraMotion: 'idle',
  individualCellsEnabled: false,
};

const EMPTY_CONTRIBUTIONS: ContributionState = {
  count: 0,
  ready: 0,
  cameraOccluded: null,
};

const FRAME_TIME_WINDOW = 240;
const MAX_MEASUREMENT_EPOCH_FRAMES = 36_000;

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * quantile) - 1,
  ));
  return sorted[index] ?? 0;
}

/** Keeps hot counters off the DOM and publishes a stable QA surface at 1Hz. */
export class TelemetryBus {
  private readonly root: HTMLElement;
  private readonly fpsOutput: HTMLOutputElement | null;
  private readonly environmentOutput: HTMLOutputElement | null;
  private readonly getAdapters: () => readonly RendererAdapter[];
  private readonly intervalMs: number;
  private renderedFrames = 0;
  private sampleFrameCount = 0;
  private sampleFirstRenderMs: number | null = null;
  private sampleLastRenderMs: number | null = null;
  private lastRenderMs: number | null = null;
  private readonly frameTimes = new Float32Array(FRAME_TIME_WINDOW);
  private frameTimeCount = 0;
  private frameTimeWriteIndex = 0;
  private lastFlushMs: number | null = null;
  private renderFps = 'waiting-for-map-render';
  private renderActivity: RendererActivityMode = 'continuous';
  private activeMeasurementEpoch: MutablePerformanceMeasurementEpoch | null = null;
  private lastMeasurementEpoch: PerformanceMeasurementEpochSnapshot | null = null;
  private camera: CameraTelemetryState | null = null;
  private projectedEntities = 0;
  private selectedEntityProjected = false;
  private streamer: SceneStreamerSnapshot = EMPTY_STREAMER;
  private contributions: ContributionState = EMPTY_CONTRIBUTIONS;
  private living: LivingQaSnapshot | null = null;
  private livingReconciliation: LivingAdapterReconciliation | null = null;
  private livingWorker: LivingWorkerControllerTelemetry | null = null;
  private livingWorkerFatalError: string | null = null;
  private scenePlanConflicts = 0;
  private assetCache: SceneAssetCacheSnapshot | null = null;
  private mapProvider: MapProviderTelemetry = { requested: 'openfreemap', status: 'checking' };
  private universalDecoration: UniversalDecorationTelemetry | null = null;
  private mapGpuFrameTiming: MapGpuFrameTimerSnapshot | null = null;
  private rendererPerformanceGovernor: RendererPerformanceGovernorTelemetry = {
    status: 'disabled',
    snapshot: null,
    lastDecision: null,
    cpuInput: 'none',
    gpuInput: 'none',
  };
  private activeLayers: ReadonlySet<WorldLayer> = new Set();
  private movement: RuntimeMovementTelemetry = {
    status: 'unavailable',
    routedEntities: 0,
    unboundEntities: 0,
    violations: 0,
    reason: 'movement_payload_unavailable',
  };
  private sceneIdentity: SceneIdentityTelemetry | null = null;
  private livingLifecycle: LivingLifecycleTelemetry = {
    partitionReplacements: 0,
    workerGeneration: 0,
    requestedSeekRevision: 0,
    appliedSeekRevision: 0,
  };
  private mapStyleOwnership: MapStyleOwnershipSnapshot = {
    requestedDetailedBuildingOwner: 'maplibre',
    detailedBuildingOwner: 'maplibre',
    mapLibreBuildingExtrusionsMasked: false,
    ownershipMaskScope: 'none',
    ownershipConflict: false,
  };
  private flushRevision = 0;
  private flushTimer: number | null = null;
  private dirty = false;
  private disposed = false;

  constructor({ root, getAdapters, intervalMs = 1_000 }: TelemetryBusOptions) {
    this.root = root;
    this.getAdapters = getAdapters;
    this.intervalMs = Math.max(1, intervalMs);
    this.fpsOutput = root.querySelector<HTMLOutputElement>('[data-testid="renderer-fps"]');
    this.environmentOutput = root.querySelector<HTMLOutputElement>(
      '[data-testid="environment-binding-status"]',
    );
  }

  initialize(): void {
    if (this.disposed) return;
    this.root.dataset.renderFps = this.renderFps;
    this.root.dataset.renderActivity = this.renderActivity;
    this.root.dataset.renderedFrames = '0';
    this.writeFrameTimeTelemetry();
    this.root.dataset.cameraSettled = 'false';
    this.root.dataset.projectedEntities = '0';
    this.root.dataset.selectedEntityProjected = 'false';
    this.writeAdapterTelemetry();
    this.writeStreamerTelemetry();
    this.writeContributionTelemetry();
    this.writeLivingTelemetry();
    this.writeLivingReconciliation();
    this.writeLivingWorker();
    this.writeMovementTelemetry();
    this.writeSceneIdentity();
    this.writeLivingLifecycle();
    this.writeMapStyleOwnership();
    this.writeAssetCacheTelemetry();
    this.writeMapProviderTelemetry();
    this.writeUniversalDecorationTelemetry();
    this.writeMapGpuFrameTiming();
    this.writeRendererPerformanceGovernor();
    this.writeMeasurementEpochTelemetry();
    this.writeActiveLayers();
    this.root.dataset.telemetryFlushRevision = '0';
  }

  recordRender(nowMs: number): void {
    if (this.disposed || !Number.isFinite(nowMs) || nowMs < 0) return;
    this.recordMeasurementEpochFrame(nowMs);
    this.renderedFrames += 1;
    if (this.renderActivity === 'event_driven') {
      this.lastRenderMs = null;
      return;
    }
    if (this.lastRenderMs !== null && nowMs > this.lastRenderMs) {
      const deltaMs = nowMs - this.lastRenderMs;
      if (Number.isFinite(deltaMs) && deltaMs > 0 && deltaMs <= 1_000) {
        this.frameTimes[this.frameTimeWriteIndex] = deltaMs;
        this.frameTimeWriteIndex = (this.frameTimeWriteIndex + 1) % FRAME_TIME_WINDOW;
        this.frameTimeCount = Math.min(FRAME_TIME_WINDOW, this.frameTimeCount + 1);
      }
    }
    this.lastRenderMs = nowMs;
    if (this.sampleFirstRenderMs === null) this.sampleFirstRenderMs = nowMs;
    this.sampleLastRenderMs = nowMs;
    this.sampleFrameCount += 1;
    const elapsed = nowMs - this.sampleFirstRenderMs;
    if (elapsed < this.intervalMs) return;
    this.publishCurrentFpsEpoch();
    // Retain the boundary frame as the first frame of the next epoch. This
    // avoids dropping one interval at every telemetry flush.
    this.sampleFrameCount = 1;
    this.sampleFirstRenderMs = nowMs;
    this.sampleLastRenderMs = nowMs;
    this.flush(nowMs, true);
  }

  setRenderActivity(activity: RendererActivityMode, nowMs = performance.now()): void {
    if (this.disposed || this.renderActivity === activity) return;
    this.renderActivity = activity;
    this.resetFpsEpoch();
    this.frameTimeCount = 0;
    this.frameTimeWriteIndex = 0;
    this.renderFps = activity === 'event_driven'
      ? 'event-driven'
      : 'waiting-for-map-render';
    this.flush(nowMs, true);
  }

  startMeasurementEpoch(
    name: string,
    nowMs = performance.now(),
    options: PerformanceMeasurementEpochOptions = {},
  ): PerformanceMeasurementEpochSnapshot {
    if (this.disposed) throw new Error('TelemetryBus is disposed');
    const normalizedName = name.trim();
    if (!normalizedName) throw new RangeError('Measurement epoch name must not be empty');
    if (!Number.isFinite(nowMs) || nowMs < 0) {
      throw new RangeError('Measurement epoch start time must be finite and non-negative');
    }
    if (this.activeMeasurementEpoch) {
      throw new Error(`Measurement epoch ${this.activeMeasurementEpoch.name} is already active`);
    }
    const targetFramesPerSecond = Math.max(
      1,
      Math.min(
        240,
        Number.isFinite(options.targetFramesPerSecond)
          ? options.targetFramesPerSecond!
          : 30,
      ),
    );
    this.activeMeasurementEpoch = {
      name: normalizedName,
      startedAtMs: nowMs,
      targetFramesPerSecond,
      phaseMetadata: Object.freeze({ ...(options.phaseMetadata ?? {}) }),
      gpuFrameTimingStart: this.mapGpuFrameTiming,
      frameTimestampsMs: [],
      frameDeltasMs: [],
      truncated: false,
    };
    this.lastMeasurementEpoch = null;
    const snapshot = this.buildMeasurementEpochSnapshot(this.activeMeasurementEpoch, null);
    this.flush(nowMs, true);
    return snapshot;
  }

  stopMeasurementEpoch(nowMs = performance.now()): PerformanceMeasurementEpochSnapshot | null {
    const epoch = this.activeMeasurementEpoch;
    if (!epoch || this.disposed) return null;
    if (!Number.isFinite(nowMs) || nowMs < epoch.startedAtMs) {
      throw new RangeError('Measurement epoch stop time must be finite and monotonic');
    }
    const stopped = this.buildMeasurementEpochSnapshot(epoch, nowMs);
    this.activeMeasurementEpoch = null;
    this.lastMeasurementEpoch = stopped;
    this.flush(nowMs, true);
    return stopped;
  }

  measurementEpochSnapshot(): PerformanceMeasurementEpochSnapshot | null {
    if (this.activeMeasurementEpoch) {
      const lastFrame = this.activeMeasurementEpoch.frameTimestampsMs.at(-1)
        ?? this.activeMeasurementEpoch.startedAtMs;
      return this.buildMeasurementEpochSnapshot(this.activeMeasurementEpoch, null, lastFrame);
    }
    return this.lastMeasurementEpoch;
  }

  setCamera(camera: CameraTelemetryState): void {
    this.camera = camera;
    this.scheduleFlush();
  }

  setProjectedEntities(projectedEntities: number): void {
    this.projectedEntities = Math.max(0, Math.floor(projectedEntities));
    this.scheduleFlush();
  }

  setSelectedEntityProjected(projected: boolean): void {
    this.selectedEntityProjected = projected;
    this.scheduleFlush();
  }

  setStreamer(streamer: SceneStreamerSnapshot): void {
    this.streamer = streamer;
    this.scheduleFlush();
  }

  setContributionState(contributions: ContributionState): void {
    this.contributions = {
      count: Math.max(0, Math.floor(contributions.count)),
      ready: Math.max(0, Math.floor(contributions.ready)),
      cameraOccluded: contributions.cameraOccluded,
    };
    this.scheduleFlush();
  }

  notifyAdaptersChanged(): void {
    this.scheduleFlush();
  }

  setLiving(living: LivingQaSnapshot | null): void {
    this.living = living;
    this.scheduleFlush();
  }

  setLivingReconciliation(reconciliation: LivingAdapterReconciliation | null): void {
    this.livingReconciliation = reconciliation;
    this.scheduleFlush();
  }

  setLivingWorker(
    worker: LivingWorkerControllerTelemetry | null,
    fatalError: string | null = null,
  ): void {
    this.livingWorker = worker;
    this.livingWorkerFatalError = fatalError;
    this.scheduleFlush();
  }

  setMapStyleOwnership(ownership: MapStyleOwnershipSnapshot): void {
    this.mapStyleOwnership = ownership;
    this.scheduleFlush();
  }

  setScenePlanConflicts(conflicts: number): void {
    this.scenePlanConflicts = Math.max(0, Math.floor(conflicts));
    this.scheduleFlush();
  }

  setAssetCache(snapshot: SceneAssetCacheSnapshot): void {
    this.assetCache = snapshot;
    this.scheduleFlush();
  }

  setMapProvider(provider: MapProviderTelemetry): void {
    this.mapProvider = provider;
    this.scheduleFlush();
  }

  setUniversalDecoration(decoration: UniversalDecorationTelemetry): void {
    this.universalDecoration = {
      ...decoration,
      vegetationCount: Math.max(0, Math.floor(decoration.vegetationCount)),
      presentationHeightClampCount: Math.max(
        0,
        Math.floor(decoration.presentationHeightClampCount),
      ),
    };
    this.scheduleFlush();
  }

  setMapGpuFrameTiming(timing: MapGpuFrameTimerSnapshot | null): void {
    this.mapGpuFrameTiming = timing;
    this.scheduleFlush();
  }

  setRendererPerformanceGovernor(governor: RendererPerformanceGovernorTelemetry): void {
    this.rendererPerformanceGovernor = governor;
    this.scheduleFlush();
  }

  setActiveLayers(activeLayers: ReadonlySet<WorldLayer>): void {
    this.activeLayers = new Set(activeLayers);
    this.scheduleFlush();
  }

  setMovement(movement: RuntimeMovementTelemetry): void {
    this.movement = movement;
    this.scheduleFlush();
  }

  setSceneIdentity(sceneIdentity: SceneIdentityTelemetry | null): void {
    this.sceneIdentity = sceneIdentity;
    this.scheduleFlush();
  }

  setLivingLifecycle(lifecycle: LivingLifecycleTelemetry): void {
    this.livingLifecycle = lifecycle;
    this.scheduleFlush();
  }

  markFallback(nowMs = performance.now()): void {
    if (this.disposed) return;
    this.renderFps = 'not-applicable';
    this.renderedFrames = 0;
    this.resetFpsEpoch();
    this.frameTimeCount = 0;
    this.frameTimeWriteIndex = 0;
    this.flush(nowMs, true);
  }

  /**
   * A forced flush is reserved for lifecycle/readiness transitions. Regular
   * calls never mutate the telemetry DOM more frequently than the interval.
   */
  flush(nowMs = performance.now(), force = false): void {
    if (this.disposed) return;
    if (!force && this.lastFlushMs !== null && nowMs - this.lastFlushMs < this.intervalMs) {
      this.scheduleFlush(nowMs);
      return;
    }
    if (this.flushTimer !== null) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (force && this.renderActivity === 'continuous' && this.sampleFrameCount >= 2) {
      this.publishCurrentFpsEpoch();
    }
    this.root.dataset.renderFps = this.renderFps;
    this.root.dataset.renderActivity = this.renderActivity;
    this.root.dataset.renderedFrames = String(this.renderedFrames);
    this.writeFrameTimeTelemetry();
    this.root.dataset.projectedEntities = String(this.projectedEntities);
    this.root.dataset.selectedEntityProjected = String(this.selectedEntityProjected);
    if (this.fpsOutput) {
      this.fpsOutput.textContent = this.renderFps === 'not-applicable'
        ? 'FPS —'
        : this.renderFps === 'event-driven'
          ? 'FPS — · event-driven'
        : this.renderFps === 'waiting-for-map-render'
          ? 'FPS …'
          : `FPS ${this.renderFps}`;
    }
    this.writeCameraTelemetry();
    this.writeAdapterTelemetry();
    this.writeStreamerTelemetry();
    this.writeContributionTelemetry();
    this.writeLivingTelemetry();
    this.writeLivingReconciliation();
    this.writeLivingWorker();
    this.writeMovementTelemetry();
    this.writeSceneIdentity();
    this.writeLivingLifecycle();
    this.writeMapStyleOwnership();
    this.writeAssetCacheTelemetry();
    this.writeMapProviderTelemetry();
    this.writeUniversalDecorationTelemetry();
    this.writeMapGpuFrameTiming();
    this.writeRendererPerformanceGovernor();
    this.writeMeasurementEpochTelemetry();
    this.writeActiveLayers();
    this.flushRevision += 1;
    this.root.dataset.telemetryFlushRevision = String(this.flushRevision);
    this.root.dataset.telemetryFlushedAtMs = Math.max(0, nowMs).toFixed(0);
    this.lastFlushMs = nowMs;
    this.dirty = false;
  }

  dispose(): void {
    this.disposed = true;
    if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private publishCurrentFpsEpoch(): void {
    const first = this.sampleFirstRenderMs;
    const last = this.sampleLastRenderMs;
    if (first === null || last === null || this.sampleFrameCount < 2 || last <= first) return;
    this.renderFps = (
      ((this.sampleFrameCount - 1) * 1_000) /
      (last - first)
    ).toFixed(1);
  }

  private resetFpsEpoch(): void {
    this.sampleFrameCount = 0;
    this.sampleFirstRenderMs = null;
    this.sampleLastRenderMs = null;
    this.lastRenderMs = null;
  }

  private recordMeasurementEpochFrame(nowMs: number): void {
    const epoch = this.activeMeasurementEpoch;
    if (!epoch || nowMs < epoch.startedAtMs) return;
    const previous = epoch.frameTimestampsMs.at(-1);
    if (previous !== undefined && nowMs <= previous) return;
    if (epoch.frameTimestampsMs.length >= MAX_MEASUREMENT_EPOCH_FRAMES) {
      epoch.truncated = true;
      return;
    }
    epoch.frameTimestampsMs.push(nowMs);
    if (previous !== undefined) epoch.frameDeltasMs.push(nowMs - previous);
  }

  private buildMeasurementEpochSnapshot(
    epoch: MutablePerformanceMeasurementEpoch,
    stoppedAtMs: number | null,
    activeAtMs = stoppedAtMs ?? epoch.startedAtMs,
  ): PerformanceMeasurementEpochSnapshot {
    const timestamps = [...epoch.frameTimestampsMs];
    const deltas = [...epoch.frameDeltasMs];
    const sorted = [...deltas].sort((left, right) => left - right);
    const firstFrame = timestamps.at(0);
    const lastFrame = timestamps.at(-1);
    const fps = firstFrame !== undefined && lastFrame !== undefined && lastFrame > firstFrame
      ? ((timestamps.length - 1) * 1_000) / (lastFrame - firstFrame)
      : null;
    const p50FrameMs = sorted.length > 0 ? percentile(sorted, 0.5) : null;
    const p95FrameMs = sorted.length > 0 ? percentile(sorted, 0.95) : null;
    const p99FrameMs = sorted.length > 0 ? percentile(sorted, 0.99) : null;
    const budgetMs = 1_000 / epoch.targetFramesPerSecond;
    let currentBelowTargetDurationMs = 0;
    let longestBelowTargetDurationMs = 0;
    for (const deltaMs of deltas) {
      if (deltaMs > budgetMs) {
        currentBelowTargetDurationMs += deltaMs;
        longestBelowTargetDurationMs = Math.max(
          longestBelowTargetDurationMs,
          currentBelowTargetDurationMs,
        );
      } else {
        currentBelowTargetDurationMs = 0;
      }
    }
    const effectiveStop = stoppedAtMs ?? Math.max(epoch.startedAtMs, activeAtMs);
    return Object.freeze({
      name: epoch.name,
      status: stoppedAtMs === null ? 'active' : 'complete',
      startedAtMs: epoch.startedAtMs,
      stoppedAtMs,
      durationMs: Math.max(0, effectiveStop - epoch.startedAtMs),
      frameCount: timestamps.length,
      frameIntervalCount: deltas.length,
      fps,
      p50FrameMs,
      p95FrameMs,
      p99FrameMs,
      onePercentLowFps: p99FrameMs === null ? null : 1_000 / Math.max(0.001, p99FrameMs),
      longestBelowTargetDurationMs,
      targetFramesPerSecond: epoch.targetFramesPerSecond,
      frameTimestampsMs: Object.freeze(timestamps),
      frameDeltasMs: Object.freeze(deltas),
      truncated: epoch.truncated,
      phaseMetadata: epoch.phaseMetadata,
      gpuFrameTimingStart: epoch.gpuFrameTimingStart,
      gpuFrameTimingEnd: stoppedAtMs === null ? null : this.mapGpuFrameTiming,
    });
  }

  private writeMeasurementEpochTelemetry(): void {
    const epoch = this.measurementEpochSnapshot();
    this.root.dataset.performanceEpochName = epoch?.name ?? 'none';
    this.root.dataset.performanceEpochStatus = epoch?.status ?? 'none';
    this.root.dataset.performanceEpochFrames = String(epoch?.frameCount ?? 0);
    this.root.dataset.performanceEpochFps = epoch?.fps === null || epoch === null
      ? 'waiting'
      : epoch.fps.toFixed(3);
    this.root.dataset.performanceEpochP95Ms = epoch?.p95FrameMs === null || epoch === null
      ? 'waiting'
      : epoch.p95FrameMs.toFixed(3);
    this.root.dataset.performanceEpochP99Ms = epoch?.p99FrameMs === null || epoch === null
      ? 'waiting'
      : epoch.p99FrameMs.toFixed(3);
    this.root.dataset.performanceEpochLongestBelowTargetMs = String(
      epoch?.longestBelowTargetDurationMs ?? 0,
    );
    this.root.dataset.performanceEpochTargetFps = String(epoch?.targetFramesPerSecond ?? 0);
    this.root.dataset.performanceEpochTruncated = String(epoch?.truncated ?? false);
  }

  private writeCameraTelemetry(): void {
    if (!this.camera) return;
    const { current, target, settled } = this.camera;
    this.root.dataset.cameraLongitude = current.longitude.toFixed(6);
    this.root.dataset.cameraLatitude = current.latitude.toFixed(6);
    this.root.dataset.cameraZoom = current.zoom.toFixed(3);
    this.root.dataset.targetCameraLongitude = target.longitude.toFixed(6);
    this.root.dataset.targetCameraLatitude = target.latitude.toFixed(6);
    this.root.dataset.targetCameraZoom = target.zoom.toFixed(3);
    this.root.dataset.cameraSettled = String(settled);
  }

  private writeFrameTimeTelemetry(): void {
    const count = this.frameTimeCount;
    this.root.dataset.frameTimeSamples = String(count);
    if (count === 0) {
      this.root.dataset.frameTimeMedianMs = 'waiting';
      this.root.dataset.frameTimeP95Ms = 'waiting';
      this.root.dataset.frameTimeP99Ms = 'waiting';
      this.root.dataset.frameTimeOnePercentLowFps = 'waiting';
      return;
    }
    const samples = Array.from(this.frameTimes.subarray(0, count)).sort((a, b) => a - b);
    const medianMs = percentile(samples, 0.5);
    const p95Ms = percentile(samples, 0.95);
    const p99Ms = percentile(samples, 0.99);
    this.root.dataset.frameTimeMedianMs = medianMs.toFixed(2);
    this.root.dataset.frameTimeP95Ms = p95Ms.toFixed(2);
    this.root.dataset.frameTimeP99Ms = p99Ms.toFixed(2);
    this.root.dataset.frameTimeOnePercentLowFps = (1_000 / Math.max(0.001, p99Ms)).toFixed(1);
  }

  private writeAdapterTelemetry(): void {
    const adapters = this.getAdapters();
    const samples = adapters.map((adapter) => ({ adapter, telemetry: adapter.telemetry() }));
    const deck = samples.find(({ adapter }) => adapter.kind === 'deck')?.telemetry;
    const three = samples.find(({ adapter }) => adapter.kind === 'three')?.telemetry;
    this.root.dataset.deckPedestrians = String(deck?.pedestrians ?? 0);
    this.root.dataset.deckVehicles = String(deck?.vehicles ?? 0);
    this.root.dataset.deckEntities = String((deck?.pedestrians ?? 0) + (deck?.vehicles ?? 0));
    this.root.dataset.demoActorPickCandidates = JSON.stringify(deck?.presentationPickCandidates ?? []);
    this.root.dataset.deckRenderedFrames = String(deck?.renderedFrames ?? 0);
    this.root.dataset.deckUpdates = String(deck?.updates ?? 0);
    this.root.dataset.deckLivingBufferAllocations = String(
      deck?.livingBufferAllocations ?? 0,
    );
    this.root.dataset.deckLivingPlanned = String(deck?.livingSubmission?.planned ?? 0);
    this.root.dataset.deckLivingEligible = String(deck?.livingSubmission?.eligible ?? 0);
    this.root.dataset.deckLivingSubmitted = String(deck?.livingSubmission?.submitted ?? 0);
    this.root.dataset.deckLivingCameraCulled = String(
      deck?.livingSubmission?.cameraCulled ?? 0,
    );
    this.root.dataset.deckLivingBudgetCulled = String(
      deck?.livingSubmission?.budgetCulled ?? 0,
    );
    this.root.dataset.deckLivingActiveCellCount = deck?.livingSubmission?.activeCellCount === null
      || deck?.livingSubmission?.activeCellCount === undefined
      ? 'unbounded'
      : String(deck.livingSubmission.activeCellCount);
    this.root.dataset.deckLivingActiveCellKey = deck?.livingSubmission?.activeCellKey ?? 'none';
    this.root.dataset.deckLivingCellOverflow = String(
      deck?.livingSubmission?.cellEnumerationOverflowed ?? false,
    );
    this.root.dataset.deckPickCandidateId = deck?.pickCandidate?.id ?? 'none';
    this.root.dataset.deckPickCandidateKind = deck?.pickCandidate?.kind ?? 'none';
    this.root.dataset.deckPickCandidateLayerId = deck?.pickCandidate?.layerId ?? 'none';
    this.root.dataset.deckPickCandidateRepresentation = deck?.pickCandidate?.representation ?? 'none';
    this.root.dataset.deckPickCandidateProfileEligible = String(
      deck?.pickCandidate?.profileEligible ?? false,
    );
    this.root.dataset.deckPickCandidateOnCanvas = String(deck?.pickCandidate?.onCanvas ?? false);
    this.root.dataset.deckPickCandidateX = deck?.pickCandidate
      ? deck.pickCandidate.x.toFixed(1)
      : 'none';
    this.root.dataset.deckPickCandidateY = deck?.pickCandidate
      ? deck.pickCandidate.y.toFixed(1)
      : 'none';
    this.root.dataset.deckClickPickAttempts = String(deck?.clickPicking?.attempts ?? 0);
    this.root.dataset.deckClickPickHits = String(deck?.clickPicking?.hits ?? 0);
    this.root.dataset.deckClickPickMisses = String(deck?.clickPicking?.misses ?? 0);
    this.root.dataset.deckClickPickErrors = String(deck?.clickPicking?.errors ?? 0);
    this.root.dataset.deckClickPickConsumed = String(deck?.clickPicking?.consumed ?? 0);
    this.root.dataset.deckClickPickStatus = deck?.clickPicking?.lastStatus ?? 'idle';
    this.root.dataset.deckClickPickLogicalId = deck?.clickPicking?.lastLogicalId ?? 'none';
    this.root.dataset.deckClickPickLayerId = deck?.clickPicking?.lastLayerId ?? 'none';
    this.root.dataset.deckClickPickError = deck?.clickPicking?.lastError ?? 'none';
    this.root.dataset.deckClickPickX = deck?.clickPicking?.lastX === null
      || deck?.clickPicking?.lastX === undefined
      ? 'none'
      : deck.clickPicking.lastX.toFixed(1);
    this.root.dataset.deckClickPickY = deck?.clickPicking?.lastY === null
      || deck?.clickPicking?.lastY === undefined
      ? 'none'
      : deck.clickPicking.lastY.toFixed(1);
    this.root.dataset.threePedestrians = String(three?.pedestrians ?? 0);
    this.root.dataset.threeVehicles = String(three?.vehicles ?? 0);
    this.root.dataset.threeInstances = String((three?.pedestrians ?? 0) + (three?.vehicles ?? 0));
    this.root.dataset.threeRenderedFrames = String(three?.renderedFrames ?? 0);
    this.root.dataset.threeUpdates = String(three?.updates ?? 0);
    this.root.dataset.threeRebuilds = String(three?.rebuilds ?? 0);
    this.root.dataset.threeActorPoseAllocations = String(
      three?.actorPoseAllocations ?? 0,
    );
    this.root.dataset.threeActorPeopleCapacity = String(
      three?.actorPoseCapacity?.people ?? 0,
    );
    this.root.dataset.threeActorVehicleCapacity = String(
      three?.actorPoseCapacity?.vehicles ?? 0,
    );

    const contributionTelemetry = samples.flatMap(
      ({ telemetry }) => telemetry.contributions ?? [],
    );
    const sceneVisual = contributionTelemetry.find(
      (item) => item.sceneGeometryStatus !== undefined
        || item.sceneAppearanceStatus !== undefined
        || item.sceneMovementProvenance !== undefined,
    );
    this.root.dataset.sceneGeometryStatus = sceneVisual?.sceneGeometryStatus
      ?? 'SCENE_GEOMETRY_UNAVAILABLE';
    this.root.dataset.sceneAppearanceStatus = sceneVisual?.sceneAppearanceStatus
      ?? 'APPEARANCE_UNAVAILABLE';
    this.root.dataset.sceneMovementProvenance = sceneVisual?.sceneMovementProvenance
      ?? 'unavailable';
    this.root.dataset.sceneAppearanceScientificClaim =
      sceneVisual?.sceneAppearanceScientificClaim === false ? 'false' : 'not-applicable';
    this.root.dataset.sceneAppearanceSynthesisVersion =
      sceneVisual?.sceneAppearanceSynthesisVersion ?? 'none';
    this.root.dataset.sceneAppearanceDisclosure =
      sceneVisual?.sceneGeometryStatus === 'SCENE_GEOMETRY_READY'
        && sceneVisual.sceneAppearanceStatus === 'APPEARANCE_SYNTHETIC'
        ? MIXED_SOURCE_APPEARANCE_LABEL_RU
        : 'none';
    const weather = contributionTelemetry.find(
      (item) => item.weatherBindingStatus !== undefined,
    );
    const weatherOwner = this.root.dataset.environmentWeatherOwner;
    const fallbackWeatherLabel = weatherOwner === 'visual_override'
      ? 'Визуальный погодный override · visual_synthesis'
      : weatherOwner === 'legacy'
        ? 'Синтетический погодный пресет'
        : 'Погодный слой недоступен';
    const fallbackWeatherStatus = weatherOwner === 'scene_pack'
      ? 'WEATHER_UNAVAILABLE'
      : 'WEATHER_SYNTHETIC';
    if (weather) {
      this.root.dataset.environmentWeather = weather.weatherCondition ?? 'unavailable';
    } else if (this.root.dataset.environmentWeatherOwner === 'scene_pack') {
      this.root.dataset.environmentWeather = 'unavailable';
    }
    this.root.dataset.environmentBindingStatus = weather?.weatherBindingStatus ?? fallbackWeatherStatus;
    this.root.dataset.environmentBindingReason = weather?.weatherBindingReason
      ?? (weatherOwner === 'visual_override' ? 'visual_override' : 'none');
    this.root.dataset.environmentDisplayLabel = weather?.weatherDisplayLabel ?? fallbackWeatherLabel;
    this.root.dataset.environmentSourceProvenance = weather?.weatherSourceProvenance
      ?? (weatherOwner === 'scene_pack' ? 'unavailable' : 'visual_synthesis');
    this.root.dataset.environmentWindDirectionProvenance =
      weather?.weatherWindDirectionProvenance ?? 'unavailable';
    this.root.dataset.environmentCycleId = weather?.weatherCycleId ?? 'none';
    this.root.dataset.environmentCycleStepIndex = weather?.weatherCycleStepIndex === null
      || weather?.weatherCycleStepIndex === undefined
      ? 'none'
      : String(weather.weatherCycleStepIndex);
    this.root.dataset.environmentCycleStepIndices =
      weather?.weatherCycleStepIndices?.join(',') ?? '';
    this.root.dataset.environmentSourceReferences = JSON.stringify(
      weather?.weatherSourceReferences ?? [],
    );
    this.root.dataset.environmentLocalDateKey = weather?.weatherLocalDateKey ?? 'none';
    this.root.dataset.environmentLocalMinuteOfDay =
      weather?.weatherLocalMinuteOfDay === null
        || weather?.weatherLocalMinuteOfDay === undefined
        ? 'none'
        : String(weather.weatherLocalMinuteOfDay);
    this.root.dataset.environmentResolvedTemperatureC =
      weather?.weatherResolvedTemperatureC === null
        || weather?.weatherResolvedTemperatureC === undefined
        ? 'none'
        : String(weather.weatherResolvedTemperatureC);
    this.root.dataset.environmentResolvedPrecipitationMmPerHour =
      weather?.weatherResolvedPrecipitationMmPerHour === null
        || weather?.weatherResolvedPrecipitationMmPerHour === undefined
        ? 'none'
        : String(weather.weatherResolvedPrecipitationMmPerHour);
    this.root.dataset.environmentResolvedCloudCover =
      weather?.weatherResolvedCloudCover === null
        || weather?.weatherResolvedCloudCover === undefined
        ? 'none'
        : String(weather.weatherResolvedCloudCover);
    this.root.dataset.environmentResolvedWindMps =
      weather?.weatherResolvedWindMps === null
        || weather?.weatherResolvedWindMps === undefined
        ? 'none'
        : String(weather.weatherResolvedWindMps);
    this.root.dataset.environmentResolvedWindDirectionDegrees =
      weather?.weatherResolvedWindDirectionDegrees === null
        || weather?.weatherResolvedWindDirectionDegrees === undefined
        ? 'none'
        : String(weather.weatherResolvedWindDirectionDegrees);
    this.root.dataset.environmentPresentationTimeIso =
      weather?.weatherPresentationTimeIso ?? 'none';
    this.root.dataset.environmentSourceTimeIso = weather?.weatherSourceTimeIso ?? 'none';
    this.root.dataset.environmentManifestSha256 = weather?.weatherManifestSha256 ?? 'none';
    this.root.dataset.environmentCyclePayloadSha256 =
      weather?.weatherCyclePayloadSha256 ?? 'none';
    this.root.dataset.environmentCycleCompiles = String(weather?.weatherCycleCompiles ?? 0);
    this.root.dataset.environmentSourceInputSha256 =
      weather?.weatherSourceInputSha256 ?? 'none';
    this.root.dataset.environmentTemporalMappingPolicy =
      weather?.weatherTemporalMappingPolicy ?? 'none';
    this.root.dataset.environmentTemporalMappingDerivationVersion =
      weather?.weatherTemporalMappingDerivationVersion ?? 'none';
    this.root.dataset.environmentTemporalMappingFormula =
      weather?.weatherTemporalMappingFormula ?? 'none';
    const plan = contributionTelemetry.find((item) => item.planCells !== undefined);
    const building = contributionTelemetry.find(
      (item) => item.detailedBuildingGeometryReady !== undefined,
    );
    this.root.dataset.detailedBuildingGeometryReady = String(
      building?.detailedBuildingGeometryReady ?? false,
    );
    const planCells = plan?.planCells ?? [];
    this.root.dataset.scenePlanCells = planCells.join(',');
    this.root.dataset.scenePlanCellCount = String(planCells.length);
    this.root.dataset.scenePlanCellAdds = String(plan?.planCellAdds ?? 0);
    this.root.dataset.scenePlanCellRemoves = String(plan?.planCellRemoves ?? 0);
    this.root.dataset.scenePlanCellRebuilds = String(plan?.planCellRebuilds ?? 0);
    this.root.dataset.scenePlanConflicts = String(this.scenePlanConflicts);
    const urbanComposition = contributionTelemetry.find(
      (item) => item.urbanComposition !== undefined,
    )?.urbanComposition;
    this.root.dataset.sceneUrbanBuildings = String(urbanComposition?.buildings ?? 0);
    this.root.dataset.sceneUrbanBuildingArchetypes =
      urbanComposition?.buildingArchetypes.join(',') ?? '';
    this.root.dataset.sceneUrbanRoads = String(urbanComposition?.roads ?? 0);
    this.root.dataset.sceneUrbanSidewalks = String(urbanComposition?.sidewalks ?? 0);
    this.root.dataset.sceneUrbanCrosswalks = String(urbanComposition?.crosswalks ?? 0);
    this.root.dataset.sceneUrbanTrees = String(urbanComposition?.trees ?? 0);
    this.root.dataset.sceneUrbanStreetFurnitureKinds =
      urbanComposition?.streetFurnitureKinds.join(',') ?? '';
    this.root.dataset.sceneUrbanRenderedBuildings = String(
      urbanComposition?.renderedBuildings ?? 0,
    );
    this.root.dataset.sceneUrbanRenderedDrawGroups = String(
      urbanComposition?.renderedDrawGroups ?? 0,
    );
    if (this.environmentOutput) {
      this.environmentOutput.textContent = weather?.weatherDisplayLabel
        ?? fallbackWeatherLabel;
    }
    if (contributionTelemetry.length > 0) {
      const occlusionValues = contributionTelemetry
        .map((item) => item.cameraOccluded)
        .filter((value): value is boolean => typeof value === 'boolean');
      this.contributions = {
        count: contributionTelemetry.length,
        ready: contributionTelemetry.filter((item) => item.ready).length,
        cameraOccluded: occlusionValues.length > 0 ? occlusionValues.some(Boolean) : null,
      };
    }
    const living = samples.find(({ telemetry }) => telemetry.living)?.telemetry.living;
    if (living) this.living = living;
  }

  private scheduleFlush(nowMs = performance.now()): void {
    if (this.disposed) return;
    this.dirty = true;
    if (this.flushTimer !== null) return;
    const delay = this.lastFlushMs === null
      ? 0
      : Math.max(0, this.intervalMs - Math.max(0, nowMs - this.lastFlushMs));
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      if (this.dirty) this.flush(performance.now());
    }, delay);
  }

  private writeLivingTelemetry(): void {
    const living = this.living;
    this.writeLivingActivityTelemetry(living?.activity);
    if (!living) {
      this.root.dataset.livingStatus = 'not-applicable';
      return;
    }
    const conservedLogical = living.logical.total ===
      living.primaryRenderer.deck + living.primaryRenderer.three + living.primaryRenderer.culled;
    const conservedRepresented = living.represented.logical ===
      living.represented.deck + living.represented.three + living.represented.culled;
    this.root.dataset.livingStatus = 'ready';
    this.root.dataset.livingConservation = String(
      conservedLogical && conservedRepresented && living.primaryRenderer.duplicates === 0,
    );
    this.root.dataset.livingLogical = String(living.logical.total);
    this.root.dataset.livingPedestrians = String(living.logical.pedestrians);
    this.root.dataset.livingVehicles = String(living.logical.vehicles);
    this.root.dataset.livingPrimaryDeck = String(living.primaryRenderer.deck);
    this.root.dataset.livingPrimaryThree = String(living.primaryRenderer.three);
    this.root.dataset.livingPrimaryCulled = String(living.primaryRenderer.culled);
    this.root.dataset.livingPrimaryDuplicates = String(living.primaryRenderer.duplicates);
    this.root.dataset.livingRepresentedLogical = String(living.represented.logical);
    this.root.dataset.livingRepresentedDeck = String(living.represented.deck);
    this.root.dataset.livingRepresentedThree = String(living.represented.three);
    this.root.dataset.livingRepresentedCulled = String(living.represented.culled);
    this.root.dataset.livingLodCulled = String(living.lod.culled);
    this.root.dataset.livingLodImpostor = String(living.lod.impostor);
    this.root.dataset.livingLodLow = String(living.lod.low);
    this.root.dataset.livingLodDetailed = String(living.lod.detailed);
    this.root.dataset.livingLodFocus = String(living.lod.focus);
    this.root.dataset.livingPositionHash = living.stablePositionHash;
    this.root.dataset.livingRouteViolations = String(living.routeAdherenceViolations);
    this.root.dataset.livingRouteDirectionViolations = String(
      living.routeDirectionViolations,
    );
    this.root.dataset.livingSimulationTick = String(living.simulationTick);
    this.root.dataset.livingFixedSteps = String(living.fixedStepCount);
    this.root.dataset.livingInterpolationCount = String(living.interpolationCount);
    this.root.dataset.livingInterpolationAlpha = living.interpolationAlpha.toFixed(6);
    this.root.dataset.livingPresentationTimeSeconds = living.presentationTimeSeconds.toFixed(3);
    this.root.dataset.livingAvoidanceStatus = living.avoidanceStatus;
    this.root.dataset.livingAvoidanceReason = living.avoidanceReason ?? 'none';
  }

  private writeLivingActivityTelemetry(activity?: LivingActivityQaSnapshot): void {
    const descriptor = activity?.descriptor;
    this.root.dataset.livingActivityClassification = descriptor?.classification ?? 'not-applicable';
    this.root.dataset.livingActivityScientificClaim = descriptor
      ? String(descriptor.scientificClaim)
      : 'not-applicable';
    this.root.dataset.livingActivitySchedulePolicy = descriptor?.policy ?? 'not-applicable';
    this.root.dataset.livingActivityScheduleVersion = descriptor?.derivationVersion
      ?? 'not-applicable';
    this.root.dataset.livingActivityScheduleFormula = descriptor?.formula ?? 'not-applicable';
    this.root.dataset.livingActivityTimeZone = descriptor?.timeZone ?? 'not-applicable';
    this.root.dataset.livingActivityLocalHour = activity?.localHour === null
      || activity === undefined
      ? 'not-applicable'
      : String(activity.localHour);
    this.root.dataset.livingActivityHash = activity?.stableHash ?? 'not-applicable';
    this.root.dataset.livingActivityCountHome = String(activity?.counts.home ?? 0);
    this.root.dataset.livingActivityCountWalk = String(activity?.counts.walk ?? 0);
    this.root.dataset.livingActivityCountWork = String(activity?.counts.work ?? 0);
    this.root.dataset.livingActivityCountTransit = String(activity?.counts.transit ?? 0);
    this.root.dataset.livingActivityCountLeisure = String(activity?.counts.leisure ?? 0);
    this.root.dataset.livingActivityCountStudy = String(activity?.counts.study ?? 0);
  }

  private writeLivingReconciliation(): void {
    const reconciliation = this.livingReconciliation;
    if (!reconciliation) {
      this.root.dataset.livingAdapterReconciled = 'false';
      return;
    }
    this.root.dataset.livingActualDeck = String(reconciliation.actual.deck);
    this.root.dataset.livingActualThree = String(reconciliation.actual.three);
    this.root.dataset.livingActualUnique = String(reconciliation.actual.unique);
    this.root.dataset.livingActualRepresentedDeck = String(
      reconciliation.representedActual.deck,
    );
    this.root.dataset.livingActualRepresentedThree = String(
      reconciliation.representedActual.three,
    );
    this.root.dataset.livingAdapterDuplicateIds = String(reconciliation.duplicateActualIds);
    this.root.dataset.livingAdapterWrongPrimary = String(reconciliation.wrongPrimaryRenderer);
    this.root.dataset.livingAdapterMissingVisible = String(reconciliation.missingVisibleIds);
    this.root.dataset.livingAdapterIntentionalMissing = String(
      reconciliation.intentionalMissingVisibleIds,
    );
    this.root.dataset.livingAdapterUnaccountedMissing = String(
      reconciliation.unaccountedMissingVisibleIds,
    );
    this.root.dataset.livingAdapterIntentionalOmissionMismatch = String(
      reconciliation.intentionalOmissionMismatch,
    );
    this.root.dataset.livingAdapterUnexpectedOrCulled = String(
      reconciliation.unexpectedOrCulledIds,
    );
    this.root.dataset.livingAdapterReconciled = String(reconciliation.exact);
  }

  private writeLivingWorker(): void {
    const worker = this.livingWorker;
    this.root.dataset.livingWorkerMode = worker?.mode ?? 'not-applicable';
    this.root.dataset.livingWorkerFallbackReason = worker?.fallbackReason ?? 'none';
    this.root.dataset.livingWorkerSubmitted = String(worker?.submitted ?? 0);
    this.root.dataset.livingWorkerExecuted = String(worker?.executed ?? 0);
    this.root.dataset.livingWorkerProcessed = String(worker?.processed ?? 0);
    this.root.dataset.livingWorkerAdvances = String(worker?.advanceOperations ?? 0);
    this.root.dataset.livingWorkerSeeks = String(worker?.seekOperations ?? 0);
    this.root.dataset.livingWorkerSuperseded = String(worker?.superseded ?? 0);
    this.root.dataset.livingWorkerFailed = String(worker?.failed ?? 0);
    this.root.dataset.livingWorkerInitialized = String(worker?.initialized ?? false);
    this.root.dataset.livingWorkerFatalError = this.livingWorkerFatalError ?? 'none';
    this.root.dataset.livingWorkerLastOperation = worker?.lastOperation ?? 'none';
    this.root.dataset.livingWorkerLastPresentationTimeSeconds =
      worker?.lastPresentationTimeSeconds === null || worker === null
        ? 'none'
        : worker.lastPresentationTimeSeconds.toFixed(3);
  }

  private writeMapStyleOwnership(): void {
    this.root.dataset.requestedDetailedBuildingOwner =
      this.mapStyleOwnership.requestedDetailedBuildingOwner;
    this.root.dataset.detailedBuildingOwner = this.mapStyleOwnership.detailedBuildingOwner;
    this.root.dataset.maplibreBuildingExtrusionsMasked = String(
      this.mapStyleOwnership.mapLibreBuildingExtrusionsMasked,
    );
    this.root.dataset.detailedBuildingMaskScope = this.mapStyleOwnership.ownershipMaskScope;
    this.root.dataset.detailedBuildingOwnershipConflict = String(
      this.mapStyleOwnership.ownershipConflict,
    );
  }

  private writeAssetCacheTelemetry(): void {
    const cache = this.assetCache;
    this.root.dataset.sceneAssetCacheRequestedPolicy = cache?.requestedPolicy ?? 'not-applicable';
    this.root.dataset.sceneAssetCacheEffectivePolicy = cache?.effectivePolicy ?? 'not-applicable';
    this.root.dataset.sceneAssetCacheMemoryBudgetBytes = String(cache?.memoryBudgetBytes ?? 0);
    this.root.dataset.sceneAssetCacheMemoryBytes = String(cache?.memoryBytes ?? 0);
    this.root.dataset.sceneAssetCacheEntries = String(cache?.memoryEntries ?? 0);
    this.root.dataset.sceneAssetCacheMemoryHits = String(cache?.memoryHits ?? 0);
    this.root.dataset.sceneAssetCachePersistentHits = String(cache?.persistentHits ?? 0);
    this.root.dataset.sceneAssetCacheNetworkLoads = String(cache?.networkLoads ?? 0);
    this.root.dataset.sceneAssetCacheEvictions = String(cache?.evictions ?? 0);
    this.root.dataset.sceneAssetCacheRejected = String(cache?.rejected ?? 0);
  }

  private writeMapProviderTelemetry(): void {
    this.root.dataset.requestedMapProvider = this.mapProvider.requested;
    this.root.dataset.mapProviderStatus = this.mapProvider.status;
  }

  private writeUniversalDecorationTelemetry(): void {
    const decoration = this.universalDecoration;
    this.root.dataset.materialAtlasVersion = decoration?.materialAtlasVersion ?? 'none';
    this.root.dataset.materialAtlasReady = String(decoration?.materialAtlasReady ?? false);
    this.root.dataset.decorationTier = decoration?.decorationTier ?? 'none';
    this.root.dataset.shadowMode = decoration?.shadowMode ?? 'contact_ao';
    this.root.dataset.waterMode = decoration?.waterMode ?? 'static_directional_gloss';
    this.root.dataset.vegetationMode = decoration?.vegetationMode ?? 'forest_fill';
    this.root.dataset.vegetationCount = String(decoration?.vegetationCount ?? 0);
    this.root.dataset.vegetationOverlayReady = String(
      decoration?.vegetationOverlayReady ?? false,
    );
    this.root.dataset.presentationHeightClampPolicy =
      decoration?.presentationHeightClampPolicy ?? 'zoom_lod_180_to_500m';
    this.root.dataset.presentationHeightClampCount = String(
      decoration?.presentationHeightClampCount ?? 0,
    );
  }

  private writeMapGpuFrameTiming(): void {
    const timing = this.mapGpuFrameTiming;
    this.root.dataset.gpuFrameTimerScope = 'maplibre_shared_webgl2_canvas';
    this.root.dataset.gpuFrameTimerStatus = timing?.status ?? 'not-attached';
    this.root.dataset.gpuFrameTimerSupported = String(timing?.supported ?? false);
    this.root.dataset.gpuFrameTimerExtensionSupported = String(
      timing?.extensionSupported ?? timing?.supported ?? false,
    );
    this.root.dataset.gpuFrameTimerReadyForGovernor = String(
      timing?.readyForGovernor ?? false,
    );
    this.root.dataset.gpuFrameTimerActive = String(timing?.active ?? false);
    this.root.dataset.gpuFrameTimerPending = String(timing?.pendingCount ?? 0);
    this.root.dataset.gpuFrameTimerSamples = String(timing?.sampleCount ?? 0);
    this.root.dataset.gpuFrameTimerWindowSamples = String(timing?.windowSampleCount ?? 0);
    this.root.dataset.gpuFrameTimerDiscards = String(timing?.discardCount ?? 0);
    this.root.dataset.gpuFrameTimerDisjointDiscards = String(
      timing?.disjointDiscardCount ?? 0,
    );
    this.root.dataset.gpuFrameTimerContextLossDiscards = String(
      timing?.contextLossDiscardCount ?? 0,
    );
    this.root.dataset.gpuFrameTimerApiErrorDiscards = String(
      timing?.apiErrorDiscardCount ?? 0,
    );
    this.root.dataset.gpuFrameTimerBeginSkips = String(timing?.beginSkippedCount ?? 0);
    this.root.dataset.gpuFrameTimeLastMs = timing?.lastMilliseconds === null
      || timing === null
      ? 'waiting'
      : timing.lastMilliseconds.toFixed(3);
    this.root.dataset.gpuFrameTimeMedianMs = timing?.medianMilliseconds === null
      || timing === null
      ? 'waiting'
      : timing.medianMilliseconds.toFixed(3);
    this.root.dataset.gpuFrameTimeP95Ms = timing?.p95Milliseconds === null
      || timing === null
      ? 'waiting'
      : timing.p95Milliseconds.toFixed(3);
    this.root.dataset.rendererSubmissionWallSamples = String(
      timing?.rendererSubmissionWallSampleCount ?? 0,
    );
    this.root.dataset.rendererSubmissionWallWindowSamples = String(
      timing?.rendererSubmissionWallWindowSampleCount ?? 0,
    );
    this.root.dataset.rendererSubmissionWallTimeLastMs =
      timing?.rendererSubmissionWallLastMilliseconds === null || timing === null
        ? 'waiting'
        : timing.rendererSubmissionWallLastMilliseconds.toFixed(3);
    this.root.dataset.rendererSubmissionWallTimeMedianMs =
      timing?.rendererSubmissionWallMedianMilliseconds === null || timing === null
        ? 'waiting'
        : timing.rendererSubmissionWallMedianMilliseconds.toFixed(3);
    this.root.dataset.rendererSubmissionWallTimeP95Ms =
      timing?.rendererSubmissionWallP95Milliseconds === null || timing === null
        ? 'waiting'
        : timing.rendererSubmissionWallP95Milliseconds.toFixed(3);
    this.root.dataset.renderIntervalSamples = String(
      timing?.renderIntervalSampleCount ?? timing?.rendererSubmissionWallSampleCount ?? 0,
    );
    this.root.dataset.renderIntervalTimeMedianMs = timing?.renderIntervalMedianMilliseconds
      === null || timing?.renderIntervalMedianMilliseconds === undefined
      ? 'waiting'
      : timing.renderIntervalMedianMilliseconds.toFixed(3);
    this.root.dataset.renderIntervalTimeP95Ms = timing?.renderIntervalP95Milliseconds
      === null || timing?.renderIntervalP95Milliseconds === undefined
      ? 'waiting'
      : timing.renderIntervalP95Milliseconds.toFixed(3);
    this.root.dataset.gpuFrameTimerMeasurementBoundary = timing?.measurementBoundary ?? 'none';
  }

  private writeRendererPerformanceGovernor(): void {
    const governor = this.rendererPerformanceGovernor;
    const snapshot = governor.snapshot;
    this.root.dataset.rendererGovernorStatus = governor.status;
    this.root.dataset.rendererGovernorActive = String(governor.status === 'active');
    this.root.dataset.rendererGovernorRevision = String(snapshot?.revision ?? 0);
    this.root.dataset.rendererGovernorCpuLevel = String(snapshot?.cpuLevel ?? 0);
    this.root.dataset.rendererGovernorGpuLevel = String(snapshot?.gpuLevel ?? 0);
    this.root.dataset.rendererGovernorDprScale = (snapshot?.dprScale ?? 1).toFixed(2);
    this.root.dataset.rendererGovernorNearUpdateHz = String(snapshot?.nearUpdateHz ?? 0);
    this.root.dataset.rendererGovernorMidUpdateHz = String(snapshot?.midUpdateHz ?? 0);
    this.root.dataset.rendererGovernorNearPeopleCap = String(snapshot?.nearPeopleCap ?? 0);
    this.root.dataset.rendererGovernorNearVehicleCap = String(snapshot?.nearVehicleCap ?? 0);
    this.root.dataset.rendererGovernorTrees = String(snapshot?.treeBillboardsEnabled ?? false);
    this.root.dataset.rendererGovernorProjectedShadow = String(
      snapshot?.projectedShadowEnabled ?? false,
    );
    this.root.dataset.rendererGovernorRoofCap = String(snapshot?.roofCapEnabled ?? false);
    this.root.dataset.rendererGovernorFacadePattern = String(
      snapshot?.facadePatternEnabled ?? false,
    );
    this.root.dataset.rendererGovernorFloorMode = snapshot?.floorMode ?? 'normal';
    this.root.dataset.rendererGovernorTargetFps = String(
      snapshot?.targetFramesPerSecond ?? 0,
    );
    this.root.dataset.rendererGovernorIndividualActors = String(
      snapshot?.individualActorsEnabled ?? true,
    );
    this.root.dataset.rendererGovernorAggregateBuildings = String(
      snapshot?.aggregateBuildingRepresentation ?? false,
    );
    this.root.dataset.rendererGovernorContactAo = String(
      snapshot?.contactAoEnabled ?? true,
    );
    this.root.dataset.rendererGovernorBaseGround = String(snapshot?.baseSurfaces.ground ?? true);
    this.root.dataset.rendererGovernorBaseRoads = String(snapshot?.baseSurfaces.roads ?? true);
    this.root.dataset.rendererGovernorBaseWater = String(snapshot?.baseSurfaces.water ?? true);
    this.root.dataset.rendererGovernorBaseBuildings = String(
      snapshot?.baseSurfaces.buildings ?? true,
    );
    this.root.dataset.rendererGovernorDecision = governor.lastDecision ?? 'none';
    this.root.dataset.rendererGovernorCpuInput = governor.cpuInput;
    this.root.dataset.rendererGovernorGpuInput = governor.gpuInput;
  }

  private writeActiveLayers(): void {
    const layers = [...this.activeLayers].sort();
    this.root.dataset.sceneActiveLayers = layers.join(',');
    this.root.dataset.sceneLayerBuildings = String(this.activeLayers.has('buildings'));
    this.root.dataset.sceneLayerInfrastructure = String(
      this.activeLayers.has('infrastructure'),
    );
    this.root.dataset.sceneLayerWeather = String(this.activeLayers.has('weather'));
  }

  private writeMovementTelemetry(): void {
    this.root.dataset.livingMovementStatus = this.movement.status;
    this.root.dataset.livingRoutedEntities = String(this.movement.routedEntities);
    this.root.dataset.livingUnboundEntities = String(this.movement.unboundEntities);
    this.root.dataset.livingMovementViolations = String(this.movement.violations);
    this.root.dataset.livingMovementReason = this.movement.reason ?? 'none';
  }

  private writeSceneIdentity(): void {
    this.root.dataset.sceneRuntimeId = this.sceneIdentity?.sceneId ?? 'unresolved';
    this.root.dataset.sceneRuntimeVersion = this.sceneIdentity?.sceneVersion ?? 'unresolved';
    this.root.dataset.sceneManifestSha256 = this.sceneIdentity?.manifestSha256 ?? 'unresolved';
    this.root.dataset.sceneManifestHashVerified = String(
      this.sceneIdentity?.manifestVerified ?? false,
    );
  }

  private writeLivingLifecycle(): void {
    this.root.dataset.livingPartitionReplacements = String(
      this.livingLifecycle.partitionReplacements,
    );
    this.root.dataset.livingWorkerGeneration = String(
      this.livingLifecycle.workerGeneration,
    );
    this.root.dataset.presentationSeekRevision = String(
      this.livingLifecycle.requestedSeekRevision,
    );
    this.root.dataset.livingAppliedSeekRevision = String(
      this.livingLifecycle.appliedSeekRevision,
    );
  }

  private writeStreamerTelemetry(): void {
    this.root.dataset.sceneStreamCurrentCell = this.streamer.currentCell ?? 'unresolved';
    this.root.dataset.sceneStreamDesired = String(this.streamer.desiredCells);
    this.root.dataset.sceneStreamActive = String(this.streamer.activeCells);
    this.root.dataset.sceneStreamCells = String(this.streamer.loadedCells);
    this.root.dataset.sceneStreamPending = String(this.streamer.pendingCells);
    this.root.dataset.sceneStreamFailed = String(this.streamer.failedCells);
    this.root.dataset.sceneStreamBudget = String(this.streamer.budgetCells);
    this.root.dataset.sceneStreamLoadedBytes = String(this.streamer.loadedBytes);
    this.root.dataset.sceneStreamMemoryBudgetBytes = this.streamer.memoryBudgetBytes === null
      ? 'not-set'
      : String(this.streamer.memoryBudgetBytes);
    this.root.dataset.sceneStreamCachePolicy = this.streamer.cachePolicy;
    this.root.dataset.sceneStreamDeviceTier = this.streamer.deviceTier ?? 'not-set';
    this.root.dataset.sceneStreamEvicted = String(this.streamer.evictedCells);
    this.root.dataset.sceneStreamRejected = String(this.streamer.rejectedCells);
    this.root.dataset.sceneStreamBudgetDisposition = this.streamer.budgetDisposition;
    this.root.dataset.sceneStreamRevision = String(this.streamer.revision);
    this.root.dataset.sceneStreamCameraMotion = this.streamer.cameraMotion;
    this.root.dataset.sceneStreamIndividualCellsEnabled = String(
      this.streamer.individualCellsEnabled,
    );
  }

  private writeContributionTelemetry(): void {
    this.root.dataset.sceneContributionCount = String(this.contributions.count);
    this.root.dataset.sceneReadyContributions = String(this.contributions.ready);
    this.root.dataset.sceneContributionsReady = this.contributions.count === 0
      ? 'not-applicable'
      : String(this.contributions.ready === this.contributions.count);
    this.root.dataset.cameraOccluded = this.contributions.cameraOccluded === null
      ? 'not-applicable'
      : String(this.contributions.cameraOccluded);
  }
}
