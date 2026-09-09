import type { GeoJSONSource, LayerSpecification, SourceSpecification, StyleSpecification } from 'maplibre-gl';
import { isOwnedBuildingLayer, UNIVERSAL_BUILDING_SOURCE_ID } from './mapStyle';
import { OPENMAPTILES_BUILDINGS_SOURCE } from './mapProvider';
import type { MapSourceDescriptorV1 } from './types';
import { VERIFIED_CITY_BUILDING_PROVIDER_ID, type VerifiedCityBuildingSnapshot } from './verifiedCityBuildingTypes';

interface BuildingMap {
  getStyle(): StyleSpecification;
  getSource(id: string): unknown;
  addSource(id: string, source: SourceSpecification): unknown;
  removeSource(id: string): unknown;
  getLayer(id: string): unknown;
  removeLayer(id: string): unknown;
  addLayer(layer: LayerSpecification, beforeId?: string): unknown;
}

export function verifiedCityBuildingDescriptor(datasetVersion: string): MapSourceDescriptorV1 {
  return { ...OPENMAPTILES_BUILDINGS_SOURCE, id: VERIFIED_CITY_BUILDING_PROVIDER_ID,
    transport: 'retained_geojson', datasetVersion, url: `retained:${datasetVersion}`,
    schema: { id: 'verified_city.buildings', version: '1', requiredLayers: ['building'] },
    rights: { ...OPENMAPTILES_BUILDINGS_SOURCE.rights, prefetch: 'visible_only' } };
}

/** One retained source, using the actual material/occlusion geometry for native picking. */
export class VerifiedCityBuildingLayer {
  snapshot: VerifiedCityBuildingSnapshot | null = null;
  status: 'disabled' | 'loading' | 'ready' | 'error' = 'disabled';
  error: string | null = null;
  private map: BuildingMap | null = null;
  private original: LayerSpecification[] | null = null;
  private generation = 0;
  private pending: Promise<boolean> | null = null;
  private pendingSignature: string | null = null;
  private pendingSource: unknown = null;
  private ownedSource: unknown = null;

  update(map: BuildingMap, next: VerifiedCityBuildingSnapshot | null): Promise<boolean> {
    if (this.map !== map) { this.dispose(); this.map = map; }
    const source = map.getSource(UNIVERSAL_BUILDING_SOURCE_ID);
    const bound = this.isBound(map);
    if (!next) {
      this.generation++;
      if (bound && this.original) this.replaceLayers(map, this.original);
      if (source && source === this.ownedSource) map.removeSource(UNIVERSAL_BUILDING_SOURCE_ID);
      const changed = this.snapshot !== null;
      this.snapshot = null; this.status = 'disabled'; this.error = null;
      this.original = null; this.pending = null; this.ownedSource = null;
      return Promise.resolve(changed);
    }
    if (this.pending && this.pendingSignature === next.signature && this.pendingSource === source) return this.pending;
    if (bound && source && this.snapshot?.signature === next.signature) {
      this.snapshot = next; this.status = 'ready'; this.error = null;
      return Promise.resolve(false);
    }
    const generation = ++this.generation;
    this.status = 'loading'; this.error = null; this.pendingSignature = next.signature;
    const task = async (): Promise<boolean> => {
      let target = map.getSource(UNIVERSAL_BUILDING_SOURCE_ID) as Pick<GeoJSONSource, 'setData' | 'on' | 'off'> | undefined;
      if (!target) {
        map.addSource(UNIVERSAL_BUILDING_SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] },
          generateId: false, promoteId: 'canonical_id', maxzoom: 18, tolerance: 0,
          attribution: '© OpenStreetMap contributors · SHA-256 verified OSM source geometry' });
        target = map.getSource(UNIVERSAL_BUILDING_SOURCE_ID) as Pick<GeoJSONSource, 'setData' | 'on' | 'off'>;
        this.ownedSource = target;
      }
      if (typeof target?.setData !== 'function' || target !== this.ownedSource) throw new Error('Exact building source is not owned retained GeoJSON');
      this.pendingSource = target;
      // The old complete source remains rendered until the new verified data has
      // reached MapLibre's worker. Subsequent data updates retain the same source.
      // MapLibre 6.4 reports worker failure through ErrorEvent while setData's
      // Promise still resolves. Do not publish an unaccepted snapshot as ready.
      let sourceFailure: unknown;
      const recordError = (event: { error?: unknown }) => { sourceFailure = event.error ?? new Error('Exact building worker rejected data'); };
      target.on('error', recordError);
      try { await target.setData(next.data); } finally { target.off('error', recordError); }
      if (sourceFailure) throw sourceFailure;
      if (generation !== this.generation || this.map !== map || map.getSource(UNIVERSAL_BUILDING_SOURCE_ID) !== target) return false;
      if (!this.isBound(map)) {
        const existing = map.getStyle().layers.filter(layer => isOwnedBuildingLayer(layer.id));
        if (!existing.length) throw new Error('No material building layers available for exact source');
        this.original = existing;
        const replacement = existing.filter(layer => !layer.id.includes('building-parts')).map(layer => {
          const result = { ...layer, source: UNIVERSAL_BUILDING_SOURCE_ID } as LayerSpecification;
          delete (result as unknown as Record<string, unknown>)['source-layer'];
          return result;
        });
        this.replaceLayers(map, replacement);
      }
      this.snapshot = next; this.status = 'ready'; this.error = null;
      return true;
    };
    this.pending = task().catch(error => {
      if (generation === this.generation) { this.status = 'error'; this.error = error instanceof Error ? error.message : 'Exact building update failed'; }
      return false;
    }).finally(() => { if (generation === this.generation) this.pending = null; });
    return this.pending;
  }

  dispose(): void {
    this.generation++; this.pending = null; this.map = null; this.original = null; this.ownedSource = null;
    this.snapshot = null; this.status = 'disabled'; this.error = null;
  }

  private isBound(map: BuildingMap): boolean {
    return map.getStyle().layers.some(layer => isOwnedBuildingLayer(layer.id) && 'source' in layer && layer.source === UNIVERSAL_BUILDING_SOURCE_ID);
  }

  private replaceLayers(map: BuildingMap, replacement: LayerSpecification[]): void {
    // Synchronous whole-source switch before the next render: no OMT building
    // pass remains underneath the exact source, including selection decoration.
    const layers = map.getStyle().layers;
    const owned = layers.filter(layer => isOwnedBuildingLayer(layer.id));
    const first = layers.findIndex(layer => isOwnedBuildingLayer(layer.id));
    const before = layers.slice(first + 1).find(layer => !isOwnedBuildingLayer(layer.id) && layer.id !== 'demo-selected-building')?.id;
    if (map.getLayer('demo-selected-building')) map.removeLayer('demo-selected-building');
    for (const layer of owned) map.removeLayer(layer.id);
    for (const layer of replacement) map.addLayer(layer, before);
  }
}
