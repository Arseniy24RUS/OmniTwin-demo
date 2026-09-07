import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACTOR_PHYSICAL_METRICS,
  actorPhysicalMetrics,
  actorPlanePoint,
  actorPlaneQuad,
} from './actorPhysical';

/** Exact bounds for the current atlas's absolute M/L/H/Q/Z paths, excluding ellipses. */
function bodyInkPoints(tile: string): Array<readonly [number, number]> {
  const points: Array<readonly [number, number]> = [];
  for (const match of tile.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)) {
    const [x, y, radius] = match.slice(1).map(Number) as [number, number, number];
    points.push([x - radius, y - radius], [x + radius, y + radius]);
  }
  for (const match of tile.matchAll(/<path d="([^"]+)"/g)) {
    const tokens = match[1]!.match(/[A-Za-z]|-?\d+(?:\.\d+)?/g)!;
    let cursor = 0;
    let x = 0;
    let y = 0;
    let startX = 0;
    let startY = 0;
    const number = () => Number(tokens[cursor++]);
    while (cursor < tokens.length) {
      const command = tokens[cursor++];
      if (command === 'M' || command === 'L') {
        x = number();
        y = number();
        if (command === 'M') [startX, startY] = [x, y];
      } else if (command === 'H') {
        x = number();
      } else if (command === 'Q') {
        const controlX = number();
        const controlY = number();
        const endX = number();
        const endY = number();
        for (const t of [
          (x - controlX) / (x - 2 * controlX + endX),
          (y - controlY) / (y - 2 * controlY + endY),
        ]) {
          if (t > 0 && t < 1) points.push([
            (1 - t) ** 2 * x + 2 * (1 - t) * t * controlX + t ** 2 * endX,
            (1 - t) ** 2 * y + 2 * (1 - t) * t * controlY + t ** 2 * endY,
          ]);
        }
        [x, y] = [endX, endY];
      } else if (command === 'Z') {
        [x, y] = [startX, startY];
      } else {
        throw new Error(`Update the atlas characterization parser for SVG command ${command}`);
      }
      points.push([x, y]);
    }
  }
  return points;
}

describe('presentation-only physical actor metrics', () => {
  it('matches the source SVG body ink and ignores the separate blurred shadow ellipses', () => {
    const svg = readFileSync(new URL(
      '../../public/assets/universal-materials/omnitwin-actor-atlas-v1.svg', import.meta.url,
    ), 'utf8');
    const tiles = [...svg.matchAll(/<g transform="translate\((\d+) (\d+)\)">([\s\S]*?)<\/g>/g)];
    expect(tiles).toHaveLength(16);
    const peoplePoints: Array<readonly [number, number]> = [];
    const bounds = (points: Array<readonly [number, number]>) => ({
      left: Math.min(...points.map((point) => point[0])),
      top: Math.min(...points.map((point) => point[1])),
      right: Math.max(...points.map((point) => point[0])),
      bottom: Math.max(...points.map((point) => point[1])),
    });
    for (const tile of tiles) {
      expect(tile[3]).toContain('<ellipse');
      const points = bodyInkPoints(tile[3]!);
      if (Number(tile[2]) === 0) {
        expect(bounds(points).top).toBe(9);
        expect(bounds(points).bottom).toBe(56);
        peoplePoints.push(...points);
      } else {
        expect(bounds(points)).toEqual(actorPhysicalMetrics('vehicle', Number(tile[1]) / 32)
          .inkBoundsPixels);
      }
    }
    expect(bounds(peoplePoints)).toEqual(ACTOR_PHYSICAL_METRICS.person.inkBoundsPixels);
  });

  it('measures person body ink rather than the blurred ground shadow or atlas padding', () => {
    const person = ACTOR_PHYSICAL_METRICS.person;
    expect(person.inkBoundsPixels).toEqual({ left: 6, top: 9, right: 27, bottom: 56 });
    expect(person.anchorYPixels).toBe(56);
    expect(person.bodyHeightMeters).toBe(1.8);
    expect(person.atlasQuadHeightMeters).toBeCloseTo(64 / 47 * 1.8);
    expect(person.atlasQuadWidthMeters).toBeCloseTo(32 / 47 * 1.8);
    expect(person.metersPerPixelX).toBe(person.metersPerPixelY);
  });

  it('uses the true quadratic rear-curve extrema for both vehicle families', () => {
    const normal = actorPhysicalMetrics('vehicle', 0);
    const wide = actorPhysicalMetrics('vehicle', 4);
    expect(normal.inkBoundsPixels).toEqual({ left: 6, top: 2, right: 26, bottom: 29 });
    expect(wide.inkBoundsPixels).toEqual({ left: 5, top: 2, right: 27, bottom: 28.5 });
    expect(normal.bodyLengthMeters).toBe(4.5);
    expect(wide.bodyLengthMeters).toBe(4.5);
    expect(normal.bodyWidthMeters).toBe(1.8);
    expect(wide.bodyWidthMeters).toBe(2);
    expect(normal.atlasQuadHeightMeters).toBeCloseTo(32 / 27 * 4.5);
    expect(wide.atlasQuadHeightMeters).toBeCloseTo(32 / 26.5 * 4.5);
    expect(normal.atlasQuadWidthMeters).toBeCloseTo(32 / 20 * 1.8);
    expect(wide.atlasQuadWidthMeters).toBeCloseTo(32 / 22 * 2);
  });

  it('never changes physical body scaling for a focus or selected presentation state', () => {
    const sizes = ['ordinary', 'focus', 'selected', 'focus-selected'].map(() => (
      actorPhysicalMetrics('person')
    ));
    expect(sizes.every((metrics) => metrics === ACTOR_PHYSICAL_METRICS.person)).toBe(true);
    for (let appearance = 0; appearance < 8; appearance += 1) {
      expect(actorPhysicalMetrics('person', appearance).bodyHeightMeters).toBe(1.8);
      expect(actorPhysicalMetrics('vehicle', appearance).bodyLengthMeters).toBe(4.5);
    }
    expect(Object.isFrozen(ACTOR_PHYSICAL_METRICS.person)).toBe(true);
    expect(Object.isFrozen(ACTOR_PHYSICAL_METRICS.person.inkBoundsPixels)).toBe(true);
  });
});

