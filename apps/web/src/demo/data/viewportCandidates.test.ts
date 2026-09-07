import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { StaticDemoProvider } from './StaticDemoProvider';

const read = (name: string) => JSON.parse(readFileSync(new URL(`../../../public/demo/${name}`, import.meta.url), 'utf8'));

it('filters a viewport cohort before the candidate budget, including the last district', () => {
  const provider = new StaticDemoProvider(read('dataset.json'), read('manifest.json'), read('legacy-synthetic-chelyabinsk-v1.json'));
  provider.seedLayout({ buildings: [{ id: 'source:home', center: [61.4, 55.16], use: 'residential' }],
    roads: [{ id: 'source:walk', coordinates: [[61.4, 55.16], [61.41, 55.16]], walkable: true, drivable: true }] });
  const territoryId = provider.territories.filter(t => t.parentId).at(-1)!.id;
  const result = provider.getVisibleCandidates('baseline', 2026, 100, {
    longitude: 61.405, latitude: 55.16, radiusMeters: 2500, minutes: 720, territoryId,
  });
  expect(result.length).toBeGreaterThan(0);
  expect(result.every(p => p.territoryId === territoryId)).toBe(true);
  expect(result.every(p => ['outdoor', 'vehicle'].includes(provider.getPresence(p.id, 720)!.state))).toBe(true);
  expect(result.length).toBeLessThanOrEqual(100);
});
