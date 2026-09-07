import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { StaticDemoProvider } from './StaticDemoProvider';
import type { DemoCityPackManifestV1 } from './StaticDemoProvider';
import type { DemoDataset, DemoDatasetManifestV1, DemoLayout, DemoLegacyExport } from '../types';
const file = (path: string) => readFileSync(new URL(`../../../public/${path}`, import.meta.url));
const json = (path: string) => JSON.parse(file(path).toString('utf8'));
const pack = json('city/manifest.json') as DemoCityPackManifestV1;
const layout = json(`city/${pack.layout.url}`) as DemoLayout;
const make = () => new StaticDemoProvider(json('demo/dataset.json') as DemoDataset, json('demo/manifest.json') as DemoDatasetManifestV1, json('demo/legacy-synthetic-chelyabinsk-v1.json') as DemoLegacyExport);

describe('bounded real-source Chelyabinsk city pack', () => {
  it('verifies every actual MVT tile and matches compiled building IDs to the source', () => {
    expect(pack.tileCount).toBe(42);
    expect(pack.tileBytes).toBeLessThan(20 * 1024 * 1024);
    expect(pack.coverage).toBe('bounded_chelyabinsk_center_not_whole_city');
    const ids = new Set<string>();
    for (const asset of pack.tiles) {
      const bytes = file(`city/${asset.url}`);
      expect(bytes.byteLength).toBe(asset.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.sha256);
      const tile = new VectorTile(new PbfReader(bytes));
      if (asset.z === 14) {
        const buildings = tile.layers.building;
        for (let i = 0; i < (buildings?.length ?? 0); i++) ids.add(`openmaptiles_buildings:${buildings!.feature(i).id}`);
      }
    }
    expect(layout.buildings.every(b => ids.has(b.id))).toBe(true);
    expect(layout.buildings).toHaveLength(pack.layout.buildings);
    expect(layout.roads).toHaveLength(pack.layout.roads);
    expect(layout.roads.some(r => r.walkable)).toBe(true);
    expect(layout.roads.some(r => r.drivable)).toBe(true);
    expect(createHash('sha256').update(file(`city/${pack.layout.url}`)).digest('hex')).toBe(pack.layout.sha256);
  });
  it('fixes source assignments before differently ordered live tile arrivals', () => {
    const a = make(); const b = make();
    a.seedLayout(layout); b.seedLayout(layout);
    const extra: DemoLayout = { buildings: [{ id: 'openmaptiles_buildings:extra', center: [61.45, 55.18], use: 'mixed' }], roads: [] };
    a.registerLayout(extra);
    b.registerLayout({ buildings: [...layout.buildings].reverse(), roads: [...layout.roads].reverse() });
    b.registerLayout(extra);
    for (const person of a.getVisibleCandidates('baseline', 2026, 1500)) {
      expect(a.getPresence(person.id, 720)).toEqual(b.getPresence(person.id, 720));
    }
    expect(() => a.seedLayout(layout)).toThrow('must precede person assignments');
  });
});
