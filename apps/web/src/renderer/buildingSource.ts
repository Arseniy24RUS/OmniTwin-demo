import type {
  BuildingFootprintV1,
  BuildingHeightQuality,
  MapSourceDescriptorV1,
  NormalizedBuildingV1,
  RendererBuildingSelection,
} from './types';
import { VERIFIED_CITY_BUILDING_PROVIDER_ID } from './verifiedCityBuildingTypes';
import {CANONICAL_FACADE_VARIANT_EXPRESSION} from './buildingFacadePolicy';

type StyleExpression = readonly unknown[];

/** Semantic geometry layers only: decorative AO, shadows and roof caps are excluded. */
export const BUILDING_PICK_LAYER_IDS = Object.freeze([
  'building',
  'building-3d',
  'building-parts',
  'building-parts-3d',
  'omnitwin-building-facade-3d',
  'omnitwin-building-parts-facade-3d',
  'omnitwin-building-motion-3d',
  'omnitwin-building-motion-flat',
] as const);

export interface RendererBuildingFeature {
  readonly id?: string | number | null;
  readonly source?: string;
  readonly sourceLayer?: string;
  readonly properties?: Readonly<Record<string, unknown>> | null;
  readonly layer?: { readonly id?: string };
}

export function buildingStyleSourceId(descriptor: MapSourceDescriptorV1): string {
  return descriptor.id === 'openmaptiles_buildings' ? 'openmaptiles' : 'omnitwin-buildings';
}

export function buildingHighlightFilter(featureId: string, verifiedSource: boolean): StyleExpression {
  // Extrusion filters see the raw vector-tile ID, before FeatureIndex applies
  // promoteId for native picking. Full compiled strings are not numeric MVT IDs.
  return verifiedSource ? ['==', ['get', 'canonical_id'], featureId]
    : ['==', ['to-string', ['coalesce', ['id'], ['get', 'id']]], featureId];
}

function isSelectableSourceFeature(descriptor: MapSourceDescriptorV1 | null, feature: RendererBuildingFeature): boolean {
  return Boolean(descriptor && descriptor.role === 'buildings'
    && feature.source === buildingStyleSourceId(descriptor) && feature.layer?.id
    && (BUILDING_PICK_LAYER_IDS as readonly string[]).includes(feature.layer.id));
}

/** A rejected foreground identity must not select a different building behind it. */
export function resolveRendererBuildingPick(
  descriptor: MapSourceDescriptorV1 | null,
  features: readonly RendererBuildingFeature[],
  verifiedCanonicalIds?: ReadonlySet<string>,
): RendererBuildingSelection | null {
  const foreground = features.find(feature => isSelectableSourceFeature(descriptor, feature));
  return foreground ? resolveRendererBuildingSelection(descriptor, foreground, verifiedCanonicalIds) : null;
}

/** Resolves only exact source IDs and rejects features left behind by another provider/style. */
export function resolveRendererBuildingSelection(
  descriptor: MapSourceDescriptorV1 | null,
  feature: RendererBuildingFeature,
  verifiedCanonicalIds?: ReadonlySet<string>,
): RendererBuildingSelection | null {
  if (!descriptor || !feature.layer?.id || !isSelectableSourceFeature(descriptor, feature)) return null;
  const rawId = feature.id ?? feature.properties?.id;
  if (typeof rawId !== 'string' && typeof rawId !== 'number') return null;
  const featureId = String(rawId).trim();
  if (!featureId) return null;
  if (descriptor.id === VERIFIED_CITY_BUILDING_PROVIDER_ID) {
    if (feature.properties?.canonical_id !== featureId || !verifiedCanonicalIds?.has(featureId)) return null;
    return Object.freeze({ canonicalId: featureId, providerId: descriptor.id, datasetVersion: descriptor.datasetVersion,
      featureId, layerId: feature.layer.id, sourceLayer: null });
  }
  // Planetiler marks merged OpenFreeMap features with a trailing zero. One
  // group may contain many unrelated buildings, even if its representative ID
  // happens to match an indexed OSM way. Never interpret it as one resident roster.
  if (descriptor.id === 'openmaptiles_buildings' && /^\d*0$/u.test(featureId)) return null;
  return Object.freeze({
    canonicalId: `${descriptor.id}:${featureId}`,
    providerId: descriptor.id,
    datasetVersion: descriptor.datasetVersion,
    featureId,
    layerId: feature.layer.id,
    sourceLayer: feature.sourceLayer ?? null,
  });
}

