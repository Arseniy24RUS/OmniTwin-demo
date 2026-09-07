import type { EnvironmentStateV1, SceneSourceSnapshotV1 } from '@omnitwin/contracts';
import { createDeterministicRng } from '../rng';
import type { EnvironmentCycle2025 } from './cycle2025';
import type { SunLightState } from './sunLight';

export type LivingCityWeatherMode = 'clear' | 'cloudy' | 'rain' | 'snow';
export const SYNTHETIC_WEATHER_LABEL_RU = 'Синтетический погодный пресет';
export const VISUAL_WEATHER_OVERRIDE_LABEL_RU =
  'Визуальная погода · ручная настройка · не данные модели';
export const VERIFIED_ERA5_WEATHER_LABEL_RU = 'Погодный цикл ERA5 2025 · повторяемый · реанализ';
export type WeatherSourceProvenance =
  | 'reanalysis_environment'
  | 'external_environment'
  | 'visual_synthesis';

interface ExternalEnvironmentSourceBase {
  readonly snapshotId: string;
  /** Must distinguish final ERA5 from preliminary ERA5T and pin its revision. */
  readonly revision: string;
  readonly retrievedAt: string;
  readonly sha256: string;
  readonly licenseSpdx: string;
  readonly licenseUrl: string;
  readonly variables: readonly string[];
  readonly variableUnits: Readonly<Record<string, string>>;
  readonly temporalResolution: 'PT1H';
  readonly grid: {
    readonly crs: 'EPSG:4326';
    readonly resolutionDegrees: readonly [longitude: number, latitude: number];
  };
  readonly coverage: {
    readonly start: string;
    readonly end: string;
    readonly bbox: readonly [west: number, south: number, east: number, north: number];
  };
}

export type ExternalEnvironmentSource = ExternalEnvironmentSourceBase & (
  | {
    readonly dataset: 'ERA5';
    readonly datasetId: 'reanalysis-era5-single-levels';
    readonly datasetDoi: '10.24381/cds.adbb2d47';
  }
  | {
    readonly dataset: 'ERA5-Land';
    readonly datasetId: 'reanalysis-era5-land';
    readonly datasetDoi: '10.24381/cds.e2161bac';
  }
);

interface WeatherSampleBase {
  readonly mode: LivingCityWeatherMode;
  readonly intensity: number;
  readonly cloudCover: number;
  readonly windSpeedMetersPerSecond: number;
  /** Meteorological FROM bearing, clockwise from true north. */
  readonly windDirectionDegrees: number;
  readonly referenceTimeIso: string;
  readonly sourceReferences: readonly EnvironmentSourceReference[];
  readonly displayLabel: string;
  readonly temporalMapping: 'visual_synthesis';
  readonly scientificClaim: false;
  readonly fieldProvenance: WeatherFieldProvenance;
}

export interface EnvironmentSourceReference {
  readonly sourceTimeIso: string;
  readonly weight: number;
}

export type WeatherSample2025 = WeatherSampleBase & (
  | {
    readonly sourceProvenance: 'visual_synthesis';
    readonly source?: never;
  }
  | {
    readonly sourceProvenance: 'reanalysis_environment' | 'external_environment';
    readonly source: ExternalEnvironmentSource;
  }
);

export interface WeatherFieldProvenance {
  readonly mode: WeatherSourceProvenance;
  readonly intensity: 'visual_synthesis';
  readonly cloudCover: WeatherSourceProvenance;
  readonly windSpeedMetersPerSecond: WeatherSourceProvenance;
  readonly windDirectionDegrees: WeatherSourceProvenance;
}

