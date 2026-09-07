import type {
  EnvironmentCyclePayloadV1,
  EnvironmentCycleV1,
  SceneSourceSnapshotV1,
} from '@omnitwin/contracts';
import { createDeterministicRng } from '../rng';
import { mapToEnvironmentCycle2025 } from './cycle2025';
import {
  SYNTHETIC_WEATHER_LABEL_RU,
  createExternalEnvironmentWeatherSample,
  reanalysisSourceFromSnapshot,
  validateExternalEnvironmentSource,
  validateExternalWeatherVariables,
  validateWeatherSample2025,
  type EnvironmentWeatherUnavailableReason,
  type ExternalEnvironmentSource,
  type LivingCityWeatherMode,
  type WeatherSample2025,
} from './weather';

export type EnvironmentCyclePlaybackCycle = EnvironmentCycleV1;

export interface EnvironmentCyclePlaybackSource {
  /** SHA of the manifest bytes already verified by the scene runtime. */
  readonly manifestSha256: string;
  readonly sceneId: string;
  readonly sceneTimeZone: string;
  readonly cycle: EnvironmentCyclePlaybackCycle;
  /** Payload bytes were hash-verified and Zod-parsed by SceneRuntime. */
  readonly payload: EnvironmentCyclePayloadV1;
  readonly payloadSha256: string;
  readonly sourceSnapshot: SceneSourceSnapshotV1;
}

export interface CompiledEnvironmentCyclePlayback {
  readonly manifestSha256: string;
  readonly sourceInputSha256: string;
  readonly sceneId: string;
  readonly sceneTimeZone: string;
  readonly cycle: EnvironmentCyclePlaybackCycle;
  readonly payload: EnvironmentCyclePayloadV1;
  readonly payloadSha256: string;
  readonly sourceSnapshot: SceneSourceSnapshotV1;
  readonly reanalysisSource: ExternalEnvironmentSource | null;
}

export type EnvironmentCyclePlaybackBinding =
  | { readonly status: 'ready'; readonly binding: CompiledEnvironmentCyclePlayback }
  | { readonly status: 'unavailable'; readonly reason: EnvironmentWeatherUnavailableReason };

export interface EnvironmentCycleSourceReference {
  readonly sourceTimeIso: string;
  readonly weight: number;
}

export const ENVIRONMENT_TEMPORAL_INTERPOLATION_DERIVATION_VERSION = '1.0.0' as const;
export const ENVIRONMENT_TEMPORAL_INTERPOLATION_FORMULA = 'scalars=weighted_mean;precipitation_null=0;condition=max(weight,severity[snow>rain>fog>cloudy>clear],-step_index);wind_from=atan2(sum(weight*speed*sin(from)),sum(weight*speed*cos(from)));wind_speed=hypot(sum(weight*speed*sin(from)),sum(weight*speed*cos(from)))' as const;

export interface EnvironmentCycleTemporalMappingDetails {
  readonly classification: 'visual_synthesis';
  readonly policy: 'daily_cycle' | 'annual_2025_non_leap_replay';
  readonly referenceYear: 2025 | null;
  readonly leapDayPolicy: 'not_applicable' | 'interpolate_feb_28_mar_1';
  readonly derivationVersion:
    | typeof ENVIRONMENT_TEMPORAL_INTERPOLATION_DERIVATION_VERSION
    | null;
  readonly formula: typeof ENVIRONMENT_TEMPORAL_INTERPOLATION_FORMULA | null;
}

export interface ResolvedEnvironmentCycleWeather {
  readonly sample: WeatherSample2025;
  readonly cycleId: string;
  readonly stepIndex: number;
  readonly stepIndices: readonly number[];
  readonly stepStartMinute: number;
  readonly localDateKey: string;
  readonly localMinuteOfDay: number;
  readonly presentationTimeIso: string;
  /** A single source timestamp, or null when leap-day interpolation uses two. */
  readonly sourceTimeIso: string | null;
  readonly sourceReferences: readonly EnvironmentCycleSourceReference[];
  /** Exact cycle fields after temporal interpolation, before visual uniforms. */
  readonly resolvedFields: {
    readonly condition: EnvironmentCyclePayloadV1['steps'][number]['condition'];
    readonly temperatureC: number | null;
    readonly precipitationMmPerHour: number;
    readonly cloudCover: number;
    readonly windMps: number;
    /** Meteorological FROM bearing, clockwise from true north. */
    readonly windDirectionDegrees: number;
  };
  readonly manifestSha256: string;
  readonly payloadSha256: string;
  readonly sourceInputSha256: string;
  readonly temporalMapping: 'visual_synthesis';
  /** Exact API-parity metadata for the deterministic presentation-time replay. */
  readonly temporalMappingDetails: EnvironmentCycleTemporalMappingDetails;
  readonly scientificClaim: false;
}

