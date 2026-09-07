import { semanticLevelForZoom } from '../lod';
import {
  LivingLod,
  LivingPrimaryRenderer,
  type LivingDeviceCaps,
} from './types';

export interface LivingLodSelectionInput {
  zoom: number;
  screenSizePixels: number;
  previousLod?: LivingLod;
  focus?: boolean;
  /** Universal mode keeps one binary Deck path; legacy preserves split rendering. */
  rendererPolicy?: LivingRendererPolicy;
}

export type LivingRendererPolicy = 'deck_only' | 'legacy_split';

export interface LivingLodSelection {
  lod: LivingLod;
  renderer: LivingPrimaryRenderer;
}

const LOD_SCREEN_THRESHOLDS: Readonly<Record<LivingLod, number>> = {
  [LivingLod.CULLED]: 0,
  [LivingLod.IMPOSTOR]: 0.75,
  [LivingLod.LOW]: 3,
  [LivingLod.DETAILED]: 12,
  [LivingLod.FOCUS]: Number.POSITIVE_INFINITY,
};

const HYSTERESIS_FRACTION = 0.15;

function semanticMaximum(zoom: number): LivingLod {
  const level = semanticLevelForZoom(zoom);
  if (level === 'country' || level === 'subject') return LivingLod.IMPOSTOR;
  if (level === 'city') return LivingLod.LOW;
  return LivingLod.DETAILED;
}

function rawScreenLod(screenSizePixels: number): LivingLod {
  const size = Math.max(0, Number.isFinite(screenSizePixels) ? screenSizePixels : 0);
  if (size >= LOD_SCREEN_THRESHOLDS[LivingLod.DETAILED]) return LivingLod.DETAILED;
  if (size >= LOD_SCREEN_THRESHOLDS[LivingLod.LOW]) return LivingLod.LOW;
  if (size >= LOD_SCREEN_THRESHOLDS[LivingLod.IMPOSTOR]) return LivingLod.IMPOSTOR;
  return LivingLod.CULLED;
}

function applyHysteresis(
  proposed: LivingLod,
  previous: LivingLod | undefined,
  screenSizePixels: number,
): LivingLod {
  if (previous === undefined || previous === LivingLod.FOCUS || previous === proposed) return proposed;
  if (proposed > previous) {
    const promoteAt = LOD_SCREEN_THRESHOLDS[proposed] * (1 + HYSTERESIS_FRACTION);
    return screenSizePixels >= promoteAt ? proposed : previous;
  }
  const retainUntil = LOD_SCREEN_THRESHOLDS[previous] * (1 - HYSTERESIS_FRACTION);
  return screenSizePixels >= retainUntil ? previous : proposed;
}

export function primaryRendererForLod(
  lod: LivingLod,
  rendererPolicy: LivingRendererPolicy = 'legacy_split',
): LivingPrimaryRenderer {
  if (lod === LivingLod.CULLED) return LivingPrimaryRenderer.NONE;
  if (rendererPolicy === 'deck_only') return LivingPrimaryRenderer.DECK;
  if (lod === LivingLod.IMPOSTOR) return LivingPrimaryRenderer.DECK;
  return LivingPrimaryRenderer.THREE;
}

export function selectLivingLod({
  zoom,
  screenSizePixels,
  previousLod,
  focus = false,
  rendererPolicy = 'legacy_split',
}: LivingLodSelectionInput): LivingLodSelection {
  if (focus) {
    return {
      lod: LivingLod.FOCUS,
      renderer: primaryRendererForLod(LivingLod.FOCUS, rendererPolicy),
    };
  }
  const maximum = semanticMaximum(zoom);
  const proposed = Math.min(rawScreenLod(screenSizePixels), maximum) as LivingLod;
  const previousWithinSemanticCeiling = previousLod === undefined
    ? undefined
    : Math.min(previousLod, maximum) as LivingLod;
  const lod = Math.min(
    applyHysteresis(proposed, previousWithinSemanticCeiling, screenSizePixels),
    maximum,
  ) as LivingLod;
  return { lod, renderer: primaryRendererForLod(lod, rendererPolicy) };
}

export function mergeLivingDeviceCaps(
  caps: Partial<LivingDeviceCaps> | undefined,
  defaults: Readonly<LivingDeviceCaps>,
): LivingDeviceCaps {
  const positiveInteger = (value: number | undefined, fallback: number, minimum = 0) =>
    Math.max(minimum, Math.floor(Number.isFinite(value) ? value! : fallback));
  return {
    maxPedestrians: positiveInteger(caps?.maxPedestrians, defaults.maxPedestrians),
    maxVehicles: positiveInteger(caps?.maxVehicles, defaults.maxVehicles),
    maxDetailedPedestrians: positiveInteger(
      caps?.maxDetailedPedestrians,
      defaults.maxDetailedPedestrians,
    ),
    maxDetailedVehicles: positiveInteger(
      caps?.maxDetailedVehicles,
      defaults.maxDetailedVehicles,
    ),
    maxDetailed: positiveInteger(caps?.maxDetailed, defaults.maxDetailed),
    maxLow: positiveInteger(caps?.maxLow, defaults.maxLow),
    maxImpostors: positiveInteger(caps?.maxImpostors, defaults.maxImpostors),
    maxChunkEntities: positiveInteger(caps?.maxChunkEntities, defaults.maxChunkEntities, 1),
  };
}
