import { StaticDemoProvider } from './StaticDemoProvider';
import { VerifiedShardStore } from './VerifiedShardStore';
import { CityPackV2, type CityPackManifestV2, type CityBuildingV2 } from './CityPackV2';
import { validateObservedCity } from './observed';
import type { RendererViewportSnapshot } from '../../renderer/types';
import type { DemoAsset, DemoCohort, DemoContextV1, DemoDataset, DemoDatasetManifestV1, DemoEmployment, DemoLayout, DemoLegacyExport, DemoPage, DemoPeopleQuery, DemoPresence, DemoScenario, DemoScenarioId, DemoSnapshot, DemoTerritory, DemoViewportQuery, PublicFictionalPersonV1 } from '../types';
import { DATASET_ID, SCENARIO_IDS, DISTRICT_IDS, decodePersonShard, recordAt, decodeHouseholdShard, householdMembers, isActive, employmentFor, coarseAgeBand, profileFor, personId, parsePersonId, type CompactPerson, type Household } from '../../../../../shared/demo-population/index.mjs';
import { decodeTargetShard, targetAt, decodeRoleShard, decodeEmbeddedPerson, decodeRosterContexts, rosterContextAt, decodeHouseholdTripMasks, householdTripParticipantAt, presenceFor, dailyMovement } from '../../../../../shared/demo-population/spatial.mjs';
import populationCodecSource from '../../../../../shared/demo-population/index.mjs?raw';
import spatialCodecSource from '../../../../../shared/demo-population/spatial.mjs?raw';

interface RangeAsset extends DemoAsset { startIndex: number; count: number }
interface BuildingRangeAsset extends DemoAsset { firstIndex: number; count: number }
interface CohortCell extends Required<DemoCohort> { population: number }
interface CubeSnapshot extends DemoSnapshot { cohortCube: CohortCell[] }
interface QueryIndex { contexts: { scenario: DemoScenarioId; year: number }[]; axes: { districts: string[]; ageBands: string[]; sexes: string[]; employment: string[] }; shards: { startIndex: number; count: number; contexts: number[][] }[] }
export interface PopulationManifestV2 {
  contract: 'DemoPopulationManifestV2'; datasetId: typeof DATASET_ID; version: string; representation: 'fictional_demo'; scientificClaim: false; predictiveValidation: false;
  startYear: number; endYear: number; initialPopulation: number; seed: number; recordCount: number; householdCount: number;
  personShardSize: number; householdShardSize: number; personShards: RangeAsset[]; householdShards: RangeAsset[];
  summaries: DemoAsset; queryIndex: DemoAsset; territories: DemoTerritory[]; scenarios: DemoScenario[];
  provenance: { source: string; sourceHashes: Record<string, string>; notes?: string; assumptions?: string[] }; licenses: string[];
  spatial: { geographyManifestUrl: string; geographyManifestSha256: string; buildingIndex: DemoAsset };
}
interface SpatialManifest {
  contract: 'DemoSpatialManifestV2'; datasetId: string; recordCount: number; targetShardSize: number; roleShardSize: number;
  sourceHashes: { populationManifest: string; geographyManifest: string; populationCodec?: string; spatialCodec?: string };
  targetShards: RangeAsset[]; roleShards: (BuildingRangeAsset & { members: number; contexts: DemoAsset & { recordBytes: number; householdTripMasks?: DemoAsset } })[];
  bindingShards: BuildingRangeAsset[]; candidateCells: (DemoAsset & { key: string; count: number })[];
}
type Targets = { workBuildingIndex: number | null; studyBuildingIndex: number | null; visitorBuildingIndex: number | null };
type Road = DemoLayout['roads'][number] & { index: number; oneway: boolean; walkable: boolean; drivable: boolean };
type Building = Pick<CityBuildingV2, 'index' | 'id' | 'center' | 'districtId' | 'use'> & { walkRoadIndex?: number | null; carRoadIndex?: number | null };
interface PersonState { record: CompactPerson; home: number | null; district: number | null; targets: Targets; walk: number | null; car: number | null; householdSize: number | null; householdContext?: string; householdRecords?: CompactPerson[] }
interface CandidateCell { contract: 'DemoSpatialCandidatesV2'; key: string; people: [number, string, number, number | null, number | null, number | null, number | null, number | null, number | null][]; households: [number, [number, string][]][]; buildings: Building[]; roads: Road[] }
const ROOT = 'RU-CHE-SET';
const emptyTargets = (): Targets => ({ workBuildingIndex: null, studyBuildingIndex: null, visitorBuildingIndex: null });
const hash = async (bytes: ArrayBuffer) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((n) => n.toString(16).padStart(2, '0')).join('');
const territory = (id?: string) => !id || id === 'chelyabinsk' ? ROOT : id;
const matches = (profile: { ageBand: string; sex: string; employment: string; territoryId: string }, query: DemoPeopleQuery | DemoViewportQuery) => (territory(query.territoryId) === ROOT || profile.territoryId === territory(query.territoryId)) && (!query.ageBand || profile.ageBand === query.ageBand) && (!query.sex || profile.sex === query.sex) && (!query.employment || profile.employment === query.employment);
const distance = (a: readonly number[], b: readonly number[]) => Math.hypot((a[0]! - b[0]!) * 111320 * Math.cos((a[1]! + b[1]!) * Math.PI / 360), (a[1]! - b[1]!) * 110540);
function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, cap: number) { map.delete(key); map.set(key, value); while (map.size > cap) map.delete(map.keys().next().value!); }
function windowFor(query: DemoPeopleQuery) { return { offset: Math.max(0, Math.floor(Number.isFinite(query.offset) ? query.offset! : 0)), limit: Math.min(100, Math.max(1, Math.floor(Number.isFinite(query.limit) ? query.limit! : 50))) }; }
function result<T>(items: T[], total: number, offset: number, limit: number): DemoPage<T> { return { items, total, offset, limit, nextOffset: offset + limit < total ? offset + limit : null }; }

