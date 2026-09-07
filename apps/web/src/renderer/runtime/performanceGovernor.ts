import { ADAPTIVE_DPR_LADDER } from './pixelBudget';
import type { UniversalQualityTier } from '../universal/types';

export type RendererPerformanceAxis = 'cpu' | 'gpu';

export type RendererPerformanceDecisionKind =
  | 'degrade_cpu'
  | 'degrade_gpu'
  | 'recover_cpu'
  | 'recover_gpu'
  | 'enter_emergency_30'
  | 'enter_compatibility_30'
  | 'probe_floor_recovery'
  | 'end_floor_probe'
  | 'recover_floor';

export type AdaptiveDprScale = typeof ADAPTIVE_DPR_LADDER[number];

export interface RendererPerformanceSample {
  /** CPU-side submission proxy or frame-interval fallback. */
  readonly cpuFrameMs: number;
  /** Asynchronous GPU timer-query result for the same sampling window. */
  readonly gpuFrameMs: number | null;
  /** Moving-scene p95 used by the non-negotiable 30 FPS floor. */
  readonly frameIntervalP95Ms?: number;
  readonly moving?: boolean;
  /** Monotonic wall-clock time. This, rather than frame count, drives hysteresis. */
  readonly wallTimeMs: number;
}

export interface RendererPerformanceGovernorPolicy {
  readonly cpuBudgetMs: number;
  readonly gpuBudgetMs: number;
  readonly overloadRatio: number;
  readonly headroomRatio: number;
  readonly degradeSustainMs: number;
  readonly recoverSustainMs: number;
  readonly minimumStepIntervalMs: number;
  readonly minimumMovingFps: number;
  readonly emergencySustainMs: number;
  readonly compatibilitySustainMs: number;
}

export interface RendererPerformanceGovernorOptions {
  readonly qualityTier?: UniversalQualityTier;
  readonly initialDprScale?: AdaptiveDprScale;
  readonly policy?: Partial<RendererPerformanceGovernorPolicy>;
  /** Explicit demo policy: retain a bounded interactive sample in floor modes; FPS remains a target. */
  readonly preserveIndividualPresentation?: boolean;
}

export interface RendererBaseSurfaceGuarantees {
  readonly ground: true;
  readonly roads: true;
  readonly water: true;
  readonly buildings: true;
}

export interface RendererPerformanceGovernorSnapshot {
  readonly revision: number;
  readonly qualityTier: UniversalQualityTier;
  readonly cpuLevel: number;
  readonly gpuLevel: number;
  readonly dprScale: AdaptiveDprScale;
  readonly nearUpdateHz: number;
  readonly midUpdateHz: number;
  readonly nearPeopleCap: number;
  readonly nearVehicleCap: number;
  readonly treeBillboardsEnabled: boolean;
  readonly treeDensityScale: 0 | 1;
  readonly projectedShadowEnabled: boolean;
  readonly roofCapEnabled: boolean;
  readonly facadePatternEnabled: boolean;
  readonly floorMode: 'normal' | 'emergency_30' | 'compatibility_30';
  readonly targetFramesPerSecond: number;
  /** Bounded uncapped measurement; reduced DPR/actor/detail budgets remain in force. */
  readonly recoveryProbe: boolean;
  readonly individualActorsEnabled: boolean;
  readonly aggregateBuildingRepresentation: boolean;
  readonly contactAoEnabled: boolean;
  /** These layers are outside the governor's degradation ladder by design. */
  readonly baseSurfaces: RendererBaseSurfaceGuarantees;
}

export interface RendererPerformanceGovernorDecision {
  readonly kind: RendererPerformanceDecisionKind;
  readonly axis: RendererPerformanceAxis;
  readonly atMs: number;
  readonly previous: RendererPerformanceGovernorSnapshot;
  readonly next: RendererPerformanceGovernorSnapshot;
}

const BASE_SURFACES: RendererBaseSurfaceGuarantees = Object.freeze({
  ground: true,
  roads: true,
  water: true,
  buildings: true,
});

const DEFAULT_POLICY: RendererPerformanceGovernorPolicy = Object.freeze({
  cpuBudgetMs: 1_000 / 60,
  gpuBudgetMs: 1_000 / 60,
  overloadRatio: 1.2,
  headroomRatio: 0.75,
  degradeSustainMs: 2_000,
  recoverSustainMs: 10_000,
  minimumStepIntervalMs: 5_000,
  minimumMovingFps: 30,
  emergencySustainMs: 500,
  compatibilitySustainMs: 1_000,
});

