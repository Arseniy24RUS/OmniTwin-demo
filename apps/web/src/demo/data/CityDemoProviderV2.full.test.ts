import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CityDemoProviderV2 } from './CityDemoProviderV2';
import { decodeHouseholdShard, householdMembers, personId } from '../../../../../shared/demo-population/index.mjs';
import { householdTripFor } from '../../../../../shared/demo-population/spatial.mjs';

afterEach(() => vi.unstubAllGlobals());
it.runIf(existsSync(new URL('../../../public/demo-v2/spatial/manifest.json', import.meta.url)))('local generated artifacts: canonical profiles, occupancy, vehicles and viewport without legacy person bundle', async () => {
  const paths: string[] = [];
  const requested: URL[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, options?: RequestInit) => {
    options?.signal?.throwIfAborted(); const url = new URL(String(input));
    if (!['https://fixture.test', 'https://assets.fixture.test'].includes(url.origin) || url.pathname.includes('..')) throw new Error('Unexpected fixture request');
    const path = url.pathname.replace(url.origin === 'https://assets.fixture.test' ? /^\/city-assets/ : /^\/app/, ''); paths.push(path); requested.push(url);
    try { const bytes = await readFile(new URL(`../../../public${path}`, import.meta.url)); return new Response(bytes, { status: 200, headers: { 'Content-Type': path.endsWith('.gz') ? 'application/gzip' : path.endsWith('.json') ? 'application/json' : 'application/octet-stream' } }); }
    catch { return new Response('', { status: 404 }); }
  });
  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const populationManifestSha256 = digest(await readFile(new URL('../../../public/demo-v2/manifest.json', import.meta.url)));
  const spatialManifestSha256 = digest(await readFile(new URL('../../../public/demo-v2/spatial/manifest.json', import.meta.url)));
  const provider = await CityDemoProviderV2.loadCity('https://assets.fixture.test/city-assets/', undefined, { applicationBaseURL: 'https://fixture.test/app/', populationManifestSha256, spatialManifestSha256 });
  expect(requested.filter((url) => url.pathname.includes('/demo/')).every((url) => url.origin === 'https://fixture.test')).toBe(true);
  expect(requested.filter((url) => url.pathname.includes('/demo-v2/') || url.pathname.includes('/city-v2/')).every((url) => url.origin === 'https://assets.fixture.test')).toBe(true);
  expect(provider.manifest.initialPopulation).toBe(1177058);
  expect(provider.dataset.data.baseline.people.length).toBe(0);
  expect(provider.observedCity?.snapshots.find((row) => row.year === 2024)?.population).toBe(1177058);
  const page = await provider.queryPeople({ scenario: 'baseline', year: 2026, limit: 3 });
  expect(page.total).toBe(1177058); expect(page.items).toHaveLength(3);
  const first = page.items[0]!; await provider.preparePerson(first.id, 'baseline', 2026);
  const profile = provider.getPerson(first.id, 'baseline', 2026)!;
  expect(profile.householdSize).toBeGreaterThan(0); expect(profile.datasetId).toBe('omnitwin-fictional-city-v2');
  expect(profile.territoryId).not.toBe('RU-CHE-SET');
  expect(provider.getPresence(first.id, 100, 'baseline', 2026)?.buildingId).toMatch(/^openmaptiles_buildings:/);
  const homeId = provider.getPresence(first.id, 100, 'baseline', 2026)!.buildingId!;
  await provider.prepareBuilding(homeId, 100, 'baseline', 2026);
  const homeRoster = provider.getBuildingOccupancy(homeId, 100, 'baseline', 2026, 0, 50);
  expect(homeRoster.assignedResidents).toBeGreaterThan(0);
  expect(homeRoster.presentNow).toBe(homeRoster.assignedResidents);
  expect(homeRoster.total).toBe(homeRoster.presentNow); expect(homeRoster.items.length).toBeLessThanOrEqual(50);
  // Source-backed high-rises and named retail buildings: full roster counts
  // remain independent of the candidate sample and the fifty-row UI page.
  const buildings = [
    { id:'openmaptiles_buildings:159526353', residents:2991, workers:0, present:[640,1836], visitors:[0,0], first:['demo2-p-0014222','demo2-p-0000824'], second:['demo2-p-0319883','demo2-p-0022676'] },
    { id:'openmaptiles_buildings:159607853', residents:832, workers:0, present:[173,509], visitors:[0,0], first:['demo2-p-0015265','demo2-p-0002941'], second:['demo2-p-0464629','demo2-p-0084389'] },
    { id:'openmaptiles_buildings:853220400', residents:0, workers:1590, present:[1621,1608], visitors:[191,1332], first:['demo2-p-0004467','demo2-p-0001699'], second:['demo2-p-0054660','demo2-p-0065060'] },
    { id:'openmaptiles_buildings:373645390', residents:0, workers:4180, present:[4047,3047], visitors:[303,2268], first:['demo2-p-0000175','demo2-p-0000078'], second:['demo2-p-0016209','demo2-p-0027977'] },
  ];
  for (const building of buildings) for (const [i, minutes] of [690,1100].entries()) {
    await provider.prepareBuilding(building.id, minutes, 'baseline', 2026);
    const firstPage = provider.getBuildingOccupancy(building.id, minutes, 'baseline', 2026, 0, 50);
    expect(firstPage.assignedResidents).toBe(building.residents); expect(firstPage.assignedWorkers).toBe(building.workers);
    expect(firstPage.presentNow).toBe(building.present[i]); expect(firstPage.visitorsNow).toBe(building.visitors[i]);
    expect(firstPage.total).toBe(building.present[i]); expect(firstPage.items).toHaveLength(50); expect(firstPage.nextOffset).toBe(50);
    expect(firstPage.items[0]!.id).toBe(building.first[i]);
    const requestCount = paths.length;
    const secondPage = provider.getBuildingOccupancy(building.id, minutes, 'baseline', 2026, 50, 50);
    expect(paths.length).toBe(requestCount); expect(secondPage.items).toHaveLength(50); expect(secondPage.items[0]!.id).toBe(building.second[i]);
    expect(new Set([...firstPage.items,...secondPage.items].map(p=>p.id)).size).toBe(100);
  }
  expect(paths.some((path) => path.endsWith('/demo/dataset.json') || path.endsWith('/demo/chat-profiles.json') || path.includes('building-index-'))).toBe(false);
  expect(paths.filter((path) => path.startsWith('/demo-v2/people/')).length).toBeLessThan(20);
  // Household 9 deterministically owns a car; all IDs/members come from verified full data.
  const hhAsset = provider.populationManifestV2.householdShards[0]!;
  const hhBytes = await readFile(new URL(`../../../public/demo-v2/${hhAsset.url}`, import.meta.url));
  const household = householdMembers(decodeHouseholdShard(hhBytes), 9);
  const driverId = personId(household.members[0]!); await provider.preparePerson(driverId, 'baseline', 2026);
  const internal = provider as unknown as { prepared: Map<number, { householdRecords: Parameters<typeof householdTripFor>[0] }> };
  const trip = householdTripFor(internal.prepared.get(household.members[0]!)!.householdRecords, 2026, 'baseline')!;
  expect(trip.passengerIndices.length).toBeGreaterThan(1);
  const minute = Array.from({ length: 40 }, (_, i) => trip.startMinute + i + 1).find((time) => provider.getPresence(driverId, time, 'baseline', 2026)?.vehicleId === trip.vehicleId)!;
  expect(minute).toBeDefined(); await provider.prepareVehicle(trip.vehicleId, minute, 'baseline', 2026);
  const vehicle = provider.getVehicle(trip.vehicleId, minute, 'baseline', 2026)!;
  expect(vehicle.occupancy).toBe(trip.passengerIndices.length); expect(vehicle.capacity).toBeGreaterThanOrEqual(vehicle.occupancy);
  const positions = vehicle.occupants.map((person) => {
    const presence = provider.getPresence(person.id, minute, 'baseline', 2026)!;
    expect(presence.vehicleId).toBe(trip.vehicleId);
    expect(presence.state).toBe('vehicle');
    expect(presence.activity).toMatch(/^В автомобиле · /);
    return presence.position;
  });
  expect(positions.every((position) => JSON.stringify(position) === JSON.stringify(positions[0]))).toBe(true);
  const context = { datasetId: 'omnitwin-fictional-city-v2', scenario: 'baseline' as const, year: 2026, territoryId: 'RU-CHE-SET', cohort: null, presentationMinutes: 600, weather: 'clear' as const, playing: false, speed: 1, camera: { longitude: 61.4026, latitude: 55.1644, zoom: 16.8, pitch: 55, bearing: 0 } };
  await provider.prepareViewport(context, undefined, { camera: context.camera, bbox: [61.4016, 55.1634, 61.4036, 55.1654], widthCss: 1920, heightCss: 1080, revision: 'fixture-viewport' });
  const candidates = provider.getVisibleCandidates('baseline', 2026, 1000, { longitude: 61.4026, latitude: 55.1644, radiusMeters: 1500, minutes: 600, territoryId: 'RU-CHE-SET' });
  expect(candidates.length).toBeGreaterThan(0); expect(candidates.length).toBeLessThanOrEqual(1000);
  const layoutRoads = new Set(provider.getLayout().roads.map((road) => road.id));
  for (const person of candidates) { const presence = provider.getPresence(person.id, 600, 'baseline', 2026)!; expect(['vehicle', 'outdoor']).toContain(presence.state); expect(layoutRoads.has(presence.roadId!)).toBe(true); expect(presence.position?.every(Number.isFinite)).toBe(true); if (presence.state === 'vehicle') expect([7, 8, 9, 10]).toContain(presence.speedMps); else expect(presence.speedMps).toBe(1.2); }
}, 15000);