const SHA256 = /^[a-f0-9]{64}$/iu;
const REFERENCE_YEAR_START_MS = Date.UTC(2025, 0, 1);
const REFERENCE_YEAR_MINUTES = 525_600;

export function environmentCycleTemporalMappingDetails(
  period: EnvironmentCyclePlaybackCycle['period'],
): EnvironmentCycleTemporalMappingDetails {
  return period === 'annual_non_leap'
    ? {
      classification: 'visual_synthesis',
      policy: 'annual_2025_non_leap_replay',
      referenceYear: 2025,
      leapDayPolicy: 'interpolate_feb_28_mar_1',
      derivationVersion: ENVIRONMENT_TEMPORAL_INTERPOLATION_DERIVATION_VERSION,
      formula: ENVIRONMENT_TEMPORAL_INTERPOLATION_FORMULA,
    }
    : {
      classification: 'visual_synthesis',
      policy: 'daily_cycle',
      referenceYear: null,
      leapDayPolicy: 'not_applicable',
      derivationVersion: null,
      formula: null,
    };
}

function expectedProvenance(
  mode: EnvironmentCyclePlaybackCycle['mode'],
): EnvironmentCyclePlaybackCycle['provenance'] {
  return mode === 'visual_preset' ? 'visual_synthesis' : 'reanalysis_environment';
}

