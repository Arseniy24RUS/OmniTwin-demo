import type { Map as MapLibreMap } from 'maplibre-gl';
import { applyMapLayerVisibility, type BuildingMaterialPolicy } from './mapLayerPolicy';
import type { UniversalRenderPhase } from './motionLodPolicy';
import type { WorldLayer } from './types';

export type DetailedBuildingOwner = 'maplibre' | 'three';
export type { BuildingMaterialPolicy } from './mapLayerPolicy';
export type DetailedBuildingCellBounds = readonly [number, number, number, number];

type MapFilter = Parameters<MapLibreMap['setFilter']>[1];

export interface MapStyleOwnershipSnapshot {
  requestedDetailedBuildingOwner: DetailedBuildingOwner;
  detailedBuildingOwner: DetailedBuildingOwner;
  mapLibreBuildingExtrusionsMasked: boolean;
  ownershipMaskScope: 'none' | 'cell' | 'feature';
  ownershipConflict: boolean;
}

export interface MapStyleControllerOptions {
  /** Static demo keeps real source extrusions even at reduced actor budgets. */
  preserveBaseExtrusions?: boolean;
  onOwnershipChange?: (snapshot: MapStyleOwnershipSnapshot) => void;
  /** scene_only has no MapLibre building source, so no exclusion mask is required. */
  baseBuildingLayerIntentionallyAbsent?: boolean;
}

export class MapStyleController {
  private activeLayers: ReadonlySet<WorldLayer> = new Set();
  private renderPhase: UniversalRenderPhase = 'settled_paused';
  private materialPolicy: BuildingMaterialPolicy | undefined;
  private requestedDetailedBuildingOwner: DetailedBuildingOwner = 'maplibre';
  private detailedBuildingOwner: DetailedBuildingOwner = 'maplibre';
  private extrusionsMasked = false;
  private detailedBuildingFootprint: DetailedBuildingCellBounds[] = [];
  private detailedBuildingFootprintKey = '';
  private buildingFeatureIds = new Map<string, string | number>();
  private buildingSourceKey = '';
  /** Source-authored filter (for example Overture `has_parts != true`). */
  private baseBuildingFilter: MapFilter | null = null;
  private baseBuildingFilterSourceKey = '';
  private disposed = false;
  private applying = false;
  private pendingApply = false;

  private readonly handleStyleData = () => {
    this.apply();
  };

  private readonly handleIdle = () => {
    if (this.pendingApply || this.requestedDetailedBuildingOwner === 'three') this.apply();
  };

  private readonly handleSourceData = () => {
    if (this.pendingApply || this.requestedDetailedBuildingOwner === 'three') this.apply();
  };

  constructor(
    private readonly map: MapLibreMap,
    private readonly options: MapStyleControllerOptions = {},
  ) {
    map.on('styledata', this.handleStyleData);
    map.on('idle', this.handleIdle);
    map.on('sourcedata', this.handleSourceData);
  }

  setDetailedBuildingOwner(owner: DetailedBuildingOwner): void {
    if (this.disposed || this.requestedDetailedBuildingOwner === owner) return;
    this.requestedDetailedBuildingOwner = owner;
    if (owner === 'maplibre') this.clearBuildingFeatureIds();
    this.apply();
  }

  setDetailedBuildingCellBounds(bounds: DetailedBuildingCellBounds | null): void {
    this.setDetailedBuildingFootprintBounds(bounds ? [bounds] : []);
  }

  setDetailedBuildingFootprintBounds(
    bounds: readonly DetailedBuildingCellBounds[],
  ): void {
    if (this.disposed) return;
    const next = bounds
      .filter(isValidDetailedBuildingBounds)
      .map((value) => [...value] as DetailedBuildingCellBounds)
      .sort((left, right) => left.join(',').localeCompare(right.join(',')));
    const nextKey = next.map((value) => value.join(',')).join('|');
    if (nextKey === this.detailedBuildingFootprintKey) return;
    this.detailedBuildingFootprint = next;
    this.detailedBuildingFootprintKey = nextKey;
    this.clearBuildingFeatureIds();
    this.apply();
  }

  ownershipSnapshot(): MapStyleOwnershipSnapshot {
    return {
      requestedDetailedBuildingOwner: this.requestedDetailedBuildingOwner,
      detailedBuildingOwner: this.detailedBuildingOwner,
      mapLibreBuildingExtrusionsMasked: this.extrusionsMasked,
      ownershipMaskScope: this.extrusionsMasked ? 'feature' : 'none',
      ownershipConflict: this.requestedDetailedBuildingOwner !== this.detailedBuildingOwner,
    };
  }

  setActiveLayers(activeLayers: ReadonlySet<WorldLayer>): void {
    if (this.disposed) return;
    this.activeLayers = new Set(activeLayers);
    this.apply();
  }

