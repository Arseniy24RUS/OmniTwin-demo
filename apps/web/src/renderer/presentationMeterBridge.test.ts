import { describe, expect, it } from 'vitest';
import { WebMercatorViewport } from '@deck.gl/core';
import { addMetersToLngLat } from '@math.gl/web-mercator';
import { createPresentationMeterBridge } from './presentationMeterBridge';

describe('source-local to Deck metre projection bridge', () => {
  it('preserves exact source WGS84 at 1km offsets rather than shifting actors into nearby buildings', () => {
    const origin = [61.4, 55.16] as const;
    const bridge = createPresentationMeterBridge(origin);
    const output = new Float32Array(3);
    const viewport = new WebMercatorViewport({ longitude: origin[0], latitude: origin[1], zoom: 18, pitch: 55, width: 1200, height: 800 });
    for (const [x, y] of [[0, 1000], [1000, 0], [1000, 1000], [-1000, -1000]]) {
      bridge.write(output, 0, x!, y!, 0.1);
      const expected = [origin[0] + x! / (111_320 * Math.cos(origin[1] * Math.PI / 180)), origin[1] + y! / 110_540, 0.1];
      const actual = addMetersToLngLat([...origin, 0], [...output]);
      expect(actual[0]).toBeCloseTo(expected[0]!, 8);
      expect(actual[1]).toBeCloseTo(expected[1]!, 8);
      const expectedPixel = viewport.project(expected);
      const actualPixel = viewport.project(actual);
      expect(Math.hypot(actualPixel[0]! - expectedPixel[0]!, actualPixel[1]! - expectedPixel[1]!)).toBeLessThan(0.02);
    }
    bridge.write(output, 0, 0, 1000, 0.1);
    expect(Math.abs(output[1]! - 1000)).toBeGreaterThan(5);
  });
});
