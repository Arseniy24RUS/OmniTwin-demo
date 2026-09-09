import { describe, expect, it, vi } from 'vitest';
import { LaneTraffic } from './laneTraffic';

describe('retained source lane geometry work', () => {
  it('does not recompute immutable segment angles in each presentation substep', () => {
    const traffic = new LaneTraffic();
    const path = [[-41.321, 8.154], [37.447, -12.076], [69.282, 114.791]] as const;
    traffic.sync([20, 40].map((distance, index) => ({ id: `car-${index}`, routeKey: 'source-edge', path,
      sourceTime: 0, sourceDistance: distance, sourceSpeed: 7, laneSpeed: 7, atGrade: false })));
    traffic.sampleWindow(0, .2);
    const atan = vi.spyOn(Math, 'atan2');
    try {
      const sample = traffic.sampleWindow(.2, .2);
      expect(sample.previous.get('car-0')!.distance).toBeGreaterThan(20);
      expect(sample.previous.get('car-1')!.distance - sample.previous.get('car-0')!.distance).toBeGreaterThanOrEqual(8);
      expect(atan.mock.calls.length).toBe(0);
    } finally { atan.mockRestore(); }
  });

  it('replaces cached segment geometry when a source refresh changes the route', () => {
    const traffic = new LaneTraffic();
    const input = { id: 'car', routeKey: 'source-edge', sourceTime: 0, sourceDistance: 20,
      sourceSpeed: 7, laneSpeed: 7, atGrade: false };
    traffic.sync([{ ...input, path: [[0, 0], [100, 0]] }]);
    expect(traffic.sampleWindow(0, 0).previous.get('car')!.heading).toBe(90);
    traffic.sync([{ ...input, sourceTime: .2, sourceDistance: 21.4, path: [[0, 0], [0, -100]] }]);
    const car = traffic.sampleWindow(.2, 0).previous.get('car')!;
    expect(car.heading).toBe(0);
    expect(car.point[0]).toBe(0);
    expect(car.point[1]).toBeLessThan(-20);
    expect(car.visible).toBe(true);
  });
});
