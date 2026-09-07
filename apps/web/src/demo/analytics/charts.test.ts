import { describe, expect, it } from 'vitest';
import { linePath } from './charts';

describe('analytics chart temporal semantics', () => {
  it('retains gaps instead of joining across missing values', () => {
    expect(linePath([{year: 2026, value: 4}, {year: 2027, value: null}, {year: 2028, value: 0}], year => year - 2026, value => value))
      .toBe('M0.00,4.00 M2.00,0.00');
  });
  it('retains signed components and measured zero', () => {
    expect(linePath([{year: 2026, value: -4}, {year: 2027, value: 0}], year => year - 2026, value => value))
      .toBe('M0.00,-4.00 L1.00,0.00');
  });
});
