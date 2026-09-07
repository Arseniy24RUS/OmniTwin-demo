import {
  OPENMAPTILES_BUILDINGS_SOURCE,
  UNIVERSAL_PMTILES_PROTOCOL,
} from './mapProvider';
import {
  BUILDING_BASE_HEIGHT_EXPRESSION,
  BUILDING_FACADE_PATTERN_EXPRESSION,
  BUILDING_ROOF_PATTERN_EXPRESSION,
  LOW_POLY_BUILDING_COLOR_EXPRESSION,
  PRESENTATION_BUILDING_HEIGHT_EXPRESSION,
  PRESENTATION_BUILDING_ROOF_HEIGHT_EXPRESSION,
} from './buildingSource';
import {
  OMNITWIN_MATERIAL_ATLAS,
  UNIVERSAL_MATERIAL_ATLAS_VERSION,
  UNIVERSAL_MATERIAL_SPRITE_ID,
} from './materialAtlas';
import type { MapSourceDescriptorV1 } from './types';
import type { UniversalQualityTier } from './universal/types';
import { rendererAssetUrl } from './assetUrl';

type MapStyle = Exclude<import('maplibre-gl').MapOptions['style'], string | null | undefined>;
type MapStyleLayer = NonNullable<MapStyle['layers']>[number];

export const UNIVERSAL_BUILDING_SOURCE_ID = 'omnitwin-buildings' as const;
export { UNIVERSAL_MATERIAL_ATLAS_VERSION };

export const UNIVERSAL_WATER_GLOSS_LAYER_ID = 'water-gloss' as const;

/** Parent-footprint-only passes used while the expensive settled style is suspended. */
export const UNIVERSAL_BUILDING_MOTION_LAYER_ID = 'omnitwin-building-motion-3d' as const;
export const UNIVERSAL_BUILDING_COMPATIBILITY_LAYER_ID = 'omnitwin-building-motion-flat' as const;

export const UNIVERSAL_BUILDING_CONTACT_LAYER_IDS = [
  'omnitwin-building-contact-ao',
  'omnitwin-building-parts-contact-ao',
] as const;

export const UNIVERSAL_BUILDING_SHADOW_LAYER_IDS = [
  // The six-ID registry is retained for atomic cleanup and the current runtime
  // ABI. A generated style emits only the two `shadow-low` IDs below: exactly
  // one projected footprint per provider source-layer.
  'omnitwin-building-shadow-low',
  'omnitwin-building-shadow-mid',
  'omnitwin-building-shadow-tall',
  'omnitwin-building-parts-shadow-low',
  'omnitwin-building-parts-shadow-mid',
  'omnitwin-building-parts-shadow-tall',
] as const;

export const UNIVERSAL_BUILDING_ACTIVE_SHADOW_LAYER_IDS = [
  'omnitwin-building-shadow-low',
  'omnitwin-building-parts-shadow-low',
] as const;

export const UNIVERSAL_BUILDING_DETAIL_LAYER_IDS = [
  'omnitwin-building-facade-3d',
  'omnitwin-building-roof-3d',
  'omnitwin-building-parts-facade-3d',
  'omnitwin-building-parts-roof-3d',
] as const;

export const UNIVERSAL_BUILDING_LAYER_IDS = [
  'building',
  'building-3d',
  'building-parts',
  'building-parts-3d',
  UNIVERSAL_BUILDING_MOTION_LAYER_ID,
  UNIVERSAL_BUILDING_COMPATIBILITY_LAYER_ID,
  ...UNIVERSAL_BUILDING_CONTACT_LAYER_IDS,
  ...UNIVERSAL_BUILDING_SHADOW_LAYER_IDS,
  ...UNIVERSAL_BUILDING_DETAIL_LAYER_IDS,
] as const;