/** Compact city-scale provider. The compatibility dataset contains snapshots, never million-row objects. */
export class CityDemoProviderV2 extends StaticDemoProvider {
  readonly cityPackV2: CityPackV2;
  readonly populationManifestV2: PopulationManifestV2;
  private readonly store: VerifiedShardStore;
  private readonly spatialStore: VerifiedShardStore;
  private readonly queryIndex: QueryIndex;
  private readonly spatial: SpatialManifest;
  private readonly records = new Map<number, CompactPerson>();
  private readonly householdsV2 = new Map<number, Household>();
  private readonly prepared = new Map<number, PersonState>();
  private visible = new Map<number, PersonState>();
  private readonly metadata = new Map<number, Building>();
  private readonly routes = new Map<number, Road>();
  private readonly bindings = new Map<number, [number | null, number | null]>();
  private readonly buildingRosters = new Map<string, { context: string; assignedResidents: number; assignedWorkers: number; assignedStudents: number; visitorsNow: number; inside: PersonState[] }>();
  private lastPage: { key: string; page: DemoPage<PublicFictionalPersonV1> } | null = null;
  private viewportEpoch = 0;

  constructor(options: { manifest: PopulationManifestV2; summaries: { snapshots: CubeSnapshot[] }; queryIndex: QueryIndex; legacy: DemoLegacyExport; geography: CityPackV2; spatial: SpatialManifest; baseURL: string; request?: typeof fetch }) {
    const { manifest, summaries } = options;
    const scenarioData = (id: DemoScenarioId) => ({ id, people: [], snapshots: summaries.snapshots.filter((row) => row.scenario === id) });
    const data: DemoDataset['data'] = { baseline: scenarioData('baseline'), inflow: scenarioData('inflow'), ageing: scenarioData('ageing') };
    const compatibility: DemoDatasetManifestV1 = { contract: 'DemoDatasetManifestV1', datasetId: manifest.datasetId, version: manifest.version, representation: 'fictional_demo', scientificClaim: false, predictiveValidation: false, startYear: manifest.startYear, endYear: manifest.endYear, initialPopulation: manifest.initialPopulation, seed: manifest.seed, assets: { summaries: manifest.summaries }, provenance: { source: manifest.provenance.source, sourceHashes: manifest.provenance.sourceHashes, notes: manifest.provenance.notes ?? manifest.provenance.assumptions?.join(' ') ?? 'Fictional public city; no scientific or predictive claims.' }, licenses: manifest.licenses };
    super({ datasetId: manifest.datasetId, territories: manifest.territories, scenarios: manifest.scenarios, data }, compatibility, options.legacy);
    this.populationManifestV2 = manifest; this.queryIndex = options.queryIndex; this.spatial = options.spatial; this.cityPackV2 = options.geography;
    this.store = new VerifiedShardStore(options.baseURL, 12 * 1024 * 1024, options.request); this.spatialStore = new VerifiedShardStore(new URL('spatial/', options.baseURL).href, 12 * 1024 * 1024, options.request);
    this.cityPackStatus = 'verified'; this.cityPackBaseUrl = this.cityPackV2.baseURL;
  }