export interface WeatherUniformState {
  readonly mode: LivingCityWeatherMode;
  readonly skyZenithLinear: readonly [number, number, number];
  readonly skyHorizonLinear: readonly [number, number, number];
  readonly fogColorLinear: readonly [number, number, number];
  readonly fogDensity: number;
  readonly cloudCover: number;
  readonly wetness: number;
  readonly snowCover: number;
  readonly precipitation: number;
  readonly windEast: number;
  readonly windNorth: number;
  readonly windAnimationRate: number;
  readonly particleCount: number;
  readonly particleSpeedMetersPerSecond: number;
  readonly particleLengthMeters: number;
  readonly reducedMotion: boolean;
  readonly sourceProvenance: WeatherSourceProvenance;
  readonly source?: ExternalEnvironmentSource;
  readonly temporalMapping: 'visual_synthesis';
  readonly scientificClaim: false;
  readonly displayLabel: string;
  readonly sourceReferences: readonly EnvironmentSourceReference[];
  readonly fieldProvenance: WeatherFieldProvenance;
}

export type EnvironmentWeatherUnavailableReason =
  | 'SOURCE_SNAPSHOT_REQUIRED'
  | 'SOURCE_ID_MISMATCH'
  | 'SOURCE_PROVENANCE_MISMATCH'
  | 'SOURCE_COVERAGE_MISMATCH'
  | 'SOURCE_METADATA_UNSUPPORTED'
  | 'SOURCE_VALUES_INCOMPLETE'
  | 'MANIFEST_HASH_INVALID'
  | 'CYCLE_REQUIRED'
  | 'CYCLE_AMBIGUOUS'
  | 'CYCLE_SCENE_MISMATCH'
  | 'CYCLE_TIME_ZONE_MISMATCH'
  | 'CYCLE_SOURCE_MISMATCH'
  | 'CYCLE_PROVENANCE_MISMATCH'
  | 'CYCLE_STEPS_INVALID'
  | 'CYCLE_SOURCE_UNSUPPORTED';

export type EnvironmentWeatherBinding =
  | { readonly status: 'ready'; readonly sample: WeatherSample2025 }
  | {
    readonly status: 'unavailable';
    readonly reason: EnvironmentWeatherUnavailableReason;
  };

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function validateExternalEnvironmentSource(source: ExternalEnvironmentSource): void {
  if (!/^[a-f0-9]{64}$/i.test(source.sha256)) {
    throw new RangeError('External environment source requires a SHA-256 hash');
  }
  if (
    !source.snapshotId.trim()
    || !source.revision.trim()
    || /\b(?:ERA5T|preliminary|provisional|near[- ]real[- ]time|unverified|unpinned)\b/i
      .test(source.revision)
    || !Number.isFinite(Date.parse(source.retrievedAt))
    || source.variables.length === 0
    || source.variables.some((variable) => !variable.trim())
    || new Set(source.variables).size !== source.variables.length
    || source.temporalResolution !== 'PT1H'
    || Object.keys(source.variableUnits).length !== source.variables.length
    || source.variables.some((variable) => !source.variableUnits[variable]?.trim())
    || source.grid.crs !== 'EPSG:4326'
    || source.grid.resolutionDegrees.some((resolution) => !Number.isFinite(resolution) || resolution <= 0)
    || !Number.isFinite(Date.parse(source.coverage.start))
    || !Number.isFinite(Date.parse(source.coverage.end))
    || Date.parse(source.coverage.start) > Date.parse(source.coverage.end)
    || Date.parse(source.coverage.start) > Date.parse('2025-01-01T00:00:00Z')
    || Date.parse(source.coverage.end) < Date.parse('2025-12-31T23:00:00Z')
    || source.coverage.bbox.some((coordinate) => !Number.isFinite(coordinate))
    || source.coverage.bbox[0] < -180
    || source.coverage.bbox[2] > 180
    || source.coverage.bbox[1] < -90
    || source.coverage.bbox[3] > 90
    || source.coverage.bbox[0] >= source.coverage.bbox[2]
    || source.coverage.bbox[1] >= source.coverage.bbox[3]
    || source.licenseSpdx !== 'CC-BY-4.0'
    || !source.licenseUrl.startsWith('https://')
  ) {
    throw new RangeError('External environment source metadata is incomplete or unpinned');
  }
  if (
    (source.dataset === 'ERA5'
      && (source.datasetId !== 'reanalysis-era5-single-levels'
        || source.datasetDoi !== '10.24381/cds.adbb2d47'))
    || (source.dataset === 'ERA5-Land'
      && (source.datasetId !== 'reanalysis-era5-land'
        || source.datasetDoi !== '10.24381/cds.e2161bac'))
  ) {
    throw new RangeError('External environment dataset identifier/DOI mismatch');
  }
  if (
    source.dataset === 'ERA5-Land'
    && source.variables.includes('total_cloud_cover')
  ) {
    throw new RangeError(
      'ERA5-Land source metadata cannot advertise the ERA5 total_cloud_cover field',
    );
  }
}

