import { describe, expect, it, vi } from 'vitest';
import type { LayerSpecification, SourceSpecification, StyleSpecification } from 'maplibre-gl';
import { VerifiedCityBuildingLayer, verifiedCityBuildingDescriptor } from '../renderer/verifiedCityBuildingLayer';
import type { VerifiedCityBuildingSnapshot } from '../renderer/verifiedCityBuildingTypes';
import { resolveRendererBuildingPick, resolveRendererBuildingSelection } from '../renderer/buildingSource';
import { OPENMAPTILES_BUILDINGS_SOURCE } from '../renderer/mapProvider';
import { actorBuildingOcclusion } from '../renderer/actorOcclusion';

const snapshot = (signature = 'first'): VerifiedCityBuildingSnapshot => ({ datasetVersion: 'verified-fixture', signature,
  data: { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'openmaptiles_buildings:853220400',
    properties: { canonical_id: 'openmaptiles_buildings:853220400', height: 12, building: 'commercial' },
    geometry: { type: 'Polygon', coordinates: [[[61,55],[61.001,55],[61.001,55.001],[61,55]]] } }] },
  canonicalIds: new Set(['openmaptiles_buildings:853220400']), cells: ['16/1/1'], coverage: 'partial_viewport',
  omittedBuildings: 0, invalidBuildings: 0, vertexCount: 4,
});

