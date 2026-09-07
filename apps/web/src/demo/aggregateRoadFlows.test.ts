import { describe, expect, it } from 'vitest';
import { buildAggregateRoadFlows } from './aggregateRoadFlows';
import { aggregateFlowPhase } from '../renderer/aggregateRoadFlow';
import type { CityRoad } from './cityRoadGraph';
import { addMetersToLngLat } from '@math.gl/web-mercator';

const road: CityRoad = { id: 'source-road', coordinates: [[61.4, 55.16], [61.401, 55.16], [61.401, 55.161]], oneway: 1, className: 'primary', walkable: true, drivable: true };
const origin = [61.4, 55.16] as const;
describe('bounded aggregate road flows', () => {
  it('uses original source segments, no diagonal shortcuts or individual/profile identities', () => {
    const frame = buildAggregateRoadFlows({ roads: [road], origin });
    expect(frame.representation).toBe('schematic_road_flow');
    expect(frame.segments).toHaveLength(2);
    for (const segment of frame.segments) {
      expect(segment.sourceRoadId).toBe(road.id);
      expect(segment.start[2]).toBe(0.12);
      const start = addMetersToLngLat([...origin, 0], [...segment.start]);
      const end = addMetersToLngLat([...origin, 0], [...segment.end]);
      expect(Math.abs(start[0]! - end[0]!) < 1e-9 || Math.abs(start[1]! - end[1]!) < 1e-9).toBe(true);
      expect(road.coordinates.some(([x, y]) => Math.abs(x - start[0]!) < 1e-9 && Math.abs(y - start[1]!) < 1e-9)).toBe(true);
      expect(road.coordinates.some(([x, y]) => Math.abs(x - end[0]!) < 1e-9 && Math.abs(y - end[1]!) < 1e-9)).toBe(true);
      expect(segment).not.toHaveProperty('personId');
      expect(segment).not.toHaveProperty('representedCount');
    }
  });
  it('is deterministic across duplicate tile/query order and bounded', () => {
    const other = { ...road, id: 'source-other', coordinates: [[61.4, 55.162], [61.402, 55.162]] as const };
    const duplicated = buildAggregateRoadFlows({ roads: [road, other, road], origin, maxInstances: 2 });
    const reordered = buildAggregateRoadFlows({ roads: [other, road], origin, maxInstances: 2 });
    expect(duplicated.segments).toEqual(reordered.segments);
    expect(duplicated.signature).toBe(reordered.signature);
    expect(buildAggregateRoadFlows({ roads: [road], origin, maxInstances: 0 }).segments).toHaveLength(0);
    expect(buildAggregateRoadFlows({ roads: [{ ...road, drivable: false }], origin }).segments).toHaveLength(0);
  });
  it('filters distance before a bounded nearest sampler, regardless of large source query order', () => {
    const farRoads = Array.from({ length: 2_200 }, (_, index): CityRoad => ({ ...road, id: `far-${index}`,
      coordinates: Array.from({ length: 16 }, (_, vertex) => [61.8 + vertex * 0.0003, 55.4 + index * 0.000001] as const) }));
    const nearest = { ...road, id: 'last-but-nearest' };
    const roads = [...farRoads, nearest];
    const forward = buildAggregateRoadFlows({ roads, origin, maxInstances: 1, maxDistanceMeters: 500 });
    const reversed = buildAggregateRoadFlows({ roads: [...roads].reverse(), origin, maxInstances: 1, maxDistanceMeters: 500 });
    expect(forward.segments).toHaveLength(1);
    expect(forward.segments[0]!.sourceRoadId).toBe(nearest.id);
    expect(forward).toEqual(reversed);
    expect(forward.diagnostics.inputRoads).toBe(2_201);
    expect(forward.diagnostics.outsideDistanceSegments).toBe(33_000);
    expect(forward.diagnostics.peakRetainedCandidates).toBe(1);
  });
  it('skips only invalid source geometry and reports it, without bridging over a broken vertex', () => {
    const broken = { ...road, id: 'broken', coordinates: [[61.4, 55.16], [NaN, 55.16], [61.401, 55.16], [61.401, 55.161]] as const };
    const missing = { ...road, id: 'missing', coordinates: null } as unknown as CityRoad;
    const frame = buildAggregateRoadFlows({ roads: [missing, broken, { ...road, id: 'footway', drivable: false }], origin });
    expect(frame.segments).toHaveLength(1);
    expect(frame.segments[0]!.sourceRoadId).toBe('broken');
    expect(frame.diagnostics.invalidRoads).toBe(1);
    expect(frame.diagnostics.invalidSegments).toBe(2);
    expect(frame.diagnostics.excludedNonDrivableRoads).toBe(1);
    expect(frame.diagnostics.scannedSegments).toBe(3);
  });
  it('selects the same nearest bounded set when all candidates are in range, without retaining the full set', () => {
    const roads = Array.from({ length: 600 }, (_, index): CityRoad => ({ ...road, id: `near-${index}`,
      coordinates: [[61.4, 55.16001 + index * 0.000002], [61.401, 55.16001 + index * 0.000002]] }));
    const frame = buildAggregateRoadFlows({ roads, origin, maxInstances: 8, maxDistanceMeters: 500 });
    const reverse = buildAggregateRoadFlows({ roads: [...roads].reverse(), origin, maxInstances: 8, maxDistanceMeters: 500 });
    expect(frame).toEqual(reverse);
    expect(new Set(frame.segments.map(({ sourceRoadId }) => sourceRoadId))).toEqual(new Set(roads.slice(0, 8).map(({ id }) => id)));
    expect(frame.diagnostics.peakRetainedCandidates).toBe(8);
    expect(frame.diagnostics.withinDistanceSegments).toBe(600);
  });
  it('respects one-way direction and advances only with supplied presentation time', () => {
    const forward = buildAggregateRoadFlows({ roads: [road], origin }).segments;
    const reverse = buildAggregateRoadFlows({ roads: [{ ...road, oneway: -1 }], origin }).segments;
    expect(reverse[0]!.start).toEqual(forward[0]!.end);
    const segment = forward[0]!;
    expect(aggregateFlowPhase(segment, 5)).not.toBe(aggregateFlowPhase(segment, 0));
    expect(aggregateFlowPhase(segment, 5)).toBe(aggregateFlowPhase(segment, 5));
    expect(aggregateFlowPhase(segment, -5)).toBeGreaterThanOrEqual(0);
  });
});
