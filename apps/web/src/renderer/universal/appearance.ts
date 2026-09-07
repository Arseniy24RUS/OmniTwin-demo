import type { SunLightState } from '../environment/sunLight';
import type { WeatherSourceProvenance, WeatherUniformState } from '../environment/weather';
import { hashSeed } from '../rng';
import { universalInstanceCaps, universalSemanticLodForZoom } from './lod';
import type {
  UniversalQualityTier,
  UniversalSemanticLod,
  VisualSynthesisDisclosure,
} from './types';

export interface UniversalAppearanceLayerIds {
  readonly background: string;
  readonly forest: string;
  readonly residential: string;
  readonly parks: string;
  readonly water: string;
  readonly waterway: string;
  readonly roadCasing: string;
  readonly roads: string;
}

export const DEFAULT_UNIVERSAL_APPEARANCE_LAYER_IDS: UniversalAppearanceLayerIds = {
  background: 'background',
  forest: 'landcover-wood',
  residential: 'landuse-residential',
  parks: 'parks',
  water: 'water',
  waterway: 'waterway',
  roadCasing: 'roads-casing',
  roads: 'roads',
};

export interface UniversalMapLightStyle {
  readonly anchor: 'map';
  readonly position: readonly [radial: number, azimuthDegrees: number, polarDegrees: number];
  readonly color: string;
  readonly intensity: number;
}

export interface UniversalMapSkyStyle {
  readonly 'sky-color': string;
  readonly 'horizon-color': string;
  readonly 'fog-color': string;
  readonly 'fog-ground-blend': number;
  readonly 'horizon-fog-blend': number;
  readonly 'sky-horizon-blend': number;
  readonly 'atmosphere-blend': number;
}

export type UniversalPaintValue = string | number | boolean | readonly unknown[];

export type UniversalAppearanceCommand =
  | {
    readonly kind: 'set-light';
    readonly value: UniversalMapLightStyle;
  }
  | {
    readonly kind: 'set-sky';
    readonly value: UniversalMapSkyStyle;
  }
  | {
    readonly kind: 'set-paint-property';
    readonly layerId: string;
    readonly property: string;
    readonly value: UniversalPaintValue;
  };

export interface UniversalBuildingEnvironmentStyle {
  /** Consumed by source-backed building expressions; never creates geometry. */
  readonly verticalGradient: true;
  readonly daylight: number;
  readonly shadowOpacity: number;
  readonly windowEmission: number;
  readonly wetness: number;
  readonly snowCover: number;
}

export type UniversalShadowMode =
  | 'contact_ao'
  | 'contact_ao_projected_flat';
export type UniversalWaterMode = 'static_directional_gloss';
export type UniversalVegetationMode =
  | 'forest_fill'
  | 'canopy_only'
  | 'canopy_billboards';

export interface UniversalProjectedShadowStyle {
  readonly mode: UniversalShadowMode;
  /** One map-anchored pixel offset shared by the source-backed footprint layer. */
  readonly bucketTranslations: readonly (readonly [x: number, y: number])[];
  readonly opacity: number;
}

export interface UniversalWaterAppearanceStyle {
  readonly mode: UniversalWaterMode;
  readonly pitchBucket: 0 | 1 | 2 | 3;
  /** Unprefixed material key; the MapLibre sprite owner adds its namespace. */
  readonly patternId: string;
  readonly opacity: number;
}

export interface UniversalPrecipitationLayerDescriptor extends VisualSynthesisDisclosure {
  readonly id: 'universal-screen-space-precipitation';
  readonly owner: 'interleaved_overlay';
  readonly coordinateSpace: 'screen';
  readonly mode: 'none' | 'rain' | 'snow';
  readonly activeInstances: number;
  readonly maximumInstances: number;
  readonly requiresAnimation: boolean;
  readonly weatherSourceProvenance: WeatherSourceProvenance;
}

export interface UniversalAppearanceFrame {
  readonly version: 1;
  readonly frameKey: string;
  readonly zoom: number;
  readonly qualityTier: UniversalQualityTier;
  readonly semanticLod: UniversalSemanticLod;
  /** 15-minute presentation-time bucket in the scene-local 24-hour cycle. */
  readonly sunBucket: number;
  readonly waterPitchBucket: 0 | 1 | 2 | 3;
  readonly shadowMode: UniversalShadowMode;
  readonly waterMode: UniversalWaterMode;
  readonly vegetationMode: UniversalVegetationMode;
  /** Renderer presentation contract, distinct from the atlas asset identifier. */
  readonly materialAtlasVersion: '1.0.0';
  readonly light: UniversalMapLightStyle;
  readonly sky: UniversalMapSkyStyle;
  readonly building: UniversalBuildingEnvironmentStyle;
  readonly shadow: UniversalProjectedShadowStyle;
  readonly water: UniversalWaterAppearanceStyle;
  readonly precipitation: UniversalPrecipitationLayerDescriptor;
  /** Complete desired state. Use diffUniversalAppearanceFrames before applying it. */
  readonly commands: readonly UniversalAppearanceCommand[];
  readonly requiresContinuousFrames: boolean;
}

