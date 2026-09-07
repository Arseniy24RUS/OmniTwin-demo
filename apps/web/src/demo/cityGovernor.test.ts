import { describe, expect, it } from 'vitest';
import { RendererPerformanceGovernor } from '../renderer/runtime/performanceGovernor';

const slow = { cpuFrameMs: 10, gpuFrameMs: null, frameIntervalP95Ms: 40, moving: true } as const;

describe('explicit demo individual presentation policy', () => {
  it('preserves the default emergency and compatibility behavior unless opted in', () => {
    for (const preserveIndividualPresentation of [undefined, false]) {
      const governor = new RendererPerformanceGovernor({ qualityTier: 'mid', preserveIndividualPresentation });
      governor.observe({ ...slow, wallTimeMs: 0 });
      for (const wallTimeMs of [500, 1_500]) {
        governor.observe({ ...slow, wallTimeMs });
        expect(governor.snapshot).toMatchObject({
          nearPeopleCap: 0, nearVehicleCap: 0, individualActorsEnabled: false,
          aggregateBuildingRepresentation: true, targetFramesPerSecond: 30,
        });
      }
    }
  });

  it('keeps a bounded 80-person and 20-car demo sample through both floor modes', () => {
    const governor = new RendererPerformanceGovernor({ qualityTier: 'mid', preserveIndividualPresentation: true });
    governor.observe({ ...slow, wallTimeMs: 0 });
    expect(governor.observe({ ...slow, wallTimeMs: 500 })?.kind).toBe('enter_emergency_30');
    expect(governor.snapshot.dprScale).toBe(0.67);
    for (const wallTimeMs of [500, 1_500, 20_000]) {
      governor.observe({ ...slow, wallTimeMs });
      expect(governor.snapshot).toMatchObject({
        nearPeopleCap: 80, nearVehicleCap: 20, individualActorsEnabled: true,
        aggregateBuildingRepresentation: false, targetFramesPerSecond: 30,
        treeBillboardsEnabled: false, treeDensityScale: 0, projectedShadowEnabled: false,
        roofCapEnabled: false, facadePatternEnabled: false, contactAoEnabled: false,
        baseSurfaces: { ground: true, roads: true, water: true, buildings: true },
      });
    }
    expect(governor.snapshot.floorMode).toBe('compatibility_30');
    expect(governor.snapshot.dprScale).toBe(0.5);
  });

  it('keeps normal tiers unchanged and recovers through the existing headroom gates', () => {
    for (const qualityTier of ['low', 'mid', 'high'] as const) {
      const normal = new RendererPerformanceGovernor({ qualityTier });
      const demo = new RendererPerformanceGovernor({ qualityTier, preserveIndividualPresentation: true });
      expect(demo.snapshot).toEqual(normal.snapshot);
      demo.observe({ ...slow, wallTimeMs: 0 });
      demo.observe({ ...slow, wallTimeMs: 500 });
      const fast = { ...slow, frameIntervalP95Ms: 20 };
      demo.observe({ ...fast, wallTimeMs: 501 });
      expect(demo.observe({ ...fast, wallTimeMs: 10_500 })).toBeNull();
      expect(demo.observe({ ...fast, wallTimeMs: 10_501 })?.kind).toBe('recover_floor');
      expect(demo.snapshot).toMatchObject({
        floorMode: 'normal', nearPeopleCap: normal.snapshot.nearPeopleCap,
        nearVehicleCap: normal.snapshot.nearVehicleCap, targetFramesPerSecond: normal.snapshot.targetFramesPerSecond,
      });
    }
  });
});
