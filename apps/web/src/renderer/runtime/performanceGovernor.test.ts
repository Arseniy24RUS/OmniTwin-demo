import { describe, expect, it } from 'vitest';
import { RendererPerformanceGovernor } from './performanceGovernor';

const FAST = { cpuFrameMs: 5, gpuFrameMs: 5 } as const;
const CPU_SLOW = { cpuFrameMs: 24, gpuFrameMs: 5 } as const;
const GPU_SLOW = { cpuFrameMs: 5, gpuFrameMs: 24 } as const;

describe('RendererPerformanceGovernor', () => {
  it('starts with the selected profile and keeps all base surfaces protected', () => {
    const governor = new RendererPerformanceGovernor({ qualityTier: 'mid' });

    expect(governor.snapshot).toMatchObject({
      revision: 0,
      dprScale: 1,
      nearUpdateHz: 10,
      midUpdateHz: 2,
      nearPeopleCap: 500,
      nearVehicleCap: 800,
      treeBillboardsEnabled: true,
      projectedShadowEnabled: true,
      roofCapEnabled: true,
      facadePatternEnabled: true,
      baseSurfaces: {
        ground: true,
        roads: true,
        water: true,
        buildings: true,
      },
    });
  });

  it('uses the tier frame target while preserving explicit budget overrides', () => {
    const high = new RendererPerformanceGovernor({ qualityTier: 'high', initialDprScale: 1 });
    const mid = new RendererPerformanceGovernor({ qualityTier: 'mid' });
    const low = new RendererPerformanceGovernor({ qualityTier: 'low' });
    const overridden = new RendererPerformanceGovernor({
      qualityTier: 'high',
      policy: { cpuBudgetMs: 20, gpuBudgetMs: 25 },
    });

    high.observe({ cpuFrameMs: 11, gpuFrameMs: 1, wallTimeMs: 0 });
    mid.observe({ cpuFrameMs: 11, gpuFrameMs: 1, wallTimeMs: 0 });
    low.observe({ cpuFrameMs: 11, gpuFrameMs: 1, wallTimeMs: 0 });
    overridden.observe({ cpuFrameMs: 11, gpuFrameMs: 1, wallTimeMs: 0 });
    expect(high.observe({ cpuFrameMs: 11, gpuFrameMs: 1, wallTimeMs: 2_000 })?.kind)
      .toBe('degrade_cpu');
    expect(mid.observe({ cpuFrameMs: 11, gpuFrameMs: 1, wallTimeMs: 2_000 })).toBeNull();
    expect(low.observe({ cpuFrameMs: 11, gpuFrameMs: 1, wallTimeMs: 2_000 })).toBeNull();
    expect(overridden.observe({ cpuFrameMs: 11, gpuFrameMs: 1, wallTimeMs: 2_000 })).toBeNull();
  });

  it('reduces update rates and near caps only after two seconds of CPU pressure', () => {
    const governor = new RendererPerformanceGovernor({
      qualityTier: 'high',
      initialDprScale: 1,
    });
    const stableSnapshot = governor.snapshot;

    expect(governor.observe({ ...CPU_SLOW, wallTimeMs: 0 })).toBeNull();
    expect(governor.observe({ ...CPU_SLOW, wallTimeMs: 1_999 })).toBeNull();
    expect(governor.snapshot).toBe(stableSnapshot);

    const decision = governor.observe({ ...CPU_SLOW, wallTimeMs: 2_000 });
    expect(decision).toMatchObject({ kind: 'degrade_cpu', axis: 'cpu', atMs: 2_000 });
    expect(decision?.previous).toBe(stableSnapshot);
    expect(governor.snapshot).toMatchObject({
      revision: 1,
      cpuLevel: 1,
      gpuLevel: 0,
      dprScale: 1,
      nearUpdateHz: 8,
      midUpdateHz: 1,
      nearPeopleCap: 960,
      nearVehicleCap: 1440,
    });
  });

  it('degrades GPU cost in the required DPR, trees, shadow, roof, facade order', () => {
    const governor = new RendererPerformanceGovernor({ initialDprScale: 1 });
    governor.observe({ ...GPU_SLOW, wallTimeMs: 0 });

    const expected = [
      { dprScale: 0.85, treeBillboardsEnabled: true, projectedShadowEnabled: true, roofCapEnabled: true, facadePatternEnabled: true },
      { dprScale: 0.75, treeBillboardsEnabled: true, projectedShadowEnabled: true, roofCapEnabled: true, facadePatternEnabled: true },
      { dprScale: 0.67, treeBillboardsEnabled: true, projectedShadowEnabled: true, roofCapEnabled: true, facadePatternEnabled: true },
      { dprScale: 0.67, treeBillboardsEnabled: false, projectedShadowEnabled: true, roofCapEnabled: true, facadePatternEnabled: true },
      { dprScale: 0.67, treeBillboardsEnabled: false, projectedShadowEnabled: false, roofCapEnabled: true, facadePatternEnabled: true },
      { dprScale: 0.67, treeBillboardsEnabled: false, projectedShadowEnabled: false, roofCapEnabled: false, facadePatternEnabled: true },
      { dprScale: 0.67, treeBillboardsEnabled: false, projectedShadowEnabled: false, roofCapEnabled: false, facadePatternEnabled: false },
      { dprScale: 0.5, treeBillboardsEnabled: false, projectedShadowEnabled: false, roofCapEnabled: false, facadePatternEnabled: false },
    ] as const;

    expected.forEach((snapshot, index) => {
      const wallTimeMs = 2_000 + index * 5_000;
      const decision = governor.observe({ ...GPU_SLOW, wallTimeMs });
      expect(decision?.kind).toBe('degrade_gpu');
      expect(governor.snapshot).toMatchObject(snapshot);
      expect(governor.snapshot.baseSurfaces).toEqual({
        ground: true,
        roads: true,
        water: true,
        buildings: true,
      });
    });

    expect(governor.observe({ ...GPU_SLOW, wallTimeMs: 42_000 })).toBeNull();
    expect(governor.snapshot.gpuLevel).toBe(8);
  });

  it('resets overload hysteresis when a neutral sample interrupts it', () => {
    const governor = new RendererPerformanceGovernor({ initialDprScale: 1 });
    governor.observe({ ...CPU_SLOW, wallTimeMs: 0 });
    governor.observe({ ...CPU_SLOW, wallTimeMs: 1_999 });
    governor.observe({ cpuFrameMs: 15, gpuFrameMs: 15, wallTimeMs: 2_000 });
    governor.observe({ ...CPU_SLOW, wallTimeMs: 2_001 });

    expect(governor.observe({ ...CPU_SLOW, wallTimeMs: 4_000 })).toBeNull();
    expect(governor.observe({ ...CPU_SLOW, wallTimeMs: 4_001 })?.kind).toBe('degrade_cpu');
  });

  it('never changes more often than once per five seconds', () => {
    const governor = new RendererPerformanceGovernor({ initialDprScale: 1 });
    governor.observe({ ...GPU_SLOW, wallTimeMs: 0 });
    expect(governor.observe({ ...GPU_SLOW, wallTimeMs: 2_000 })?.kind).toBe('degrade_gpu');

    expect(governor.observe({ ...GPU_SLOW, wallTimeMs: 4_000 })).toBeNull();
    expect(governor.observe({ ...GPU_SLOW, wallTimeMs: 6_999 })).toBeNull();
    expect(governor.observe({ ...GPU_SLOW, wallTimeMs: 7_000 })?.kind).toBe('degrade_gpu');
    expect(governor.snapshot.dprScale).toBe(0.75);
  });

  it('recovers one reverse-order step only after ten seconds of headroom', () => {
    const governor = new RendererPerformanceGovernor({ initialDprScale: 1 });
    governor.observe({ ...GPU_SLOW, wallTimeMs: 0 });
    governor.observe({ ...GPU_SLOW, wallTimeMs: 2_000 });
    governor.observe({ ...FAST, wallTimeMs: 2_001 });

    expect(governor.observe({ ...FAST, wallTimeMs: 12_000 })).toBeNull();
    const decision = governor.observe({ ...FAST, wallTimeMs: 12_001 });
    expect(decision).toMatchObject({ kind: 'recover_gpu', axis: 'gpu' });
    expect(governor.snapshot).toMatchObject({ dprScale: 1, gpuLevel: 0 });
  });

  it('does not recover above the tier-specific initial DPR ceiling', () => {
    const governor = new RendererPerformanceGovernor({ initialDprScale: 0.85 });
    expect(governor.snapshot.dprScale).toBe(0.85);

    governor.observe({ ...FAST, wallTimeMs: 0 });
    expect(governor.observe({ ...FAST, wallTimeMs: 10_000 })).toBeNull();
    expect(governor.snapshot.dprScale).toBe(0.85);
  });

  it('starts low/mobile at the thermal-safe 0.75 DPR rung by default', () => {
    expect(new RendererPerformanceGovernor({ qualityTier: 'low' }).snapshot.dprScale).toBe(0.75);
  });

  it('enters emergency and compatibility modes on the 30 FPS hard floor', () => {
    const governor = new RendererPerformanceGovernor({
      qualityTier: 'mid',
      initialDprScale: 1,
    });
    const slow = {
      cpuFrameMs: 10,
      gpuFrameMs: null,
      frameIntervalP95Ms: 40,
      moving: true,
    } as const;

    expect(governor.observe({ ...slow, wallTimeMs: 0 })).toBeNull();
    expect(governor.observe({ ...slow, wallTimeMs: 499 })).toBeNull();
    expect(governor.observe({ ...slow, wallTimeMs: 500 })?.kind).toBe('enter_emergency_30');
    expect(governor.snapshot).toMatchObject({
      floorMode: 'emergency_30',
      dprScale: 0.67,
      targetFramesPerSecond: 30,
      individualActorsEnabled: false,
      aggregateBuildingRepresentation: true,
      contactAoEnabled: false,
    });

    expect(governor.observe({ ...slow, wallTimeMs: 1_499 })).toBeNull();
    expect(governor.observe({ ...slow, wallTimeMs: 1_500 })?.kind)
      .toBe('enter_compatibility_30');
    expect(governor.snapshot).toMatchObject({
      floorMode: 'compatibility_30',
      dprScale: 0.5,
    });
  });

  it('uses CPU/frame-interval fallback when GPU samples are unavailable', () => {
    const governor = new RendererPerformanceGovernor({ initialDprScale: 1 });
    const fallback = { cpuFrameMs: 24, gpuFrameMs: null } as const;

    governor.observe({ ...fallback, wallTimeMs: 0 });
    expect(governor.observe({ ...fallback, wallTimeMs: 2_000 })?.kind).toBe('degrade_cpu');
  });

  it('recovers hard-floor modes only after ten seconds of sustained headroom', () => {
    const governor = new RendererPerformanceGovernor({
      qualityTier: 'mid',
      initialDprScale: 1,
    });
    const slow = {
      cpuFrameMs: 10,
      gpuFrameMs: null,
      frameIntervalP95Ms: 40,
      moving: true,
    } as const;
    governor.observe({ ...slow, wallTimeMs: 0 });
    governor.observe({ ...slow, wallTimeMs: 500 });
    governor.observe({ ...slow, wallTimeMs: 1_500 });

    const fast = { ...slow, frameIntervalP95Ms: 20 } as const;
    governor.observe({ ...fast, wallTimeMs: 1_501 });
    expect(governor.observe({ ...fast, wallTimeMs: 11_500 })).toBeNull();
    expect(governor.observe({ ...fast, wallTimeMs: 11_501 })?.kind).toBe('recover_floor');
    expect(governor.snapshot.floorMode).toBe('emergency_30');

    expect(governor.observe({ ...fast, wallTimeMs: 16_500 })).toBeNull();
    expect(governor.observe({ ...fast, wallTimeMs: 16_501 })?.kind).toBe('recover_floor');
    expect(governor.snapshot.floorMode).toBe('normal');
  });

  it('chooses the dominant normalized bottleneck and validates monotonic samples', () => {
    const governor = new RendererPerformanceGovernor({
      policy: { cpuBudgetMs: 10, gpuBudgetMs: 20 },
    });
    governor.observe({ cpuFrameMs: 13, gpuFrameMs: 40, wallTimeMs: 10 });
    const decision = governor.observe({ cpuFrameMs: 13, gpuFrameMs: 40, wallTimeMs: 2_010 });
    expect(decision?.kind).toBe('degrade_gpu');

    expect(() => governor.observe({ cpuFrameMs: 1, gpuFrameMs: 1, wallTimeMs: 2_009 }))
      .toThrow(/monotonic/i);
    expect(() => new RendererPerformanceGovernor({ policy: { headroomRatio: 2 } }))
      .toThrow(/headroomRatio/i);
  });
});
