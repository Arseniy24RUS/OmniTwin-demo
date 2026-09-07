// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { UniversalRenderPhase } from '../renderer/motionLodPolicy';
vi.mock('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', () => ({ default: '/unit-worker.mjs' }));
vi.mock('../renderer/deckAdapter', () => ({ attachDeckOverlay: vi.fn() }));
import { SceneRuntime } from '../renderer/runtime/SceneRuntime';

type Hooks = {
  applyUniversalSourceTileLod(map: MapLibreMap, phase: UniversalRenderPhase): void;
  publishMapLifecycleReadiness(map: MapLibreMap, idle: boolean): void;
  recordMapRenderReadiness(map: MapLibreMap): void;
};
function fixture() {
  const root = document.createElement('div');
  let source = {};
  let tilesLoaded = true;
  const setter = vi.fn();
  const map = { getSource: () => source, setSourceTileLodParams: setter,
    areTilesLoaded: () => tilesLoaded } as unknown as MapLibreMap;
  const runtime = Object.assign(Object.create(SceneRuntime.prototype), {
    root, map, disposed: false, lifecycle: new AbortController(),
    activeBuildingSource: { id: 'openmaptiles_buildings' },
    appliedUniversalSourceTileLod: null, mapRenderRevision: 0,
  }) as Hooks;
  return { root, map, runtime, setter, replaceSource: () => { source = {}; },
    setTilesLoaded: (value: boolean) => { tilesLoaded = value; } };
}

describe('paused map service lifecycle', () => {
  it('does not dirty MapLibre again for identical source objects and LOD budgets', () => {
    const scene = fixture();
    scene.runtime.applyUniversalSourceTileLod(scene.map, 'settled_paused');
    const calls = scene.setter.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    scene.runtime.applyUniversalSourceTileLod(scene.map, 'settled_paused');
    expect(scene.setter).toHaveBeenCalledTimes(calls);
    scene.replaceSource();
    scene.runtime.applyUniversalSourceTileLod(scene.map, 'settled_paused');
    expect(scene.setter).toHaveBeenCalledTimes(calls * 2);
    scene.runtime.applyUniversalSourceTileLod(scene.map, 'camera_motion');
    expect(scene.setter).toHaveBeenCalledTimes(calls * 3);
  });

  it('publishes actual tile/idle state and a fresh revision for every render', () => {
    const scene = fixture();
    scene.runtime.publishMapLifecycleReadiness(scene.map, true);
    expect(scene.root.dataset.mapIdle).toBe('true');
    expect(scene.root.dataset.mapTilesLoaded).toBe('true');
    scene.runtime.recordMapRenderReadiness(scene.map);
    expect(scene.root.dataset.mapIdle).toBe('false');
    expect(scene.root.dataset.mapRenderRevision).toBe('1');
    scene.runtime.recordMapRenderReadiness(scene.map);
    expect(scene.root.dataset.mapRenderRevision).toBe('2');
    scene.setTilesLoaded(false);
    scene.runtime.publishMapLifecycleReadiness(scene.map, false);
    expect(scene.root.dataset.mapTilesLoaded).toBe('false');
    scene.setTilesLoaded(true);
    scene.runtime.publishMapLifecycleReadiness(scene.map, true);
    expect(scene.root.dataset.mapIdle).toBe('true');
    expect(scene.root.dataset.mapRenderRevision).toBe('2');
  });
});
