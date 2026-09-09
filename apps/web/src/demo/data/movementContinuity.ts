import type { DemoContextV1 } from '../types';

export type MovementBounds = readonly [number, number, number, number];
/** A retention window, not a change to any shared schedule or movement rule. */
export const MOVEMENT_CONTINUITY_SECONDS = 120;
export function movementWindow(minutes: number) {
  if (!Number.isFinite(minutes) || Math.abs(minutes * 60) > Number.MAX_SAFE_INTEGER) throw new RangeError('Movement window needs finite bounded presentation time');
  const validFromMinutes = Math.floor((minutes * 60 + 1e-7) / 5) * 5 / 60;
  return { validFromMinutes, validUntilMinutes: validFromMinutes + MOVEMENT_CONTINUITY_SECONDS / 60 };
}
export function movementContextKey(context: DemoContextV1): string {
  return JSON.stringify([context.datasetId, context.scenario, context.year, context.territoryId,
    context.cohort?.ageBand ?? null, context.cohort?.sex ?? null, context.cohort?.employment ?? null]);
}
/** Shared authored schedule changes currently occur only at integer minutes.
 * Check the initial state and every intervening boundary, including midnight.
 * The caller invokes presenceFor; no schedule coefficients are copied here.
 */
export function movementScheduleSamples(minutes: number): number[] {
  const window = movementWindow(minutes); const samples = [window.validFromMinutes];
  for (let next = Math.floor(window.validFromMinutes) + 1; next <= window.validUntilMinutes; next += 1) samples.push(next);
  return samples.map(value => ((value % 1440) + 1440) % 1440);
}
/** Liang–Barsky segment clipping. A road AABB alone admits unrelated corners. */
export function corridorIntersectsBounds(coordinates: readonly (readonly number[])[], bounds: MovementBounds): boolean {
  for (let i = 1; i < coordinates.length; i += 1) {
    const a = coordinates[i - 1]!; const b = coordinates[i]!;
    const dx = b[0]! - a[0]!; const dy = b[1]! - a[1]!;
    const p = [-dx, dx, -dy, dy];
    const q = [a[0]! - bounds[0], bounds[2] - a[0]!, a[1]! - bounds[1], bounds[3] - a[1]!];
    let low = 0; let high = 1; let outside = false;
    for (let side = 0; side < 4; side += 1) {
      if (p[side] === 0) { if (q[side]! < 0) { outside = true; break; } continue; }
      const fraction = q[side]! / p[side]!;
      if (p[side]! < 0) low = Math.max(low, fraction); else high = Math.min(high, fraction);
      if (low > high) { outside = true; break; }
    }
    if (!outside) return true;
  }
  return false;
}