export interface ResolvedBuildingHeight {
  heightM: number;
  quality: BuildingHeightQuality;
}

export interface SourceBuildingInput {
  source: MapSourceDescriptorV1;
  featureId: string | number | null;
  footprint: BuildingFootprintV1 | null;
  properties: Readonly<Record<string, unknown>>;
}

const positiveNumberCondition = (property: string): StyleExpression => [
  'all',
  ['has', property],
  ['>', ['to-number', ['get', property], -1], 0],
];

const numberExpression = (property: string): StyleExpression => [
  'to-number',
  ['get', property],
  -1,
];

const FLOOR_COUNT_EXPRESSION: StyleExpression = [
  'case',
  positiveNumberCondition('num_floors'), numberExpression('num_floors'),
  positiveNumberCondition('building:levels'), numberExpression('building:levels'),
  positiveNumberCondition('levels'), numberExpression('levels'),
  0,
];

/** Shared MapLibre expression: authored height -> floors*3m -> provider height -> 5m. */
export const BUILDING_HEIGHT_EXPRESSION: StyleExpression = Object.freeze([
  'case',
  positiveNumberCondition('height'), numberExpression('height'),
  ['>', FLOOR_COUNT_EXPRESSION, 0], ['*', FLOOR_COUNT_EXPRESSION, 3],
  positiveNumberCondition('render_height'), numberExpression('render_height'),
  5,
]);

export const BUILDING_BASE_HEIGHT_EXPRESSION: StyleExpression = Object.freeze([
  'case',
  positiveNumberCondition('min_height'), numberExpression('min_height'),
  positiveNumberCondition('render_min_height'), numberExpression('render_min_height'),
  0,
]);

const PRESENTATION_HEIGHT_MIN_ZOOM = 13;
const PRESENTATION_HEIGHT_MAX_ZOOM = 16;
const PRESENTATION_HEIGHT_MIN_METERS = 180;
const PRESENTATION_HEIGHT_MAX_METERS = 500;

export function presentationHeightLimitM(zoom: number): number {
  if (!Number.isFinite(zoom)) throw new RangeError('zoom must be finite');
  const boundedZoom = Math.max(
    PRESENTATION_HEIGHT_MIN_ZOOM,
    Math.min(PRESENTATION_HEIGHT_MAX_ZOOM, zoom),
  );
  const progress = (boundedZoom - PRESENTATION_HEIGHT_MIN_ZOOM)
    / (PRESENTATION_HEIGHT_MAX_ZOOM - PRESENTATION_HEIGHT_MIN_ZOOM);
  return PRESENTATION_HEIGHT_MIN_METERS
    + progress * (PRESENTATION_HEIGHT_MAX_METERS - PRESENTATION_HEIGHT_MIN_METERS);
}

export function isPresentationHeightClamped(heightM: number, zoom: number): boolean {
  if (!Number.isFinite(heightM)) throw new RangeError('heightM must be finite');
  return heightM > presentationHeightLimitM(zoom);
}

const PRESENTATION_HEIGHT_STOPS = [13, 14, 15, 16].map((zoom) => ({
  zoom,
  limitM: presentationHeightLimitM(zoom),
}));

