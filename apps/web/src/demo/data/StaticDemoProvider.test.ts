import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { StaticDemoProvider } from './StaticDemoProvider';
import type { DemoDataset, DemoDatasetManifestV1, DemoLayout, DemoLegacyExport, DemoScenarioId } from '../types';

const read = (name: string) => readFileSync(new URL(`../../../public/demo/${name}`, import.meta.url), 'utf8');
const dataset = JSON.parse(read('dataset.json')) as DemoDataset;
const manifest = JSON.parse(read('manifest.json')) as DemoDatasetManifestV1;
const legacy = JSON.parse(read('legacy-synthetic-chelyabinsk-v1.json')) as DemoLegacyExport;
const scenarios: DemoScenarioId[] = ['baseline', 'inflow', 'ageing'];
// Small explicit source-feature fixture tests placement logic, not actual city geography.
const layout: DemoLayout = {
  buildings: [
    { id: 'source:house-a', center: [61.40, 55.16], use: 'residential' },
    { id: 'source:house-b', center: [61.41, 55.16], use: 'residential' },
    { id: 'source:office', center: [61.405, 55.161], use: 'work' },
    { id: 'source:school', center: [61.405, 55.162], use: 'study' },
  ],
  roads: [
    { id: 'source:footway', coordinates: [[61.4, 55.16], [61.41, 55.16]], walkable: true, drivable: false },
    { id: 'source:road', coordinates: [[61.4, 55.161], [61.41, 55.161]], walkable: false, drivable: true },
  ],
};
let provider: StaticDemoProvider;
beforeEach(() => { provider = new StaticDemoProvider(dataset, manifest, legacy); });

describe('verified fictional stock and flow data', () => {
  it('has no scientific claims, verifies asset bytes and content hashes', () => {
    expect(manifest.scientificClaim).toBe(false);
    expect(manifest.predictiveValidation).toBe(false);
    for (const asset of Object.values(manifest.assets)) {
      const bytes = readFileSync(new URL(`../../../public/demo/${asset.url}`, import.meta.url));
      expect(bytes.byteLength).toBe(asset.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.sha256);
    }
  });
  it('preserves both original stock dates and exact original city events', () => {
    const stock = (date: string) => legacy.population.filter(r => r.geography_id === 'RU-CHE-SET' && r.stock_as_of === date).reduce((n, r) => n + Number(r.value), 0);
    expect(stock('2025-01-01')).toBe(8225);
    expect(stock('2026-01-01')).toBe(8246);
    const events = Object.fromEntries(legacy.events_aggregate.filter(r => r.geography_id === 'RU-CHE-SET').map(r => [r.event_type, r.value]));
    expect(events).toEqual({ live_birth: 98, death: 84, internal_migration_in: 105, internal_migration_out: 105, external_immigration: 17, external_emigration: 10 });
  });
  it('materializes all 8246 fictional residents, matching initial age/sex and district stocks', () => {
    for (const scenario of scenarios) {
      expect(provider.getPeople({ scenario, year: 2026 }).total).toBe(8246);
      for (const territory of provider.territories) {
        const snapshot = provider.getSnapshot(scenario, 2026, territory.id)!;
        const rows = legacy.population.filter(r => r.geography_id === territory.id && r.stock_as_of === '2026-01-01');
        expect(snapshot.population).toBe(rows.reduce((n, r) => n + Number(r.value), 0));
        for (const row of rows) expect(snapshot.ageSex.find(r => r.ageBand === row.age_band)![row.sex as 'male' | 'female']).toBe(row.value);
      }
    }
  });
  it('conserves stocks, population pyramid and employment in every scenario/year/territory', () => {
    for (const scenario of scenarios) for (const territory of provider.territories) {
      const timeline = provider.getTimeline(scenario, territory.id);
      expect(timeline).toHaveLength(11);
      for (const [index, s] of timeline.entries()) {
        expect(s.ageSex.reduce((n, r) => n + r.male + r.female, 0)).toBe(s.population);
        expect(Object.values(s.employment).reduce((a, b) => a + b, 0)).toBe(s.population);
        if (index === 0) { expect(s.netChange).toBeNull(); expect(s.births).toBeNull(); }
        else {
          expect(s.population - timeline[index - 1]!.population).toBe(s.births! - s.deaths! + s.immigration! - s.emigration! + s.internalIn! - s.internalOut!);
        }
      }
    }
  });
  it('never double-counts ancestor rows or turns unavailable snapshots into zero', () => {
    const root = provider.getSnapshot('baseline', 2030)!;
    const children = provider.territories.filter(t => t.parentId).map(t => provider.getSnapshot('baseline', 2030, t.id)!);
    expect(children.reduce((n, s) => n + s.population, 0)).toBe(root.population);
    expect(provider.getSnapshot('baseline', 2025)).toBeNull();
    expect(provider.getSnapshot('baseline', 2026, 'RU')).toBeNull();
    expect(provider.getSnapshot('baseline', 2026, 'unknown')).toBeNull();
  });
  it('returns profiles from exactly the active scenario-year membership', () => {
    for (const scenario of scenarios) for (const year of [2026, 2031, 2036]) {
      expect(provider.getPeople({ scenario, year }).total).toBe(provider.getSnapshot(scenario, year)!.population);
    }
    const newcomer = dataset.data.inflow.people.find(p => p.entryYear === 2030)!;
    expect(provider.getPerson(newcomer.id, 'inflow', 2029)).toBeNull();
    expect(provider.getPerson(newcomer.id, 'inflow', 2030)?.isFictional).toBe(true);
    expect(provider.getPerson(newcomer.id, 'baseline', 2030)).toBeNull();
    const comparison = provider.compareScenarios('baseline', 'inflow', 2036)!;
    expect(comparison.populationDelta).toBe(1620);
  });
  it('keeps approved chat profiles and household sizes consistent with public profiles', () => {
    const chat = JSON.parse(read('chat-profiles.json')) as { profiles: Array<{ id: string; householdSizes: Partial<Record<DemoScenarioId, Array<number | null>>> }> };
    const index = new Map(chat.profiles.map(p => [p.id, p]));
    expect(index.size).toBe(chat.profiles.length);
    for (const scenario of scenarios) for (const year of [2026, 2036]) {
      for (const person of provider.getPeople({ scenario, year, offset: 100, limit: 50 }).items) {
        expect(index.get(person.id)!.householdSizes[scenario]![year - 2026]).toBe(person.householdSize);
      }
    }
  });
  it('clamps pagination and shares a coherent cohort filter', () => {
    const q = { year: 2026, ageBand: '18-34' as const, sex: 'female' as const };
    const people = provider.getPeople({ ...q, limit: 500 });
    expect(people.items).toHaveLength(100);
    expect(people.total).toBe(provider.getSnapshot('baseline', 2026)!.ageSex.find(r => r.ageBand === '18-34')!.female);
    expect(provider.getPeople({ ...q, offset: 100, limit: 50 }).items.some(p => people.items.some(a => a.id === p.id))).toBe(false);
  });
});