export function validateExternalWeatherVariables(
  source: ExternalEnvironmentSource,
  mode: LivingCityWeatherMode,
): void {
  const variables = new Set(source.variables);
  const hasWind = variables.has('10m_u_component_of_wind')
    && variables.has('10m_v_component_of_wind');
  const hasCloudCover = variables.has('total_cloud_cover');
  const hasPrecipitation = variables.has('total_precipitation');
  if (
    !hasWind
    || !hasCloudCover
    || ((mode === 'rain' || mode === 'snow') && !hasPrecipitation)
  ) {
    throw new RangeError(
      'External environment source variables do not cover rendered weather fields',
    );
  }
}

/** Runtime boundary guard for samples deserialized from the Presentation API. */
export function validateWeatherSample2025(sample: WeatherSample2025): void {
  if (
    !['clear', 'cloudy', 'rain', 'snow'].includes(sample.mode)
    || !Number.isFinite(sample.intensity)
    || sample.intensity < 0
    || sample.intensity > 1
    || !Number.isFinite(sample.cloudCover)
    || sample.cloudCover < 0
    || sample.cloudCover > 1
    || !Number.isFinite(sample.windSpeedMetersPerSecond)
    || sample.windSpeedMetersPerSecond < 0
    || sample.windSpeedMetersPerSecond > 150
    || !Number.isFinite(sample.windDirectionDegrees)
    || sample.windDirectionDegrees < 0
    || sample.windDirectionDegrees >= 360
    || !Number.isFinite(Date.parse(sample.referenceTimeIso))
    || sample.temporalMapping !== 'visual_synthesis'
    || sample.scientificClaim !== false
  ) {
    throw new RangeError('Weather sample metadata or values are invalid');
  }
  const fieldValues = Object.values(sample.fieldProvenance);
  const sourceWeight = sample.sourceReferences.reduce(
    (sum, reference) => sum + reference.weight,
    0,
  );
  if (
    sample.sourceReferences.length > 2
    || sample.sourceReferences.some((reference) =>
      !Number.isFinite(Date.parse(reference.sourceTimeIso))
      || !Number.isFinite(reference.weight)
      || reference.weight <= 0
      || reference.weight > 1)
    || new Set(sample.sourceReferences.map((reference) => reference.sourceTimeIso)).size
      !== sample.sourceReferences.length
  ) {
    throw new RangeError('Weather source references are invalid');
  }
  if (
    fieldValues.length !== 5
    || fieldValues.some((value) => ![
      'reanalysis_environment', 'external_environment', 'visual_synthesis',
    ].includes(value))
    || sample.fieldProvenance.intensity !== 'visual_synthesis'
  ) {
    throw new RangeError('Weather field-level provenance is incomplete');
  }
  if (sample.sourceProvenance === 'visual_synthesis') {
    if (
      sample.source !== undefined
      || sample.sourceReferences.length !== 0
      || ![
        SYNTHETIC_WEATHER_LABEL_RU,
        VISUAL_WEATHER_OVERRIDE_LABEL_RU,
      ].includes(sample.displayLabel)
      || fieldValues.some((value) => value !== 'visual_synthesis')
    ) {
      throw new RangeError('Synthetic weather must use the explicit synthetic preset label');
    }
    return;
  }
  validateExternalEnvironmentSource(sample.source);
  const referenceTime = Date.parse(sample.referenceTimeIso);
  const coverageStart = Date.parse(sample.source.coverage.start);
  const coverageEnd = Date.parse(sample.source.coverage.end);
  const referenceTimes = sample.sourceReferences.map(
    (reference) => Date.parse(reference.sourceTimeIso),
  );
  const weightedReferenceTime = sample.sourceReferences.reduce(
    (total, reference, index) => total + referenceTimes[index]! * reference.weight,
    0,
  ) / Math.max(Number.EPSILON, sourceWeight);
  if (
    sample.sourceReferences.length < 1
    || Math.abs(sourceWeight - 1) > 1e-9
    || referenceTimes.some((instant) => instant < coverageStart || instant > coverageEnd)
    || referenceTime < coverageStart
    || referenceTime > coverageEnd
    || Math.abs(referenceTime - weightedReferenceTime) > 1
  ) {
    throw new RangeError('External weather requires covered weighted source references');
  }
  if (
    ![sample.sourceProvenance, 'visual_synthesis'].includes(sample.fieldProvenance.mode)
    || sample.fieldProvenance.cloudCover !== sample.sourceProvenance
    || sample.fieldProvenance.windSpeedMetersPerSecond !== sample.sourceProvenance
    || ![
      sample.sourceProvenance,
      'visual_synthesis',
    ].includes(sample.fieldProvenance.windDirectionDegrees)
  ) {
    throw new RangeError('External weather field provenance does not match its source axis');
  }
  const expectedLabel = sample.sourceProvenance === 'reanalysis_environment'
    ? sample.source.dataset === 'ERA5'
      ? VERIFIED_ERA5_WEATHER_LABEL_RU
      : 'Погодный цикл ERA5-Land 2025 · повторяемый · реанализ'
    : 'Внешний погодный источник · повторяемый визуальный цикл 2025';
  if (sample.displayLabel !== expectedLabel) {
    throw new RangeError('External weather display label does not match its provenance');
  }
}