describe('world-space actor planes', () => {
  it('keeps upright people on world Z with body feet on the ground at every camera bearing', () => {
    for (const cameraRight of [[1, 0], [0, 1], [-2, 3]] as const) {
      const options = { kind: 'person' as const, cameraRight, origin: [10, 20, 7] as const };
      const feet = actorPlanePoint({ ...options, atlasX: 16, atlasY: 56 });
      const head = actorPlanePoint({ ...options, atlasX: 16, atlasY: 9 });
      expect(feet).toEqual([10, 20, 7]);
      expect(head[0]).toBe(10);
      expect(head[1]).toBe(20);
      expect(head[2] - feet[2]).toBeCloseTo(1.8);
      const body = actorPlaneQuad(options, 'body');
      expect(Math.min(...body.map((point) => point[2]))).toBe(7);
      expect(Math.max(...body.map((point) => point[2]))).toBeCloseTo(8.8);
      expect(body.every((point) => point.every(Number.isFinite))).toBe(true);
    }
  });

  it('distinguishes the grounded cropped person card from discarded below-foot shadow padding', () => {
    const visible = actorPlaneQuad({ kind: 'person' }, 'visible');
    const atlas = actorPlaneQuad({ kind: 'person' }, 'atlas');
    expect(Math.min(...visible.map((point) => point[2]))).toBe(0);
    expect(Math.max(...visible.map((point) => point[2]))).toBeCloseTo(1.8);
    expect(Math.min(...atlas.map((point) => point[2]))).toBeLessThan(0);
    expect(Math.hypot(visible[1][0] - visible[0][0], visible[1][1] - visible[0][1]))
      .toBeCloseTo(ACTOR_PHYSICAL_METRICS.person.atlasQuadWidthMeters);
  });

  it('keeps every car corner above the ground and turns clockwise from north', () => {
    for (const appearance of [0, 4]) {
      const metrics = actorPhysicalMetrics('vehicle', appearance);
      const common = { kind: 'vehicle' as const, appearance, origin: [3, 4, 2] as const };
      for (const headingDegrees of [0, 45, 90, 180, -90, 720]) {
        const quad = actorPlaneQuad({ ...common, headingDegrees }, 'body');
        expect(quad.every((point) => point.every(Number.isFinite))).toBe(true);
        expect(quad.every((point) => point[2] === 2.1)).toBe(true);
        expect(Math.hypot(...quad[1].map((value, index) => value - quad[0][index]!)))
          .toBeCloseTo(metrics.bodyWidthMeters);
        expect(Math.hypot(...quad[3].map((value, index) => value - quad[0][index]!)))
          .toBeCloseTo(4.5);
      }
      const frontNorth = actorPlanePoint({ ...common, atlasX: 16, atlasY: 2 });
      const frontEast = actorPlanePoint({ ...common, atlasX: 16, atlasY: 2, headingDegrees: 90 });
      expect(frontNorth[0]).toBeCloseTo(3);
      expect(frontNorth[1]).toBeGreaterThan(4);
      expect(frontEast[0]).toBeGreaterThan(3);
      expect(frontEast[1]).toBeCloseTo(4);
    }
  });

  it('rejects non-finite geometry, invalid appearance slots and degenerate camera directions', () => {
    expect(() => actorPhysicalMetrics('vehicle', Number.NaN)).toThrow(RangeError);
    expect(() => actorPhysicalMetrics('vehicle', 8)).toThrow(RangeError);
    expect(() => actorPhysicalMetrics('person', 0.5)).toThrow(RangeError);
    expect(() => actorPlanePoint({ kind: 'person', atlasX: Number.NaN, atlasY: 56 }))
      .toThrow(RangeError);
    expect(() => actorPlanePoint({ kind: 'person', atlasX: 16, atlasY: 65 }))
      .toThrow(RangeError);
    expect(() => actorPlaneQuad({ kind: 'person', cameraRight: [0, 0] })).toThrow(RangeError);
    expect(() => actorPlaneQuad({ kind: 'person', cameraRight: [Number.POSITIVE_INFINITY, 0] }))
      .toThrow(RangeError);
    expect(() => actorPlaneQuad({ kind: 'vehicle', headingDegrees: Number.NaN }))
      .toThrow(RangeError);
    expect(() => actorPlaneQuad({ kind: 'person', origin: [0, 0, Number.POSITIVE_INFINITY] }))
      .toThrow(RangeError);
  });
});
