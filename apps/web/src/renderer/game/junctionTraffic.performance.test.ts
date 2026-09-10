import { describe, expect, it } from 'vitest';
import { JunctionTraffic, type JunctionActor, type JunctionPath } from './junctionTraffic';

const paths: JunctionPath[] = [
  { key: 'east', kind: 'vehicle', points: [[-1000, 0], [1000, 0]], atGrade: true },
  { key: 'south', kind: 'vehicle', points: [[0, -40], [0, 40]], atGrade: true },
];

describe('junction sampling work bounds', () => {
  it('admits traffic across a city viewport exceeding the former quarter-sized junction budget', () => {
    const traffic = new JunctionTraffic();
    const city = Array.from({ length: 400 }, (_, i) => {
      const x = (i % 20) * 120, y = Math.floor(i / 20) * 120;
      return [
        { key: `east-${i}`, kind: 'vehicle', atGrade: true, points: [[x - 40, y], [x + 40, y]] },
        { key: `south-${i}`, kind: 'vehicle', atGrade: true, points: [[x, y - 40], [x, y + 40]] },
      ] as JunctionPath[];
    }).flat();
    traffic.sync(city, 1);
    expect(traffic.readSignals().diagnostics.overflow).toBe(0);
    expect(traffic.readSignals().junctions).toHaveLength(400);
    const cars: JunctionActor[] = city.map(path => ({ id: path.key, pathKey: path.key,
      distance: 32, desired: 34, fresh: true, entered: true }));
    const caps = traffic.constrain(cars, 1);
    for (let i = 0; i < 400; i++) {
      expect(caps.get(`east-${i}`)).toEqual({ distance: 34, visible: true });
      expect(caps.get(`south-${i}`)!.distance).toBeLessThanOrEqual(33);
    }
    const bounded = new JunctionTraffic({ maxJunctions: 1 });
    bounded.sync(city.slice(0, 4), 1);
    expect(bounded.readSignals().diagnostics.overflowReasons).toContain('junctions');
    expect(bounded.constrain(cars.slice(0, 4), 1).get('east-0'))
      .toEqual({ distance: 32, visible: false });
  });
  it('does not sort actors whose current and desired stations cannot reach a local conflict', () => {
    const traffic = new JunctionTraffic();
    traffic.sync([paths[0]!, ...Array.from({ length: 24 }, (_, index): JunctionPath => ({
      ...paths[1]!, key: `crossing-${index}`, points: [[-400 + index * 35, -40], [-400 + index * 35, 40]],
    }))], 1);
    expect(traffic.readSignals().diagnostics.overflow).toBe(0);
    expect(traffic.readSignals().junctions).toHaveLength(24);
    let distanceReads = 0;
    // Scrambled input catches hidden O(n log n) ordering; all stations remain
    // at least 700 m before this crossing. No elapsed-time assertion is needed.
    const actors: JunctionActor[] = Array.from({ length: 1000 }, (_, i) => {
      const distance = (i * 617 % 997) / 5;
      return { id: `remote-${i}`, pathKey: 'east', fresh: false, entered: true,
        get distance() { distanceReads++; return distance; }, desired: distance + .25 };
    });
    const caps = traffic.constrain(actors, 1, false);
    const work = distanceReads;
    expect([...caps]).toEqual(actors.map(actor => [actor.id, { distance: actor.desired, visible: true }]));
    expect(work).toBeLessThanOrEqual(actors.length * 6);
  });

  it('does not construct discarded signal snapshots during prediction', () => {
    const traffic = new JunctionTraffic(); traffic.sync(paths, 1);
    const before = traffic.readSignals(); let propReads = 0;
    const nodes = (traffic as unknown as { nodes: { approaches: { signalPoint: readonly number[] | null }[] }[] }).nodes;
    for (const node of nodes) for (const approach of node.approaches) {
      const point = approach.signalPoint;
      Object.defineProperty(approach, 'signalPoint', { get() { propReads++; return point; } });
    }
    const actors: JunctionActor[] = [
      { id: 'east-car', pathKey: 'east', distance: 992, desired: 994, fresh: false, entered: true },
      { id: 'south-car', pathKey: 'south', distance: 32, desired: 34, fresh: false, entered: true },
    ];
    const predicted = traffic.constrain(actors, 11, false);
    expect(propReads).toBe(0);
    expect(traffic.readSignals()).toEqual(before);
    expect(traffic.constrain(actors, 11, true)).toEqual(predicted);
    expect(propReads).toBeGreaterThan(0);
  });

  it('keeps long advances, occupied zones and the stop-line tolerance inside the station query', () => {
    const traffic = new JunctionTraffic(); traffic.sync(paths, 1);
    const actor = (id: string, pathKey: string, distance: number, desired: number): JunctionActor =>
      ({ id, pathKey, distance, desired, fresh: false, entered: true });
    const leap = traffic.constrain([actor('leap', 'east', 2, 1100)], 11);
    expect(leap.get('leap')!.distance).toBe(993);
    const occupied = traffic.constrain([actor('occupant', 'east', 998, 0), actor('south', 'south', 32, 34)], 11);
    expect(occupied.get('south')!.distance).toBe(33);
    expect(traffic.readSignals().junctions[0]!.heldForOccupancy).toBe(true);
    traffic.constrain([actor('at-red', 'east', 993 - .0499, 993 - .0499)], 11);
    expect(traffic.readSignals().junctions[0]!.approaches.some(approach => approach.waiting === 1)).toBe(true);
  });
});