function mix(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  amount: number,
): readonly [number, number, number] {
  const factor = clamp01(amount);
  return [
    from[0] + (to[0] - from[0]) * factor,
    from[1] + (to[1] - from[1]) * factor,
    from[2] + (to[2] - from[2]) * factor,
  ];
}

/**
 * Creates an explicitly synthetic weather sample for demos and user controls.
 * Real ERA5 values must enter through a separately verified importer.
 */
export function createVisualWeatherSample(
  cycle: EnvironmentCycle2025,
  mode: LivingCityWeatherMode,
  intensity = 0.7,
  seed: number | string = 'omnitwin-weather',
): WeatherSample2025 {
  const normalizedIntensity = clamp01(intensity);
  const rng = createDeterministicRng(
    `${seed}:${cycle.localDateKey}:${Math.floor(cycle.localMinuteOfDay / 30)}:${mode}`,
  );
  const baseCloudCover: Record<LivingCityWeatherMode, number> = {
    clear: 0.08,
    cloudy: 0.58,
    rain: 0.78,
    snow: 0.74,
  };
  const windRange: Record<LivingCityWeatherMode, readonly [number, number]> = {
    clear: [0.5, 3.2],
    cloudy: [1.8, 6.2],
    rain: [3.2, 9.5],
    snow: [1.2, 6.8],
  };
  const wind = windRange[mode];
  return {
    mode,
    intensity: mode === 'clear' ? 0 : normalizedIntensity,
    cloudCover: clamp01(baseCloudCover[mode] + normalizedIntensity * 0.2 + rng() * 0.06),
    windSpeedMetersPerSecond: wind[0] + (wind[1] - wind[0]) * rng(),
    windDirectionDegrees: rng() * 360,
    referenceTimeIso: cycle.referenceInstants[0]?.date.toISOString() ?? '',
    sourceReferences: [],
    displayLabel: SYNTHETIC_WEATHER_LABEL_RU,
    sourceProvenance: 'visual_synthesis',
    temporalMapping: 'visual_synthesis',
    scientificClaim: false,
    fieldProvenance: {
      mode: 'visual_synthesis',
      intensity: 'visual_synthesis',
      cloudCover: 'visual_synthesis',
      windSpeedMetersPerSecond: 'visual_synthesis',
      windDirectionDegrees: 'visual_synthesis',
    },
  };
}

