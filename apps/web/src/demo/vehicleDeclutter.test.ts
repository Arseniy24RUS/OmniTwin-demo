import { describe, expect, it } from 'vitest';
import { declutterVehicleGlyphs, type VehicleGlyphCandidate } from './vehicleDeclutter';

const car = (id: string, x = 0, y = 0, heading = 0, selected = false): VehicleGlyphCandidate => ({ id, x, y, heading, selected });

describe('presentation-only vehicle body decluttering', () => {
  it('retains one overlapping authentic glyph without changing its identity or coordinates', () => {
    const input = [car('car:a'), car('car:b', 0, 1), car('car:c', 0, 9)];
    const before = JSON.stringify(input); const result = declutterVehicleGlyphs(input);
    expect(result.retained).toHaveLength(2);
    expect(result.diagnostics).toMatchObject({ candidateCount: 3, retainedCount: 2, suppressedOverlap: 1, suppressedBudget: 0 });
    expect(result.retained.every(item => input.includes(item))).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
  });
  it('is stable on reordered inputs and independent cold reloads', () => {
    const input = Array.from({ length: 200 }, (_, i) => car(`car:${i}`, (i % 20) * 1.5, Math.floor(i / 20) * 3));
    const ids = (rows: VehicleGlyphCandidate[]) => declutterVehicleGlyphs(rows).retained.map(item => item.id);
    expect(ids([...input].reverse())).toEqual(ids(input));
    expect(ids(JSON.parse(JSON.stringify(input)))).toEqual(ids(input));
  });
  it('protects selection before previous IDs and honors an explicit caller-owned snapshot', () => {
    const input = [car('old'), car('selected', 0, 0, 0, true)];
    const previousVehicleIds = new Set(['old', 'absent']);
    expect(declutterVehicleGlyphs(input, { previousVehicleIds }).retained.map(item => item.id)).toEqual(['selected']);
    const old = declutterVehicleGlyphs(input.map(item => ({ ...item, selected: false })), { previousVehicleIds });
    expect(old.retained.map(item => item.id)).toEqual(['old']);
    expect(old.diagnostics.previousRetainedCount).toBe(1);
    expect([...previousVehicleIds]).toEqual(['old', 'absent']);
  });
  it('keeps two still-active retained cars through a later overlap while suppressing a new entrant', () => {
    const before = declutterVehicleGlyphs([car('old:a'),car('old:b',0,12)]);
    const previousVehicleIds = new Set(before.retained.map(item=>item.id));
    const input=[car('old:a'),car('old:b',0,1),car('new',0,2)];
    const snapshot=JSON.stringify(input);
    const after=declutterVehicleGlyphs(input,{previousVehicleIds,preserveActiveMembership:true});
    expect(after.retained.map(item=>item.id).sort()).toEqual(['old:a','old:b']);
    expect(after.diagnostics).toMatchObject({previousRetainedCount:2,retainedOverlap:1,suppressedOverlap:1});
    expect(after.retained.every(item=>input.includes(item))).toBe(true);expect(JSON.stringify(input)).toBe(snapshot);
    const stopped=declutterVehicleGlyphs([input[1]!,input[2]!],{previousVehicleIds,preserveActiveMembership:true});
    expect(stopped.retained.map(item=>item.id)).toEqual(['old:b']);
    const selected=declutterVehicleGlyphs([...input.slice(0,2),{...input[2]!,selected:true}],{previousVehicleIds,preserveActiveMembership:true});
    expect(selected.retained.map(item=>item.id)).toEqual(['new']);
    expect(declutterVehicleGlyphs(input,{previousVehicleIds}).retained).toHaveLength(1);
  });
  it('keeps side-by-side and opposite lanes with actual lateral separation', () => {
    const result = declutterVehicleGlyphs([car('lane:a'), car('lane:b', 2.6, 0), car('lane:c', -2.6, 0, 180)]);
    expect(result.retained).toHaveLength(3);
    expect(result.diagnostics.suppressedOverlap).toBe(0);
    expect(declutterVehicleGlyphs([car('opposite:a'), car('opposite:b', 0, 0, 180)]).retained).toHaveLength(1);
  });
  it('handles a sharp crossing with oriented bodies rather than isotropic distance', () => {
    expect(declutterVehicleGlyphs([car('north'), car('east', 0, 0, 90)]).retained).toHaveLength(1);
    // These centers are only 4m apart, but their perpendicular bodies do not overlap.
    expect(declutterVehicleGlyphs([car('north'), car('east', 4, 0, 90)]).retained).toHaveLength(2);
    expect(declutterVehicleGlyphs([car('bend:a', 0, 0, 45), car('bend:b', 0.2, 0.2, 135)]).retained).toHaveLength(1);
  });
  it('finds overlaps across spatial-bin boundaries', () => {
    expect(declutterVehicleGlyphs([car('edge:a', 5.9, 0), car('edge:b', 6.1, 0)]).retained).toHaveLength(1);
  });
  it('bounds output and collision work and reports distinct visual suppression reasons', () => {
    const input = Array.from({ length: 5_001 }, (_, i) => car(`budget:${i}`, (i % 100) * 10, Math.floor(i / 100) * 10));
    const output = declutterVehicleGlyphs(input, { maxVehicles: 7 });
    expect(output.retained).toHaveLength(7);
    expect(output.diagnostics).toMatchObject({ candidateCount: 5_001, suppressedBudget: 4_994, suppressedOverlap: 0, partial: false });
    expect(declutterVehicleGlyphs(input).retained).toHaveLength(1_800);
    const bounded = declutterVehicleGlyphs([car('a'), car('b', 0, 1), car('c', 0, 2)], { maxComparisons: 0 });
    expect(bounded.diagnostics).toMatchObject({ retainedCount: 1, comparisons: 0, suppressedComparisonBudget: 2, partial: true });
    const dense = declutterVehicleGlyphs(input.map(item => ({ ...item, x: item.x / 10, y: item.y / 10 })));
    expect(dense.diagnostics.comparisons).toBeLessThanOrEqual(100_000);
    expect(dense.retained.length).toBeLessThanOrEqual(1_800);
  });
  it('fails explicitly on unbounded, duplicate or invalid geometry inputs', () => {
    expect(() => declutterVehicleGlyphs(Array.from({ length: 5_002 }, (_, i) => car(`car:${i}`)))).toThrow(RangeError);
    expect(() => declutterVehicleGlyphs([car('same'), car('same')])).toThrow();
    expect(() => declutterVehicleGlyphs([car('bad', NaN)])).toThrow();
    expect(() => declutterVehicleGlyphs([], { maxVehicles: Infinity })).toThrow();
  });
});
