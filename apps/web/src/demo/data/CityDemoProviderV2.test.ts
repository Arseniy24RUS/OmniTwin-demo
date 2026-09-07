import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { CityDemoProviderV2, type PopulationManifestV2 } from './CityDemoProviderV2';
import { CityPackV2 } from './CityPackV2';
import { DATASET_ID, decodePersonShard, recordAt, encodePersonShard, encodeHouseholdShard, profileFor, isActive, employmentFor, coarseAgeBand } from '../../../../../shared/demo-population/index.mjs';
import { encodeTargetShard, SPATIAL_NONE } from '../../../../../shared/demo-population/spatial.mjs';
import type { DemoAsset, DemoLegacyExport, DemoScenarioId, DemoSnapshot } from '../types';

async function fixture() {
  const files = new Map<string, Uint8Array>(); const requests: string[] = [];
  const asset = (url: string, value: Uint8Array | object): DemoAsset => { const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(JSON.stringify(value)); files.set(new URL(url, 'https://fixture.test/demo-v2/').href, bytes); return { url, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; };
  const people = encodePersonShard(0, [
    { householdIndex: 0, birthYear: 1986, sex: 'female', householdRole: 'head', scenarioMask: 7, entryYear: 2026, entryReason: 'initial', exitYears: [null, null, null], exitReasons: [null, null, null] },
    { householdIndex: 0, birthYear: 2017, sex: 'male', householdRole: 'child', scenarioMask: 7, entryYear: 2026, entryReason: 'initial', exitYears: [null, null, null], exitReasons: [null, null, null] },
    { householdIndex: 1, birthYear: 1946, sex: 'male', householdRole: 'head', scenarioMask: 7, entryYear: 2026, entryReason: 'initial', exitYears: [null, null, null], exitReasons: [null, null, null] },
    { householdIndex: 0, birthYear: 2027, sex: 'female', householdRole: 'child', scenarioMask: 1, entryYear: 2027, entryReason: 'birth', exitYears: [null, null, null], exitReasons: [null, null, null] },
  ]);
  const decoded = decodePersonShard(people); const records = Array.from({ length: 4 }, (_, i) => recordAt(decoded, i));
  const p = asset('people.bin', people); const h = asset('households.bin', encodeHouseholdShard(0, [{ homeBuildingIndex: 0, districtIndex: 0, members: [0, 1, 3] }, { homeBuildingIndex: 1, districtIndex: 4, members: [2] }]));
  const ageBands = ['0-17', '18-34', '35-54', '55-69', '70+']; const jobs = ['child', 'student', 'employed', 'retired', 'not_employed']; const districts = ['RU-CHE-SET-CEN', 'RU-CHE-SET-KAL', 'RU-CHE-SET-KUR', 'RU-CHE-SET-LEN', 'RU-CHE-SET-MET', 'RU-CHE-SET-SOV', 'RU-CHE-SET-TRA'];
  const contexts = [2026, 2027].map((year) => ({ scenario: 'baseline' as const, year })); const snapshots: (DemoSnapshot & { cohortCube: object[] })[] = [];
  const facets = contexts.map(({ year }) => {
    const cells = new Map<number, number>(); const active = records.filter((record) => isActive(record, year, 'baseline')); const cube = [];
    for (const record of active) { const code = (record.householdIndex === 1 ? 4 : 0) * 50 + ageBands.indexOf(coarseAgeBand(year - record.birthYear)) * 10 + (record.sex === 'female' ? 5 : 0) + jobs.indexOf(employmentFor(record, year)); cells.set(code, (cells.get(code) ?? 0) + 1); cube.push({ ageBand: coarseAgeBand(year - record.birthYear), sex: record.sex, employment: employmentFor(record, year), population: 1 }); }
    snapshots.push({ datasetId: DATASET_ID, scenario: 'baseline', year, stockAsOf: `${year}-01-01`, territoryId: 'RU-CHE-SET', population: active.length, ageSex: ageBands.map((ageBand) => ({ ageBand, male: active.filter((r) => r.sex === 'male' && coarseAgeBand(year - r.birthYear) === ageBand).length, female: active.filter((r) => r.sex === 'female' && coarseAgeBand(year - r.birthYear) === ageBand).length })) as DemoSnapshot['ageSex'], employment: Object.fromEntries(jobs.map((job) => [job, active.filter((r) => employmentFor(r, year) === job).length])) as DemoSnapshot['employment'], households: 2, births: null, deaths: null, immigration: null, emigration: null, internalIn: null, internalOut: null, netChange: null, representation: 'fictional_demo', cohortCube: cube });
    return [...cells].flat();
  });
  const queryIndex = { contexts, axes: { districts, ageBands, sexes: ['male', 'female'], employment: jobs }, shards: [{ startIndex: 0, count: 4, contexts: facets }] };
  const manifest: PopulationManifestV2 = { contract: 'DemoPopulationManifestV2', datasetId: DATASET_ID, version: '2', representation: 'fictional_demo', scientificClaim: false, predictiveValidation: false, startYear: 2026, endYear: 2036, initialPopulation: 3, recordCount: 4, householdCount: 2, seed: 1, personShardSize: 8192, householdShardSize: 4096, personShards: [{ ...p, startIndex: 0, count: 4 }], householdShards: [{ ...h, startIndex: 0, count: 2 }], summaries: asset('summary.json', { snapshots }), queryIndex: asset('query.json', queryIndex), territories: [{ id: 'RU-CHE-SET', name: 'Челябинск', parentId: null }, { id: districts[0]!, name: 'Центральный район', parentId: 'RU-CHE-SET' }, { id: districts[4]!, name: 'Металлургический район', parentId: 'RU-CHE-SET' }], scenarios: ['baseline', 'inflow', 'ageing'].map((id) => ({ id: id as DemoScenarioId, label: id, description: 'fictional', scientificClaim: false })), provenance: { source: 'test-only synthetic', notes: 'fixture', sourceHashes: {} }, licenses: [], spatial: { geographyManifestUrl: '../city-v2/manifest.json', geographyManifestSha256: '0'.repeat(64), buildingIndex: asset('unused.json', {}) } };
  const buildings = Array.from({ length: 4 }, (_, index) => ({ index, id: `openmaptiles_buildings:${100 + index * 10}`, aliases: [], center: [61.4 + index * .001, 55.16], districtId: index === 1 ? districts[4] : districts[0], use: index === 2 ? 'work' : index === 3 ? 'study' : 'residential', areaM2: 100, levels: 1, heightM: 3, heightQuality: 'fixture', capacityWeight: 5, classificationProvenance: 'test' }));
  const page = asset('../city-v2/buildings.json', { contract: 'DemoBuildingPageV2', firstIndex: 0, buildings });
  const request: typeof fetch = async (input, init) => { init?.signal?.throwIfAborted(); const url = String(input); requests.push(url); const bytes = files.get(url); return bytes ? new Response(bytes.slice().buffer, { status: 200 }) : new Response('', { status: 404 }); };
  const geography = await CityPackV2.load('https://fixture.test/city-v2/', { contract: 'DemoCityPackManifestV2', packId: 'fixture', datasetVersion: '1', bounds: [61, 55, 62, 56], coverage: { districtIds: districts }, buildingPageSize: 512, buildingPages: [{ ...page, url: 'buildings.json', firstIndex: 0, count: 4, firstId: buildings[0]!.id, lastId: buildings[3]!.id }], cells: [], cellZoom: 16 }, undefined, { fetcher: request, preferGzip: false });
  const target = asset('spatial/targets.bin', encodeTargetShard(0, new Uint32Array([2, SPATIAL_NONE, SPATIAL_NONE, SPATIAL_NONE, 3, SPATIAL_NONE, SPATIAL_NONE, SPATIAL_NONE, SPATIAL_NONE, SPATIAL_NONE, 3, SPATIAL_NONE]), 4));
  const spatial = { contract: 'DemoSpatialManifestV2' as const, datasetId: DATASET_ID, recordCount: 4, targetShardSize: 8192, roleShardSize: 256, sourceHashes: { populationManifest: '', geographyManifest: '' }, targetShards: [{ ...target, url: 'targets.bin', startIndex: 0, count: 4 }], roleShards: [], bindingShards: [], candidateCells: [] };
  const legacy = { contract: 'OriginalSyntheticBundleExportV1', sourceRunId: 'synthetic-chelyabinsk-v1', run: {}, completion: {}, geography: [], population: [], events_aggregate: [] } as DemoLegacyExport;
  const provider = new CityDemoProviderV2({ manifest, summaries: { snapshots: snapshots as ConstructorParameters<typeof CityDemoProviderV2>[0]['summaries']['snapshots'] }, queryIndex, geography, spatial, legacy, baseURL: 'https://fixture.test/demo-v2/', request });
  return { provider, requests, records };
}

describe('compact city-scale provider', () => {
  it('pages exact facets without a materialized population or name-search scan', async () => {
    const { provider, requests } = await fixture();
    expect(provider.dataset.data.baseline.people).toEqual([]);
    const first = await provider.queryPeople({ limit: 1 }); expect(first.total).toBe(3); expect(first.items[0]!.id).toBe('demo2-p-0000000'); expect(first.items[0]!.householdSize).toBeNull();
    const second = await provider.queryPeople({ offset: 1, limit: 1 }); expect(second.items[0]!.id).toBe('demo2-p-0000001');
    const old = await provider.queryPeople({ ageBand: '70+', territoryId: 'RU-CHE-SET-MET' }); expect(old.total).toBe(1); expect(old.items[0]!.age).toBe(80);
    expect(requests.filter((url) => url.endsWith('people.bin'))).toHaveLength(1);
    expect((await provider.queryPeople({ query: 'Анна' })).total).toBe(0);
    expect((await provider.queryPeople({ query: 'demo2-p-0000003', year: 2026 })).total).toBe(0);
    expect((await provider.queryPeople({ query: 'demo2-p-0000003', year: 2027 })).total).toBe(1);
  });
  it('prepared profiles match canonical server derivation and never retain stale household sizes', async () => {
    const { provider, records } = await fixture(); await provider.preparePerson('demo2-p-0000000', 'baseline', 2026);
    expect(provider.getPerson('demo2-p-0000000', 'baseline', 2026)).toEqual(profileFor(records[0]!, 2026, 'baseline', { householdSize: 2, territoryId: 'RU-CHE-SET-CEN', territoryName: 'Центральный район' }));
    expect(provider.getPerson('demo2-p-0000000', 'baseline', 2027)!.householdSize).toBeNull();
    await provider.preparePerson('demo2-p-0000000', 'baseline', 2027); expect(provider.getPerson('demo2-p-0000000', 'baseline', 2027)!.householdSize).toBe(3);
    expect(provider.getPresence('demo2-p-0000000', 100, 'baseline', 2027)!.buildingId).toBe('openmaptiles_buildings:100');
  });
  it('cohort cubes give exact stocks but do not invent household/event breakdowns; aborts fail promptly', async () => {
    const { provider, requests } = await fixture(); const snapshot = provider.getSnapshot('baseline', 2026)!;
    const cohort = provider.getCohortSnapshot(snapshot, { sex: 'male', ageBand: '0-17' })!; expect(cohort.population).toBe(1); expect(cohort.households).toBeNull(); expect(cohort.births).toBeNull();
    const controller = new AbortController(); controller.abort(); await expect(provider.queryPeople({}, controller.signal)).rejects.toThrow(); expect(requests).toHaveLength(0);
  });
  it('rejects a pinned manifest mismatch before any companion or legacy request', async () => {
    const request = vi.fn(async () => new Response('{}', { status: 200 })); vi.stubGlobal('fetch', request);
    try { await expect(CityDemoProviderV2.loadCity('https://cdn.fixture.test/assets/', undefined, { applicationBaseURL: 'https://app.fixture.test/demo/', populationManifestSha256: '0'.repeat(64) })).rejects.toThrow('Population manifest pin mismatch'); expect(request).toHaveBeenCalledTimes(1); }
    finally { vi.unstubAllGlobals(); }
  });
});