function fixture() {
  let release: (() => void) | undefined;
  let pending = false;
  const sourceErrors = new Set<(event: { error: Error }) => void>();
  const sources = new Map<string, unknown>([['openmaptiles', {}]]);
  let layers: LayerSpecification[] = [
    { id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water' },
    { id: 'building-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', paint: { 'fill-extrusion-height': ['get','height'] } },
    { id: 'omnitwin-building-facade-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 17, paint: { 'fill-extrusion-pattern': 'facade' } },
    { id: 'labels', type: 'symbol', source: 'openmaptiles', 'source-layer': 'place' },
  ];
  const original = structuredClone(layers);
  const setData = vi.fn(() => pending ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve());
  const map = {
    getStyle: () => ({ version: 8, sources: {}, layers: [...layers] }) as StyleSpecification,
    getSource: (id: string) => sources.get(id),
    addSource: vi.fn((id: string, _source: SourceSpecification) => { sources.set(id, { setData,
      on: (_type: string, listener: (event: { error: Error }) => void) => { sourceErrors.add(listener); },
      off: (_type: string, listener: (event: { error: Error }) => void) => { sourceErrors.delete(listener); },
    }); }),
    removeSource: vi.fn((id: string) => { sources.delete(id); }),
    getLayer: (id: string) => layers.find(layer => layer.id === id) as (LayerSpecification & { source?: string }) | undefined,
    removeLayer: (id: string) => { layers = layers.filter(layer => layer.id !== id); },
    addLayer: (layer: LayerSpecification, before?: string) => { const index = layers.findIndex(item => item.id === before); layers.splice(index < 0 ? layers.length : index, 0, layer); },
  };
  return { map, setData, original, hold: () => { pending = true; }, release: () => { pending = false; release?.(); },
    sourceError: () => { for (const listener of sourceErrors) listener({ error: new Error('Worker data rejected') }); },
    sourceErrorListeners: () => sourceErrors.size,
    resetStyle: () => { sources.delete('omnitwin-buildings'); layers = structuredClone(original); } };
}

describe('retained exact building source', () => {
  it('does not click through an ambiguous front building and still uses it for real depth occlusion', () => {
    const merged = { id: 20783610, source: 'openmaptiles', layer: { id: 'building-3d', type: 'fill-extrusion' },
      properties: { render_height: 15 }, geometry: { type: 'Polygon', coordinates: [[[0,0],[10,0],[10,10],[0,10],[0,0]]] } };
    const underneath = { ...merged, id: 159526353 };
    expect(resolveRendererBuildingPick(OPENMAPTILES_BUILDINGS_SOURCE, [merged, underneath])).toBeNull();
    expect(actorBuildingOcclusion({ features: [merged], point: [5,5], actorNearestDepth: -1.8, zoom: 17,
      project: ([x,y,z]) => [x,y,-z] })).toBe('occluded');
    expect(resolveRendererBuildingPick(OPENMAPTILES_BUILDINGS_SOURCE, [{ ...merged, source: 'stale-source' }, underneath])?.featureId).toBe('159526353');
  });
  it('rejects merged OMT IDs even when their representative number collides with a compiled building', () => {
    for (const id of [20783610, 591780650]) expect(resolveRendererBuildingSelection(OPENMAPTILES_BUILDINGS_SOURCE, {
      id, source: 'openmaptiles', layer: { id: 'building-3d' }, sourceLayer: 'building', properties: { id, name: 'Known indexed name' },
    })).toBeNull();
  });
  it('resolves the actual drawn compiled identity, not an OMT group or an unchecked property', async () => {
    const f = fixture(); const controller = new VerifiedCityBuildingLayer(); const data = snapshot(); await controller.update(f.map, data);
    const feature = { id: 'openmaptiles_buildings:853220400', source: 'omnitwin-buildings', layer: { id: 'omnitwin-building-facade-3d' },
      properties: { canonical_id: 'openmaptiles_buildings:853220400' } };
    const descriptor = verifiedCityBuildingDescriptor(data.datasetVersion);
    expect(resolveRendererBuildingSelection(descriptor, feature, controller.snapshot!.canonicalIds)).toMatchObject({
      canonicalId: 'openmaptiles_buildings:853220400', providerId: 'verified_city_buildings', datasetVersion: data.datasetVersion,
    });
    expect(resolveRendererBuildingSelection(descriptor, feature)).toBeNull();
    expect(resolveRendererBuildingSelection(descriptor, { ...feature, source: 'openmaptiles' }, data.canonicalIds)).toBeNull();
    expect(resolveRendererBuildingSelection(descriptor, { ...feature, id: 'openmaptiles_buildings:20783610' }, data.canonicalIds)).toBeNull();
  });
  it('waits for verified source data, then replaces all building passes without duplicate OMT geometry', async () => {
    const f = fixture(); const controller = new VerifiedCityBuildingLayer(); f.hold();
    const update = controller.update(f.map, snapshot());
    expect(f.map.getLayer('building-3d')?.source).toBe('openmaptiles');
    f.release(); expect(await update).toBe(true);
    const buildings = f.map.getStyle().layers.filter(layer => layer.id.includes('building'));
    expect(buildings).toHaveLength(2);
    expect(buildings.every(layer => 'source' in layer && layer.source === 'omnitwin-buildings' && !('source-layer' in layer))).toBe(true);
    expect(f.map.getLayer('omnitwin-building-facade-3d')?.paint).toEqual({ 'fill-extrusion-pattern': 'facade' });
    expect(f.map.getLayer('water')?.source).toBe('openmaptiles');
    expect(controller.snapshot?.canonicalIds.has('openmaptiles_buildings:853220400')).toBe(true);
    expect(f.map.addSource).toHaveBeenCalledWith('omnitwin-buildings', expect.objectContaining({ promoteId: 'canonical_id', generateId: false }));
    await controller.update(f.map, snapshot()); expect(f.setData).toHaveBeenCalledTimes(1);
  });
  it('treats the SDK error event as failure even when its setData Promise resolves', async () => {
    const f = fixture(); const controller = new VerifiedCityBuildingLayer(); await controller.update(f.map, snapshot());
    f.hold(); const update = controller.update(f.map, snapshot('worker-failed'));
    f.sourceError(); f.release();
    expect(await update).toBe(false);
    expect(controller.status).toBe('error'); expect(controller.snapshot?.signature).toBe('first');
    expect(f.sourceErrorListeners()).toBe(0);
    expect(f.map.getLayer('building-3d')?.source).toBe('omnitwin-buildings');
  });
  it('cancels first readiness cleanly without rebinding after the source was disabled', async () => {
    const f = fixture(); const controller = new VerifiedCityBuildingLayer(); f.hold();
    const update = controller.update(f.map, snapshot());
    await controller.update(f.map, null);
    expect(f.map.getSource('omnitwin-buildings')).toBeUndefined();
    f.release(); expect(await update).toBe(false);
    expect(controller.status).toBe('disabled'); expect(controller.snapshot).toBeNull();
    expect(f.map.getStyle().layers).toEqual(f.original);
    expect(f.sourceErrorListeners()).toBe(0);
  });
  it('keeps prior verified geometry during a pending or rejected viewport update', async () => {
    const f = fixture(); const controller = new VerifiedCityBuildingLayer(); await controller.update(f.map, snapshot());
    f.hold(); const update = controller.update(f.map, snapshot('next'));
    expect(controller.snapshot?.signature).toBe('first');
    expect(f.map.getLayer('building-3d')?.source).toBe('omnitwin-buildings');
    f.release(); await update; expect(controller.snapshot?.signature).toBe('next');
    f.setData.mockRejectedValueOnce(new Error('source update failed'));
    expect(await controller.update(f.map, snapshot('failed'))).toBe(false);
    expect(controller.status).toBe('error'); expect(controller.snapshot?.signature).toBe('next');
    expect(f.map.getLayer('building-3d')?.source).toBe('omnitwin-buildings');
  });
  it('reinstalls exact geometry after setStyle and restores the original whole source only when disabled', async () => {
    const f = fixture(); const controller = new VerifiedCityBuildingLayer(); await controller.update(f.map, snapshot());
    f.resetStyle(); await controller.update(f.map, snapshot());
    expect(f.map.getLayer('building-3d')?.source).toBe('omnitwin-buildings');
    expect(f.setData).toHaveBeenCalledTimes(2);
    await controller.update(f.map, null);
    expect(f.map.getStyle().layers).toEqual(f.original);
    expect(f.map.getSource('omnitwin-buildings')).toBeUndefined();
    expect(controller.snapshot).toBeNull();
  });
});
