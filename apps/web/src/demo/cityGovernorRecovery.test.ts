import { describe, expect, it } from 'vitest';
import { RendererPerformanceGovernor } from '../renderer/runtime/performanceGovernor';

const moving = { cpuFrameMs: 33.4, gpuFrameMs: null, frameIntervalP95Ms: 40, moving: true } as const;
function floor() {
  const governor = new RendererPerformanceGovernor({ qualityTier: 'mid', preserveIndividualPresentation: true });
  governor.observe({ ...moving, wallTimeMs: 0 });
  governor.observe({ ...moving, wallTimeMs: 500 });
  governor.observe({ ...moving, wallTimeMs: 1_500 });
  expect(governor.snapshot.floorMode).toBe('compatibility_30');
  return governor;
}

describe('city governor material recovery', () => {
  it('keeps CPU classification usable for legacy samples without a motion flag', () => {
    const governor = new RendererPerformanceGovernor({ qualityTier: 'mid' });
    governor.observe({ cpuFrameMs: 40, gpuFrameMs: 5, wallTimeMs: 0 });
    expect(governor.observe({ cpuFrameMs: 40, gpuFrameMs: 5, wallTimeMs: 2_000 })?.kind).toBe('degrade_cpu');
  });

  it('uses the owner-approved logical presentation caps, independent of population size', () => {
    for (const [qualityTier, people, vehicles] of [['high', 1200, 1800], ['mid', 500, 800], ['low', 160, 320]] as const) {
      expect(new RendererPerformanceGovernor({ qualityTier }).snapshot).toMatchObject({ nearPeopleCap: people, nearVehicleCap: vehicles });
    }
  });

  it('releases the transient motion floor when a real sample is paused and settled', () => {
    const governor = floor();
    expect(governor.observe({ ...moving, moving: false, wallTimeMs: 1_600 })?.kind).toBe('recover_floor');
    expect(governor.snapshot).toMatchObject({ floorMode: 'normal', recoveryProbe: false,
      facadePatternEnabled: true, roofCapEnabled: true });
  });

  it('can recover at its own 30 FPS cap when fresh GPU timing demonstrates headroom', () => {
    const governor = floor();
    const capped = { ...moving, cpuFrameMs: 33.4, frameIntervalP95Ms: 34, gpuFrameMs: 10 };
    governor.observe({ ...capped, wallTimeMs: 1_600 });
    expect(governor.observe({ ...capped, wallTimeMs: 11_599 })).toBeNull();
    expect(governor.observe({ ...capped, wallTimeMs: 11_600 })?.kind).toBe('recover_floor');
    expect(governor.snapshot.floorMode).toBe('emergency_30');
  });

  it('uses a bounded 60 FPS probe without GPU timings, then restores the protected cadence', () => {
    const governor = floor();
    const capped = { ...moving, frameIntervalP95Ms: 33.4 };
    expect(governor.observe({ ...capped, wallTimeMs: 11_499 })).toBeNull();
    expect(governor.observe({ ...capped, wallTimeMs: 11_500 })?.kind).toBe('probe_floor_recovery');
    expect(governor.snapshot).toMatchObject({ floorMode: 'compatibility_30', recoveryProbe: true,
      targetFramesPerSecond: 60, dprScale: 0.5, nearPeopleCap: 80, nearVehicleCap: 20 });
    const fast = { ...moving, cpuFrameMs: 16.7, frameIntervalP95Ms: 16.7 };
    governor.observe({ ...fast, wallTimeMs: 11_750 });
    expect(governor.observe({ ...fast, wallTimeMs: 12_500 })?.kind).toBe('recover_floor');
    expect(governor.snapshot).toMatchObject({ floorMode: 'emergency_30', recoveryProbe: false, targetFramesPerSecond: 30 });
  });

  it('stops a failed probe within two seconds and does not immediately retry', () => {
    const governor = floor();
    const capped = { ...moving, frameIntervalP95Ms: 33.4 };
    governor.observe({ ...capped, wallTimeMs: 11_500 });
    expect(governor.observe({ ...moving, wallTimeMs: 13_500 })?.kind).toBe('end_floor_probe');
    expect(governor.snapshot).toMatchObject({ floorMode: 'compatibility_30', recoveryProbe: false, targetFramesPerSecond: 30 });
    expect(governor.observe({ ...capped, wallTimeMs: 13_750 })).toBeNull();
    expect(governor.snapshot.recoveryProbe).toBe(false);
  });

  it('does not treat a genuinely slow CPU/render stream as capped headroom', () => {
    const governor = floor();
    const cpuBound = { ...moving, cpuFrameMs: 55, frameIntervalP95Ms: 60, gpuFrameMs: 5 };
    governor.observe({ ...cpuBound, wallTimeMs: 1_600 });
    expect(governor.observe({ ...cpuBound, wallTimeMs: 12_000 })).toBeNull();
    expect(governor.snapshot.floorMode).toBe('compatibility_30');
  });

  it('does not recover when fresh GPU work is over budget despite fast submission intervals', () => {
    const governor = floor();
    const queuedGpu = { ...moving, cpuFrameMs: 16.7, frameIntervalP95Ms: 16.7, gpuFrameMs: 45 };
    governor.observe({ ...queuedGpu, wallTimeMs: 1_600 });
    expect(governor.observe({ ...queuedGpu, wallTimeMs: 12_000 })).toBeNull();
    expect(governor.snapshot.floorMode).toBe('compatibility_30');
  });
});
