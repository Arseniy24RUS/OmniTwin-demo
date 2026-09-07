import {
  LivingKind,
  LivingLod,
  LivingPrimaryRenderer,
  type LivingAvoidanceStatus,
  type LivingPartition,
  type LivingRenderFrame,
} from './types';

export interface LivingAvoidanceStatusReport {
  status: LivingAvoidanceStatus;
  reason: string | null;
}

export interface LivingLocalAvoidanceInput {
  partition: LivingPartition;
  frame: LivingRenderFrame;
  candidateIndices: Uint32Array;
  deltaSeconds: number;
}

export interface LivingLocalAvoidanceResult {
  /** One navmesh-validated local position per candidate, in candidate order. */
  x: Float32Array;
  y: Float32Array;
  navmeshValidated: true;
}

/**
 * Optional near-zone boundary. A real adapter must use an authored navmesh; this
 * package intentionally neither synthesizes a navmesh nor silently falls back to
 * free-space steering.
 */
export interface LivingLocalAvoidanceAdapter {
  readonly maxEntities: number;
  readonly radiusMeters: number;
  readonly maxDisplacementMeters: number;
  status(): LivingAvoidanceStatusReport;
  resolve(input: LivingLocalAvoidanceInput): LivingLocalAvoidanceResult;
  dispose?(): void;
}

export interface LivingAvoidanceApplication {
  frame: LivingRenderFrame;
  report: LivingAvoidanceStatusReport;
  candidateCount: number;
  adjustedCount: number;
}

const DEFAULT_UNAVAILABLE_REASON = 'recast_navigation_not_configured';

function validBoundedInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validatedAdapterBounds(adapter: LivingLocalAvoidanceAdapter): string | null {
  if (!validBoundedInteger(adapter.maxEntities)) return 'invalid_max_entities';
  if (!Number.isFinite(adapter.radiusMeters) || adapter.radiusMeters < 0) return 'invalid_radius';
  if (!Number.isFinite(adapter.maxDisplacementMeters) || adapter.maxDisplacementMeters < 0) {
    return 'invalid_max_displacement';
  }
  return null;
}

export function createUnavailableLivingLocalAvoidance(
  reason = DEFAULT_UNAVAILABLE_REASON,
): LivingLocalAvoidanceAdapter {
  return {
    maxEntities: 0,
    radiusMeters: 0,
    maxDisplacementMeters: 0,
    status: () => ({ status: 'unavailable', reason }),
    resolve: () => {
      throw new Error(`Living local avoidance is unavailable: ${reason}`);
    },
  };
}

/** Selects only the bounded, near, detailed Three.js cohort in stable row order. */
export function selectLivingAvoidanceCandidates(
  partition: LivingPartition,
  frame: LivingRenderFrame,
  adapter: LivingLocalAvoidanceAdapter,
): Uint32Array {
  if (validatedAdapterBounds(adapter) || adapter.maxEntities === 0 || adapter.radiusMeters === 0) {
    return new Uint32Array(0);
  }
  const radiusSquared = adapter.radiusMeters * adapter.radiusMeters;
  const candidates: number[] = [];
  for (let index = 0; index < partition.count && candidates.length < adapter.maxEntities; index += 1) {
    if (partition.presentation.primaryRenderer[index] !== LivingPrimaryRenderer.THREE) continue;
    const lod = partition.presentation.lod[index];
    if (lod !== LivingLod.DETAILED && lod !== LivingLod.FOCUS) continue;
    if (partition.identity.kind[index] === LivingKind.VEHICLE) continue;
    const x = frame.x[index]!;
    const y = frame.y[index]!;
    if (x * x + y * y <= radiusSquared) candidates.push(index);
  }
  return Uint32Array.from(candidates);
}

function degraded(reason: string, frame: LivingRenderFrame, candidateCount = 0): LivingAvoidanceApplication {
  return {
    frame,
    report: { status: 'degraded', reason },
    candidateCount,
    adjustedCount: 0,
  };
}

export function applyLivingLocalAvoidance(
  partition: LivingPartition,
  frame: LivingRenderFrame,
  adapter: LivingLocalAvoidanceAdapter,
  deltaSeconds: number,
): LivingAvoidanceApplication {
  const boundsError = validatedAdapterBounds(adapter);
  if (boundsError) return degraded(boundsError, frame);
  const reported = adapter.status();
  if (reported.status !== 'ready') {
    return { frame, report: reported, candidateCount: 0, adjustedCount: 0 };
  }
  const candidates = selectLivingAvoidanceCandidates(partition, frame, adapter);
  if (candidates.length === 0) {
    return { frame, report: reported, candidateCount: 0, adjustedCount: 0 };
  }
  let result: LivingLocalAvoidanceResult;
  try {
    result = adapter.resolve({ partition, frame, candidateIndices: candidates, deltaSeconds });
  } catch (error) {
    return degraded(error instanceof Error ? `adapter_error:${error.message}` : 'adapter_error', frame, candidates.length);
  }
  if (result.navmeshValidated !== true) return degraded('navmesh_not_validated', frame, candidates.length);
  if (result.x.length !== candidates.length || result.y.length !== candidates.length) {
    return degraded('invalid_result_length', frame, candidates.length);
  }
  const nextX = frame.x.slice();
  const nextY = frame.y.slice();
  let adjustedCount = 0;
  for (let candidate = 0; candidate < candidates.length; candidate += 1) {
    const index = candidates[candidate]!;
    const x = result.x[candidate]!;
    const y = result.y[candidate]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return degraded('non_finite_result', frame, candidates.length);
    const displacement = Math.hypot(x - frame.x[index]!, y - frame.y[index]!);
    if (displacement > adapter.maxDisplacementMeters) {
      return degraded('displacement_limit_exceeded', frame, candidates.length);
    }
    nextX[index] = x;
    nextY[index] = y;
    if (displacement > 0) adjustedCount += 1;
  }
  return {
    frame: { ...frame, x: nextX, y: nextY },
    report: reported,
    candidateCount: candidates.length,
    adjustedCount,
  };
}