/** Public cap curve for diagnostics and equivalent non-feature expressions. */
export const PRESENTATION_BUILDING_HEIGHT_LIMIT_EXPRESSION: StyleExpression = Object.freeze([
  'interpolate',
  ['linear'],
  ['zoom'],
  PRESENTATION_HEIGHT_MIN_ZOOM, PRESENTATION_HEIGHT_MIN_METERS,
  PRESENTATION_HEIGHT_MAX_ZOOM, PRESENTATION_HEIGHT_MAX_METERS,
]);

function presentationHeightExpression(extraMeters = 0): StyleExpression {
  const expression: unknown[] = ['interpolate', ['linear'], ['zoom']];
  for (const stop of PRESENTATION_HEIGHT_STOPS) {
    const capped: StyleExpression = ['min', BUILDING_HEIGHT_EXPRESSION, stop.limitM];
    expression.push(stop.zoom, extraMeters === 0 ? capped : ['+', capped, extraMeters]);
  }
  return expression;
}

/**
 * MapLibre requires zoom to drive the top-level interpolate. Integer stops
 * apply min(raw, limit); interpolation remains conservative between stops.
 */
export const PRESENTATION_BUILDING_HEIGHT_EXPRESSION: StyleExpression = Object.freeze(
  presentationHeightExpression(),
);

export const PRESENTATION_BUILDING_ROOF_HEIGHT_EXPRESSION: StyleExpression = Object.freeze(
  presentationHeightExpression(0.25),
);

const FALLBACK_HEIGHT_PALETTE: StyleExpression = [
  'interpolate',
  ['linear'],
  BUILDING_HEIGHT_EXPRESSION,
  0, '#d7c3a7',
  12, '#caa27b',
  30, '#b7a59b',
  80, '#9ca7ad',
  180, '#7d878b',
];

const colorLiteral = (value: string): StyleExpression => ['to-color', value];

const CLASS_PALETTE: StyleExpression = [
  'match',
  ['coalesce', ['get', 'building'], ['get', 'class'], ['get', 'subtype'], ''],
  ['apartments', 'residential', 'house', 'detached', 'semidetached_house'], colorLiteral('#caa27b'),
  ['commercial', 'retail', 'office'], colorLiteral('#a5b1b1'),
  ['industrial', 'warehouse', 'manufacture'], colorLiteral('#9e755c'),
  ['school', 'university', 'college', 'kindergarten'], colorLiteral('#c7b98d'),
  ['hospital', 'clinic'], colorLiteral('#c8a6a2'),
  ['civic', 'public', 'government'], colorLiteral('#b5afaa'),
  FALLBACK_HEIGHT_PALETTE,
];

const SOURCE_OR_CLASS_COLOR_EXPRESSION: StyleExpression = [
  'to-color',
  ['get', 'facade_color'],
  ['get', 'facade_colour'],
  ['get', 'colour'],
  ['get', 'color'],
  CLASS_PALETTE,
];

/**
 * Source facade colors retain their hue, then pass through a fixed warm-grey
 * art-direction blend. This prevents unbounded source saturation from turning
 * the nationwide map neon while classification and height remain deterministic
 * fallbacks.
 */
export const LOW_POLY_BUILDING_COLOR_EXPRESSION: StyleExpression = Object.freeze([
  'interpolate',
  ['linear'],
  0.32,
  0, SOURCE_OR_CLASS_COLOR_EXPRESSION,
  1, colorLiteral('#b9b6aa'),
]);

const normalizedSourceTextExpression = (...properties: readonly string[]): StyleExpression => [
  'downcase',
  ['to-string', ['coalesce', ...properties.map((property) => ['get', property]), '']],
];

const FACADE_MATERIAL_EXPRESSION = normalizedSourceTextExpression(
  'facade_material',
  'building_material',
  'building:material',
  'material',
);

const BUILDING_CLASS_EXPRESSION: StyleExpression = [
  'coalesce',
  ['get', 'building'],
  ['get', 'class'],
  ['get', 'subtype'],
  '',
];

