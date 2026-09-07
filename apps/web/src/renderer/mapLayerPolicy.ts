import type { Map as MapLibreMap } from 'maplibre-gl';
import type { WorldLayer } from './types';
import type { UniversalRenderPhase } from './motionLodPolicy';
import {
  UNIVERSAL_BUILDING_COMPATIBILITY_LAYER_ID,
  UNIVERSAL_BUILDING_LAYER_IDS,
  UNIVERSAL_BUILDING_MOTION_LAYER_ID,
} from './mapStyle';

const SURFACE_LAYER_FEATURE: Readonly<Record<string, WorldLayer>> = {
  'landcover-grass': 'land',
  'landcover-grass-pattern': 'land',
  'landcover-wood': 'land',
  'landcover-wood-pattern': 'land',
  'landuse-residential': 'land',
  'landuse-residential-pattern': 'land',
  parks: 'land',
  'parks-pattern': 'land',
  water: 'land',
  'water-gloss': 'land',
  waterway: 'land',
  'roads-casing': 'infrastructure',
  roads: 'infrastructure',
  walkways: 'infrastructure',
  'roads-pattern': 'infrastructure',
  'road-labels': 'infrastructure',
};

const STYLE_LAYER_FEATURE: Readonly<Record<string, WorldLayer>> = Object.freeze({
  ...SURFACE_LAYER_FEATURE,
  ...Object.fromEntries(UNIVERSAL_BUILDING_LAYER_IDS.map((id) => [id, 'buildings' as const])),
});

export function mapStyleLayerVisibility(
  layerId: string,
  activeLayers: ReadonlySet<WorldLayer>,
  renderPhase: UniversalRenderPhase = 'settled_paused',
  preserveBaseExtrusions = false,
): 'visible' | 'none' | undefined {
  const feature = STYLE_LAYER_FEATURE[layerId];
  if (!feature) return undefined;
  if (!activeLayers.has(feature)) return 'none';
  if (feature !== 'buildings') return 'visible';
  return buildingLayerVisibilityForPhase(layerId, preserveBaseExtrusions && renderPhase === 'compatibility_30' ? 'emergency_30' : renderPhase);
}

export function applyMapLayerVisibility(
  map: MapLibreMap,
  activeLayers: ReadonlySet<WorldLayer>,
  renderPhase: UniversalRenderPhase = 'settled_paused',
  preserveBaseExtrusions = false,
): void {
  for (const layerId of Object.keys(STYLE_LAYER_FEATURE)) {
    const visibility = mapStyleLayerVisibility(layerId, activeLayers, renderPhase, preserveBaseExtrusions);
    if (visibility && map.getLayer(layerId)) {
      const current = typeof map.getLayoutProperty === 'function'
        ? map.getLayoutProperty(layerId, 'visibility') ?? 'visible'
        : undefined;
      if (current !== visibility) map.setLayoutProperty(layerId, 'visibility', visibility);
    }
  }
}

function buildingLayerVisibilityForPhase(
  layerId: string,
  renderPhase: UniversalRenderPhase,
): 'visible' | 'none' {
  if (layerId === UNIVERSAL_BUILDING_MOTION_LAYER_ID) {
    return renderPhase !== 'settled_paused' && renderPhase !== 'compatibility_30'
      ? 'visible'
      : 'none';
  }
  if (layerId === UNIVERSAL_BUILDING_COMPATIBILITY_LAYER_ID) {
    return renderPhase === 'compatibility_30' ? 'visible' : 'none';
  }
  return renderPhase === 'settled_paused' ? 'visible' : 'none';
}
