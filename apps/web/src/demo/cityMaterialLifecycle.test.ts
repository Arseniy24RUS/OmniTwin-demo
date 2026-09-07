import { describe, expect, it, vi } from 'vitest';
import type { StyleSpecification } from 'maplibre-gl';
import { applyUniversalBuildingStyle } from '../renderer/mapStyle';
import { MapStyleController, type BuildingMaterialPolicy } from '../renderer/mapStyleController';
import { OPENMAPTILES_BUILDINGS_SOURCE } from '../renderer/mapProvider';

const READY: BuildingMaterialPolicy = {
  atlasReady: true, facadePatternEnabled: true, roofCapEnabled: true,
  projectedShadowEnabled: true, contactAoEnabled: true, retainDuringCameraMotion: true,
};
const FACADE = 'omnitwin-building-facade-3d';
const ROOF = 'omnitwin-building-roof-3d';
const MOTION = 'omnitwin-building-motion-3d';
const FLAT = 'omnitwin-building-motion-flat';

function fixture(preserveBaseExtrusions = true) {
  const style = applyUniversalBuildingStyle({ version: 8,
    sources: { openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } }, layers: [],
  }, OPENMAPTILES_BUILDINGS_SOURCE, { qualityTier: 'mid', materialDetailZoom: 16 });
  const layers = new Map<string, StyleSpecification['layers'][number]>(style.layers.map((layer) => [layer.id, structuredClone(layer)]));
  const handlers = new Map<string, () => void>();
  let synchronousEvents = false;
  const map = {
    isStyleLoaded: () => true,
    getLayer: (id: string) => layers.get(id),
    getFilter: (id: string) => (layers.get(id) as { filter?: unknown } | undefined)?.filter,
    setFilter: vi.fn(),
    getLayoutProperty: (id: string) => layers.get(id)?.layout?.visibility ?? 'visible',
    setLayoutProperty: vi.fn((id: string, _name: string, visibility: 'visible' | 'none') => {
      const layer = layers.get(id)!;
      layer.layout = { ...layer.layout, visibility };
      if (synchronousEvents) handlers.get('styledata')?.();
    }),
    setLayerZoomRange: vi.fn((id: string, minzoom: number, maxzoom: number) => {
      Object.assign(layers.get(id)!, { minzoom, maxzoom });
      if (synchronousEvents) handlers.get('styledata')?.();
    }),
    on: vi.fn((event: string, handler: () => void) => handlers.set(event, handler)),
    off: vi.fn(),
  };
  const controller = new MapStyleController(map as never, { preserveBaseExtrusions });
  controller.setActiveLayers(new Set(['buildings']));
  const visible = (id: string) => map.getLayoutProperty(id) === 'visible';
  const primaryAt = (zoom: number) => ['building-3d', FACADE, MOTION].filter((id) => {
    const layer = layers.get(id);
    return layer && visible(id) && zoom >= (layer.minzoom ?? 0) && zoom < (layer.maxzoom ?? 24);
  });
  return { map, controller, layers, visible, primaryAt,
    styledata: () => handlers.get('styledata')?.(),
    enableSynchronousEvents: () => { synchronousEvents = true; } };
}

