import { RendererPerformancePolicyV3Schema, type RendererPerformancePolicyV3 } from '@omnitwin/contracts';
import { conservativeRendererPerformancePolicyV3 } from './performancePolicyClient';
import type { RendererQuality } from './types';

const policies = new Map<string, RendererPerformancePolicyV3>();

/** A local presentation policy; no server negotiation or model parameters are involved. */
export function demoPerformancePolicy(quality: RendererQuality, reducedMotion: boolean): RendererPerformancePolicyV3 {
  const tier = quality === 'performance' ? 'low' : 'mid';
  const key = `${tier}:${reducedMotion}`;
  const cached = policies.get(key);
  if (cached) return cached;
  const baseline = conservativeRendererPerformancePolicyV3(reducedMotion);
  const detailed = {
    buildingMode: 'full_budgeted', actorMode: 'budgeted',
    contactAo: tier !== 'low', projectedShadow: tier !== 'low',
    facadePattern: true, roofCap: true, treeBillboards: true,
  };
  const policy = RendererPerformancePolicyV3Schema.parse({
    ...baseline, tier,
    targetFps: tier === 'low' ? 30 : 60,
    targetFrameBudgetMs: tier === 'low' ? 33.333 : 16.667,
    scheduler: { ...baseline.scheduler, maxFps: tier === 'low' ? 30 : 60 },
    dprLadder: tier === 'low' ? [0.75, 0.67, 0.5] : [1, 0.85, 0.75, 0.67, 0.5],
    phaseProfiles: {
      ...baseline.phaseProfiles,
      living_motion: { ...detailed, projectedShadow: false, actorMode: 'individual' },
      settled_paused: detailed,
    },
  });
  policies.set(key, policy);
  return policy;
}