function modeFromCondition(
  condition: EnvironmentCyclePayloadV1['steps'][number]['condition'],
): LivingCityWeatherMode {
  return condition === 'fog' ? 'cloudy' : condition;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function intensityFromStep(
  mode: LivingCityWeatherMode,
  precipitationMmPerHour: number,
  cloudCover: number,
): number {
  if (mode === 'rain' || mode === 'snow') {
    return clamp01(1 - Math.exp(-precipitationMmPerHour / 4));
  }
  return mode === 'cloudy' ? clamp01(cloudCover) : 0;
}

function validSteps(
  cycle: EnvironmentCyclePlaybackCycle,
  payload: EnvironmentCyclePayloadV1,
): boolean {
  const annual = cycle.period === 'annual_non_leap';
  if (
    annual !== (cycle.mode !== 'visual_preset')
    || (annual
      ? cycle.referenceYear !== 2025
        || cycle.sourceTimeZone !== 'UTC'
        || cycle.timestepMinutes !== 60
        || cycle.leapDayPolicy !== 'interpolate_feb_28_mar_1'
        || payload.steps.length !== 8_760
      : cycle.referenceYear !== null
        || cycle.sourceTimeZone !== null
        || cycle.leapDayPolicy !== 'not_applicable')
  ) return false;
  const expectedMinutes = annual ? 525_600 : 1_440;
  const expectedStepCount = expectedMinutes / cycle.timestepMinutes;
  if (!Number.isInteger(expectedStepCount) || payload.steps.length !== expectedStepCount) {
    return false;
  }
  let cursor = 0;
  for (const step of payload.steps) {
    if (
      !Number.isInteger(step.startMinute)
      || !Number.isInteger(step.durationMinutes)
      || step.startMinute !== cursor
      || step.durationMinutes !== cycle.timestepMinutes
      || step.startMinute < 0
      || step.startMinute >= expectedMinutes
      || (step.temperatureC !== null
        && (!Number.isFinite(step.temperatureC)
          || step.temperatureC < -100
          || step.temperatureC > 70))
      || step.cloudCover === null
      || !Number.isFinite(step.cloudCover)
      || step.cloudCover < 0
      || step.cloudCover > 1
      || step.windMps === null
      || !Number.isFinite(step.windMps)
      || step.windMps < 0
      || step.windMps > 150
      || (step.precipitationMmPerHour !== null
        && (!Number.isFinite(step.precipitationMmPerHour)
          || step.precipitationMmPerHour < 0
          || step.precipitationMmPerHour > 500))
      || (step.windDirectionDegrees !== null
        && (!Number.isFinite(step.windDirectionDegrees)
          || step.windDirectionDegrees < 0
          || step.windDirectionDegrees >= 360))
      || (annual && step.windDirectionDegrees === null)
      || ((step.condition === 'rain' || step.condition === 'snow')
        && (step.precipitationMmPerHour === null
          || !Number.isFinite(step.precipitationMmPerHour)))
    ) return false;
    cursor += step.durationMinutes;
  }
  return cursor === expectedMinutes;
}

function validFieldSources(
  cycle: EnvironmentCyclePlaybackCycle,
  payload: EnvironmentCyclePayloadV1,
  sourceSnapshot: SceneSourceSnapshotV1,
): boolean {
  const { meteorology, wind, condition } = cycle.fieldSources;
  if (
    meteorology.sourceId !== cycle.sourceId
    || meteorology.provenance !== cycle.provenance
    || condition.provenance !== 'visual_synthesis'
    || !condition.sourceId.trim()
    || !condition.derivationVersion.trim()
    || !condition.formula.trim()
  ) return false;
  const authoredDirection = payload.steps.some((step) => step.windDirectionDegrees !== null);
  if (!authoredDirection) return true;
  if (wind.sourceId !== cycle.sourceId || wind.provenance !== cycle.provenance) return false;

  // A visual preset is itself the pinned authoring source for every visual-only
  // field. It deliberately has no external environmentMetadata to validate.
  // External/reanalysis directions still require an advertised direction field
  // or a documented u/v derivation below.
  if (cycle.provenance === 'visual_synthesis') return true;

  const metadata = sourceSnapshot.environmentMetadata as (
    SceneSourceSnapshotV1['environmentMetadata'] & {
      readonly variableUnits?: Readonly<Record<string, string>>;
    }
  );
  if (!metadata) return false;
  const variables = new Set(metadata.variables);
  const directDirection = variables.has('10m_wind_direction');
  const derivedFromComponents = variables.has('10m_u_component_of_wind')
    && variables.has('10m_v_component_of_wind')
    && wind.derivationVersion !== null
    && wind.formula !== null
    && /atan2/iu.test(wind.formula);
  return directDirection || derivedFromComponents;
}

/**
 * Compiles immutable manifest metadata once. It does not fetch or upgrade
 * provenance and rejects incomplete cycle/source bindings before playback.
 */
export function compileEnvironmentCyclePlayback(
  input: EnvironmentCyclePlaybackSource,
): EnvironmentCyclePlaybackBinding {
  const { cycle, payload, sourceSnapshot } = input;
  if (
    !SHA256.test(input.manifestSha256)
    || !SHA256.test(input.payloadSha256)
    || !SHA256.test(sourceSnapshot.inputSha256)
  ) {
    return { status: 'unavailable', reason: 'MANIFEST_HASH_INVALID' };
  }
  if (cycle.sceneId !== input.sceneId) {
    return { status: 'unavailable', reason: 'CYCLE_SCENE_MISMATCH' };
  }
  if (cycle.timeZone !== input.sceneTimeZone) {
    return { status: 'unavailable', reason: 'CYCLE_TIME_ZONE_MISMATCH' };
  }
  if (cycle.sourceId !== sourceSnapshot.sourceId) {
    return { status: 'unavailable', reason: 'CYCLE_SOURCE_MISMATCH' };
  }
  if (!sourceSnapshot.coverage.geographyIds.includes(cycle.geographyId)) {
    return { status: 'unavailable', reason: 'SOURCE_COVERAGE_MISMATCH' };
  }
  if (
    input.payloadSha256 !== cycle.content.sha256
    || payload.sceneId !== cycle.sceneId
    || payload.cycleId !== cycle.cycleId
    || payload.steps.length !== cycle.content.recordCount
  ) {
    return { status: 'unavailable', reason: 'CYCLE_STEPS_INVALID' };
  }
  if (
    cycle.provenance !== expectedProvenance(cycle.mode)
    || sourceSnapshot.provenance !== cycle.provenance
  ) {
    return { status: 'unavailable', reason: 'CYCLE_PROVENANCE_MISMATCH' };
  }
  if (!validSteps(cycle, payload)) {
    return { status: 'unavailable', reason: 'CYCLE_STEPS_INVALID' };
  }
  if (!validFieldSources(cycle, payload, sourceSnapshot)) {
    return { status: 'unavailable', reason: 'CYCLE_PROVENANCE_MISMATCH' };
  }

  let reanalysisSource: ExternalEnvironmentSource | null = null;
  if (cycle.mode === 'reanalysis_external') {
    reanalysisSource = reanalysisSourceFromSnapshot(sourceSnapshot);
    if (!reanalysisSource) {
      return { status: 'unavailable', reason: 'SOURCE_METADATA_UNSUPPORTED' };
    }
    try {
      validateExternalEnvironmentSource(reanalysisSource);
      validateExternalWeatherVariables(
        reanalysisSource,
        payload.steps.some((step) => step.condition === 'rain' || step.condition === 'snow')
          ? 'rain'
          : 'clear',
      );
    } catch {
      return { status: 'unavailable', reason: 'SOURCE_METADATA_UNSUPPORTED' };
    }
  } else if (
    cycle.mode !== 'visual_preset'
    || sourceSnapshot.sourceType !== 'visual_synthesis'
  ) {
    return { status: 'unavailable', reason: 'CYCLE_SOURCE_UNSUPPORTED' };
  }

  return {
    status: 'ready',
    binding: {
      ...input,
      sourceInputSha256: sourceSnapshot.inputSha256,
      reanalysisSource,
    },
  };
}

type EnvironmentCycleStep = EnvironmentCyclePayloadV1['steps'][number];

interface WeightedEnvironmentCycleStep {
  readonly stepIndex: number;
  readonly step: EnvironmentCycleStep;
  readonly weight: number;
  readonly sourceTimeIso: string | null;
}

const CONDITION_PRIORITY: Readonly<Record<EnvironmentCycleStep['condition'], number>> = {
  clear: 0,
  cloudy: 1,
  fog: 2,
  rain: 3,
  snow: 4,
};

/** Highest temporal weight wins; ties choose the more visually severe condition. */
function categoricalCondition(
  weightedSteps: readonly WeightedEnvironmentCycleStep[],
): EnvironmentCycleStep['condition'] {
  return [...weightedSteps].sort((left, right) =>
    right.weight - left.weight
    || CONDITION_PRIORITY[right.step.condition] - CONDITION_PRIORITY[left.step.condition]
    || left.stepIndex - right.stepIndex)[0]!.step.condition;
}

function weightedScalar(
  weightedSteps: readonly WeightedEnvironmentCycleStep[],
  value: (step: EnvironmentCycleStep) => number,
): number {
  const weightTotal = weightedSteps.reduce((sum, item) => sum + item.weight, 0);
  return weightedSteps.reduce(
    (sum, item) => sum + value(item.step) * item.weight,
    0,
  ) / Math.max(Number.EPSILON, weightTotal);
}

function weightedWind(
  cycleId: string,
  weightedSteps: readonly WeightedEnvironmentCycleStep[],
) {
  let east = 0;
  let north = 0;
  let sourceDirection = true;
  for (const item of weightedSteps) {
    const direction = item.step.windDirectionDegrees
      ?? createDeterministicRng(`${cycleId}:${item.step.startMinute}:wind`)() * 360;
    if (item.step.windDirectionDegrees === null) sourceDirection = false;
    const radians = direction * Math.PI / 180;
    const speed = item.step.windMps!;
    east += Math.sin(radians) * speed * item.weight;
    north += Math.cos(radians) * speed * item.weight;
  }
  return {
    // If any direction is synthesized, keep the reported sourced speed free
    // of RNG by blending the source speed scalars instead.
    speed: sourceDirection
      ? Math.hypot(east, north)
      : weightedScalar(weightedSteps, (step) => step.windMps!),
    directionDegrees: (Math.atan2(east, north) * 180 / Math.PI + 360) % 360,
    sourceDirection,
  };
}

function weightedReferenceTimeIso(
  weightedSteps: readonly WeightedEnvironmentCycleStep[],
  fallback: Date,
): string {
  const sourced = weightedSteps.filter(
    (item): item is WeightedEnvironmentCycleStep & { sourceTimeIso: string } =>
      item.sourceTimeIso !== null,
  );
  if (sourced.length === 0) return fallback.toISOString();
  return new Date(weightedScalar(
    sourced,
    (step) => REFERENCE_YEAR_START_MS + step.startMinute * 60_000,
  )).toISOString();
}

/** Resolves a bound cycle solely from the authoritative presentation clock. */
export function resolveEnvironmentCycleWeather2025(
  binding: CompiledEnvironmentCyclePlayback,
  absolutePresentationSeconds: number,
): ResolvedEnvironmentCycleWeather {
  if (!Number.isFinite(absolutePresentationSeconds)) {
    throw new RangeError('Environment cycle presentation clock must be finite');
  }
  const presentationDate = new Date(absolutePresentationSeconds * 1_000);
  if (!Number.isFinite(presentationDate.valueOf())) {
    throw new RangeError('Environment cycle presentation clock is out of range');
  }
  const mapped = mapToEnvironmentCycle2025(presentationDate, binding.sceneTimeZone);
  const annual = binding.cycle.period === 'annual_non_leap';
  const weightedSteps: readonly WeightedEnvironmentCycleStep[] = annual
    ? mapped.referenceInstants.map((reference) => {
      const sourceMinuteOfYear = (
        (reference.date.valueOf() - REFERENCE_YEAR_START_MS) / 60_000
        % REFERENCE_YEAR_MINUTES
        + REFERENCE_YEAR_MINUTES
      ) % REFERENCE_YEAR_MINUTES;
      const stepIndex = Math.floor(sourceMinuteOfYear / binding.cycle.timestepMinutes);
      const step = binding.payload.steps[stepIndex];
      if (!step) throw new Error('Compiled annual environment cycle step is missing');
      return {
        stepIndex,
        step,
        weight: reference.weight,
        sourceTimeIso: new Date(
          REFERENCE_YEAR_START_MS + step.startMinute * 60_000,
        ).toISOString(),
      };
    })
    : (() => {
      const stepIndex = binding.payload.steps.findIndex((step) =>
        mapped.localMinuteOfDay >= step.startMinute
        && mapped.localMinuteOfDay < step.startMinute + step.durationMinutes);
      const step = binding.payload.steps[stepIndex];
      return stepIndex < 0 || !step
        ? []
        : [{ stepIndex, step, weight: 1, sourceTimeIso: null }];
    })();
  if (weightedSteps.length === 0) {
    throw new Error('Compiled environment cycle has no step for local presentation time');
  }
  const step = weightedSteps[0]!.step;
  const stepIndex = weightedSteps[0]!.stepIndex;
  const condition = categoricalCondition(weightedSteps);
  const mode = modeFromCondition(condition);
  const temperatureC = weightedSteps.every((item) => item.step.temperatureC !== null)
    ? weightedScalar(weightedSteps, (item) => item.temperatureC!)
    : null;
  const cloudCover = weightedScalar(weightedSteps, (item) => item.cloudCover!);
  const precipitationMmPerHour = weightedScalar(
    weightedSteps,
    (item) => item.precipitationMmPerHour ?? 0,
  );
  const wind = weightedWind(binding.cycle.cycleId, weightedSteps);
  const sourceReferences = weightedSteps
    .filter(
      (item): item is WeightedEnvironmentCycleStep & { sourceTimeIso: string } =>
        item.sourceTimeIso !== null,
    )
    .map((item) => ({ sourceTimeIso: item.sourceTimeIso, weight: item.weight }));
  const sourceTimeIso = sourceReferences.length === 1
    ? sourceReferences[0]!.sourceTimeIso
    : null;
  const windDirectionProvenance = wind.sourceDirection
    ? binding.cycle.fieldSources.wind.provenance
    : 'visual_synthesis' as const;
  const values = {
    mode,
    intensity: intensityFromStep(mode, precipitationMmPerHour, cloudCover),
    cloudCover,
    windSpeedMetersPerSecond: wind.speed,
    windDirectionDegrees: wind.directionDegrees,
    referenceTimeIso: weightedReferenceTimeIso(
      weightedSteps,
      mapped.referenceInstants[0]!.date,
    ),
    sourceReferences,
  } as const;
  const sample: WeatherSample2025 = binding.reanalysisSource
    ? createExternalEnvironmentWeatherSample({
      ...values,
      source: binding.reanalysisSource,
      modeProvenance: binding.cycle.fieldSources.condition.provenance,
      windDirectionProvenance,
    }, 'reanalysis_environment')
    : {
      ...values,
      displayLabel: SYNTHETIC_WEATHER_LABEL_RU,
      sourceProvenance: 'visual_synthesis',
      temporalMapping: 'visual_synthesis',
      scientificClaim: false,
      sourceReferences: [],
      fieldProvenance: {
        mode: 'visual_synthesis',
        intensity: 'visual_synthesis',
        cloudCover: 'visual_synthesis',
        windSpeedMetersPerSecond: 'visual_synthesis',
        windDirectionDegrees: 'visual_synthesis',
      },
    };
  validateWeatherSample2025(sample);

  return {
    sample,
    cycleId: binding.cycle.cycleId,
    stepIndex,
    stepIndices: weightedSteps.map((item) => item.stepIndex),
    stepStartMinute: step.startMinute,
    localDateKey: mapped.localDateKey,
    localMinuteOfDay: mapped.localMinuteOfDay,
    presentationTimeIso: presentationDate.toISOString(),
    sourceTimeIso,
    sourceReferences,
    resolvedFields: {
      condition,
      temperatureC,
      precipitationMmPerHour,
      cloudCover,
      windMps: wind.speed,
      windDirectionDegrees: wind.directionDegrees,
    },
    manifestSha256: binding.manifestSha256,
    payloadSha256: binding.payloadSha256,
    sourceInputSha256: binding.sourceInputSha256,
    temporalMapping: 'visual_synthesis',
    temporalMappingDetails: environmentCycleTemporalMappingDetails(binding.cycle.period),
    scientificClaim: false,
  };
}
