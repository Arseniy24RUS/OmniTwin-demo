// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { BuildingMaterialPolicy } from '../renderer/mapStyleController';
import type { UniversalRenderPhase } from '../renderer/motionLodPolicy';
import { RendererPerformanceGovernor, type RendererPerformanceGovernorDecision } from '../renderer/runtime/performanceGovernor';

// This is a runtime orchestration unit test, not browser/pixel evidence. The
// worker URL is an asset import only; no worker, canvas or network is started.
vi.mock('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', () => ({ default: '/unit-worker.mjs' }));
vi.mock('../renderer/deckAdapter', () => ({ attachDeckOverlay: vi.fn() }));
import { SceneRuntime } from '../renderer/runtime/SceneRuntime';

type RuntimeHooks = {
  settleRendererPerformanceIfIdle(map: MapLibreMap): void;
  applyPerformanceGovernorDecision(map: MapLibreMap, decision: RendererPerformanceGovernorDecision): void;
  applyUniversalRenderPhase(map: MapLibreMap, phase: UniversalRenderPhase): void;
};

function fixture(paused = true) {
  const root = document.createElement('div');
  const governor = new RendererPerformanceGovernor({ qualityTier: 'mid', preserveIndividualPresentation: true });
  const setRenderState = vi.fn<(phase: UniversalRenderPhase, policy: BuildingMaterialPolicy) => void>();
  const setTargetFramesPerSecond = vi.fn();
  const resetFrameIntervals = vi.fn();
  const map = { getCenter: () => ({ lng: 61.4026, lat: 55.1684 }), getZoom: () => 16.7,
    getPitch: () => 58, getBearing: () => -24 } as unknown as MapLibreMap;
  const runtime = Object.create(SceneRuntime.prototype) as RuntimeHooks;
  Object.assign(runtime, {
    rendererMode: 'universal_lowpoly', onMapFeatures: vi.fn(), performanceGovernor: governor,
    map, root, container: root, adapters: [], currentSnapshot: {}, loaded: true,
    universalRenderPhase: 'emergency_30', universalMaterialAtlasReady: true,
    presentationClock: { paused, baseRateSecondsPerWallSecond: 1, speedMultiplier: 1 },
    reducedMotion: false, cameraMoving: false, decorationTier: 'mid',
    styleController: { setRenderState, apply: vi.fn() },
    dependencies: { now: () => 2_000, clearTimeout: vi.fn() },
    frameScheduler: { setTargetFramesPerSecond },
    mapGpuFrameTimer: { resetFrameIntervals, snapshot: () => ({ readyForGovernor: false }) },
    telemetry: { setRendererPerformanceGovernor: vi.fn() },
    applyPixelBudget: vi.fn(), rebuildLivingPipeline: vi.fn(), applySnapshotToAdapter: vi.fn(),
    scheduleUniversalVegetation: vi.fn(), clearUniversalVegetation: vi.fn(),
    applyUniversalSourceTileLod: vi.fn(), publishFrameSchedulerState: vi.fn(),
  });
  return { root, map, runtime, governor, setRenderState, setTargetFramesPerSecond, resetFrameIntervals };
}

function enterFloor(governor: RendererPerformanceGovernor) {
  const slow = { moving: true, cpuFrameMs: 40, gpuFrameMs: null, frameIntervalP95Ms: 40 };
  for (const wallTimeMs of [0, 500, 1_500]) governor.observe({ ...slow, wallTimeMs });
}

describe('city runtime material orchestration', () => {
  it('resolves the new settled phase before applying recovered material ranges/visibility', () => {
    const scene = fixture();
    enterFloor(scene.governor);
    scene.runtime.settleRendererPerformanceIfIdle(scene.map);
    expect(scene.governor.snapshot.floorMode).toBe('normal');
    expect(scene.root.dataset.rendererPhase).toBe('settled_paused');
    expect(scene.setRenderState).toHaveBeenLastCalledWith('settled_paused', expect.objectContaining({
      atlasReady: true, facadePatternEnabled: true, roofCapEnabled: true, retainDuringCameraMotion: true,
    }));
    expect(scene.setTargetFramesPerSecond).toHaveBeenLastCalledWith(60);
  });

  it('does not erase genuine playback pressure merely because the camera stops', () => {
    const scene = fixture(false);
    enterFloor(scene.governor);
    scene.runtime.settleRendererPerformanceIfIdle(scene.map);
    expect(scene.governor.snapshot.floorMode).toBe('compatibility_30');
    expect(scene.setRenderState).not.toHaveBeenCalled();
  });

  it('passes the combined textured policy during ordinary camera motion', () => {
    const scene = fixture();
    scene.runtime.applyUniversalRenderPhase(scene.map, 'camera_motion');
    expect(scene.setRenderState).toHaveBeenLastCalledWith('camera_motion', expect.objectContaining({
      atlasReady: true, facadePatternEnabled: true, roofCapEnabled: true, retainDuringCameraMotion: true,
    }));
  });

  it('restores eligible static materials even after the optional GPU detail ladder was exhausted', () => {
    const scene = fixture();
    scene.governor.observe({ cpuFrameMs: 5, gpuFrameMs: 40, wallTimeMs: 0 });
    for (let step = 0; step < 7; step += 1) {
      scene.governor.observe({ cpuFrameMs: 5, gpuFrameMs: 40, wallTimeMs: 2_000 + step * 5_000 });
    }
    expect(scene.governor.snapshot.facadePatternEnabled).toBe(false);
    scene.runtime.applyUniversalRenderPhase(scene.map, 'settled_paused');
    expect(scene.setRenderState).toHaveBeenLastCalledWith('settled_paused', expect.objectContaining({
      atlasReady: true, facadePatternEnabled: true, roofCapEnabled: true,
    }));
  });

  it('starts recovery probes with a fresh measurement window and the bounded cadence', () => {
    const scene = fixture(false);
    enterFloor(scene.governor);
    const decision = scene.governor.observe({ moving: true, cpuFrameMs: 33.4,
      gpuFrameMs: null, frameIntervalP95Ms: 33.4, wallTimeMs: 11_500 })!;
    expect(decision.kind).toBe('probe_floor_recovery');
    scene.runtime.applyPerformanceGovernorDecision(scene.map, decision);
    expect(scene.resetFrameIntervals).toHaveBeenCalledOnce();
    expect(scene.setTargetFramesPerSecond).toHaveBeenLastCalledWith(60);
    expect(scene.setRenderState).toHaveBeenLastCalledWith('compatibility_30', expect.objectContaining({
      facadePatternEnabled: false, roofCapEnabled: false,
    }));
  });
});