export interface CreateUniversalAppearanceOptions {
  readonly zoom: number;
  readonly pitch: number;
  readonly presentationMinutes: number;
  readonly qualityTier: UniversalQualityTier;
  readonly sun: SunLightState;
  readonly weather: WeatherUniformState;
  readonly reducedMotion?: boolean;
  readonly layerIds?: Partial<UniversalAppearanceLayerIds>;
}

export interface UniversalAppearanceDiff {
  readonly fromFrameKey: string | null;
  readonly toFrameKey: string;
  readonly commands: readonly UniversalAppearanceCommand[];
  readonly precipitationChanged: boolean;
  readonly requiresRepaint: boolean;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function byteHex(value: number): string {
  return Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, '0');
}

function linearChannelToSrgb(value: number): number {
  const linear = clamp01(value);
  return 255 * (linear <= 0.0031308
    ? linear * 12.92
    : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055);
}

function linearRgbToHex(color: readonly [number, number, number]): string {
  return `#${byteHex(linearChannelToSrgb(color[0]))}${byteHex(linearChannelToSrgb(color[1]))}${byteHex(linearChannelToSrgb(color[2]))}`;
}

function hexChannels(color: string): readonly [number, number, number] {
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ];
}

function mixHex(from: string, to: string, amount: number): string {
  const factor = clamp01(amount);
  const left = hexChannels(from);
  const right = hexChannels(to);
  return `#${byteHex(left[0] + (right[0] - left[0]) * factor)}${byteHex(left[1] + (right[1] - left[1]) * factor)}${byteHex(left[2] + (right[2] - left[2]) * factor)}`;
}

function shadedSurface(
  base: string,
  snowTarget: string,
  snowCover: number,
  wetness: number,
  night: number,
): string {
  const snowed = mixHex(base, snowTarget, snowCover);
  const wet = mixHex(snowed, '#07131b', wetness * 0.58);
  return mixHex(wet, '#02070b', night * 0.58);
}

function pitchBucket(pitch: number): 0 | 1 | 2 | 3 {
  if (!Number.isFinite(pitch)) throw new RangeError('pitch must be finite');
  if (pitch < 20) return 0;
  if (pitch < 40) return 1;
  if (pitch < 60) return 2;
  return 3;
}

function presentationSunBucket(presentationMinutes: number): number {
  if (!Number.isFinite(presentationMinutes)) {
    throw new RangeError('presentationMinutes must be finite');
  }
  const normalized = ((presentationMinutes % 1_440) + 1_440) % 1_440;
  return Math.floor(normalized / 15);
}

function vegetationMode(
  zoom: number,
  qualityTier: UniversalQualityTier,
): UniversalVegetationMode {
  if (zoom < 13) return 'forest_fill';
  const billboardZoom = qualityTier === 'low' ? 16 : 14;
  return zoom >= billboardZoom ? 'canopy_billboards' : 'canopy_only';
}

function projectedShadowStyle(
  qualityTier: UniversalQualityTier,
  sun: SunLightState,
): UniversalProjectedShadowStyle {
  const opacity = rounded(clamp01(sun.shadowOpacity) * 0.28);
  if (qualityTier === 'low' || sun.daylight < 0.08 || opacity < 0.01) {
    return { mode: 'contact_ao', bucketTranslations: [], opacity: 0 };
  }
  const altitudeRadians = Math.max(8, Math.min(80, sun.altitudeDegrees)) * Math.PI / 180;
  const maximumDistance = Math.max(2.5, Math.min(18, 7.5 / Math.tan(altitudeRadians)));
  const azimuthRadians = sun.azimuthDegrees * Math.PI / 180;
  const directionX = -Math.sin(azimuthRadians);
  const directionY = Math.cos(azimuthRadians);
  return {
    mode: 'contact_ao_projected_flat',
    bucketTranslations: [[
      rounded(directionX * maximumDistance, 100),
      rounded(directionY * maximumDistance, 100),
    ]],
    opacity,
  };
}