/** Explicit user-facing visual override; it never inherits model/source provenance. */
export function createVisualWeatherOverrideSample(
  cycle: EnvironmentCycle2025,
  mode: LivingCityWeatherMode,
  intensity = 0.7,
  seed: number | string = 'omnitwin-weather-visual-override',
): WeatherSample2025 {
  const sample = {
    ...createVisualWeatherSample(cycle, mode, intensity, seed),
    displayLabel: VISUAL_WEATHER_OVERRIDE_LABEL_RU,
  } satisfies WeatherSample2025;
  validateWeatherSample2025(sample);
  return sample;
}

export function deriveWeatherUniforms(
  sample: WeatherSample2025,
  sun: SunLightState,
  particleCap: number,
  reducedMotion = false,
): WeatherUniformState {
  validateWeatherSample2025(sample);
  const intensity = clamp01(sample.intensity);
  const cloudCover = clamp01(sample.cloudCover);
  const night = 1 - sun.daylight;
  const clearZenith = mix([0.025, 0.045, 0.11], [0.18, 0.48, 0.86], sun.daylight);
  const clearHorizon = mix([0.08, 0.09, 0.18], [0.62, 0.78, 0.92], sun.daylight);
  const stormZenith: readonly [number, number, number] = [0.16, 0.2, 0.24];
  const stormHorizon: readonly [number, number, number] = [0.34, 0.38, 0.4];
  const snowSky: readonly [number, number, number] = [0.5, 0.57, 0.62];
  const weatherColor = sample.mode === 'snow' ? snowSky : stormZenith;
  const weatherHorizon = sample.mode === 'snow' ? [0.68, 0.71, 0.72] as const : stormHorizon;
  const weatherFactor = cloudCover * (0.35 + intensity * 0.65);
  const skyZenithLinear = mix(clearZenith, weatherColor, weatherFactor);
  const skyHorizonLinear = mix(clearHorizon, weatherHorizon, weatherFactor);
  const fogColorLinear = mix(skyHorizonLinear, [0.12, 0.14, 0.18], night * 0.52);
  const directionRadians = sample.windDirectionDegrees * Math.PI / 180;
  const precipitation = sample.mode === 'rain' || sample.mode === 'snow' ? intensity : 0;
  const targetParticles = Math.round(
    Math.max(0, particleCap) * precipitation * (sample.mode === 'snow' ? 0.72 : 1),
  );

  return {
    mode: sample.mode,
    skyZenithLinear,
    skyHorizonLinear,
    fogColorLinear,
    fogDensity: 0.00045 + cloudCover * 0.00115 + precipitation * 0.0018,
    cloudCover,
    wetness: sample.mode === 'rain' ? intensity : 0,
    snowCover: sample.mode === 'snow' ? intensity : 0,
    precipitation,
    // Contract direction is meteorological FROM; particles need the TOWARD vector.
    windEast: -Math.sin(directionRadians) * sample.windSpeedMetersPerSecond,
    windNorth: -Math.cos(directionRadians) * sample.windSpeedMetersPerSecond,
    windAnimationRate: reducedMotion ? 0 : sample.windSpeedMetersPerSecond,
    particleCount: reducedMotion ? 0 : targetParticles,
    particleSpeedMetersPerSecond: sample.mode === 'snow'
      ? 0.7 + intensity * 1.1
      : 8 + intensity * 12,
    particleLengthMeters: sample.mode === 'rain' ? 0.8 + intensity * 1.8 : 0.08,
    reducedMotion,
    sourceProvenance: sample.sourceProvenance,
    source: sample.source,
    temporalMapping: sample.temporalMapping,
    scientificClaim: false,
    displayLabel: sample.displayLabel,
    sourceReferences: sample.sourceReferences,
    fieldProvenance: sample.fieldProvenance,
  };
}