describe('one source-backed presence state shared by all inspectors', () => {
  it('does not invent a building or position when geometry is missing', () => {
    const person = provider.getPeople().items[0]!;
    expect(provider.getPresence(person.id, 720)).toMatchObject({ state: 'unplaced', position: null, buildingId: null });
  });
  it('is deterministic, preserves assignments after new tile registration, and keeps most people inside', () => {
    provider.registerLayout(layout);
    const records = provider.getVisibleCandidates('baseline', 2026, 2000);
    const before = records.map(p => provider.getPresence(p.id, 720)!);
    expect(before.filter(p => ['home', 'work', 'study'].includes(p.state)).length).toBeGreaterThan(1600);
    expect(before.filter(p => p.state === 'outdoor').length).toBeGreaterThan(30);
    provider.registerLayout({ buildings: [{ id: 'source:new', center: [61.42, 55.16], use: 'mixed' }], roads: [] });
    expect(records.map(p => provider.getPresence(p.id, 720)!)).toEqual(before);
    const second = new StaticDemoProvider(dataset, manifest, legacy);
    second.registerLayout(layout);
    expect(records.map(p => second.getPresence(p.id, 720)!)).toEqual(before);
    expect(provider.getSnapshot('baseline', 2026)!.population).toBe(8246);
  });
  it('keeps children/household at the same home and respects road mode eligibility', () => {
    provider.registerLayout(layout);
    const people = provider.getVisibleCandidates('baseline', 2026, 2000);
    const householdHomes = new Map<string, string | null>();
    for (const person of people) {
      const night = provider.getPresence(person.id, 120)!;
      if (householdHomes.has(person.householdId)) expect(night.buildingId).toBe(householdHomes.get(person.householdId));
      householdHomes.set(person.householdId, night.buildingId);
      const noon = provider.getPresence(person.id, 720)!;
      if (noon.state === 'outdoor') expect(noon.roadId).toBe('source:footway');
      if (noon.state === 'vehicle') expect(noon.roadId).toBe('source:road');
      expect(Number(noon.buildingId !== null) + Number(noon.vehicleId !== null) + Number(noon.state === 'outdoor')).toBe(1);
    }
  });
  it('building pages and vehicle passengers match the same presence state without duplicates', () => {
    provider.registerLayout(layout);
    const occupancy = provider.getBuildingOccupancy('source:office', 720, 'baseline', 2026, 0, 500);
    expect(occupancy.limit).toBe(100);
    expect(occupancy.items.every(p => provider.getPresence(p.id, 720)!.buildingId === 'source:office')).toBe(true);
    const moving = provider.getVisibleCandidates('baseline', 2026, 2000).map(p => provider.getPresence(p.id, 720)!).find(p => p.vehicleId)!;
    const vehicle = provider.getVehicle(moving.vehicleId!, 720)!;
    expect(vehicle.occupancy).toBe(vehicle.occupants.length);
    expect(new Set(vehicle.occupants.map(p => p.id)).size).toBe(vehicle.occupancy);
    expect(vehicle.occupants.every(p => provider.getPresence(p.id, 720)!.vehicleId === vehicle.id)).toBe(true);
    expect(provider.getVehicle(vehicle.id, 120)).toBeNull();
  });
  it('does not synthesize a link between nearby but distinct one-way endpoints', () => {
    provider.registerLayout({ buildings: layout.buildings, roads: [{ id: 'source:once', coordinates: [[61.4, 55.16], [61.40001, 55.16], [61.400005, 55.16]], oneway: true, walkable: true, drivable: true }] });
    // Degenerate source route under 5m is excluded rather than invented into a traversable loop.
    expect(provider.getLayout().roads).toHaveLength(0);
  });
});