function rounded(value: number, precision = 10_000): number {
  return Math.round(value * precision) / precision;
}

function commandKey(command: UniversalAppearanceCommand): string {
  return command.kind === 'set-paint-property'
    ? `${command.kind}\u0000${command.layerId}\u0000${command.property}`
    : command.kind;
}

function commandEqual(
  left: UniversalAppearanceCommand | undefined,
  right: UniversalAppearanceCommand,
): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function buildSurfaceCommands(
  ids: UniversalAppearanceLayerIds,
  sun: SunLightState,
  weather: WeatherUniformState,
): readonly UniversalAppearanceCommand[] {
  const night = 1 - clamp01(sun.daylight);
  const wetness = clamp01(weather.wetness);
  const snow = clamp01(weather.snowCover);
  const roadPrimary = shadedSurface('#4c5558', '#7c817f', snow * 0.32, wetness, night);
  const roadSecondary = shadedSurface('#3d494d', '#727875', snow * 0.3, wetness, night);
  const roadLocal = shadedSurface('#303c42', '#696f6d', snow * 0.28, wetness, night);

  return [
    {
      kind: 'set-paint-property',
      layerId: ids.background,
      property: 'background-color',
      value: shadedSurface('#687064', '#aeb4ad', snow * 0.42, wetness * 0.15, night),
    },
    {
      kind: 'set-paint-property',
      layerId: ids.forest,
      property: 'fill-color',
      value: shadedSurface('#3f6247', '#b7beb7', snow * 0.86, wetness * 0.2, night),
    },
    {
      kind: 'set-paint-property',
      layerId: ids.residential,
      property: 'fill-color',
      value: shadedSurface('#77766c', '#b7bab5', snow * 0.58, wetness * 0.2, night),
    },
    {
      kind: 'set-paint-property',
      layerId: ids.parks,
      property: 'fill-color',
      value: shadedSurface('#537552', '#c0c6bf', snow * 0.9, wetness * 0.2, night),
    },
    {
      kind: 'set-paint-property',
      layerId: ids.water,
      property: 'fill-color',
      value: shadedSurface('#3b7588', '#849aa2', snow * 0.28, wetness * 0.12, night),
    },
    {
      kind: 'set-paint-property',
      layerId: ids.waterway,
      property: 'line-color',
      value: shadedSurface('#3a8299', '#8198a2', snow * 0.25, wetness * 0.12, night),
    },
    {
      kind: 'set-paint-property',
      layerId: ids.roadCasing,
      property: 'line-color',
      value: shadedSurface('#182126', '#bdc3c0', snow * 0.52, wetness * 0.42, night),
    },
    {
      kind: 'set-paint-property',
      layerId: ids.roads,
      property: 'line-color',
      value: [
        'match',
        ['get', 'class'],
        ['motorway', 'trunk', 'primary'],
        roadPrimary,
        ['secondary', 'tertiary'],
        roadSecondary,
        roadLocal,
      ],
    },
  ];
}

