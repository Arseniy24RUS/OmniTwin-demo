import type { RendererQuality } from '../types';

const HIGH_PIXEL_BUDGET = 3_840 * 2_160;
const MID_PIXEL_BUDGET = 1_920 * 1_080;
/**
 * Shared raster-pressure ladder. The final 0.5 rung is deliberately reserved
 * for the compatibility floor: it keeps the DOM UI crisp while halving each
 * canvas dimension when a moving WebGL scene cannot otherwise hold 30 FPS.
 */
export const ADAPTIVE_DPR_LADDER = [1, 0.85, 0.75, 0.67, 0.5] as const;

export interface PixelBudgetInput {
  cssWidth: number;
  cssHeight: number;
  devicePixelRatio: number;
  quality: RendererQuality;
  adaptiveScale?: number;
}

export interface PixelBudgetPolicy {
  pixelRatio: number;
  pixelBudget: number;
  drawingBufferWidth: number;
  drawingBufferHeight: number;
  drawingBufferPixels: number;
}

function pixelBudgetForQuality(quality: RendererQuality): number {
  return quality === 'performance' || quality === 'balanced'
    ? MID_PIXEL_BUDGET
    : HIGH_PIXEL_BUDGET;
}

/** Caps raster work by actual drawing-buffer pixels, independent of display DPR. */
export function resolvePixelBudget({
  cssWidth,
  cssHeight,
  devicePixelRatio,
  quality,
  adaptiveScale = 1,
}: PixelBudgetInput): PixelBudgetPolicy {
  const width = Math.max(1, Math.floor(Number.isFinite(cssWidth) ? cssWidth : 1));
  const height = Math.max(1, Math.floor(Number.isFinite(cssHeight) ? cssHeight : 1));
  const dpr = Math.max(0.5, Math.min(3, Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1));
  const pixelBudget = pixelBudgetForQuality(quality);
  const budgetRatio = Math.sqrt(pixelBudget / (width * height));
  const pixelRatio = Math.max(
    0.25,
    Math.min(dpr, budgetRatio) * Math.max(0.5, Math.min(1, adaptiveScale)),
  );
  const drawingBufferWidth = Math.max(1, Math.round(width * pixelRatio));
  const drawingBufferHeight = Math.max(1, Math.round(height * pixelRatio));
  return {
    pixelRatio,
    pixelBudget,
    drawingBufferWidth,
    drawingBufferHeight,
    drawingBufferPixels: drawingBufferWidth * drawingBufferHeight,
  };
}

/** Small deterministic controller: degrade quickly, recover only after sustained headroom. */
export class AdaptivePixelBudgetController {
  private scaleIndex: number;
  private slowDurationMs = 0;
  private fastDurationMs = 0;
  private readonly targetFrameMs: number;

  constructor(options: { initialScale?: number; targetFrameMs?: number } = {}) {
    const initialScale = options.initialScale ?? 1;
    this.scaleIndex = ADAPTIVE_DPR_LADDER.reduce((best, scale, index) => (
      Math.abs(scale - initialScale) < Math.abs(ADAPTIVE_DPR_LADDER[best]! - initialScale)
        ? index
        : best
    ), 0);
    this.targetFrameMs = Math.max(4, options.targetFrameMs ?? 1_000 / 60);
  }

  get scale(): number {
    return ADAPTIVE_DPR_LADDER[this.scaleIndex]!;
  }

  observeFrame(deltaMs: number): boolean {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return false;
    const boundedDelta = Math.min(100, deltaMs);
    if (deltaMs > this.targetFrameMs * 1.2) {
      this.slowDurationMs += boundedDelta;
      this.fastDurationMs = 0;
      if (this.slowDurationMs < 2_000 || this.scaleIndex >= ADAPTIVE_DPR_LADDER.length - 1) return false;
      this.scaleIndex += 1;
      this.slowDurationMs = 0;
      return true;
    }
    if (deltaMs < this.targetFrameMs * 0.75) {
      this.fastDurationMs += boundedDelta;
      this.slowDurationMs = 0;
      if (this.fastDurationMs < 10_000 || this.scaleIndex === 0) return false;
      this.scaleIndex -= 1;
      this.fastDurationMs = 0;
      return true;
    }
    this.slowDurationMs = 0;
    this.fastDurationMs = 0;
    return false;
  }
}