/** Creates a verified external-environment sample after importer hash checks. */
export function createExternalEnvironmentWeatherSample(
  values: Omit<
    WeatherSampleBase,
    | 'displayLabel'
    | 'temporalMapping'
    | 'scientificClaim'
    | 'fieldProvenance'
    | 'sourceReferences'
  > & {
    readonly source: ExternalEnvironmentSource;
    readonly sourceReferences?: readonly EnvironmentSourceReference[];
    readonly modeProvenance?: WeatherSourceProvenance;
    /** Visual synthesis until a verified u/v-derived direction is supplied. */
    readonly windDirectionProvenance?: WeatherSourceProvenance;
  },
  sourceProvenance: 'reanalysis_environment' | 'external_environment' = 'reanalysis_environment',
): WeatherSample2025 {
  validateExternalEnvironmentSource(values.source);
  validateExternalWeatherVariables(values.source, values.mode);
  const displayLabel = sourceProvenance === 'reanalysis_environment'
    ? values.source.dataset === 'ERA5'
      ? VERIFIED_ERA5_WEATHER_LABEL_RU
      : 'Погодный цикл ERA5-Land 2025 · повторяемый · реанализ'
    : 'Внешний погодный источник · повторяемый визуальный цикл 2025';
  const {
    modeProvenance,
    windDirectionProvenance,
    sourceReferences = [{ sourceTimeIso: values.referenceTimeIso, weight: 1 }],
    ...sampleValues
  } = values;
  const sample: WeatherSample2025 = {
    ...sampleValues,
    sourceReferences,
    displayLabel,
    sourceProvenance,
    temporalMapping: 'visual_synthesis',
    scientificClaim: false,
    fieldProvenance: {
      mode: modeProvenance ?? sourceProvenance,
      intensity: 'visual_synthesis',
      cloudCover: sourceProvenance,
      windSpeedMetersPerSecond: sourceProvenance,
      windDirectionDegrees: windDirectionProvenance ?? 'visual_synthesis',
    },
  };
  validateWeatherSample2025(sample);
  return sample;
}

function weatherModeFromEnvironment(
  condition: EnvironmentStateV1['condition'],
): LivingCityWeatherMode {
  return condition === 'fog' ? 'cloudy' : condition;
}

function referenceTimeFromEnvironment(environment: EnvironmentStateV1): string {
  if (environment.sourceTime) return environment.sourceTime;
  if (environment.sourceReferences.length === 0) return environment.validFrom;
  const weight = environment.sourceReferences.reduce(
    (total, reference) => total + reference.weight,
    0,
  );
  const weightedTime = environment.sourceReferences.reduce(
    (total, reference) => total + Date.parse(reference.sourceTimeIso) * reference.weight,
    0,
  ) / Math.max(Number.EPSILON, weight);
  return Number.isFinite(weightedTime)
    ? new Date(weightedTime).toISOString()
    : environment.validFrom;
}

function visualIntensity(
  mode: LivingCityWeatherMode,
  precipitationMmPerHour: number | null,
  cloudCover: number | null,
): number {
  if (mode === 'rain' || mode === 'snow') {
    return clamp01(1 - Math.exp(-(precipitationMmPerHour ?? 0) / 4));
  }
  return mode === 'cloudy' ? clamp01(cloudCover ?? 0) : 0;
}

function deterministicWindDirection(environment: EnvironmentStateV1): number {
  const referenceTime = environment.sourceTime ?? (
    environment.sourceReferences
      .map((item) => `${item.sourceTimeIso}:${item.weight}`)
      .join('|')
    || environment.validFrom
  );
  return createDeterministicRng(
    `${environment.sourceId}:${referenceTime}:${environment.condition}:wind-direction`,
  )() * 360;
}

type EnvironmentStateWithFieldSources = EnvironmentStateV1 & Readonly<{
  windDirectionDegrees: number | null;
  fieldSources: Readonly<{
    wind: Readonly<{
      provenance: WeatherSourceProvenance;
    }>;
    condition: Readonly<{
      provenance: 'visual_synthesis';
    }>;
  }>;
}>;

