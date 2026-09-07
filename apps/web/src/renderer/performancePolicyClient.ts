import {
  RendererPerformancePolicyV3Schema,
  type RendererPerformancePolicyV3,
} from '@omnitwin/contracts';

export type RendererPerformancePolicyTier = RendererPerformancePolicyV3['tier'];

export interface RendererPerformancePolicyV3Request {
  readonly tier: RendererPerformancePolicyTier;
  readonly reducedMotion: boolean;
  readonly signal?: AbortSignal;
}

export type RendererPerformancePolicyV3ClientErrorKind =
  | 'http'
  | 'invalid_json'
  | 'invalid_contract'
  | 'identity_mismatch'
  | 'network';

export class RendererPerformancePolicyV3ClientError extends Error {
  readonly kind: RendererPerformancePolicyV3ClientErrorKind;
  readonly status: number | null;

  constructor(
    kind: RendererPerformancePolicyV3ClientErrorKind,
    message: string,
    options: { readonly status?: number; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RendererPerformancePolicyV3ClientError';
    this.kind = kind;
    this.status = options.status ?? null;
  }
}

const PERFORMANCE_POLICY_V3_PATH = '/v2/presentation/performance-policy';
const ACCEPTED_POLICY_TTL_MS = 5 * 60 * 1_000;
const acceptedPolicyCache = new Map<string, {
  readonly policy: RendererPerformancePolicyV3;
  readonly expiresAtMs: number;
}>();
const conservativePolicyCache = new Map<boolean, RendererPerformancePolicyV3>();

function requestKey(request: RendererPerformancePolicyV3Request): string {
  return `${request.tier}:${request.reducedMotion ? 'reduced' : 'motion'}`;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true
    || (error instanceof DOMException && error.name === 'AbortError')
    || (error instanceof Error && error.name === 'AbortError');
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * Local safety floor used while V3 is loading or unavailable. It intentionally
 * chooses the low tier and never enables decorative motion passes.
 */
export function conservativeRendererPerformancePolicyV3(
  reducedMotion: boolean,
): RendererPerformancePolicyV3 {
  const cached = conservativePolicyCache.get(reducedMotion);
  if (cached) return cached;
  const phase = (buildingMode: 'aggregate_2_5d' | 'single_extrusion' | 'full_budgeted', actorMode: 'aggregate' | 'individual' | 'budgeted') => ({
    buildingMode,
    actorMode,
    contactAo: false,
    projectedShadow: false,
    facadePattern: false,
    roofCap: false,
    treeBillboards: false,
  });
  const parsed = RendererPerformancePolicyV3Schema.parse({
    contractVersion: '3',
    policyId: 'universal_lowpoly_motion_floor_v3',
    tier: 'low',
    targetFps: 30,
    targetFrameBudgetMs: 33.333,
    minimumMovingFps: 30,
    movingFrameBudgetMs: 33.333,
    pitchMaxDegrees: 60,
    workerCount: 1,
    reducedMotion,
    scheduler: {
      mode: 'invalidation_driven_capped',
      maxFps: 30,
      deckAnimate: false,
      continuousRepaint: false,
      pausedMode: 'event_driven',
    },
    dprLadder: [0.75, 0.67, 0.5],
    lod: {
      individualActorsMinZoom: 15.5,
      livingCellZoom: 16,
      guardRingCells: 1,
      moving: {
        buildingsMaxOverscale: 2,
        buildingsTileLodBias: 1.25,
        basemapMaxOverscale: 2,
        basemapTileLodBias: 1.5,
      },
      settled: {
        buildingsMaxOverscale: 3,
        buildingsTileLodBias: 2,
        basemapMaxOverscale: 3,
        basemapTileLodBias: 2,
      },
    },
    watchdog: {
      overBudgetFrameMs: 33.333,
      emergencyAfterMs: 500,
      compatibilityAfterMs: 1_500,
      recoveryAfterMs: 10_000,
      minimumStepIntervalMs: 5_000,
      gpuMinimumSamples: 30,
      gpuSampleDeadlineMs: 1_000,
    },
    phaseProfiles: {
      general_plan: phase('aggregate_2_5d', 'aggregate'),
      camera_motion: phase('single_extrusion', 'aggregate'),
      living_motion: phase('single_extrusion', reducedMotion ? 'aggregate' : 'individual'),
      settled_paused: {
        ...phase('full_budgeted', 'budgeted'),
        treeBillboards: true,
      },
      emergency_30: phase('single_extrusion', 'aggregate'),
      compatibility_30: phase('aggregate_2_5d', 'aggregate'),
    },
    degradationOrder: [
      'motion_profile',
      'dpr',
      'individual_actors',
      'contact_ao',
      'aggregate_buildings',
      'compatibility_30',
    ],
  });
  const policy = deepFreeze(parsed);
  conservativePolicyCache.set(reducedMotion, policy);
  return policy;
}

/**
 * Fetches the negotiated V3 policy and publishes only a schema-validated,
 * request-bound value. Invalid and failed responses are deliberately not
 * cached, so a later settlement mount may recover without a page reload.
 */
export async function fetchRendererPerformancePolicyV3(
  request: RendererPerformancePolicyV3Request,
): Promise<RendererPerformancePolicyV3> {
  if (request.signal?.aborted) throw abortReason(request.signal);
  const key = requestKey(request);
  const cached = acceptedPolicyCache.get(key);
  if (cached && cached.expiresAtMs > Date.now()) return cached.policy;
  if (cached) acceptedPolicyCache.delete(key);

  const parameters = new URLSearchParams({
    contractVersion: '3',
    tier: request.tier,
    reducedMotion: String(request.reducedMotion),
  });
  let response: Response;
  try {
    response = await fetch(`${PERFORMANCE_POLICY_V3_PATH}?${parameters}`, {
      signal: request.signal,
      cache: 'default',
      headers: { Accept: 'application/json' },
    });
  } catch (error) {
    if (isAbortError(error, request.signal)) throw error;
    throw new RendererPerformancePolicyV3ClientError(
      'network',
      'Renderer performance policy V3 request failed',
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new RendererPerformancePolicyV3ClientError(
      'http',
      `Renderer performance policy V3 request failed (${response.status})`,
      { status: response.status },
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new RendererPerformancePolicyV3ClientError(
      'invalid_json',
      'Renderer performance policy V3 response is not valid JSON',
      { cause: error },
    );
  }
  const parsed = RendererPerformancePolicyV3Schema.safeParse(payload);
  if (!parsed.success) {
    throw new RendererPerformancePolicyV3ClientError(
      'invalid_contract',
      'Renderer performance policy V3 response failed contract validation',
      { cause: parsed.error },
    );
  }
  if (
    parsed.data.tier !== request.tier
    || parsed.data.reducedMotion !== request.reducedMotion
  ) {
    throw new RendererPerformancePolicyV3ClientError(
      'identity_mismatch',
      'Renderer performance policy V3 response does not match the requested profile',
    );
  }
  if (request.signal?.aborted) throw abortReason(request.signal);
  const policy = deepFreeze(parsed.data);
  acceptedPolicyCache.set(key, {
    policy,
    expiresAtMs: Date.now() + ACCEPTED_POLICY_TTL_MS,
  });
  return policy;
}

/** Test-only reset kept explicit so production callers cannot bypass validation. */
export function clearRendererPerformancePolicyV3CacheForTests(): void {
  acceptedPolicyCache.clear();
}