const FRAME_BUDGET_BY_TIER: Readonly<Record<UniversalQualityTier, number>> = Object.freeze({
  high: 1_000 / 120,
  mid: 1_000 / 60,
  low: 1_000 / 30,
});

const TARGET_FPS_BY_TIER: Readonly<Record<UniversalQualityTier, number>> = Object.freeze({
  high: 120,
  mid: 60,
  low: 30,
});

const INITIAL_DPR_BY_TIER: Readonly<Record<UniversalQualityTier, AdaptiveDprScale>> = Object.freeze({
  high: 0.85,
  mid: 1,
  low: 0.75,
});

const NEAR_CAPS: Readonly<Record<UniversalQualityTier, {
  readonly people: number;
  readonly vehicles: number;
}>> = Object.freeze({
  high: Object.freeze({ people: 1200, vehicles: 1800 }),
  mid: Object.freeze({ people: 500, vehicles: 800 }),
  low: Object.freeze({ people: 160, vehicles: 320 }),
});

const FLOOR_PROBE_DURATION_MS = 2_000;
const FLOOR_PROBE_HEADROOM_MS = 750;
// Render-event timing includes display/scheduler quantization. This is not
// additional work headroom: a capped recovery also requires measured GPU slack.
const CAPPED_INTERVAL_TOLERANCE = 1.1;

const CPU_STAGES = Object.freeze([
  Object.freeze({ nearUpdateHz: 10, midUpdateHz: 2, nearCapScale: 1 }),
  Object.freeze({ nearUpdateHz: 8, midUpdateHz: 1, nearCapScale: 0.8 }),
  Object.freeze({ nearUpdateHz: 6, midUpdateHz: 0.75, nearCapScale: 0.6 }),
  Object.freeze({ nearUpdateHz: 4, midUpdateHz: 0.5, nearCapScale: 0.4 }),
] as const);

const GPU_STAGES = Object.freeze([
  Object.freeze({ dprScale: 1, trees: true, shadow: true, roof: true, facade: true }),
  Object.freeze({ dprScale: 0.85, trees: true, shadow: true, roof: true, facade: true }),
  Object.freeze({ dprScale: 0.75, trees: true, shadow: true, roof: true, facade: true }),
  Object.freeze({ dprScale: 0.67, trees: true, shadow: true, roof: true, facade: true }),
  Object.freeze({ dprScale: 0.67, trees: false, shadow: true, roof: true, facade: true }),
  Object.freeze({ dprScale: 0.67, trees: false, shadow: false, roof: true, facade: true }),
  Object.freeze({ dprScale: 0.67, trees: false, shadow: false, roof: false, facade: true }),
  Object.freeze({ dprScale: 0.67, trees: false, shadow: false, roof: false, facade: false }),
  Object.freeze({ dprScale: 0.5, trees: false, shadow: false, roof: false, facade: false }),
] as const satisfies readonly {
  readonly dprScale: AdaptiveDprScale;
  readonly trees: boolean;
  readonly shadow: boolean;
  readonly roof: boolean;
  readonly facade: boolean;
}[]);

type PressureSignal = RendererPerformanceAxis | 'headroom' | 'neutral';

function finitePositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite positive number`);
  }
  return value;
}

function finiteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
  return value;
}

function resolvePolicy(
  qualityTier: UniversalQualityTier,
  override: Partial<RendererPerformanceGovernorPolicy> | undefined,
): RendererPerformanceGovernorPolicy {
  const tierFrameBudgetMs = FRAME_BUDGET_BY_TIER[qualityTier];
  const policy = {
    ...DEFAULT_POLICY,
    cpuBudgetMs: tierFrameBudgetMs,
    gpuBudgetMs: tierFrameBudgetMs,
    ...override,
  };
  finitePositive(policy.cpuBudgetMs, 'cpuBudgetMs');
  finitePositive(policy.gpuBudgetMs, 'gpuBudgetMs');
  finitePositive(policy.overloadRatio, 'overloadRatio');
  finitePositive(policy.headroomRatio, 'headroomRatio');
  finitePositive(policy.degradeSustainMs, 'degradeSustainMs');
  finitePositive(policy.recoverSustainMs, 'recoverSustainMs');
  finitePositive(policy.minimumStepIntervalMs, 'minimumStepIntervalMs');
  finitePositive(policy.minimumMovingFps, 'minimumMovingFps');
  finitePositive(policy.emergencySustainMs, 'emergencySustainMs');
  finitePositive(policy.compatibilitySustainMs, 'compatibilitySustainMs');
  if (policy.headroomRatio >= policy.overloadRatio) {
    throw new RangeError('headroomRatio must be lower than overloadRatio');
  }
  return Object.freeze(policy);
}

function initialGpuLevel(scale: AdaptiveDprScale): number {
  const index = GPU_STAGES.findIndex((stage) => stage.dprScale === scale);
  if (index < 0) throw new RangeError('initialDprScale must be an adaptive DPR ladder value');
  return index;
}

/**
 * A deterministic, wall-time based renderer governor.
 *
 * Callers should feed aggregated CPU/GPU samples rather than React state on
 * every animation frame. `observe` returns `null` while policy is unchanged,
 * so retained renderer buffers are only touched after a real ladder step.
 */
export class RendererPerformanceGovernor {
  private readonly qualityTier: UniversalQualityTier;
  private readonly policy: RendererPerformanceGovernorPolicy;
  private readonly preserveIndividualPresentation: boolean;
  private cpuLevel = 0;
  private gpuLevel: number;
  private readonly minimumGpuLevel: number;
  private revision = 0;
  private cachedSnapshot: RendererPerformanceGovernorSnapshot;
  private candidate: PressureSignal | null = null;
  private candidateSinceMs = 0;
  private lastObservedAtMs: number | null = null;
  private lastStepAtMs = Number.NEGATIVE_INFINITY;
  private readonly degradationHistory: RendererPerformanceAxis[] = [];
  private floorLevel: 0 | 1 | 2 = 0;
  private floorPressureSinceMs: number | null = null;
  private floorLevelSinceMs: number | null = null;
  private floorHeadroomSinceMs: number | null = null;
  private floorProbeSinceMs: number | null = null;
  private floorProbeHeadroomSinceMs: number | null = null;
  private lastFloorProbeAtMs = Number.NEGATIVE_INFINITY;

  constructor(options: RendererPerformanceGovernorOptions = {}) {
    this.qualityTier = options.qualityTier ?? 'high';
    this.policy = resolvePolicy(this.qualityTier, options.policy);
    this.preserveIndividualPresentation = options.preserveIndividualPresentation ?? false;
    this.gpuLevel = initialGpuLevel(
      options.initialDprScale ?? INITIAL_DPR_BY_TIER[this.qualityTier],
    );
    this.minimumGpuLevel = this.gpuLevel;
    this.cachedSnapshot = this.buildSnapshot();
  }

  get snapshot(): RendererPerformanceGovernorSnapshot {
    return this.cachedSnapshot;
  }

  observe(sample: RendererPerformanceSample): RendererPerformanceGovernorDecision | null {
    const wallTimeMs = finiteNonNegative(sample.wallTimeMs, 'wallTimeMs');
    const cpuFrameMs = finiteNonNegative(sample.cpuFrameMs, 'cpuFrameMs');
    const gpuFrameMs = sample.gpuFrameMs === null
      ? null
      : finiteNonNegative(sample.gpuFrameMs, 'gpuFrameMs');
    const frameIntervalP95Ms = sample.frameIntervalP95Ms === undefined
      ? null
      : finiteNonNegative(sample.frameIntervalP95Ms, 'frameIntervalP95Ms');
    if (this.lastObservedAtMs !== null && wallTimeMs < this.lastObservedAtMs) {
      throw new RangeError('wallTimeMs must be monotonic');
    }
    this.lastObservedAtMs = wallTimeMs;

    const floorDecision = this.observeHardFloor(
      sample.moving,
      frameIntervalP95Ms,
      cpuFrameMs,
      gpuFrameMs,
      wallTimeMs,
    );
    if (floorDecision || this.floorLevel > 0) return floorDecision;
    if (sample.moving === false) return null;

    const signal = this.classify(cpuFrameMs, gpuFrameMs);
    if (signal === 'neutral') {
      this.candidate = null;
      return null;
    }
    if (this.candidate !== signal) {
      this.candidate = signal;
      this.candidateSinceMs = wallTimeMs;
      return null;
    }

    const requiredSustainMs = signal === 'headroom'
      ? this.policy.recoverSustainMs
      : this.policy.degradeSustainMs;
    if (wallTimeMs - this.candidateSinceMs < requiredSustainMs) return null;
    if (wallTimeMs - this.lastStepAtMs < this.policy.minimumStepIntervalMs) return null;

    const decision = signal === 'headroom'
      ? this.recover(wallTimeMs)
      : this.degrade(signal, wallTimeMs);
    if (decision) this.candidateSinceMs = wallTimeMs;
    return decision;
  }

  private classify(cpuFrameMs: number, gpuFrameMs: number | null): PressureSignal {
    const cpuRatio = cpuFrameMs / this.policy.cpuBudgetMs;
    const gpuRatio = gpuFrameMs === null
      ? Number.NEGATIVE_INFINITY
      : gpuFrameMs / this.policy.gpuBudgetMs;
    const cpuOverloaded = cpuRatio >= this.policy.overloadRatio;
    const gpuOverloaded = gpuRatio >= this.policy.overloadRatio;
    if (cpuOverloaded || gpuOverloaded) {
      // A tie is resolved toward GPU because lowering raster cost is reversible
      // and does not reduce simulation update fidelity.
      return cpuRatio > gpuRatio ? 'cpu' : 'gpu';
    }
    if (
      cpuRatio <= this.policy.headroomRatio
      && (gpuFrameMs === null || gpuRatio <= this.policy.headroomRatio)
    ) return 'headroom';
    return 'neutral';
  }

  private observeHardFloor(
    moving: boolean | undefined,
    frameIntervalP95Ms: number | null,
    cpuFrameMs: number,
    gpuFrameMs: number | null,
    wallTimeMs: number,
  ): RendererPerformanceGovernorDecision | null {
    if (moving === false) return this.settle(wallTimeMs);
    if (!moving || frameIntervalP95Ms === null) return null;
    const floorBudgetMs = 1_000 / this.policy.minimumMovingFps;
    const uncappedHeadroom = frameIntervalP95Ms <= floorBudgetMs * this.policy.headroomRatio
      && (gpuFrameMs === null || gpuFrameMs <= floorBudgetMs * this.policy.headroomRatio);
    if (this.floorProbeSinceMs !== null) {
      const headroom = uncappedHeadroom && (gpuFrameMs === null || gpuFrameMs <= floorBudgetMs * this.policy.headroomRatio);
      if (!headroom) this.floorProbeHeadroomSinceMs = null;
      else if (this.floorProbeHeadroomSinceMs === null) this.floorProbeHeadroomSinceMs = wallTimeMs;
      if (this.floorProbeHeadroomSinceMs !== null && wallTimeMs - this.floorProbeHeadroomSinceMs >= FLOOR_PROBE_HEADROOM_MS) {
        return this.commit('recover_floor', 'gpu', wallTimeMs, () => {
          this.floorLevel = Math.max(0, this.floorLevel - 1) as 0 | 1;
          this.floorLevelSinceMs = wallTimeMs;
          this.endFloorProbe(wallTimeMs);
        });
      }
      if (wallTimeMs - this.floorProbeSinceMs >= FLOOR_PROBE_DURATION_MS) {
        return this.commit('end_floor_probe', 'gpu', wallTimeMs, () => this.endFloorProbe(wallTimeMs));
      }
      return null;
    }

    // A scheduler-capped 30 FPS stream cannot reach the former <=25 ms
    // recovery gate. Fresh GPU work timing supplies independent headroom;
    // both CPU/interval proxies must still fit the protected cadence.
    const cappedHeadroom = this.floorLevel > 0 && gpuFrameMs !== null
      && gpuFrameMs <= floorBudgetMs * this.policy.headroomRatio
      && cpuFrameMs <= floorBudgetMs * CAPPED_INTERVAL_TOLERANCE
      && frameIntervalP95Ms <= floorBudgetMs * CAPPED_INTERVAL_TOLERANCE;
    if (this.floorLevel > 0 && (uncappedHeadroom || cappedHeadroom)) {
      this.floorPressureSinceMs = null;
      if (this.floorHeadroomSinceMs === null) this.floorHeadroomSinceMs = wallTimeMs;
      if (wallTimeMs - this.floorHeadroomSinceMs < this.policy.recoverSustainMs
        || wallTimeMs - this.lastStepAtMs < this.policy.minimumStepIntervalMs) return null;
      return this.commit('recover_floor', 'gpu', wallTimeMs, () => {
        this.floorLevel = (this.floorLevel - 1) as 0 | 1;
        this.floorLevelSinceMs = wallTimeMs;
      });
    }
    this.floorHeadroomSinceMs = null;

    // Without independent GPU timing, briefly measure the existing reduced
    // scene at 60 FPS. No new instances/textures are enabled by a probe.
    if (this.floorLevel > 0 && gpuFrameMs === null
      && frameIntervalP95Ms <= floorBudgetMs * CAPPED_INTERVAL_TOLERANCE
      && wallTimeMs - Math.max(this.lastStepAtMs, this.lastFloorProbeAtMs) >= this.policy.recoverSustainMs) {
      return this.commit('probe_floor_recovery', 'gpu', wallTimeMs, () => {
        this.floorProbeSinceMs = wallTimeMs;
        this.floorProbeHeadroomSinceMs = null;
        this.lastFloorProbeAtMs = wallTimeMs;
      });
    }

    const overloadBudgetMs = floorBudgetMs * (this.floorLevel > 0 ? CAPPED_INTERVAL_TOLERANCE : 1);
    if (frameIntervalP95Ms > overloadBudgetMs) {
      this.floorHeadroomSinceMs = null;
      if (this.floorPressureSinceMs === null) this.floorPressureSinceMs = wallTimeMs;
      if (
        this.floorLevel === 0
        && wallTimeMs - this.floorPressureSinceMs >= this.policy.emergencySustainMs
      ) {
        return this.commit('enter_emergency_30', 'gpu', wallTimeMs, () => {
          this.floorLevel = 1;
          this.floorLevelSinceMs = wallTimeMs;
          this.candidate = null;
        });
      }
      if (
        this.floorLevel === 1
        && this.floorLevelSinceMs !== null
        && wallTimeMs - this.floorLevelSinceMs >= this.policy.compatibilitySustainMs
      ) {
        return this.commit('enter_compatibility_30', 'gpu', wallTimeMs, () => {
          this.floorLevel = 2;
          this.floorLevelSinceMs = wallTimeMs;
          this.candidate = null;
        });
      }
      return null;
    }

    this.floorPressureSinceMs = null;
    return null;
  }

  /** End transient motion pressure without starting a paused repaint loop. */
  settle(wallTimeMs: number): RendererPerformanceGovernorDecision | null {
    finiteNonNegative(wallTimeMs, 'wallTimeMs');
    if (this.lastObservedAtMs !== null && wallTimeMs < this.lastObservedAtMs) throw new RangeError('wallTimeMs must be monotonic');
    this.lastObservedAtMs = wallTimeMs;
    this.floorPressureSinceMs = null;
    this.floorHeadroomSinceMs = null;
    this.candidate = null;
    if (this.floorLevel === 0 && this.floorProbeSinceMs === null) return null;
    return this.commit('recover_floor', 'gpu', wallTimeMs, () => {
      this.floorLevel = 0;
      this.floorLevelSinceMs = null;
      this.endFloorProbe(wallTimeMs);
    });
  }

  private endFloorProbe(wallTimeMs: number): void {
    this.floorProbeSinceMs = null;
    this.floorProbeHeadroomSinceMs = null;
    this.floorHeadroomSinceMs = null;
    this.floorPressureSinceMs = null;
    this.lastFloorProbeAtMs = wallTimeMs;
  }

  private degrade(
    axis: RendererPerformanceAxis,
    wallTimeMs: number,
  ): RendererPerformanceGovernorDecision | null {
    if (axis === 'cpu') {
      if (this.cpuLevel >= CPU_STAGES.length - 1) return null;
      return this.commit('degrade_cpu', axis, wallTimeMs, () => {
        this.cpuLevel += 1;
        this.degradationHistory.push(axis);
      });
    }
    if (this.gpuLevel >= GPU_STAGES.length - 1) return null;
    return this.commit('degrade_gpu', axis, wallTimeMs, () => {
      this.gpuLevel += 1;
      this.degradationHistory.push(axis);
    });
  }

  private recover(wallTimeMs: number): RendererPerformanceGovernorDecision | null {
    let axis = this.lastRecoverableAxis();
    if (!axis) return null;
    if (axis === 'cpu' && this.cpuLevel === 0) axis = this.gpuLevel > 0 ? 'gpu' : axis;
    if (axis === 'gpu' && this.gpuLevel === this.minimumGpuLevel) {
      axis = this.cpuLevel > 0 ? 'cpu' : axis;
    }
    if (
      (axis === 'cpu' && this.cpuLevel === 0)
      || (axis === 'gpu' && this.gpuLevel === this.minimumGpuLevel)
    ) return null;
    const kind: RendererPerformanceDecisionKind = axis === 'cpu'
      ? 'recover_cpu'
      : 'recover_gpu';
    return this.commit(kind, axis, wallTimeMs, () => {
      if (axis === 'cpu') this.cpuLevel -= 1;
      else this.gpuLevel -= 1;
    });
  }

  private lastRecoverableAxis(): RendererPerformanceAxis | null {
    while (this.degradationHistory.length > 0) {
      const axis = this.degradationHistory.pop()!;
      if (
        axis === 'cpu'
          ? this.cpuLevel > 0
          : this.gpuLevel > this.minimumGpuLevel
      ) return axis;
    }
    // An initial 0.85/0.75/0.67 DPR is intentional pressure state and can
    // recover to native DPR after the same sustained-headroom gate.
    if (this.gpuLevel > this.minimumGpuLevel) return 'gpu';
    if (this.cpuLevel > 0) return 'cpu';
    return null;
  }

  private commit(
    kind: RendererPerformanceDecisionKind,
    axis: RendererPerformanceAxis,
    wallTimeMs: number,
    mutate: () => void,
  ): RendererPerformanceGovernorDecision {
    const previous = this.cachedSnapshot;
    mutate();
    this.revision += 1;
    this.lastStepAtMs = wallTimeMs;
    this.cachedSnapshot = this.buildSnapshot();
    return Object.freeze({
      kind,
      axis,
      atMs: wallTimeMs,
      previous,
      next: this.cachedSnapshot,
    });
  }

  private buildSnapshot(): RendererPerformanceGovernorSnapshot {
    const cpu = CPU_STAGES[this.cpuLevel]!;
    const gpu = GPU_STAGES[this.gpuLevel]!;
    const caps = NEAR_CAPS[this.qualityTier];
    const floorMode = this.floorLevel === 2
      ? 'compatibility_30'
      : this.floorLevel === 1 ? 'emergency_30' : 'normal';
    const dprScale: AdaptiveDprScale = this.floorLevel === 2
      ? 0.5
      : this.floorLevel === 1 && gpu.dprScale > 0.67 ? 0.67 : gpu.dprScale;
    const fullDetail = this.floorLevel === 0;
    return Object.freeze({
      revision: this.revision,
      qualityTier: this.qualityTier,
      cpuLevel: this.cpuLevel,
      gpuLevel: this.gpuLevel,
      dprScale,
      nearUpdateHz: cpu.nearUpdateHz,
      midUpdateHz: cpu.midUpdateHz,
      nearPeopleCap: fullDetail ? Math.max(1, Math.floor(caps.people * cpu.nearCapScale))
        : this.preserveIndividualPresentation ? 80 : 0,
      nearVehicleCap: fullDetail ? Math.max(1, Math.floor(caps.vehicles * cpu.nearCapScale))
        : this.preserveIndividualPresentation ? 20 : 0,
      treeBillboardsEnabled: fullDetail && gpu.trees,
      treeDensityScale: fullDetail && gpu.trees ? 1 : 0,
      projectedShadowEnabled: fullDetail && gpu.shadow,
      roofCapEnabled: fullDetail && gpu.roof,
      facadePatternEnabled: fullDetail && gpu.facade,
      floorMode,
      targetFramesPerSecond: this.floorProbeSinceMs !== null ? 60 : fullDetail
        ? TARGET_FPS_BY_TIER[this.qualityTier]
        : this.policy.minimumMovingFps,
      recoveryProbe: this.floorProbeSinceMs !== null,
      individualActorsEnabled: fullDetail || this.preserveIndividualPresentation,
      aggregateBuildingRepresentation: !fullDetail && !this.preserveIndividualPresentation,
      contactAoEnabled: fullDetail,
      baseSurfaces: BASE_SURFACES,
    });
  }
}