const facadeVariants=(...patterns:readonly string[]):StyleExpression=>[
  'match',CANONICAL_FACADE_VARIANT_EXPRESSION,0,`omnitwin:facade-${patterns[0]}`,1,`omnitwin:facade-${patterns[1]}`,
  2,`omnitwin:facade-${patterns[2]}`,`omnitwin:facade-${patterns[3]}`,
];
const RESIDENTIAL_FACADE_VARIANTS:StyleExpression=['case',['>=',BUILDING_HEIGHT_EXPRESSION,15],
  facadeVariants('concrete','plaster','civic','concrete'),facadeVariants('plaster','ochre','sandstone','civic')];
/** Pre-tinted atlas selection because fill-extrusion-pattern replaces color.
 * Explicit source materials win. Unobserved finishes vary only as deterministic
 * visual synthesis; IDs, source tags, heights and footprints are never modified. */
export const BUILDING_FACADE_PATTERN_EXPRESSION: StyleExpression = Object.freeze([
  'match',
  FACADE_MATERIAL_EXPRESSION,
  ['brick', 'bricks'], 'omnitwin:facade-brick',
  ['stone', 'sandstone', 'limestone'], 'omnitwin:facade-sandstone',
  ['concrete', 'panel', 'panels', 'reinforced_concrete'], 'omnitwin:facade-concrete',
  ['metal', 'glass', 'steel'], 'omnitwin:facade-slate',
  ['plaster', 'stucco'], 'omnitwin:facade-plaster',
  ['wood', 'timber'], 'omnitwin:facade-ochre',
  [
    'match',
    BUILDING_CLASS_EXPRESSION,
    ['industrial', 'warehouse', 'manufacture'], 'omnitwin:facade-industrial',
    ['school', 'university', 'college', 'kindergarten', 'hospital', 'clinic', 'civic', 'public', 'government'], 'omnitwin:facade-civic',
    ['commercial', 'retail', 'office'], facadeVariants('plaster','slate','civic','sandstone'),
    ['house', 'detached', 'semidetached_house'], 'omnitwin:facade-ochre',
    ['apartments', 'residential'], RESIDENTIAL_FACADE_VARIANTS,
    [
      'step',
      BUILDING_HEIGHT_EXPRESSION,
      facadeVariants('sandstone','plaster','ochre','brick'),
      12, facadeVariants('plaster','brick','civic','sandstone'),
      30, facadeVariants('concrete','slate','plaster','civic'),
      80, 'omnitwin:facade-slate',
    ],
  ],
]);

const ROOF_MATERIAL_EXPRESSION = normalizedSourceTextExpression(
  'roof_material',
  'roof:material',
);

const ROOF_COLOR_EXPRESSION = normalizedSourceTextExpression(
  'roof_color',
  'roof_colour',
  'roof:colour',
);

export const BUILDING_ROOF_PATTERN_EXPRESSION: StyleExpression = Object.freeze([
  'match',
  ROOF_MATERIAL_EXPRESSION,
  ['tile', 'tiles', 'roof_tiles', 'clay'], 'omnitwin:roof-tile',
  ['metal', 'steel', 'copper', 'zinc'], 'omnitwin:roof-metal',
  ['bitumen', 'asphalt', 'tar_paper'], 'omnitwin:roof-bitumen',
  ['grass', 'green', 'plants'], 'omnitwin:roof-green',
  ['concrete', 'cement'], 'omnitwin:roof-concrete',
  [
    'match',
    ROOF_COLOR_EXPRESSION,
    ['red', 'brown', 'orange'], 'omnitwin:roof-tile',
    ['silver', 'gray', 'grey'], 'omnitwin:roof-metal',
    ['black', 'darkgrey', 'darkgray'], 'omnitwin:roof-bitumen',
    ['green'], 'omnitwin:roof-green',
    'omnitwin:roof-concrete',
  ],
]);

