import type { UniversalQualityTier, UniversalSemanticLod } from './types';

export interface UniversalInstanceCaps {
  readonly maxAmbientInstances: number;
  readonly maxAmbientVehicles: number;
  readonly maxAmbientPeople: number;
  readonly maxVegetationInstances: number;
  readonly maxPrecipitationInstances: number;
}

export interface UniversalVegetationProfile {
  readonly enabled: boolean;
  readonly maxInstances: number;
  readonly maxSizePixels: number;
}

const INSTANCE_CAPS: Readonly<Record<UniversalQualityTier, UniversalInstanceCaps>> = {
  high: {
    maxAmbientInstances: 3_000,
    maxAmbientVehicles: 1_800,
    maxAmbientPeople: 1_200,
    maxVegetationInstances: 2_500,
    maxPrecipitationInstances: 4_000,
  },
  mid: {
    maxAmbientInstances: 1_300,
    maxAmbientVehicles: 800,
    maxAmbientPeople: 500,
    maxVegetationInstances: 1_200,
    maxPrecipitationInstances: 1_500,
  },
  low: {
    maxAmbientInstances: 480,
    maxAmbientVehicles: 320,
    maxAmbientPeople: 160,
    maxVegetationInstances: 400,
    maxPrecipitationInstances: 400,
  },
};

export function universalSemanticLodForZoom(zoom: number): UniversalSemanticLod {
  if (!Number.isFinite(zoom)) throw new RangeError('zoom must be finite');
  if (zoom < 11) return 'territory';
  if (zoom < 13) return 'footprints';
  if (zoom < 16) return 'extrusions';
  return 'detail';
}

export function universalInstanceCaps(tier: UniversalQualityTier): UniversalInstanceCaps {
  return INSTANCE_CAPS[tier];
}

/**
 * Bounded billboard budget. The medium band starts at the detail LOD, while
 * the near band is reserved for z17+ where individual trees are legible.
 */
export function universalVegetationProfile(
  tier: UniversalQualityTier,
  zoom: number,
): UniversalVegetationProfile {
  universalSemanticLodForZoom(zoom);
  const maxSizePixels = tier === 'high' ? 64 : tier === 'mid' ? 48 : 36;
  if (tier === 'low') {
    return zoom >= 16
      ? { enabled: true, maxInstances: 400, maxSizePixels }
      : { enabled: false, maxInstances: 0, maxSizePixels };
  }
  if (zoom < 14) return { enabled: false, maxInstances: 0, maxSizePixels };
  if (tier === 'mid') {
    return {
      enabled: true,
      maxInstances: 1_200,
      maxSizePixels,
    };
  }
  return {
    enabled: true,
    maxInstances: 2_500,
    maxSizePixels,
  };
}
