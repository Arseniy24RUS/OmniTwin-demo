import { describe, expect, it } from 'vitest';
import { buildAggregateRoadFlows } from './aggregateRoadFlows';
import { aggregateFlowPhase } from '../renderer/aggregateRoadFlow';
import type { CityRoad } from './cityRoadGraph';
import { addMetersToLngLat } from '@math.gl/web-mercator';
import { WebMercatorViewport } from '@deck.gl/core';
import type { RendererViewportSnapshot } from '../renderer/types';
import { hashSeed } from '../renderer/rng';

const road: CityRoad = { id: 'source-road', coordinates: [[61.4, 55.16], [61.401, 55.16], [61.401, 55.161]], oneway: 1, className: 'primary', walkable: true, drivable: true };
const origin = [61.4, 55.16] as const;

function screenFixture(widthCss = 960, heightCss = 640) {
  const camera = { longitude: origin[0], latitude: origin[1], zoom: 14.8, pitch: 55, bearing: -24 };
  const projection = new WebMercatorViewport({ ...camera, width: widthCss, height: heightCss });
  const viewport: RendererViewportSnapshot = { camera, widthCss, heightCss, bbox: projection.getBounds(), revision: 'settled' };
  const at = (x: number, y: number): readonly [number, number] => {
    const point = projection.unproject([x, y], { targetZ: 0.12 });
    return [point[0]!, point[1]!];
  };
  const source = (id: string, x: number, y: number): CityRoad => ({ ...road, id, coordinates: [at(x - 12, y), at(x + 12, y)] });
  return { viewport, source, at };
}
describe('bounded aggregate road flows', () => {
  it('supports a denser game overview without exceeding its independent 1024-streak budget', () => {
    const { viewport, source } = screenFixture();
    const roads = Array.from({ length: 1400 }, (_, i) => source(`overview-${i}`, 32 + (i % 40) * 22, 32 + Math.floor(i / 40) * 16));
    const frame = buildAggregateRoadFlows({ roads, origin, viewport, maxInstances: 768 });
    expect(frame.segments).toHaveLength(768);
    expect(frame.diagnostics.selectedViewportCells).toBeGreaterThanOrEqual(20);
    const bounded = buildAggregateRoadFlows({ roads, origin, viewport, maxInstances: 10000 });
    expect(bounded.segments).toHaveLength(1024);
    expect(bounded.diagnostics.peakRetainedCandidates).toBeLessThanOrEqual(1024);
  });
  it.each([[960, 640], [390, 654]])('stratifies visible roads at %sx%s instead of filling the cap at a dense central junction', (width, height) => {
    const { viewport, source } = screenFixture(width, height);
    const columns = width > height ? 6 : 4;
    const rows = width > height ? 4 : 6;
    const spread = Array.from({ length: columns * rows }, (_, cell) => source(`spread-${cell}`,
      (cell % columns + 0.5) * width / columns, (Math.floor(cell / columns) + 0.5) * height / rows));
    const dense = Array.from({ length: 500 }, (_, index) => source(`central-${index}`, width / 2 + 16 + index % 4, height / 2 + 16 + index % 7));
    const frame = buildAggregateRoadFlows({ roads: [...dense, ...spread], origin, viewport, maxInstances: 48 });
    expect(frame.segments.filter(item => item.sourceRoadId.startsWith('spread-')).length).toBeGreaterThanOrEqual(22);
    expect(frame.segments.filter(item => item.sourceRoadId.startsWith('central-')).length).toBeLessThanOrEqual(26);
    expect(frame.segments.length).toBeLessThanOrEqual(48);
    expect(frame.diagnostics.peakRetainedCandidates).toBeLessThanOrEqual(48);
    expect(frame.diagnostics.occupiedViewportCells).toBe(24);
    expect(frame.diagnostics.selectedViewportCells).toBe(24);
    const reordered = buildAggregateRoadFlows({ roads: [...spread, ...dense].reverse(), origin, viewport, maxInstances: 48 });
    expect(reordered.segments).toEqual(frame.segments);
    expect(reordered.signature).toEqual(frame.signature);
    const duplicated = buildAggregateRoadFlows({ roads: [...spread, ...dense, ...spread, ...dense], origin, viewport, maxInstances: 48 });
    expect(duplicated.segments).toEqual(frame.segments);
  });
  it('matches a fair round-robin reference under sparse/dense cells, sub-cell caps and source reorderings', () => {
    const { viewport, source } = screenFixture();
    const groups = Array.from({ length: 24 }, (_, cell) => Array.from({ length: cell % 5 === 0 ? 1 : cell % 3 === 0 ? 27 : 8 }, (_, index) =>
      source(`cell-${cell}-road-${index}`, (cell % 6 + 0.5) * 160 + index % 4, (Math.floor(cell / 6) + 0.5) * 160 + index % 3)));
    const sourceRank = (item: CityRoad) => hashSeed(`${item.id}:${item.coordinates[0]!.join(',')}>${item.coordinates[1]!.join(',')}`);
    groups.forEach(group => group.sort((a, b) => sourceRank(a) - sourceRank(b)));
    const cellOrder = groups.map((_, index) => index).sort((a, b) => hashSeed(`aggregate-cell:6:4:${a}`) - hashSeed(`aggregate-cell:6:4:${b}`));
    for (const cap of [7, 24, 48, 96, 256]) {
      const expected: string[] = [];
      for (let level = 0; expected.length < cap && level < 27; level += 1) {
        for (const cell of cellOrder) {
          if (expected.length < cap && groups[cell]![level]) expected.push(groups[cell]![level]!.id);
        }
      }
      for (let order = 0; order < 4; order += 1) {
        const roads = groups.flat().sort((a, b) => hashSeed(`${order}:${a.id}`) - hashSeed(`${order}:${b.id}`));
        const frame = buildAggregateRoadFlows({ roads: [...roads, ...roads.slice(0, 60)], origin, viewport, maxInstances: cap });
        expect(new Set(frame.segments.map(segment => segment.sourceRoadId))).toEqual(new Set(expected));
        expect(frame.diagnostics.peakRetainedCandidates).toBeLessThanOrEqual(cap);
      }
    }
  });
  it('rejects offscreen roads but includes an original segment crossing the actual pitched viewport', () => {
    const { viewport, source, at } = screenFixture();
    const crossing: CityRoad = { ...road, id: 'crossing-edge', coordinates: [at(-300, 260), at(80, 260)] };
    const outside = Array.from({ length: 100 }, (_, index) => source(`offscreen-${index}`, -60, 280 + index));
    const frame = buildAggregateRoadFlows({ roads: [...outside, crossing], origin, viewport, maxInstances: 48 });
    expect(frame.segments.map(item => item.sourceRoadId)).toEqual(['crossing-edge']);
    // Viewport allocation must not fabricate endpoints or alter route timing.
    expect(frame.segments).toEqual(buildAggregateRoadFlows({ roads: [crossing], origin }).segments);
  });
  it('uses the actual wide viewport instead of silently cropping its outskirts to the initial 12 km radius', () => {
    const { viewport } = screenFixture();
    const camera = { ...viewport.camera, zoom: 10, pitch: 0 };
    const projection = new WebMercatorViewport({ ...camera, width: viewport.widthCss, height: viewport.heightCss });
    const wide = { ...viewport, camera, bbox: projection.getBounds() };
    const coordinate = (x: number): readonly [number, number] => {
      const point = projection.unproject([x, 320]); return [point[0]!, point[1]!];
    };
    const outskirts: CityRoad = { ...road, id: 'visible-outskirts', coordinates: [coordinate(820), coordinate(900)] };
    expect(buildAggregateRoadFlows({ roads: [outskirts], origin }).segments).toHaveLength(0);
    expect(buildAggregateRoadFlows({ roads: [outskirts], origin, viewport: wide }).segments).toHaveLength(1);
    expect(buildAggregateRoadFlows({ roads: [outskirts], origin, viewport: wide, maxDistanceMeters: 500 }).segments).toHaveLength(0);
  });
  it('rejects an invalid supplied viewport instead of silently falling back to a central radius', () => {
    const { viewport } = screenFixture();
    expect(() => buildAggregateRoadFlows({ roads: [road], origin, viewport: { ...viewport, widthCss: NaN } })).toThrow('viewport must be finite');
  });
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