export const BUILDING_ROOF_HEIGHT_EXPRESSION: StyleExpression = Object.freeze([
  '+',
  BUILDING_HEIGHT_EXPRESSION,
  0.25,
]);

export function resolveSourceBuildingHeight(
  properties: Readonly<Record<string, unknown>>,
): ResolvedBuildingHeight {
  const exact = positiveNumber(properties.height);
  if (exact !== null) return { heightM: exact, quality: 'exact' };

  const floors = firstPositiveNumber(
    properties.num_floors,
    properties['building:levels'],
    properties.levels,
  );
  if (floors !== null) return { heightM: floors * 3, quality: 'derived_floors' };

  const providerHeight = positiveNumber(properties.render_height);
  if (providerHeight !== null) {
    return { heightM: providerHeight, quality: 'provider_derived' };
  }
  return { heightM: 5, quality: 'approximate_fixed_5m' };
}

/** Returns null rather than manufacturing geometry when a source footprint is absent. */
export function normalizeSourceBuilding(
  input: SourceBuildingInput,
): NormalizedBuildingV1 | null {
  if (!isSourceFootprint(input.footprint)) return null;
  const { heightM, quality } = resolveSourceBuildingHeight(input.properties);
  const featureId = input.featureId;
  const sourceIdentity = featureId === null
    ? sourceString(input.properties.id) ?? 'unidentified'
    : String(featureId);
  return {
    buildingId: `${input.source.id}:${sourceIdentity}`,
    sourceFeatureId: featureId,
    parentBuildingId: sourceString(input.properties.building_id),
    footprint: input.footprint,
    heightM,
    heightQuality: quality,
    numFloors: firstPositiveNumber(
      input.properties.num_floors,
      input.properties['building:levels'],
      input.properties.levels,
    ),
    minHeightM: firstNonNegativeNumber(
      input.properties.min_height,
      input.properties.render_min_height,
    ) ?? 0,
    buildingClass: firstSourceString(
      input.properties.building,
      input.properties.class,
      input.properties.subtype,
    ),
    facadeColor: firstSourceString(
      input.properties.facade_color,
      input.properties.facade_colour,
      input.properties.colour,
      input.properties.color,
    ),
    roofColor: firstSourceString(
      input.properties.roof_color,
      input.properties.roof_colour,
    ),
    facadeMaterial: firstSourceString(
      input.properties.facade_material,
      input.properties.building_material,
      input.properties['building:material'],
    ),
    roofMaterial: firstSourceString(
      input.properties.roof_material,
      input.properties['roof:material'],
    ),
    roofShape: firstSourceString(
      input.properties.roof_shape,
      input.properties['roof:shape'],
    ),
    sourceId: input.source.id,
    datasetVersion: input.source.datasetVersion,
  };
}

function isSourceFootprint(value: BuildingFootprintV1 | null): value is BuildingFootprintV1 {
  if (!value || (value.type !== 'Polygon' && value.type !== 'MultiPolygon')) return false;
  return containsFiniteCoordinate(value.coordinates);
}

function containsFiniteCoordinate(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  if (
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number'
  ) {
    return Number.isFinite(value[0]) && Number.isFinite(value[1]);
  }
  return value.some(containsFiniteCoordinate);
}

function positiveNumber(value: unknown): number | null {
  const parsed = numericValue(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function firstPositiveNumber(...values: readonly unknown[]): number | null {
  for (const value of values) {
    const parsed = positiveNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function firstNonNegativeNumber(...values: readonly unknown[]): number | null {
  for (const value of values) {
    const parsed = numericValue(value);
    if (parsed !== null && parsed >= 0) return parsed;
  }
  return null;
}

function numericValue(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sourceString(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = String(value).trim();
  return parsed === '' ? null : parsed;
}

function firstSourceString(...values: readonly unknown[]): string | null {
  for (const value of values) {
    const parsed = sourceString(value);
    if (parsed !== null) return parsed;
  }
  return null;
}