  /** Changes only layer visibility; no style/source reconstruction occurs. */
  setRenderPhase(renderPhase: UniversalRenderPhase): void {
    if (this.disposed || this.renderPhase === renderPhase) return;
    this.renderPhase = renderPhase;
    this.apply();
  }

  /** Atomically own phase, atlas/governor allowances, visibility and solid fallback ranges. */
  setRenderState(renderPhase: UniversalRenderPhase, materialPolicy: BuildingMaterialPolicy): void {
    if (this.disposed) return;
    const next = { ...materialPolicy, retainDuringCameraMotion: materialPolicy.retainDuringCameraMotion ?? false };
    const current = this.materialPolicy;
    const unchanged = current !== undefined
      && current.atlasReady === next.atlasReady
      && current.facadePatternEnabled === next.facadePatternEnabled
      && current.roofCapEnabled === next.roofCapEnabled
      && current.projectedShadowEnabled === next.projectedShadowEnabled
      && current.contactAoEnabled === next.contactAoEnabled
      && current.retainDuringCameraMotion === next.retainDuringCameraMotion;
    if (renderPhase === this.renderPhase && unchanged) return;
    this.renderPhase = renderPhase;
    this.materialPolicy = Object.freeze(next);
    this.apply();
  }

  getRenderPhase(): UniversalRenderPhase {
    return this.renderPhase;
  }

  apply(): void {
    if (this.disposed || this.applying) return;
    // Atlas/phase updates can arrive while source tiles are loading. Retain
    // that work: the runtime may not publish another identical policy, and
    // readiness can return through sourcedata/idle without another styledata.
    this.pendingApply = true;
    if (!this.map.isStyleLoaded()) return;
    this.applying = true;
    try {
      this.applySnapshot();
      this.pendingApply = false;
    } finally {
      this.applying = false;
    }
  }

  private applySnapshot(): void {
    applyMapLayerVisibility(this.map, this.activeLayers, this.renderPhase,
      this.options.preserveBaseExtrusions, this.materialPolicy);
    const hasBuildingLayer = Boolean(this.map.getLayer('building-3d'));
    this.captureBaseBuildingFilter(hasBuildingLayer);
    const canApplyFeatureMask = hasBuildingLayer &&
      this.requestedDetailedBuildingOwner === 'three' &&
      this.detailedBuildingFootprint.length > 0;
    if (
      !hasBuildingLayer
      && this.options.baseBuildingLayerIntentionallyAbsent === true
    ) {
      this.detailedBuildingOwner = this.requestedDetailedBuildingOwner;
      this.extrusionsMasked = false;
    } else if (canApplyFeatureMask) {
      try {
        const resolved = this.buildingFeatureIdsInDetailedFootprint();
        if (resolved.missingStableId) {
          throw new Error('A detailed MapLibre building lacks a stable feature ID');
        }
        if (resolved.ambiguousStableId) {
          throw new Error('A MapLibre building ID is not unique within loaded source features');
        }
        for (const value of resolved.ids) {
          this.buildingFeatureIds.set(`${typeof value}:${String(value)}`, value);
        }
        const ids = [...this.buildingFeatureIds.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([, value]) => value);
        if (ids.length === 0) throw new Error('No stable MapLibre building IDs were resolved');
        const exclusion = buildingFeatureExclusionFilter(ids);
        const filter = this.baseBuildingFilter
          ? ['all', this.baseBuildingFilter, exclusion] as MapFilter
          : exclusion;
        if (!filtersEqual(this.map.getFilter('building-3d'), filter)) {
          this.map.setFilter('building-3d', filter);
        }
        this.detailedBuildingOwner = 'three';
        this.extrusionsMasked = true;
      } catch {
        this.resetBuildingFilter(hasBuildingLayer);
      }
    } else {
      this.resetBuildingFilter(hasBuildingLayer);
    }
    this.options.onOwnershipChange?.(this.ownershipSnapshot());
  }

  private buildingFeatureIdsInDetailedFootprint(): {
    ids: Array<string | number>;
    missingStableId: boolean;
    ambiguousStableId: boolean;
  } {
    const layer = this.map.getLayer('building-3d') as unknown as {
      source?: unknown;
      sourceLayer?: unknown;
      'source-layer'?: unknown;
    } | undefined;
    const source = typeof layer?.source === 'string' ? layer.source : null;
    const sourceLayer = typeof layer?.sourceLayer === 'string'
      ? layer.sourceLayer
      : typeof layer?.['source-layer'] === 'string'
        ? layer['source-layer']
        : null;
    if (!source || !sourceLayer) {
      return { ids: [], missingStableId: true, ambiguousStableId: false };
    }
    const sourceKey = `${source}\u0000${sourceLayer}`;
    if (this.buildingSourceKey !== sourceKey) {
      this.clearBuildingFeatureIds();
      this.buildingSourceKey = sourceKey;
    }
    const ids: Array<string | number> = [];
    const insideKeys = new Set<string>();
    const outsideKeys = new Set<string>();
    let missingStableId = false;
    for (const feature of this.map.querySourceFeatures(source, { sourceLayer })) {
      const featureBounds = geoJsonGeometryBounds(feature.geometry);
      if (!featureBounds) continue;
      const intersects = this.detailedBuildingFootprint.some(
        (bounds) => boundsIntersect(featureBounds, bounds),
      );
      if (typeof feature.id !== 'string' && typeof feature.id !== 'number') {
        if (intersects) missingStableId = true;
        continue;
      }
      const key = `${typeof feature.id}:${String(feature.id)}`;
      if (intersects) {
        insideKeys.add(key);
        ids.push(feature.id);
      } else {
        outsideKeys.add(key);
      }
    }
    return {
      ids,
      missingStableId,
      ambiguousStableId: [...insideKeys].some((key) => outsideKeys.has(key)),
    };
  }