export interface UniversalBuildingStyleOptions {
  readonly qualityTier?: UniversalQualityTier;
  /** Explicit city art pass on mid/high tiers; omitted preserves the high-only z17 default. */
  readonly materialDetailZoom?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function absoluteResourceUrl(value: unknown, origin: string): unknown {
  if (typeof value !== 'string') return value;
  return new URL(rendererAssetUrl(value), origin).href.replaceAll('%7B', '{').replaceAll('%7D', '}');
}

interface MapSpriteEntry {
  readonly id: string;
  readonly url: string;
}

function isMapSpriteEntry(value: unknown): value is MapSpriteEntry {
  return isRecord(value) && typeof value.id === 'string' && typeof value.url === 'string';
}

/** Converts the legacy sprite string to MapLibre's multi-sprite form once. */
function ensureUniversalMaterialSprite(value: unknown): unknown {
  let sprites: readonly MapSpriteEntry[];
  if (typeof value === 'string') {
    sprites = [{ id: 'default', url: value }];
  } else if (Array.isArray(value) && value.every(isMapSpriteEntry)) {
    sprites = value;
  } else if (value === undefined) {
    sprites = [];
  } else {
    return value;
  }
  if (sprites.some((sprite) => sprite.id === UNIVERSAL_MATERIAL_SPRITE_ID)) return sprites;
  return [
    ...sprites,
    {
      id: UNIVERSAL_MATERIAL_SPRITE_ID,
      url: OMNITWIN_MATERIAL_ATLAS.spriteUrl,
    },
  ];
}

function absoluteSpriteSpecification(value: unknown, origin: string): unknown {
  const withMaterials = ensureUniversalMaterialSprite(value);
  if (typeof withMaterials === 'string') return absoluteResourceUrl(withMaterials, origin);
  if (!Array.isArray(withMaterials)) return withMaterials;
  return withMaterials.map((entry) => (
    isMapSpriteEntry(entry)
      ? { ...entry, url: absoluteResourceUrl(entry.url, origin) }
      : entry
  ));
}

const LOCAL_LABEL_FIELD = [
  'coalesce',
  ['get', 'name:ru'],
  ['get', 'name:latin'],
  ['get', 'ref'],
  '',
] as const;

function localizeSymbolLayer(value: unknown): unknown {
  if (!isRecord(value) || value.type !== 'symbol' || !isRecord(value.layout)) return value;
  if (!('text-field' in value.layout)) return value;
  return {
    ...value,
    layout: {
      ...value.layout,
      // The local v0.8 glyph pack deliberately contains Cyrillic and Latin ranges.
      // Never fall through to arbitrary scripts that would create hidden network fetches.
      'text-field': LOCAL_LABEL_FIELD,
    },
  };
}

/** MapLibre requires sprite and glyph resources to be absolute when style JSON is passed as data. */
export function normalizeLocalMapStyle(value: unknown, origin: string): MapStyle {
  if (!isRecord(value) || value.version !== 8 || !isRecord(value.sources) || !Array.isArray(value.layers)) {
    throw new Error('Local map style contract rejected');
  }
  return {
    ...value,
    sprite: absoluteSpriteSpecification(value.sprite, origin),
    glyphs: absoluteResourceUrl(value.glyphs, origin),
    layers: value.layers.map(localizeSymbolLayer),
  } as MapStyle;
}

export function mapLibreVectorSourceFromDescriptor(
  descriptor: MapSourceDescriptorV1,
): Record<string, unknown> | null {
  assertBuildingSource(descriptor);
  if (descriptor.id === OPENMAPTILES_BUILDINGS_SOURCE.id) return null;
  const common = {
    type: 'vector' as const,
    attribution: descriptor.attributionHtml,
  };
  if (descriptor.transport === 'pmtiles') {
    return {
      ...common,
      url: `${UNIVERSAL_PMTILES_PROTOCOL}://${descriptor.url}`,
    };
  }
  if (descriptor.transport === 'xyz_mvt') {
    return { ...common, tiles: [descriptor.url], minzoom: descriptor.minZoom, maxzoom: descriptor.maxZoom };
  }
  if (descriptor.transport === 'tilejson_mvt') {
    return { ...common, url: descriptor.url };
  }
  throw new Error('Building source must use an MVT transport');
}

/**
 * Replaces every building layer as one atomic style value. The returned style
 * never references both Overture and OpenMapTiles building sources.
 */
export function applyUniversalBuildingStyle(
  style: MapStyle,
  descriptor: MapSourceDescriptorV1,
  options: UniversalBuildingStyleOptions = {},
): MapStyle {
  assertBuildingSource(descriptor);
  const sources = { ...(style.sources ?? {}) } as Record<string, unknown>;
  const sourceSpecification = mapLibreVectorSourceFromDescriptor(descriptor);
  let sourceId: string;
  if (sourceSpecification) {
    sources[UNIVERSAL_BUILDING_SOURCE_ID] = sourceSpecification;
    sourceId = UNIVERSAL_BUILDING_SOURCE_ID;
  } else {
    delete sources[UNIVERSAL_BUILDING_SOURCE_ID];
    if (!sources.openmaptiles) {
      throw new Error('OpenMapTiles fallback requires the openmaptiles style source');
    }
    sourceId = 'openmaptiles';
  }

  const qualityTier = options.qualityTier ?? 'mid';
  const materialDetailZoom = options.materialDetailZoom ?? 17;
  if (!Number.isFinite(materialDetailZoom) || materialDetailZoom < 13 || materialDetailZoom > 22) {
    throw new RangeError('materialDetailZoom must be a finite zoom between 13 and 22');
  }
  const cityMaterialDetail = options.materialDetailZoom !== undefined && qualityTier !== 'low';
  const sourceLayers = descriptor.schema.requiredLayers;
  const parentSourceLayer = sourceLayers[0];
  if (!parentSourceLayer) throw new Error('Building source layer is required');
  const partSourceLayer = sourceLayers[1] ?? null;
  const parentFilter = partSourceLayer
    ? ['!=', ['get', 'has_parts'], true]
    : undefined;
  const layerSources: readonly BuildingLayerSource[] = [
    {
      key: 'building',
      source: sourceId,
      sourceLayer: parentSourceLayer,
      filter: parentFilter,
    },
    ...(partSourceLayer ? [{
      key: 'building-parts' as const,
      source: sourceId,
      sourceLayer: partSourceLayer,
    }] : []),
  ];
  const projectedShadow = qualityTier !== 'low';
  const materialDetail = qualityTier === 'high' || cityMaterialDetail;
  const buildingLayers = [
    ...layerSources.map(createFootprintLayer),
    ...(projectedShadow ? layerSources.map(createProjectedShadowLayer) : []),
    ...layerSources.map((source) => createContactLayer(source, cityMaterialDetail)),
    ...layerSources.map((source) => createExtrusionLayer(source, materialDetail, materialDetailZoom)),
    ...(materialDetail ? layerSources.flatMap((source) => [
      createFacadePatternLayer(source, materialDetailZoom),
      createRoofLayer(source, materialDetailZoom),
    ]) : []),
    // These two parent-only layers deliberately omit the settled `has_parts`
    // filter. Hiding parts during motion must not leave holes in Overture
    // buildings whose authored parent footprint owns those parts.
    createMotionExtrusionLayer({
      key: 'building',
      source: sourceId,
      sourceLayer: parentSourceLayer,
    }),
    createCompatibilityFootprintLayer({
      key: 'building',
      source: sourceId,
      sourceLayer: parentSourceLayer,
    }),
  ];
  const retainedLayers = style.layers.filter((layer) => !isOwnedBuildingLayer(layer.id));
  const labelIndex = retainedLayers.findIndex((layer) => layer.type === 'symbol');
  const insertionIndex = labelIndex < 0 ? retainedLayers.length : labelIndex;
  return {
    ...style,
    sources: sources as MapStyle['sources'],
    layers: [
      ...retainedLayers.slice(0, insertionIndex),
      ...buildingLayers,
      ...retainedLayers.slice(insertionIndex),
    ] as MapStyle['layers'],
  };
}

type BuildingLayerKey = 'building' | 'building-parts';

interface BuildingLayerSource {
  readonly key: BuildingLayerKey;
  readonly source: string;
  readonly sourceLayer: string;
  readonly filter?: unknown;
}

function createFootprintLayer(input: BuildingLayerSource): MapStyleLayer {
  return {
    id: input.key,
    type: 'fill',
    source: input.source,
    'source-layer': input.sourceLayer,
    minzoom: 11,
    maxzoom: 13,
    ...(input.filter ? { filter: input.filter } : {}),
    paint: {
      'fill-color': LOW_POLY_BUILDING_COLOR_EXPRESSION,
      'fill-outline-color': '#6f716b',
      'fill-opacity': 0.88,
    },
  } as MapStyleLayer;
}

function createContactLayer(input: BuildingLayerSource, cityMaterialDetail: boolean): MapStyleLayer {
  return {
    id: `omnitwin-${input.key}-contact-ao`,
    type: 'line',
    source: input.source,
    'source-layer': input.sourceLayer,
    minzoom: 13,
    ...(input.filter ? { filter: input.filter } : {}),
    paint: {
      'line-color': '#182024',
      'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.8, 16, 1.6, 19, 2.8],
      'line-blur': cityMaterialDetail
        ? ['interpolate', ['linear'], ['zoom'], 13, 0.8, 16, 1, 19, 2]
        : ['interpolate', ['linear'], ['zoom'], 13, 0.6, 19, 1.5],
      'line-opacity': cityMaterialDetail ? 0.5 : 0.34,
    },
  } as MapStyleLayer;
}

function createProjectedShadowLayer(input: BuildingLayerSource): MapStyleLayer {
  return {
    // Keep the established `shadow-low` ID so style replacement and the
    // event-driven appearance updater remain backward compatible.
    id: `omnitwin-${input.key}-shadow-low`,
    type: 'fill',
    source: input.source,
    'source-layer': input.sourceLayer,
    minzoom: 13,
    ...(input.filter ? { filter: input.filter } : {}),
    paint: {
      'fill-antialias': false,
      'fill-color': '#172026',
      'fill-opacity': 0.16,
      'fill-translate': [2.5, 3.5],
      'fill-translate-anchor': 'map',
    },
  } as MapStyleLayer;
}

function createExtrusionLayer(input: BuildingLayerSource, materialDetail: boolean, materialDetailZoom: number): MapStyleLayer {
  return {
    id: `${input.key}-3d`,
    type: 'fill-extrusion',
    source: input.source,
    'source-layer': input.sourceLayer,
    minzoom: 13,
    ...(materialDetail ? { maxzoom: materialDetailZoom } : {}),
    ...(input.filter ? { filter: input.filter } : {}),
    paint: {
      'fill-extrusion-base': BUILDING_BASE_HEIGHT_EXPRESSION,
      'fill-extrusion-height': PRESENTATION_BUILDING_HEIGHT_EXPRESSION,
      'fill-extrusion-color': LOW_POLY_BUILDING_COLOR_EXPRESSION,
      'fill-extrusion-opacity': 1,
      'fill-extrusion-vertical-gradient': true,
    },
  } as MapStyleLayer;
}

function createMotionExtrusionLayer(input: BuildingLayerSource): MapStyleLayer {
  return {
    id: UNIVERSAL_BUILDING_MOTION_LAYER_ID,
    type: 'fill-extrusion',
    source: input.source,
    'source-layer': input.sourceLayer,
    minzoom: 13,
    layout: { visibility: 'none' },
    paint: {
      'fill-extrusion-base': BUILDING_BASE_HEIGHT_EXPRESSION,
      'fill-extrusion-height': PRESENTATION_BUILDING_HEIGHT_EXPRESSION,
      'fill-extrusion-color': LOW_POLY_BUILDING_COLOR_EXPRESSION,
      'fill-extrusion-opacity': 1,
      'fill-extrusion-vertical-gradient': true,
    },
  } as MapStyleLayer;
}

function createCompatibilityFootprintLayer(input: BuildingLayerSource): MapStyleLayer {
  return {
    id: UNIVERSAL_BUILDING_COMPATIBILITY_LAYER_ID,
    type: 'fill',
    source: input.source,
    'source-layer': input.sourceLayer,
    minzoom: 11,
    layout: { visibility: 'none' },
    paint: {
      'fill-antialias': false,
      'fill-color': LOW_POLY_BUILDING_COLOR_EXPRESSION,
      'fill-opacity': 0.9,
    },
  } as MapStyleLayer;
}

function createFacadePatternLayer(input: BuildingLayerSource, materialDetailZoom: number): MapStyleLayer {
  return {
    id: `omnitwin-${input.key}-facade-3d`,
    type: 'fill-extrusion',
    source: input.source,
    'source-layer': input.sourceLayer,
    minzoom: materialDetailZoom,
    ...(input.filter ? { filter: input.filter } : {}),
    paint: {
      'fill-extrusion-base': BUILDING_BASE_HEIGHT_EXPRESSION,
      'fill-extrusion-height': PRESENTATION_BUILDING_HEIGHT_EXPRESSION,
      'fill-extrusion-pattern': BUILDING_FACADE_PATTERN_EXPRESSION,
      'fill-extrusion-opacity': 1,
      'fill-extrusion-vertical-gradient': true,
    },
  } as MapStyleLayer;
}

function createRoofLayer(input: BuildingLayerSource, materialDetailZoom: number): MapStyleLayer {
  return {
    id: `omnitwin-${input.key}-roof-3d`,
    type: 'fill-extrusion',
    source: input.source,
    'source-layer': input.sourceLayer,
    minzoom: materialDetailZoom,
    ...(input.filter ? { filter: input.filter } : {}),
    paint: {
      'fill-extrusion-base': PRESENTATION_BUILDING_HEIGHT_EXPRESSION,
      'fill-extrusion-height': PRESENTATION_BUILDING_ROOF_HEIGHT_EXPRESSION,
      'fill-extrusion-pattern': BUILDING_ROOF_PATTERN_EXPRESSION,
      'fill-extrusion-opacity': 0.99,
      'fill-extrusion-vertical-gradient': false,
    },
  } as MapStyleLayer;
}

export interface UniversalBuildingDetailFallbackMap {
  getLayer(id: string): unknown;
  setLayerZoomRange(id: string, minzoom: number, maxzoom: number): unknown;
}

/**
 * Pair with facade visibility changes. The existing opaque source extrusion
 * expands above the material threshold whenever facades are disabled, then
 * relinquishes that zoom range on recovery. This avoids overlapping full
 * extrusion passes and keeps actual buildings present after GPU degradation.
 * Layer visibility remains owned by the caller's building-layer policy.
 */
export function setUniversalBuildingDetailFallback(
  map: UniversalBuildingDetailFallbackMap,
  detailEnabled: boolean,
): void {
  for (const key of ['building', 'building-parts'] as const) {
    const base = map.getLayer(`${key}-3d`);
    const facade = map.getLayer(`omnitwin-${key}-facade-3d`);
    if (!isRecord(base) || !isRecord(facade)
      || typeof facade.minzoom !== 'number' || !Number.isFinite(facade.minzoom)) continue;
    const minzoom = typeof base.minzoom === 'number' ? base.minzoom : 13;
    const maxzoom = detailEnabled ? facade.minzoom : 24;
    if (base.minzoom !== minzoom || base.maxzoom !== maxzoom) {
      map.setLayerZoomRange(`${key}-3d`, minzoom, maxzoom);
    }
  }
}

export function isOwnedBuildingLayer(id: string): boolean {
  return (UNIVERSAL_BUILDING_LAYER_IDS as readonly string[]).includes(id)
    || id.startsWith('omnitwin-building-');
}

function assertBuildingSource(descriptor: MapSourceDescriptorV1): void {
  if (descriptor.role !== 'buildings') throw new Error('Expected a buildings source descriptor');
  if (descriptor.schema.requiredLayers.length === 0) {
    throw new Error('Building source must declare at least one required source layer');
  }
}

export async function loadLocalMapStyle(
  signal?: AbortSignal,
  buildings: MapSourceDescriptorV1 = OPENMAPTILES_BUILDINGS_SOURCE,
): Promise<MapStyle> {
  const response = await fetch(rendererAssetUrl('/map/openfreemap-liberty.json'), {
    signal,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Local map style request failed: ${response.status}`);
  return applyUniversalBuildingStyle(
    normalizeLocalMapStyle(await response.json(), window.location.origin),
    buildings,
  );
}