  static async loadCity(baseURL = '/', signal?: AbortSignal, options: { applicationBaseURL?: string; populationManifestSha256?: string; spatialManifestSha256?: string } = {}): Promise<CityDemoProviderV2> {
    const root = new URL(baseURL.endsWith('/') ? baseURL : `${baseURL}/`, globalThis.location?.href ?? 'http://localhost/');
    const applicationBase = options.applicationBaseURL ?? baseURL; const applicationRoot = new URL(applicationBase.endsWith('/') ? applicationBase : `${applicationBase}/`, globalThis.location?.href ?? 'http://localhost/');
    const manifestURL = new URL('demo-v2/manifest.json', root); const response = await fetch(manifestURL, { signal });
    if (!response.ok) throw new Error(`Population manifest HTTP ${response.status}`);
    const bytes = await response.arrayBuffer(); if (bytes.byteLength > 2 * 1024 * 1024) throw new Error('Population manifest exceeds budget');
    if (options.populationManifestSha256 && await hash(bytes) !== options.populationManifestSha256) throw new Error('Population manifest pin mismatch');
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as PopulationManifestV2;
    if (manifest.contract !== 'DemoPopulationManifestV2' || manifest.datasetId !== DATASET_ID || manifest.scientificClaim !== false || manifest.predictiveValidation !== false || manifest.recordCount > 10_000_000 || manifest.personShardSize !== 8192 || manifest.householdShardSize !== 4096) throw new Error('Invalid fictional population manifest');
    const store = new VerifiedShardStore(new URL('.', manifestURL).href);
    const [summaries, queryIndex, legacyResponse, geoResponse, spatialResponse] = await Promise.all([
      store.json<{ snapshots: CubeSnapshot[] }>(manifest.summaries, signal), store.json<QueryIndex>(manifest.queryIndex, signal),
      fetch(new URL('demo/manifest.json', applicationRoot), { signal }), fetch(new URL(manifest.spatial.geographyManifestUrl, manifestURL), { signal }), fetch(new URL('spatial/manifest.json', manifestURL), { signal }),
    ]);
    if (!legacyResponse.ok || !geoResponse.ok || !spatialResponse.ok) throw new Error('Verified city companion manifest is unavailable');
    const legacyManifest = await legacyResponse.json() as DemoDatasetManifestV1; const legacyStore = new VerifiedShardStore(new URL('demo/', applicationRoot).href);
    const geoBytes = await geoResponse.arrayBuffer(); if (geoBytes.byteLength > 8 * 1024 * 1024 || await hash(geoBytes) !== manifest.spatial.geographyManifestSha256) throw new Error('Geography manifest integrity mismatch');
    const geo = JSON.parse(new TextDecoder().decode(geoBytes)) as CityPackManifestV2;
    const spatialBytes = await spatialResponse.arrayBuffer(); if (spatialBytes.byteLength > 8 * 1024 * 1024) throw new Error('Spatial manifest exceeds budget');
    if (options.spatialManifestSha256 && await hash(spatialBytes) !== options.spatialManifestSha256) throw new Error('Spatial manifest pin mismatch');
    const spatial = JSON.parse(new TextDecoder().decode(spatialBytes)) as SpatialManifest;
    if (spatial.contract !== 'DemoSpatialManifestV2' || spatial.datasetId !== manifest.datasetId || spatial.recordCount !== manifest.recordCount || spatial.sourceHashes.populationManifest !== await hash(bytes) || spatial.sourceHashes.geographyManifest !== manifest.spatial.geographyManifestSha256) throw new Error('Spatial/population version mismatch');
    if (spatial.sourceHashes.populationCodec !== await hash(new TextEncoder().encode(populationCodecSource).buffer) || spatial.sourceHashes.spatialCodec !== await hash(new TextEncoder().encode(spatialCodecSource).buffer)) throw new Error('Population/spatial rules require a matching application build');
    const [legacy, observed, geography] = await Promise.all([legacyStore.json<DemoLegacyExport>(legacyManifest.assets.legacy!, signal), legacyStore.json<unknown>(legacyManifest.assets.observedCity!, signal), CityPackV2.load(new URL('city-v2/', root).href, geo, signal)]);
    const provider = new CityDemoProviderV2({ manifest, summaries, queryIndex, legacy, geography, spatial, baseURL: new URL('.', manifestURL).href });
    provider.observedCity = validateObservedCity(observed); return provider;
  }

