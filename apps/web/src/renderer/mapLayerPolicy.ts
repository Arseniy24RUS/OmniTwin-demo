import type { Map as MapLibreMap } from 'maplibre-gl';
import type { WorldLayer } from './types';
import type { UniversalRenderPhase } from './motionLodPolicy';
import {
  UNIVERSAL_BUILDING_COMPATIBILITY_LAYER_ID,
  UNIVERSAL_BUILDING_CONTACT_LAYER_IDS,
  UNIVERSAL_BUILDING_DETAIL_LAYER_IDS,
  UNIVERSAL_BUILDING_LAYER_IDS,
  UNIVERSAL_BUILDING_MOTION_LAYER_ID,
  UNIVERSAL_BUILDING_SHADOW_LAYER_IDS,
  setUniversalBuildingDetailFallback,
} from './mapStyle';

/** One controller-owned snapshot of the material atlas and governor allowances. */
export interface BuildingMaterialPolicy {
  readonly atlasReady: boolean;
  readonly facadePatternEnabled: boolean;
  readonly roofCapEnabled: boolean;
  readonly projectedShadowEnabled: boolean;
  readonly contactAoEnabled: boolean;
  readonly retainDuringCameraMotion?: boolean;
}

interface BuildingMaterialDecision {
  readonly facade: boolean;
  readonly roof: boolean;
  readonly shadow: boolean;
  readonly contactAo: boolean;
  readonly flat: boolean;
}

function materialDecision(
  phase: UniversalRenderPhase,
  policy: BuildingMaterialPolicy,
  preserveBaseExtrusions: boolean,
): BuildingMaterialDecision {
  const settled = phase === 'settled_paused';
  const ordinaryMotion = phase === 'camera_motion' || phase === 'living_motion';
  const materialsAllowed = settled || ordinaryMotion && policy.retainDuringCameraMotion === true;
  const facade = materialsAllowed && policy.atlasReady && policy.facadePatternEnabled;
  return {
    facade,
    roof: facade && policy.roofCapEnabled,
    // Keep the motion art pass bounded; ground contact and projected shadows recover on settle.
    shadow: settled && policy.projectedShadowEnabled,
    contactAo: settled && policy.contactAoEnabled,
    flat: phase === 'compatibility_30' && !preserveBaseExtrusions,
  };
}

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
  materialPolicy?: BuildingMaterialPolicy,
): 'visible' | 'none' | undefined {
  const decision = materialPolicy ? materialDecision(renderPhase, materialPolicy, preserveBaseExtrusions) : undefined;
  return layerVisibility(layerId, activeLayers, renderPhase, preserveBaseExtrusions, decision);
}

function layerVisibility(
  layerId: string,
  activeLayers: ReadonlySet<WorldLayer>,
  renderPhase: UniversalRenderPhase,
  preserveBaseExtrusions: boolean,
  decision?: BuildingMaterialDecision,
): 'visible' | 'none' | undefined {
  const feature = STYLE_LAYER_FEATURE[layerId];
  if (!feature) return undefined;
  if (!activeLayers.has(feature)) return 'none';
  if (feature !== 'buildings') return 'visible';
  if (decision) return combinedBuildingLayerVisibility(layerId, decision);
  return buildingLayerVisibilityForPhase(layerId, preserveBaseExtrusions && renderPhase === 'compatibility_30' ? 'emergency_30' : renderPhase);
}

export function applyMapLayerVisibility(
  map: MapLibreMap,
  activeLayers: ReadonlySet<WorldLayer>,
  renderPhase: UniversalRenderPhase = 'settled_paused',
  preserveBaseExtrusions = false,
  materialPolicy?: BuildingMaterialPolicy,
): void {
  // The same decision controls ranges and visibility. It survives styledata without
  // accidentally revealing a facade that the governor or atlas readiness disabled.
  const decision = materialPolicy ? materialDecision(renderPhase, materialPolicy, preserveBaseExtrusions) : undefined;
  if (decision) {
    setUniversalBuildingDetailFallback(map, activeLayers.has('buildings') && decision.facade);
  }
  for (const layerId of Object.keys(STYLE_LAYER_FEATURE)) {
    const visibility = layerVisibility(layerId, activeLayers, renderPhase, preserveBaseExtrusions, decision);
    if (visibility && map.getLayer(layerId)) {
      const current = typeof map.getLayoutProperty === 'function'
        ? map.getLayoutProperty(layerId, 'visibility') ?? 'visible'
        : undefined;
      if (current !== visibility) map.setLayoutProperty(layerId, 'visibility', visibility);
    }
  }
}

function combinedBuildingLayerVisibility(
  layerId: string,
  decision: BuildingMaterialDecision,
): 'visible' | 'none' {
  // Normal source extrusions provide the solid fallback in the combined policy;
  // a second parent-only extrusion would compete with the textured primary pass.
  if (layerId === UNIVERSAL_BUILDING_MOTION_LAYER_ID) return 'none';
  if (layerId === UNIVERSAL_BUILDING_COMPATIBILITY_LAYER_ID) return decision.flat ? 'visible' : 'none';
  if (decision.flat) return 'none';
  if ((UNIVERSAL_BUILDING_DETAIL_LAYER_IDS as readonly string[]).includes(layerId)) {
    return (layerId.includes('-roof-') ? decision.roof : decision.facade) ? 'visible' : 'none';
  }
  if ((UNIVERSAL_BUILDING_SHADOW_LAYER_IDS as readonly string[]).includes(layerId)) {
    return decision.shadow ? 'visible' : 'none';
  }
  if ((UNIVERSAL_BUILDING_CONTACT_LAYER_IDS as readonly string[]).includes(layerId)) {
    return decision.contactAo ? 'visible' : 'none';
  }
  return 'visible';
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