function validEnvironmentFieldSources(
  environment: EnvironmentStateWithFieldSources,
  sourceSnapshot: SceneSourceSnapshotV1,
): boolean {
  const { meteorology, wind, condition } = environment.fieldSources;
  if (
    meteorology.sourceId !== environment.sourceId
    || meteorology.provenance !== environment.provenance
    || condition.provenance !== 'visual_synthesis'
    || !condition.sourceId.trim()
    || !condition.derivationVersion.trim()
    || !condition.formula.trim()
  ) return false;
  if (
    environment.windDirectionDegrees === null
    || wind.provenance === 'visual_synthesis'
  ) return true;
  if (
    wind.sourceId !== environment.sourceId
    || wind.provenance !== environment.provenance
    || !sourceSnapshot.environmentMetadata
  ) return false;
  const variables = new Set(sourceSnapshot.environmentMetadata.variables);
  if (variables.has('10m_wind_direction')) return true;
  return variables.has('10m_u_component_of_wind')
    && variables.has('10m_v_component_of_wind')
    && wind.derivationVersion !== null
    && wind.formula !== null
    && /atan2/iu.test(wind.formula);
}

export function reanalysisSourceFromSnapshot(
  source: SceneSourceSnapshotV1,
): ExternalEnvironmentSource | null {
  const metadata = source.environmentMetadata;
  const typedMetadata = metadata as (typeof metadata & {
    readonly variableUnits?: Readonly<Record<string, string>>;
    readonly temporalResolution?: string;
  });
  if (
    source.sourceType !== 'environment'
    || source.provenance !== 'reanalysis_environment'
    || !metadata
    || source.license.name !== 'CC-BY-4.0'
    || source.license.url === null
    || metadata.grid.crs !== 'EPSG:4326'
    || typedMetadata.temporalResolution !== 'PT1H'
    || !typedMetadata.variableUnits
  ) return null;

  const common = {
    snapshotId: source.sourceId,
    revision: metadata.revision,
    retrievedAt: metadata.retrievedAt,
    sha256: source.inputSha256,
    licenseSpdx: source.license.name,
    licenseUrl: source.license.url,
    variables: metadata.variables,
    variableUnits: typedMetadata.variableUnits,
    temporalResolution: 'PT1H' as const,
    grid: {
      crs: 'EPSG:4326' as const,
      resolutionDegrees: [
        metadata.grid.resolutionDegrees,
        metadata.grid.resolutionDegrees,
      ] as const,
    },
    coverage: {
      start: metadata.temporalCoverage.start,
      end: metadata.temporalCoverage.end,
      bbox: source.coverage.bbox,
    },
  };
  if (
    metadata.datasetId === 'reanalysis-era5-single-levels'
    && metadata.doi === '10.24381/cds.adbb2d47'
  ) {
    return {
      ...common,
      dataset: 'ERA5',
      datasetId: 'reanalysis-era5-single-levels',
      datasetDoi: '10.24381/cds.adbb2d47',
    };
  }
  if (
    metadata.datasetId === 'reanalysis-era5-land'
    && metadata.doi === '10.24381/cds.e2161bac'
  ) {
    return {
      ...common,
      dataset: 'ERA5-Land',
      datasetId: 'reanalysis-era5-land',
      datasetDoi: '10.24381/cds.e2161bac',
    };
  }
  return null;
}

/**
 * Binds a contract EnvironmentStateV1 to renderer weather without upgrading
 * provenance. Reanalysis requires its exact immutable manifest source snapshot.
 */
