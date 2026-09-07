import { DEFAULT_RENDERER_MODE, type RendererMode } from './types';

export type RendererCapability = 'initializing' | 'ready' | 'degraded' | 'canvas_fallback';

export interface RendererPartsState {
  maplibre: boolean;
  deck: boolean;
  three: boolean;
  deckFailed: boolean;
  threeFailed: boolean;
  livingWorkerFallback: boolean;
}

export function rendererCapability(
  parts: RendererPartsState,
  offlineFallback: boolean,
  rendererMode: RendererMode = DEFAULT_RENDERER_MODE,
): RendererCapability {
  if (offlineFallback) return 'canvas_fallback';
  if (parts.deckFailed || parts.threeFailed || parts.livingWorkerFallback) return 'degraded';
  if (
    parts.maplibre && parts.deck &&
    (rendererMode === 'universal_lowpoly' || parts.three)
  ) return 'ready';
  return 'initializing';
}

export function rendererCapabilityLabel(
  capability: RendererCapability,
  rendererMode: RendererMode = DEFAULT_RENDERER_MODE,
): string {
  if (capability === 'ready') return rendererMode === 'universal_lowpoly'
    ? 'FULL_RENDERER · MAPLIBRE + DECK.GL'
    : 'FULL_RENDERER · MAPLIBRE + DECK.GL + THREE.JS';
  if (capability === 'degraded') return 'RENDERER_DEGRADED';
  if (capability === 'canvas_fallback') return 'CANVAS_FALLBACK';
  return 'RENDERER_INITIALIZING';
}
