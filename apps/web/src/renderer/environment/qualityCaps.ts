import type { RendererQuality } from '../types';

export type LivingCityDeviceTier = 'low' | 'medium' | 'high';

export interface LivingCityDeviceCapabilities {
  readonly hardwareConcurrency: number;
  readonly deviceMemoryGb?: number;
  readonly devicePixelRatio: number;
  readonly mobile: boolean;
  readonly webgl2: boolean;
}

export interface LivingCityQualityCaps {
  readonly requestedQuality: RendererQuality;
  readonly effectiveQuality: Exclude<RendererQuality, 'adaptive'>;
  readonly deviceTier: LivingCityDeviceTier;
  readonly maxBuildings: number;
  readonly maxWindows: number;
  readonly maxTrees: number;
  readonly maxBenches: number;
  readonly maxStreetLamps: number;
  readonly maxTransitStops: number;
  readonly maxVehicles: number;
  readonly weatherParticles: number;
  readonly shadowMapSize: 0 | 512 | 1024 | 2048;
  readonly dynamicShadows: boolean;
  readonly animatedVegetation: boolean;
  readonly maximumPixelRatio: number;
}

const QUALITY_RANK: Record<Exclude<RendererQuality, 'adaptive'>, number> = {
  performance: 0,
  balanced: 1,
  cinematic: 2,
};

const PROFILE_CAPS = {
  performance: {
    maxBuildings: 90,
    maxWindows: 3_000,
    maxTrees: 240,
    maxBenches: 80,
    maxStreetLamps: 120,
    maxTransitStops: 28,
    maxVehicles: 120,
    weatherParticles: 480,
    shadowMapSize: 0 as const,
    dynamicShadows: false,
    animatedVegetation: false,
    maximumPixelRatio: 1,
  },
  balanced: {
    maxBuildings: 190,
    maxWindows: 8_000,
    maxTrees: 700,
    maxBenches: 180,
    maxStreetLamps: 260,
    maxTransitStops: 60,
    maxVehicles: 280,
    weatherParticles: 1_800,
    shadowMapSize: 1024 as const,
    dynamicShadows: true,
    animatedVegetation: true,
    maximumPixelRatio: 1.5,
  },
  cinematic: {
    maxBuildings: 360,
    maxWindows: 18_000,
    maxTrees: 1_600,
    maxBenches: 360,
    maxStreetLamps: 520,
    maxTransitStops: 120,
    maxVehicles: 600,
    weatherParticles: 4_800,
    shadowMapSize: 2048 as const,
    dynamicShadows: true,
    animatedVegetation: true,
    maximumPixelRatio: 2,
  },
};

export function classifyLivingCityDevice(
  capabilities: LivingCityDeviceCapabilities,
): LivingCityDeviceTier {
  const cores = Math.max(1, capabilities.hardwareConcurrency);
  const memory = capabilities.deviceMemoryGb ?? 8;
  if (!capabilities.webgl2 || capabilities.mobile || cores <= 4 || memory <= 4) return 'low';
  if (cores < 8 || memory < 8 || capabilities.devicePixelRatio > 2.5) return 'medium';
  return 'high';
}

function tierCeiling(tier: LivingCityDeviceTier): Exclude<RendererQuality, 'adaptive'> {
  if (tier === 'low') return 'performance';
  if (tier === 'medium') return 'balanced';
  return 'cinematic';
}

function lowerQuality(
  requested: Exclude<RendererQuality, 'adaptive'>,
  ceiling: Exclude<RendererQuality, 'adaptive'>,
): Exclude<RendererQuality, 'adaptive'> {
  return QUALITY_RANK[requested] <= QUALITY_RANK[ceiling] ? requested : ceiling;
}

export function resolveLivingCityQualityCaps(
  requestedQuality: RendererQuality,
  capabilities: LivingCityDeviceCapabilities,
  reducedMotion = false,
): LivingCityQualityCaps {
  const deviceTier = classifyLivingCityDevice(capabilities);
  const ceiling = tierCeiling(deviceTier);
  const effectiveQuality = requestedQuality === 'adaptive'
    ? ceiling
    : lowerQuality(requestedQuality, ceiling);
  const profile = PROFILE_CAPS[effectiveQuality];

  return {
    requestedQuality,
    effectiveQuality,
    deviceTier,
    ...profile,
    weatherParticles: reducedMotion ? 0 : profile.weatherParticles,
    animatedVegetation: reducedMotion ? false : profile.animatedVegetation,
    maximumPixelRatio: Math.min(
      profile.maximumPixelRatio,
      Math.max(1, capabilities.devicePixelRatio),
    ),
  };
}

/** Reads capabilities once; it never installs global listeners. */
export function readLivingCityDeviceCapabilities(): LivingCityDeviceCapabilities {
  const globalNavigator = typeof navigator === 'undefined' ? undefined : navigator;
  const memory = globalNavigator as (Navigator & { deviceMemory?: number }) | undefined;
  let webgl2 = false;
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    webgl2 = Boolean(canvas.getContext('webgl2'));
  }
  return {
    hardwareConcurrency: globalNavigator?.hardwareConcurrency || 8,
    deviceMemoryGb: memory?.deviceMemory,
    devicePixelRatio: typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
    mobile: typeof matchMedia === 'function'
      ? matchMedia('(pointer: coarse)').matches
      : false,
    webgl2,
  };
}