  private clearBuildingFeatureIds(): void {
    this.buildingFeatureIds.clear();
    this.buildingSourceKey = '';
  }

  private captureBaseBuildingFilter(hasBuildingLayer: boolean): void {
    if (!hasBuildingLayer) {
      this.baseBuildingFilter = null;
      this.baseBuildingFilterSourceKey = '';
      return;
    }
    const layer = this.map.getLayer('building-3d') as unknown as {
      source?: unknown;
      sourceLayer?: unknown;
      'source-layer'?: unknown;
    } | undefined;
    const source = typeof layer?.source === 'string' ? layer.source : '';
    const sourceLayer = typeof layer?.sourceLayer === 'string'
      ? layer.sourceLayer
      : typeof layer?.['source-layer'] === 'string'
        ? layer['source-layer']
        : '';
    const sourceKey = `${source}\u0000${sourceLayer}`;
    if (sourceKey !== this.baseBuildingFilterSourceKey) {
      // A style/provider replacement owns a fresh source filter. It cannot be
      // carrying the exclusion installed against the previous source.
      this.baseBuildingFilterSourceKey = sourceKey;
      this.extrusionsMasked = false;
      this.baseBuildingFilter = (this.map.getFilter('building-3d') ?? null) as MapFilter | null;
      return;
    }
    if (!this.extrusionsMasked) {
      this.baseBuildingFilter = (this.map.getFilter('building-3d') ?? null) as MapFilter | null;
    }
  }

  private resetBuildingFilter(hasBuildingLayer: boolean): void {
    // Never clear a provider-authored filter. In universal mode that filter is
    // what prevents parent footprints from being rendered together with their
    // building parts.
    if (hasBuildingLayer && this.extrusionsMasked) {
      try {
        const target = this.baseBuildingFilter ?? null;
        if (!filtersEqual(this.map.getFilter('building-3d'), target)) {
          this.map.setFilter('building-3d', target);
        }
      } catch {
        // A style replacement can transiently invalidate the layer between
        // getLayer and setFilter; the next styledata event retries exactly.
      }
    }
    this.detailedBuildingOwner = 'maplibre';
    this.extrusionsMasked = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.map.off('styledata', this.handleStyleData);
    this.map.off('idle', this.handleIdle);
    this.map.off('sourcedata', this.handleSourceData);
  }
}

export function buildingFeatureExclusionFilter(
  ids: readonly (string | number)[],
): MapFilter {
  return [
    '!',
    ['in', ['id'], ['literal', [...ids]]],
  ] as MapFilter;
}

function filtersEqual(left: MapFilter | void, right: MapFilter | null): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function isValidDetailedBuildingBounds(
  bounds: DetailedBuildingCellBounds,
): boolean {
  const [west, south, east, north] = bounds;
  return bounds.every(Number.isFinite) &&
    west >= -180 && east <= 180 && south >= -90 && north <= 90 &&
    west <= east && south <= north;
}

function boundsIntersect(
  left: DetailedBuildingCellBounds,
  right: DetailedBuildingCellBounds,
): boolean {
  return left[0] <= right[2] && left[2] >= right[0] &&
    left[1] <= right[3] && left[3] >= right[1];
}

function geoJsonGeometryBounds(geometry: unknown): DetailedBuildingCellBounds | null {
  if (!geometry || typeof geometry !== 'object') return null;
  const coordinates = (geometry as { coordinates?: unknown }).coordinates;
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (
      value.length >= 2 &&
      typeof value[0] === 'number' &&
      typeof value[1] === 'number' &&
      Number.isFinite(value[0]) &&
      Number.isFinite(value[1])
    ) {
      west = Math.min(west, value[0]);
      south = Math.min(south, value[1]);
      east = Math.max(east, value[0]);
      north = Math.max(north, value[1]);
      return;
    }
    for (const nested of value) visit(nested);
  };
  visit(coordinates);
  return Number.isFinite(west) && Number.isFinite(south) &&
    Number.isFinite(east) && Number.isFinite(north)
    ? [west, south, east, north]
    : null;
}