export function bindEnvironmentWeatherSample(
  environment: EnvironmentStateV1,
  sourceSnapshot?: SceneSourceSnapshotV1,
): EnvironmentWeatherBinding {
  const mode = weatherModeFromEnvironment(environment.condition);
  const enriched = environment as EnvironmentStateWithFieldSources;
  const referenceTimeIso = referenceTimeFromEnvironment(environment);
  const windDirectionDegrees = enriched.windDirectionDegrees
    ?? deterministicWindDirection(environment);
  if (environment.provenance === 'visual_synthesis') {
    const sample: WeatherSample2025 = {
      mode,
      intensity: visualIntensity(
        mode,
        environment.precipitationMmPerHour,
        environment.cloudCover,
      ),
      cloudCover: clamp01(environment.cloudCover ?? 0),
      windSpeedMetersPerSecond: Math.max(0, environment.windMps ?? 0),
      windDirectionDegrees,
      referenceTimeIso,
      sourceReferences: [],
      displayLabel: SYNTHETIC_WEATHER_LABEL_RU,
      sourceProvenance: 'visual_synthesis',
      temporalMapping: 'visual_synthesis',
      scientificClaim: false,
      fieldProvenance: {
        mode: 'visual_synthesis',
        intensity: 'visual_synthesis',
        cloudCover: 'visual_synthesis',
        windSpeedMetersPerSecond: 'visual_synthesis',
        windDirectionDegrees: 'visual_synthesis',
      },
    };
    validateWeatherSample2025(sample);
    return { status: 'ready', sample };
  }

  if (!sourceSnapshot) {
    return { status: 'unavailable', reason: 'SOURCE_SNAPSHOT_REQUIRED' };
  }
  if (sourceSnapshot.sourceId !== environment.sourceId) {
    return { status: 'unavailable', reason: 'SOURCE_ID_MISMATCH' };
  }
  if (sourceSnapshot.provenance !== environment.provenance) {
    return { status: 'unavailable', reason: 'SOURCE_PROVENANCE_MISMATCH' };
  }
  const temporalCoverage = sourceSnapshot.environmentMetadata?.temporalCoverage;
  const temporalStart = Date.parse(temporalCoverage?.start ?? '');
  const temporalEnd = Date.parse(temporalCoverage?.end ?? '');
  const sourceTimes = [
    ...(environment.sourceTime ? [environment.sourceTime] : []),
    ...environment.sourceReferences.map((reference) => reference.sourceTimeIso),
  ];
  if (
    !sourceSnapshot.coverage.geographyIds.includes(environment.geographyId)
    || !Number.isFinite(temporalStart)
    || !Number.isFinite(temporalEnd)
    || sourceTimes.length === 0
    || sourceTimes.some((sourceTime) => {
      const instant = Date.parse(sourceTime);
      return !Number.isFinite(instant) || instant < temporalStart || instant > temporalEnd;
    })
  ) {
    return { status: 'unavailable', reason: 'SOURCE_COVERAGE_MISMATCH' };
  }
  if (!validEnvironmentFieldSources(enriched, sourceSnapshot)) {
    return { status: 'unavailable', reason: 'SOURCE_PROVENANCE_MISMATCH' };
  }
  const source = reanalysisSourceFromSnapshot(sourceSnapshot);
  if (!source) {
    return { status: 'unavailable', reason: 'SOURCE_METADATA_UNSUPPORTED' };
  }
  if (
    environment.cloudCover === null
    || environment.windMps === null
    || ((mode === 'rain' || mode === 'snow')
      && environment.precipitationMmPerHour === null)
  ) {
    return { status: 'unavailable', reason: 'SOURCE_VALUES_INCOMPLETE' };
  }
  try {
    const sample = createExternalEnvironmentWeatherSample({
      mode,
      intensity: visualIntensity(
        mode,
        environment.precipitationMmPerHour,
        environment.cloudCover,
      ),
      cloudCover: environment.cloudCover,
      windSpeedMetersPerSecond: environment.windMps,
      windDirectionDegrees,
      referenceTimeIso,
      sourceReferences: environment.sourceReferences,
      source,
      modeProvenance: enriched.fieldSources.condition.provenance,
      windDirectionProvenance: enriched.windDirectionDegrees === null
        ? 'visual_synthesis'
        : enriched.fieldSources.wind.provenance,
    }, 'reanalysis_environment');
    return { status: 'ready', sample };
  } catch {
    return { status: 'unavailable', reason: 'SOURCE_METADATA_UNSUPPORTED' };
  }
}