describe('combined city material lifecycle', () => {
  it('retains atlas materials through ordinary camera rotation with exactly one primary extrusion', () => {
    const f = fixture();
    f.controller.setRenderState('settled_paused', READY);
    f.controller.setRenderState('camera_motion', READY);
    expect(f.visible(FACADE)).toBe(true);
    expect(f.visible(ROOF)).toBe(true);
    expect(f.visible(MOTION)).toBe(false);
    expect(f.primaryAt(15.9)).toEqual(['building-3d']);
    expect(f.primaryAt(16)).toEqual([FACADE]);
    expect(f.primaryAt(18)).toEqual([FACADE]);
    f.controller.setRenderState('living_motion', READY);
    expect(f.primaryAt(16.8)).toEqual([FACADE]);
    f.controller.setRenderState('settled_paused', READY);
    expect(f.primaryAt(16.8)).toEqual([FACADE]);
  });

  it('atomically restores solid ranges without an atlas and restores materials after it recovers', () => {
    const f = fixture();
    f.controller.setRenderState('camera_motion', { ...READY, atlasReady: false });
    expect(f.visible(FACADE)).toBe(false);
    expect(f.visible(ROOF)).toBe(false);
    expect(f.layers.get('building-3d')).toMatchObject({ minzoom: 13, maxzoom: 24 });
    expect(f.primaryAt(16.8)).toEqual(['building-3d']);
    f.controller.setRenderState('camera_motion', READY);
    expect(f.layers.get('building-3d')).toMatchObject({ maxzoom: 16 });
    expect(f.primaryAt(16.8)).toEqual([FACADE]);
  });

  it('keeps distant and floor phases source-backed and restores materials only after phase recovery', () => {
    const f = fixture();
    for (const phase of ['general_plan', 'emergency_30', 'compatibility_30'] as const) {
      f.controller.setRenderState(phase, READY);
      expect(f.visible(FACADE), phase).toBe(false);
      expect(f.visible(ROOF), phase).toBe(false);
      expect(f.visible(FLAT), phase).toBe(false);
      expect(f.primaryAt(16.8), phase).toEqual(['building-3d']);
    }
    f.controller.setRenderState('settled_paused', READY);
    expect(f.primaryAt(16.8)).toEqual([FACADE]);
    const legacyFloor = fixture(false);
    legacyFloor.controller.setRenderState('compatibility_30', READY);
    expect(legacyFloor.visible(FLAT)).toBe(true);
    expect(legacyFloor.primaryAt(16.8)).toEqual([]);
  });

  it('never lets styledata overwrite governor caps and treats identical snapshots as no-ops', () => {
    const f = fixture();
    const capped = { ...READY, facadePatternEnabled: false, roofCapEnabled: false,
      projectedShadowEnabled: false, contactAoEnabled: false };
    f.controller.setRenderState('settled_paused', capped);
    expect(f.primaryAt(18)).toEqual(['building-3d']);
    expect(f.visible('omnitwin-building-contact-ao')).toBe(false);
    expect(f.visible('omnitwin-building-shadow-low')).toBe(false);
    f.map.setLayoutProperty.mockClear();
    f.map.setLayerZoomRange.mockClear();
    f.styledata();
    f.controller.setRenderState('settled_paused', { ...capped });
    expect(f.map.setLayoutProperty).not.toHaveBeenCalled();
    expect(f.map.setLayerZoomRange).not.toHaveBeenCalled();
    f.layers.get(FACADE)!.layout = { visibility: 'visible' };
    f.styledata();
    expect(f.visible(FACADE)).toBe(false);
    expect(f.primaryAt(18)).toEqual(['building-3d']);
    f.controller.setRenderState('settled_paused', READY);
    expect(f.primaryAt(18)).toEqual([FACADE]);
  });

  it('honors product layer disabling and preserves caps through the legacy phase setter', () => {
    const f = fixture();
    f.controller.setRenderState('camera_motion', { ...READY, facadePatternEnabled: false });
    f.controller.setRenderPhase('settled_paused');
    expect(f.primaryAt(18)).toEqual(['building-3d']);
    f.controller.setActiveLayers(new Set());
    expect(f.primaryAt(18)).toEqual([]);
    expect(f.visible(ROOF)).toBe(false);
    f.controller.setActiveLayers(new Set(['buildings']));
    expect(f.primaryAt(18)).toEqual(['building-3d']);
  });

  it('keeps roof and camera-retention allowances explicit without exposing competing primary passes', () => {
    const f = fixture();
    f.controller.setRenderState('camera_motion', { ...READY, roofCapEnabled: false });
    expect(f.visible(ROOF)).toBe(false);
    expect(f.primaryAt(18)).toEqual([FACADE]);
    f.controller.setRenderState('camera_motion', { ...READY, retainDuringCameraMotion: false });
    expect(f.visible(FACADE)).toBe(false);
    expect(f.primaryAt(18)).toEqual(['building-3d']);
    f.controller.setRenderState('settled_paused', { ...READY, retainDuringCameraMotion: false });
    expect(f.primaryAt(18)).toEqual([FACADE]);
  });

  it('keeps solid geometry if a style reload lacks its expected facade pass', () => {
    const f = fixture();
    f.controller.setRenderState('settled_paused', READY);
    f.layers.delete(FACADE);
    f.styledata();
    expect(f.layers.get('building-3d')).toMatchObject({ maxzoom: 24 });
    expect(f.primaryAt(18)).toEqual(['building-3d']);
  });

  it('survives synchronous styledata during a combined update and does not reconstruct styles', () => {
    const f = fixture();
    f.enableSynchronousEvents();
    expect(() => f.controller.setRenderState('camera_motion', READY)).not.toThrow();
    expect(f.primaryAt(18)).toEqual([FACADE]);
    expect(() => f.controller.setRenderState('camera_motion', { ...READY, atlasReady: false })).not.toThrow();
    expect(f.primaryAt(18)).toEqual(['building-3d']);
  });
});