/** Builds deterministic MapLibre-native appearance state without mutating a map. */
export function createUniversalAppearanceFrame(
  options: CreateUniversalAppearanceOptions,
): UniversalAppearanceFrame {
  if (!Number.isFinite(options.zoom)) throw new RangeError('zoom must be finite');
  const sunBucket = presentationSunBucket(options.presentationMinutes);
  const waterPitchBucket = pitchBucket(options.pitch);
  const reducedMotion = options.reducedMotion ?? options.weather.reducedMotion;
  const layerIds = { ...DEFAULT_UNIVERSAL_APPEARANCE_LAYER_IDS, ...options.layerIds };
  const fogStrength = clamp01((options.weather.fogDensity - 0.00035) / 0.0032);
  const light: UniversalMapLightStyle = {
    anchor: 'map',
    position: [
      1.5,
      rounded(options.sun.azimuthDegrees, 100),
      rounded(Math.max(15, Math.min(85, 90 - options.sun.altitudeDegrees)), 100),
    ],
    color: linearRgbToHex(options.sun.colorLinear),
    intensity: rounded(clamp01(0.08 + options.sun.directionalIntensity / 3.5)),
  };
  const sky: UniversalMapSkyStyle = {
    'sky-color': linearRgbToHex(options.weather.skyZenithLinear),
    'horizon-color': linearRgbToHex(options.weather.skyHorizonLinear),
    'fog-color': linearRgbToHex(options.weather.fogColorLinear),
    'fog-ground-blend': rounded(0.12 + fogStrength * 0.52),
    'horizon-fog-blend': rounded(0.3 + fogStrength * 0.62),
    'sky-horizon-blend': rounded(0.46 + options.weather.cloudCover * 0.34),
    'atmosphere-blend': rounded(0.5 + options.weather.cloudCover * 0.42),
  };
  const caps = universalInstanceCaps(options.qualityTier);
  const shadow = projectedShadowStyle(options.qualityTier, options.sun);
  const resolvedVegetationMode = vegetationMode(options.zoom, options.qualityTier);
  const waterWeather = options.weather.mode === 'rain'
    ? 'rain'
    : options.sun.daylight < 0.16
      ? 'night'
      : options.sun.daylight < 0.58
        ? 'dusk'
        : 'day';
  const water: UniversalWaterAppearanceStyle = {
    mode: 'static_directional_gloss',
    pitchBucket: waterPitchBucket,
    patternId: `water-gloss-${waterPitchBucket}-${waterWeather}`,
    opacity: rounded(0.13 + clamp01(options.sun.daylight) * 0.14),
  };
  const precipitationMode = options.weather.mode === 'rain' || options.weather.mode === 'snow'
    ? options.weather.mode
    : 'none';
  const activePrecipitation = reducedMotion || precipitationMode === 'none'
    ? 0
    : Math.min(caps.maxPrecipitationInstances, Math.max(0, options.weather.particleCount));
  const precipitation: UniversalPrecipitationLayerDescriptor = {
    id: 'universal-screen-space-precipitation',
    owner: 'interleaved_overlay',
    coordinateSpace: 'screen',
    mode: precipitationMode,
    activeInstances: activePrecipitation,
    maximumInstances: caps.maxPrecipitationInstances,
    requiresAnimation: activePrecipitation > 0,
    weatherSourceProvenance: options.weather.sourceProvenance,
    provenance: 'visual_synthesis',
    temporalMapping: 'visual_synthesis',
    scientificClaim: false,
    displayLabel: `Визуализация осадков · ${options.weather.displayLabel}`,
  };
  const commands: readonly UniversalAppearanceCommand[] = [
    { kind: 'set-light', value: light },
    { kind: 'set-sky', value: sky },
    ...buildSurfaceCommands(layerIds, options.sun, options.weather),
  ];
  const semanticLod = universalSemanticLodForZoom(options.zoom);
  const signature = JSON.stringify({
    zoom: rounded(options.zoom, 100),
    sunBucket,
    waterPitchBucket,
    qualityTier: options.qualityTier,
    semanticLod,
    light,
    sky,
    commands,
    precipitation,
    shadow,
    water,
    resolvedVegetationMode,
  });

  return {
    version: 1,
    frameKey: `universal-appearance-${hashSeed(signature).toString(16).padStart(8, '0')}`,
    zoom: options.zoom,
    qualityTier: options.qualityTier,
    semanticLod,
    sunBucket,
    waterPitchBucket,
    shadowMode: shadow.mode,
    waterMode: water.mode,
    vegetationMode: resolvedVegetationMode,
    materialAtlasVersion: '1.0.0',
    light,
    sky,
    building: {
      verticalGradient: true,
      daylight: clamp01(options.sun.daylight),
      shadowOpacity: clamp01(options.sun.shadowOpacity),
      windowEmission: clamp01(options.sun.windowEmission),
      wetness: clamp01(options.weather.wetness),
      snowCover: clamp01(options.weather.snowCover),
    },
    shadow,
    water,
    precipitation,
    commands,
    requiresContinuousFrames: precipitation.requiresAnimation,
  };
}

/** Returns only state changes so a paused/static map does not repaint continuously. */
export function diffUniversalAppearanceFrames(
  previous: UniversalAppearanceFrame | null,
  next: UniversalAppearanceFrame,
): UniversalAppearanceDiff {
  const previousCommands = new Map(
    previous?.commands.map((command) => [commandKey(command), command]) ?? [],
  );
  const commands = next.commands.filter(
    (command) => !commandEqual(previousCommands.get(commandKey(command)), command),
  );
  const precipitationChanged = JSON.stringify(previous?.precipitation ?? null)
    !== JSON.stringify(next.precipitation);
  return {
    fromFrameKey: previous?.frameKey ?? null,
    toFrameKey: next.frameKey,
    commands,
    precipitationChanged,
    requiresRepaint: commands.length > 0 || precipitationChanged,
  };
}
