import { useMemo } from 'react';
import type { RendererPerformancePolicyV3 } from '@omnitwin/contracts';
import type { RendererQuality } from './types';
import { demoPerformancePolicy } from './demoPerformancePolicy';

export interface RendererPerformancePolicyV3View {
  readonly policy: RendererPerformancePolicyV3;
  readonly requestedTier: RendererPerformancePolicyV3['tier'];
  readonly status: 'ready';
  readonly source: 'static_demo';
  readonly errorKind: null;
  readonly error: null;
}

/** Static Pages deployment never performs a local API request. */
export function useRendererPerformancePolicyV3(quality: RendererQuality, reducedMotion: boolean): RendererPerformancePolicyV3View {
  const policy = useMemo(() => demoPerformancePolicy(quality, reducedMotion), [quality, reducedMotion]);
  return { policy, requestedTier: policy.tier, status: 'ready', source: 'static_demo', errorKind: null, error: null };
}