  private async resident(index: number, signal?: AbortSignal): Promise<CompactPerson> {
    signal?.throwIfAborted(); const retained = this.records.get(index); if (retained) return retained;
    const asset = this.populationManifestV2.personShards[Math.floor(index / this.populationManifestV2.personShardSize)];
    if (!asset || index < asset.startIndex || index >= asset.startIndex + asset.count) throw new Error('Unknown fictional person');
    const record = recordAt(decodePersonShard(await this.store.read(asset, signal)), index); boundedSet(this.records, index, record, 4096); return record;
  }
  private async household(index: number, signal?: AbortSignal): Promise<Household> {
    const retained = this.householdsV2.get(index); if (retained) return retained;
    const asset = this.populationManifestV2.householdShards[Math.floor(index / this.populationManifestV2.householdShardSize)]; if (!asset) throw new Error('Unknown fictional household');
    const row = householdMembers(decodeHouseholdShard(await this.store.read(asset, signal)), index); boundedSet(this.householdsV2, index, row, 2048); return row;
  }
  private profile(state: PersonState, scenario: DemoScenarioId, year: number): PublicFictionalPersonV1 | null {
    if (!isActive(state.record, year, scenario)) return null;
    const territoryId = state.district === null ? ROOT : DISTRICT_IDS[state.district]!;
    const size = state.householdContext === `${scenario}:${year}` ? state.householdSize : null;
    return { ...profileFor(state.record, year, scenario, { householdSize: size ?? 1, territoryId, territoryName: this.territories.find((row) => row.id === territoryId)?.name ?? 'Челябинск' }), householdSize: size };
  }
  private async state(index: number, signal?: AbortSignal): Promise<PersonState> {
    const existing = this.prepared.get(index) ?? this.visible.get(index); if (existing) return existing;
    const record = await this.resident(index, signal); const household = await this.household(record.householdIndex, signal);
    const state: PersonState = { record, home: household.homeBuildingIndex, district: household.districtIndex, targets: emptyTargets(), walk: null, car: null, householdSize: null };
    boundedSet(this.prepared, index, state, 4096); return state;
  }
  override getPeople(query: DemoPeopleQuery = {}) { const key = JSON.stringify(query); if (this.lastPage?.key === key) return this.lastPage.page; const { offset, limit } = windowFor(query); return result<PublicFictionalPersonV1>([], this.countQuery(query), offset, limit); }
  private countFacet(codes: number[], query: DemoPeopleQuery) {
    let count = 0; const axes = this.queryIndex.axes;
    for (let i = 0; i < codes.length; i += 2) { const code = codes[i]!; const d = Math.floor(code / 50); const age = Math.floor(code % 50 / 10); const sex = Math.floor(code % 10 / 5); const job = code % 5;
      if (matches({ territoryId: axes.districts[d]!, ageBand: axes.ageBands[age]!, sex: axes.sexes[sex]!, employment: axes.employment[job]! }, query)) count += codes[i + 1]!;
    } return count;
  }
  private countQuery(query: DemoPeopleQuery) { const context = this.queryIndex.contexts.findIndex((row) => row.scenario === (query.scenario ?? 'baseline') && row.year === (query.year ?? 2026)); return context < 0 ? 0 : this.queryIndex.shards.reduce((sum, shard) => sum + this.countFacet(shard.contexts[context]!, query), 0); }
  override async queryPeople(query: DemoPeopleQuery = {}, signal?: AbortSignal) {
    signal?.throwIfAborted(); const scenario = query.scenario ?? 'baseline'; const year = query.year ?? 2026; const { offset, limit } = windowFor(query); const items: PublicFictionalPersonV1[] = [];
    if (query.query?.trim()) {
      const index = parsePersonId(query.query.trim()); if (index === null || index >= this.populationManifestV2.recordCount) return result(items, 0, offset, limit);
      const state = await this.state(index, signal); const profile = this.profile(state, scenario, year); const accepted = profile && matches(profile, query); return result(accepted && offset === 0 ? [profile] : [], accepted ? 1 : 0, offset, limit);
    }
    const context = this.queryIndex.contexts.findIndex((row) => row.scenario === scenario && row.year === year); if (context < 0) return result(items, 0, offset, limit);
    const total = this.countQuery(query); let skip = offset;
    for (const facet of this.queryIndex.shards) {
      signal?.throwIfAborted(); const count = this.countFacet(facet.contexts[context]!, query); if (!count) continue; if (skip >= count) { skip -= count; continue; }
      const asset = this.populationManifestV2.personShards[Math.floor(facet.startIndex / this.populationManifestV2.personShardSize)]!;
      const shard = decodePersonShard(await this.store.read(asset, signal));
      for (let i = 0; i < shard.count; i++) {
        const record = recordAt(shard, shard.startIndex + i); if (!isActive(record, year, scenario)) continue;
        const demographic = { ageBand: coarseAgeBand(year - record.birthYear), sex: record.sex, employment: employmentFor(record, year), territoryId: ROOT };
        if ((query.ageBand && demographic.ageBand !== query.ageBand) || (query.sex && demographic.sex !== query.sex) || (query.employment && demographic.employment !== query.employment)) continue;
        const hh = await this.household(record.householdIndex, signal); demographic.territoryId = hh.districtIndex === null ? ROOT : DISTRICT_IDS[hh.districtIndex]!; if (!matches(demographic, query)) continue;
        if (skip) { skip--; continue; }
        const state: PersonState = { record, home: hh.homeBuildingIndex, district: hh.districtIndex, targets: emptyTargets(), walk: null, car: null, householdSize: null };
        boundedSet(this.records, record.personIndex, record, 4096); boundedSet(this.prepared, record.personIndex, state, 4096); items.push(this.profile(state, scenario, year)!); if (items.length >= limit) break;
      }
      if (items.length >= limit) break;
    }
    signal?.throwIfAborted(); const page = result(items, total, offset, limit); this.lastPage = { key: JSON.stringify(query), page }; return page;
  }
  override getPerson(id: string, scenario: DemoScenarioId = 'baseline', year = 2026) { const index = parsePersonId(id); const state = index === null ? null : this.prepared.get(index) ?? this.visible.get(index); return state ? this.profile(state, scenario, year) : null; }
  override async preparePerson(id: string, scenario: DemoScenarioId, year: number, signal?: AbortSignal) {
    const index = parsePersonId(id); if (index === null || index >= this.populationManifestV2.recordCount) return;
    const state = await this.state(index, signal); if (!isActive(state.record, year, scenario)) return;
    const hh = await this.household(state.record.householdIndex, signal); let size = 0; const householdRecords: CompactPerson[] = [];
    for (const member of hh.members) { const memberRecord = await this.resident(member, signal); householdRecords.push(memberRecord); if (isActive(memberRecord, year, scenario)) size++; }
    const asset = this.spatial.targetShards[Math.floor(index / this.spatial.targetShardSize)]!; state.targets = targetAt(decodeTargetShard(await this.spatialStore.read(asset, signal)), index); state.householdSize = size; state.householdContext = `${scenario}:${year}`; state.householdRecords = householdRecords;
    for (const buildingIndex of [state.home, state.targets.workBuildingIndex, state.targets.studyBuildingIndex, state.targets.visitorBuildingIndex]) if (buildingIndex !== null) { const building = await this.cityPackV2.loadBuildingByIndex(buildingIndex, signal); if (building) boundedSet(this.metadata, building.index, building, 16384); await this.loadBinding(buildingIndex, signal); }
    const binding = state.home === null ? null : this.bindings.get(state.home); state.walk = binding?.[0] ?? null; state.car = binding?.[1] ?? null; boundedSet(this.prepared, index, state, 4096);
  }
  private async loadBinding(building: number, signal?: AbortSignal) {
    if (this.bindings.has(building)) return;
    const asset = this.spatial.bindingShards[Math.floor(building / this.spatial.roleShardSize)]; if (!asset) return;
    const data = await this.spatialStore.json<{ bindings: [number, number | null, number | null][]; roads: Road[] }>(asset, signal);
    for (const [index, walk, car] of data.bindings) boundedSet(this.bindings, index, [walk, car], 16384);
    for (const road of data.roads) boundedSet(this.routes, road.index, road, 8192);
  }
  override getCohortSnapshot(source: DemoSnapshot, cohort?: DemoCohort | null): DemoSnapshot | null {
    if (!cohort) return source; const cube = (source as CubeSnapshot).cohortCube; if (!cube) return null;
    const cells = cube.filter((cell) => (!cohort.ageBand || cell.ageBand === cohort.ageBand) && (!cohort.sex || cell.sex === cohort.sex) && (!cohort.employment || cell.employment === cohort.employment));
    return { ...source, population: cells.reduce((n, cell) => n + cell.population, 0), ageSex: source.ageSex.map((row) => ({ ageBand: row.ageBand, male: cells.filter((c) => c.ageBand === row.ageBand && c.sex === 'male').reduce((n, c) => n + c.population, 0), female: cells.filter((c) => c.ageBand === row.ageBand && c.sex === 'female').reduce((n, c) => n + c.population, 0) })), employment: Object.fromEntries(Object.keys(source.employment).map((key) => [key, cells.filter((c) => c.employment === key).reduce((n, c) => n + c.population, 0)])) as Record<DemoEmployment, number>, households: null, births: null, deaths: null, immigration: null, emigration: null, internalIn: null, internalOut: null, netChange: null };
  }
  override registerLayout(_layout: DemoLayout) { /* Streaming basemap cannot reassign the compiled population. */ }
  override getLayout(): DemoLayout {
    const layout = this.cityPackV2.getLayout(); const buildings = new Map(layout.buildings.map((row) => [row.id, row]));
    for (const row of this.metadata.values()) if (!buildings.has(row.id)) buildings.set(row.id, row as CityBuildingV2);
    const roads = new Map(layout.roads.map((row) => [row.id, row as DemoLayout['roads'][number]])); for (const road of this.routes.values()) roads.set(road.id, road);
    return { buildings: [...buildings.values()], roads: [...roads.values()] };
  }
  override async prepareViewport(context: DemoContextV1, signal?: AbortSignal, viewport?: RendererViewportSnapshot) {
    const bbox = viewport ? [...viewport.bbox] as [number, number, number, number] : undefined;
    const epoch = ++this.viewportEpoch; const cells = await this.cityPackV2.updateViewport(viewport?.camera ?? context.camera, bbox, signal); const visible = new Map<number, PersonState>();
    for (const cell of cells) {
      signal?.throwIfAborted(); const asset = this.spatial.candidateCells.find((row) => row.key === cell.key); if (!asset) continue;
      const candidates = await this.spatialStore.json<CandidateCell>(asset, signal); if (candidates.contract !== 'DemoSpatialCandidatesV2' || candidates.key !== cell.key) throw new Error('Invalid spatial candidates');
      const sizes = new Map<number, number>(); const familyRecords = new Map<number, CompactPerson[]>();
      for (const [hh, members] of candidates.households) { const records = members.map(([index, raw]) => decodeEmbeddedPerson(index, raw)); familyRecords.set(hh, records); sizes.set(hh, records.filter((record) => isActive(record, context.year, context.scenario)).length); }
      const metadata = new Map(candidates.buildings.map((row) => [row.index, row]));
      for (const building of candidates.buildings) { boundedSet(this.metadata, building.index, building, 16384); if ('walkRoadIndex' in building) boundedSet(this.bindings, building.index, [building.walkRoadIndex ?? null, building.carRoadIndex ?? null], 16384); }
      for (const road of candidates.roads) boundedSet(this.routes, road.index, road, 8192);
      for (const [index, raw, hh, home, work, study, visitor, walk, car] of candidates.people) {
        const record = decodeEmbeddedPerson(index, raw); if (!isActive(record, context.year, context.scenario)) continue;
        const districtId = home === null ? null : metadata.get(home)?.districtId; const district = districtId ? DISTRICT_IDS.indexOf(districtId) : -1;
        const state: PersonState = { record, home, district: district < 0 ? null : district, targets: { workBuildingIndex: work, studyBuildingIndex: study, visitorBuildingIndex: visitor }, walk, car, householdSize: sizes.get(hh) ?? null, householdContext: `${context.scenario}:${context.year}`, householdRecords: familyRecords.get(hh) };
        visible.set(index, state);
      }
    }
    signal?.throwIfAborted(); if (epoch !== this.viewportEpoch) throw new DOMException('Superseded viewport', 'AbortError'); this.visible = visible;
  }
  private presence(state: PersonState, minutes: number, scenario: DemoScenarioId, year: number): DemoPresence | null {
    const minute = ((minutes % 1440) + 1440) % 1440; const current = presenceFor(state.record, state.targets, state.home, year, scenario, minute, { householdRecords: state.householdRecords }); if (!current.active) return null;
    const base = { personId: state.record.id, buildingId: null, vehicleId: null, roadId: null, position: null, representation: 'visual_synthesis' as const };
    const origin = current.originBuildingIndex ?? current.buildingIndex ?? state.home; const binding = origin === null ? null : this.bindings.get(origin);
    const walkIndex = binding ? binding[0] : origin === state.home ? state.walk : null; const carIndex = binding ? binding[1] : origin === state.home ? state.car : null;
    const movement = dailyMovement(state.record, current, { walkRoad: this.routes.get(walkIndex ?? -1) ?? null, carRoad: this.routes.get(carIndex ?? -1) ?? null }, minute);
    if (movement) { const movingPresence: DemoPresence & { routeMode: 'ping_pong' | 'loop' | 'once'; endpointOpacity: number } = { ...base, state: movement.mode === 'vehicle' ? 'vehicle' : 'outdoor', vehicleId: movement.vehicleId, roadId: movement.routeId, position: [movement.longitude, movement.latitude], routeProgress: movement.progress, direction: movement.direction, speedMps: movement.speedMps, routeMode: movement.routeMode, endpointOpacity: movement.endpointOpacity, activity: 'Вымышленная локальная поездка по исходному дорожному коридору' }; return movingPresence; }
    const building = current.buildingIndex === null ? null : this.metadata.get(current.buildingIndex);
    const stateName = current.role === 'visitor' ? 'shopping' : current.role === 'work' || current.role === 'study' || current.role === 'home' ? current.role : 'unplaced';
    return { ...base, state: stateName, buildingId: building?.id ?? null, position: building?.center ?? null, activity: stateName === 'work' ? 'На работе — визуальный синтез' : stateName === 'study' ? 'На занятиях — визуальный синтез' : stateName === 'shopping' ? 'В гостевом посещении — визуальный синтез' : stateName === 'home' ? 'Дома' : 'Маршрут или размещение недоступны; житель остаётся в учёте' };
  }
  override getPresence(id: string, minutes: number, scenario: DemoScenarioId = 'baseline', year = 2026) { const index = parsePersonId(id); const state = index === null ? null : this.visible.get(index) ?? this.prepared.get(index); return state ? this.presence(state, minutes, scenario, year) : null; }
  override getVisibleCandidates(scenario: DemoScenarioId = 'baseline', year = 2026, limit = 2000, viewport?: DemoViewportQuery) {
    const accepted: { profile: PublicFictionalPersonV1; distance: number }[] = [];
    for (const state of this.visible.values()) { const profile = this.profile(state, scenario, year); if (!profile || profile.age < 7 || viewport && !matches(profile, viewport)) continue; const presence = this.presence(state, viewport?.minutes ?? 720, scenario, year); if (!presence?.position || !['vehicle', 'outdoor'].includes(presence.state)) continue; const d = viewport ? distance(presence.position, [viewport.longitude, viewport.latitude]) : 0; if (!viewport || d <= viewport.radiusMeters) accepted.push({ profile, distance: d }); }
    return accepted.sort((a, b) => a.distance - b.distance || a.profile.id.localeCompare(b.profile.id)).slice(0, Math.min(5000, Math.max(0, limit))).map((row) => row.profile);
  }
  override async prepareBuilding(id: string, minutes: number, scenario: DemoScenarioId, year: number, signal?: AbortSignal) {
    const building = await this.cityPackV2.loadBuilding(id, signal); if (!building) return; boundedSet(this.metadata, building.index, building, 16384);
    const asset = this.spatial.roleShards[Math.floor(building.index / this.spatial.roleShardSize)]; if (!asset) return;
    if (!asset.members) { boundedSet(this.buildingRosters, id, { context: `${scenario}:${year}:${Math.floor(minutes)}`, assignedResidents: 0, assignedWorkers: 0, assignedStudents: 0, visitorsNow: 0, inside: [] }, 2); return; }
    const shard = decodeRoleShard(await this.spatialStore.read(asset, signal)); const contexts = decodeRosterContexts(await this.spatialStore.read(asset.contexts, signal));
    if (!asset.contexts.householdTripMasks) throw new Error('Verified household-trip roster context is unavailable');
    const tripMasks = decodeHouseholdTripMasks(await this.spatialStore.read(asset.contexts.householdTripMasks, signal));
    if (contexts.count !== asset.members || tripMasks.count !== asset.members) throw new Error('Building roster context alignment mismatch');
    const roster = { context: `${scenario}:${year}:${Math.floor(minutes)}`, assignedResidents: 0, assignedWorkers: 0, assignedStudents: 0, visitorsNow: 0, inside: [] as PersonState[] }; const seen = new Set<number>();
    for (let role = 0; role < 4; role++) {
      const row = (building.index - shard.startIndex) * 4 + role; const start = shard.view.getUint32(32 + row * 4, true); const end = shard.view.getUint32(32 + (row + 1) * 4, true);
      for (let ordinal = start; ordinal < end; ordinal++) {
        const item = rosterContextAt(contexts, ordinal); const { record, homeBuildingIndex: home, targets } = item; if (!isActive(record, year, scenario)) continue;
        const job = employmentFor(record, year); if (role === 0) roster.assignedResidents++; if (role === 1 && job === 'employed') roster.assignedWorkers++; if (role === 2 && job === 'student') roster.assignedStudents++;
        const presence = presenceFor(record, targets, home, year, scenario, ((minutes % 1440) + 1440) % 1440, { householdTripParticipant: householdTripParticipantAt(tripMasks, ordinal, year, scenario) });
        if (presence.buildingIndex !== building.index || seen.has(record.personIndex)) continue; seen.add(record.personIndex); if (presence.role === 'visitor') roster.visitorsNow++;
        const known = this.prepared.get(record.personIndex) ?? this.visible.get(record.personIndex); const homeBuilding = home === null ? null : this.metadata.get(home); const districtId = homeBuilding?.districtId ?? building.districtId; const district = districtId ? DISTRICT_IDS.indexOf(districtId) : -1;
        roster.inside.push(known ?? { record, home, district: district < 0 ? null : district, targets, walk: null, car: null, householdSize: null });
      }
    }
    roster.inside.sort((a, b) => a.record.personIndex - b.record.personIndex); signal?.throwIfAborted(); boundedSet(this.buildingRosters, building.id, roster, 2); if (id !== building.id) boundedSet(this.buildingRosters, id, roster, 2);
  }
  override getBuildingOccupancy(id: string, minutes: number, scenario: DemoScenarioId = 'baseline', year = 2026, offset = 0, limit = 50) {
    const roster = this.buildingRosters.get(id); const current = roster?.context === `${scenario}:${year}:${Math.floor(minutes)}` ? roster : null; const page = windowFor({ offset, limit });
    const inside = current?.inside ?? []; const items = inside.slice(page.offset, page.offset + page.limit).map((state) => this.profile(state, scenario, year)!).filter(Boolean);
    return { ...result(items, inside.length, page.offset, page.limit), buildingId: id, assignedResidents: current?.assignedResidents ?? 0, assignedWorkers: current?.assignedWorkers ?? 0, assignedStudents: current?.assignedStudents ?? 0, visitorsNow: current?.visitorsNow ?? 0, presentNow: inside.length, representation: 'visual_synthesis' as const };
  }
  override async prepareVehicle(id: string, minutes: number, scenario: DemoScenarioId, year: number, signal?: AbortSignal) {
    const match = /^demo2-v-(\d{7})$/.exec(id); if (!match) return; const driverIndex = Number(match[1]); await this.preparePerson(personId(driverIndex), scenario, year, signal);
    const driver = this.prepared.get(driverIndex); if (!driver?.householdRecords) return;
    for (const member of driver.householdRecords) if (member.personIndex !== driverIndex && isActive(member, year, scenario)) await this.preparePerson(member.id, scenario, year, signal);
  }
  override getVehicle(id: string, minutes: number, scenario: DemoScenarioId = 'baseline', year = 2026) {
    const match = /^demo2-v-(\d{7})$/.exec(id); if (!match) return null; const index = Number(match[1]); const state = this.visible.get(index) ?? this.prepared.get(index);
    if (!state) return null;
    const householdSize = state.householdRecords?.filter((member) => isActive(member, year, scenario)).length ?? null;
    const members = state.householdRecords ?? [state.record];
    const occupants = members.flatMap((record) => { const personState = this.visible.get(record.personIndex) ?? this.prepared.get(record.personIndex) ?? { ...state, record, targets: emptyTargets(), householdSize, householdContext: `${scenario}:${year}` }; const profile = this.presence(personState, minutes, scenario, year)?.vehicleId === id ? this.profile(personState, scenario, year) : null; return profile ? [profile] : []; });
    if (!occupants.length) return null; const presence = this.getPresence(occupants[0]!.id, minutes, scenario, year)!; return { id, label: occupants.length > 4 ? 'Семейный минивэн' : 'Городской автомобиль', class: occupants.length > 4 ? 'minivan' as const : 'sedan' as const, occupants, occupancy: occupants.length, capacity: Math.max(occupants.length, occupants.length > 4 ? 7 : 4), roadId: presence.roadId!, representation: 'visual_synthesis' as const };
  }
}
