import type { Map as MapLibreMap, MapOptions } from 'maplibre-gl';

/** Rendering phase chosen by the frame-budget governor, independent from quality tier. */
export type UniversalRenderPhase =
  | 'general_plan'
  | 'camera_motion'
  | 'living_motion'
  | 'settled_paused'
  | 'emergency_30'
  | 'compatibility_30';

export interface SourceTileLodBudget {
  readonly maxZoomLevelsOnScreen: number;
  readonly tileCountMaxMinRatio: number;
}

export interface UniversalSourceTileLodProfile {
  readonly buildings: SourceTileLodBudget;
  readonly basemap: SourceTileLodBudget;
}

export interface UniversalSourceTileLodIds {
  readonly basemapSourceId: string;
  readonly buildingSourceId: string;
}

export interface AppliedSourceTileLodProfile {
  readonly status: 'applied' | 'partial' | 'unsupported';
  readonly sourceCount: number;
  readonly missingSourceIds: readonly string[];
  readonly profileKey: 'moving' | 'settled';
}

const MOVING_SOURCE_TILE_LOD = Object.freeze({
  buildings: Object.freeze({ maxZoomLevelsOnScreen: 2, tileCountMaxMinRatio: 1.25 }),
  basemap: Object.freeze({ maxZoomLevelsOnScreen: 2, tileCountMaxMinRatio: 1.5 }),
}) satisfies UniversalSourceTileLodProfile;

const SETTLED_SOURCE_TILE_LOD = Object.freeze({
  buildings: Object.freeze({ maxZoomLevelsOnScreen: 3, tileCountMaxMinRatio: 2 }),
  basemap: Object.freeze({ maxZoomLevelsOnScreen: 3, tileCountMaxMinRatio: 2 }),
}) satisfies UniversalSourceTileLodProfile;

export const UNIVERSAL_SOURCE_TILE_LOD_PROFILES = Object.freeze({
  moving: MOVING_SOURCE_TILE_LOD,
  settled: SETTLED_SOURCE_TILE_LOD,
});

export const UNIVERSAL_MAX_PITCH = 60 as const;

/**
 * One depth-correct WebGL2 canvas with no multisample or readback tax. The
 * caller spreads this into the MapLibre constructor options.
 */
export function universalMapPerformanceOptions(): Pick<
  MapOptions,
  'maxPitch' | 'canvasContextAttributes'
> {
  return {
    maxPitch: UNIVERSAL_MAX_PITCH,
    canvasContextAttributes: {
      contextType: 'webgl2',
      antialias: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    },
  };
}

export function sourceTileLodProfileForPhase(
  phase: UniversalRenderPhase,
): UniversalSourceTileLodProfile {
  return phase === 'settled_paused'
    ? SETTLED_SOURCE_TILE_LOD
    : MOVING_SOURCE_TILE_LOD;
}

/**
 * Applies LOD per source. OpenMapTiles fallback shares the basemap source, so
 * its stricter building budget is applied once instead of being overwritten by
 * a second call. Unsupported versions fail soft and are surfaced to telemetry.
 */
export function applyUniversalSourceTileLodProfile(
  map: Pick<MapLibreMap, 'getSource' | 'setSourceTileLodParams'>,
  phase: UniversalRenderPhase,
  sourceIds: UniversalSourceTileLodIds,
): AppliedSourceTileLodProfile {
  const profileKey = phase === 'settled_paused' ? 'settled' : 'moving';
  const profile = sourceTileLodProfileForPhase(phase);
  const assignments = new Map<string, SourceTileLodBudget>();
  assignments.set(sourceIds.basemapSourceId, profile.basemap);
  const existingBuildingBudget = assignments.get(sourceIds.buildingSourceId);
  assignments.set(
    sourceIds.buildingSourceId,
    existingBuildingBudget
      ? stricterSourceBudget(existingBuildingBudget, profile.buildings)
      : profile.buildings,
  );

  const missingSourceIds: string[] = [];
  let sourceCount = 0;
  let unsupported = false;
  for (const [sourceId, budget] of assignments) {
    if (!map.getSource(sourceId)) {
      missingSourceIds.push(sourceId);
      continue;
    }
    try {
      map.setSourceTileLodParams(
        budget.maxZoomLevelsOnScreen,
        budget.tileCountMaxMinRatio,
        sourceId,
      );
      sourceCount += 1;
    } catch {
      unsupported = true;
    }
  }
  return {
    status: unsupported ? 'unsupported' : missingSourceIds.length > 0 ? 'partial' : 'applied',
    sourceCount,
    missingSourceIds,
    profileKey,
  };
}

function stricterSourceBudget(
  left: SourceTileLodBudget,
  right: SourceTileLodBudget,
): SourceTileLodBudget {
  return {
    maxZoomLevelsOnScreen: Math.min(
      left.maxZoomLevelsOnScreen,
      right.maxZoomLevelsOnScreen,
    ),
    tileCountMaxMinRatio: Math.min(left.tileCountMaxMinRatio, right.tileCountMaxMinRatio),
  };
}
