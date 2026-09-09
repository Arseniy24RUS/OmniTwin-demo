import { describe, expect, it } from 'vitest';
import { corridorIntersectsBounds, movementScheduleSamples, movementWindow } from './movementContinuity';

describe('bounded movement retention window', () => {
  it('includes every shared schedule boundary without shifting validity at completion', () => {
    const samples=movementScheduleSamples(500+55/60);expect(samples[0]).toBeCloseTo(500+55/60,10);expect(samples.slice(1)).toEqual([501,502]);
    const before=movementWindow(500+55/60);expect(before.validUntilMinutes-before.validFromMinutes).toBe(2);
    expect(before.validUntilMinutes).toBeLessThan(500+55/60+10*16/60);
  });
  it('wraps schedule evaluation across midnight while keeping absolute validity', () => {
    const samples=movementScheduleSamples(1439+55/60);expect(samples[0]).toBeCloseTo(1439+55/60,10);expect(samples.slice(1)).toEqual([0,1]);
    expect(movementWindow(1439+55/60).validUntilMinutes).toBeGreaterThan(1440);
  });
  it('uses source segments, not only a corridor bounding box', () => {
    const bounds=[0,0,1,1] as const;
    expect(corridorIntersectsBounds([[-1,.5],[2,.5]],bounds)).toBe(true);
    expect(corridorIntersectsBounds([[0,0],[0,0]],bounds)).toBe(true);
    expect(corridorIntersectsBounds([[-1,.5],[-1,2],[2,2]],bounds)).toBe(false);
    expect(corridorIntersectsBounds([[-1,2],[2,-1]],bounds)).toBe(true);
  });
  it('rejects unbounded clocks instead of creating an unbounded sample loop',()=>{
    expect(()=>movementScheduleSamples(1e308)).toThrow(RangeError);expect(()=>movementWindow(NaN)).toThrow(RangeError);
  });
});
