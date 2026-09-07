import type { RendererQuality } from './types';

export interface RendererQualityProfile {
  pixelRatio: number;
  maxPitch: number;
  mapFadeDuration: number;
  antialiasThree: boolean;
  capsuleDetail: readonly [capSegments: number, radialSegments: number];
}

export function rendererQualityProfile(
  quality: RendererQuality,
  devicePixelRatio = 1,
): RendererQualityProfile {
  const dpr = Math.max(1, Math.min(3, devicePixelRatio));
  if (quality === 'cinematic') {
    return {
      pixelRatio: Math.min(2, dpr),
      maxPitch: 72,
      mapFadeDuration: 420,
      antialiasThree: true,
      capsuleDetail: [4, 8],
    };
  }
  if (quality === 'performance') {
    return {
      pixelRatio: 1,
      maxPitch: 56,
      mapFadeDuration: 0,
      antialiasThree: false,
      capsuleDetail: [1, 3],
    };
  }
  if (quality === 'balanced') {
    return {
      pixelRatio: Math.min(1.5, dpr),
      maxPitch: 66,
      mapFadeDuration: 220,
      antialiasThree: true,
      capsuleDetail: [2, 4],
    };
  }
  const hardwareConcurrency = typeof navigator === 'undefined'
    ? 8
    : navigator.hardwareConcurrency || 8;
  const constrained = hardwareConcurrency <= 4 || dpr > 2;
  return constrained
    ? rendererQualityProfile('performance', dpr)
    : rendererQualityProfile('balanced', dpr);
}
