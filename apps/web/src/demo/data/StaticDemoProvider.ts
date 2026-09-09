import type {
  DemoBuildingOccupancy, DemoDataset, DemoDatasetManifestV1, DemoLayout, DemoLegacyExport,
  DemoPage, DemoPeopleQuery, DemoPersonRecord, DemoPresence, DemoScenarioComparisonV1,
  DemoScenarioId, DemoSnapshot, DemoVehicle, DemoViewportQuery, PublicFictionalPersonV1, DemoCohort, DemoContextV1,
} from '../types';
import { employmentFor, fictionalProfile, stableHash } from './fictionalProfile.mjs';
import { validateObservedCity, type ObservedCityReferenceV1 } from './observed';
import type { RendererViewportSnapshot } from '../../renderer/types';

const ROOT = 'RU-CHE-SET';
const territoryAlias = (id: string) => id === 'chelyabinsk' ? ROOT : id;
const mod = (value: number, divisor: number) => ((value % divisor) + divisor) % divisor;
const validCoordinate = (p: number[]) => p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0]!) <= 180 && Math.abs(p[1]!) <= 85.1;
type Building = DemoLayout['buildings'][number];
type Road = DemoLayout['roads'][number] & { lengths: number[]; length: number };
type Assignment = { home: string | null; work: string | null; study: string | null; road: string | null };
export interface DemoCityPackManifestV1 {
  contract: 'DemoCityPackManifestV1';
  packId: string;
  datasetVersion: string;
  provider: string;
  sourceTiles: string;
  sourceTileJSON: string;
  attribution: string;
  coverage: 'bounded_chelyabinsk_center_not_whole_city';
  bounds: [number, number, number, number];
  center: [number, number];
  minzoom: number;
  maxzoom: number;
  tileCount: number;
  tileBytes: number;
  layout: { url: string; sha256: string; bytes: number; buildings: number; roads: number };
  tiles: Array<{ z: number; x: number; y: number; url: string; sha256: string; bytes: number }>;
}

function page<T>(items: T[], offset = 0, limit = 50): DemoPage<T> {
  const take = Math.min(100, Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 50)));
  const start = Math.max(0, Math.floor(Number.isFinite(offset) ? offset : 0));
  return { items: items.slice(start, start + take), total: items.length, offset: start, limit: take, nextOffset: start + take < items.length ? start + take : null };
}
function roadLength(a: [number, number], b: [number, number]) {
  const dx = (a[0] - b[0]) * 111_320 * Math.cos((a[1] + b[1]) * Math.PI / 360);
  const dy = (a[1] - b[1]) * 111_320;
  return Math.hypot(dx, dy);
}
function sampleRoad(road: Road, progress: number): [number, number] {
  const distance = progress * road.length;
  let previous = 0;
  for (let i = 0; i < road.lengths.length; i += 1) {
    const length = road.lengths[i]!;
    if (distance <= previous + length || i === road.lengths.length - 1) {
      const t = length ? Math.min(1, Math.max(0, (distance - previous) / length)) : 0;
      const a = road.coordinates[i]!; const b = road.coordinates[i + 1]!;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    previous += length;
  }
  return road.coordinates[0]!;
}

/** One read-only fixture instance shared by every tab and every presence inspector. */
export class StaticDemoProvider {
  get movementPreviewOverlay():{scope:'local_preview';delivery?:'local_preview'|'public_pinned';chatCompatibility:'pending'|'base_profiles_unchanged';bounds:readonly number[];version:string}|null{return null;}
  readonly territories;
  readonly scenarios;
  observedCity: ObservedCityReferenceV1 | null = null;
  cityPack: DemoCityPackManifestV1 | null = null;
  cityPackStatus: 'not_loaded' | 'verified' | 'streaming_fallback' = 'not_loaded';
  cityPackError: string | null = null;
  cityPackBaseUrl: string | null = null;
  private recordIndexes = new Map<DemoScenarioId, Map<string, DemoPersonRecord>>();
  private activeCache = new Map<string, DemoPersonRecord[]>();
  private profileCache = new Map<string, PublicFictionalPersonV1[]>();
  private buildings = new Map<string, Building>();
  private roads = new Map<string, Road>();
  private buildingPools = { home: [] as string[], work: [] as string[], study: [] as string[] };
  private roadIds: string[] = [];
  private assignments = new Map<string, Assignment>();
  private householdAssignments = new Map<string, Assignment>();
  private walkRoadIds: string[] = [];
  private driveRoadIds: string[] = [];

  constructor(readonly dataset: DemoDataset, readonly manifest: DemoDatasetManifestV1, readonly legacy: DemoLegacyExport) {
    if (dataset.datasetId !== manifest.datasetId || manifest.representation !== 'fictional_demo' || manifest.scientificClaim !== false) throw new Error('Incompatible fictional demo manifest');
    this.territories = dataset.territories;
    this.scenarios = dataset.scenarios;
    for (const scenario of dataset.scenarios) this.recordIndexes.set(scenario.id, new Map(dataset.data[scenario.id].people.map(p => [p.id, p])));
  }

  /** baseUrl is the app deployment base, e.g. /OmniTwin-demo/. Hosting ETags are not SHA hashes. */
  static async load(baseUrl = '/', signal?: AbortSignal): Promise<StaticDemoProvider> {
    const root = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`, globalThis.location?.href ?? 'http://localhost/');
    const manifestUrl = new URL('demo/manifest.json', root);
    const response = await fetch(manifestUrl, { signal });
    if (!response.ok) throw new Error(`Demo manifest unavailable (${response.status})`);
    const manifest = await response.json() as DemoDatasetManifestV1;
    if (manifest.contract !== 'DemoDatasetManifestV1' || manifest.scientificClaim !== false || manifest.predictiveValidation !== false) throw new Error('Unsafe demo manifest');
    const read = async (key: 'dataset' | 'legacy' | 'observedCity') => {
      const asset = manifest.assets[key];
      if (!asset || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error(`Missing verified demo asset: ${key}`);
      const url = new URL(asset.url, manifestUrl);
      if (url.origin !== manifestUrl.origin || !url.pathname.startsWith(new URL('.', manifestUrl).pathname)) throw new Error('Demo asset escapes its approved directory');
      const r = await fetch(url, { signal });
      if (!r.ok) throw new Error(`Demo ${key} unavailable (${r.status})`);
      const bytes = await r.arrayBuffer();
      if (bytes.byteLength !== asset.bytes) throw new Error(`Demo ${key} byte length mismatch`);
      if (!globalThis.crypto?.subtle) throw new Error('Secure context is required to verify demo assets');
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
      if (hash !== asset.sha256) throw new Error(`Demo ${key} hash mismatch`);
      return JSON.parse(new TextDecoder().decode(bytes));
    };
    const [dataset, legacy, observed] = await Promise.all([read('dataset'), read('legacy'), read('observedCity')]);
    const provider = new StaticDemoProvider(dataset as DemoDataset, manifest, legacy as DemoLegacyExport);
    provider.observedCity = validateObservedCity(observed);
    await provider.loadCityPack(root.href, signal);
    return provider;
  }

  /** The optional bounded pack makes assignments independent of tile arrival order. */
  async loadCityPack(baseUrl: string, signal?: AbortSignal): Promise<void> {
    try {
      const root = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`, globalThis.location?.href ?? 'http://localhost/');
      const manifestUrl = new URL('city/manifest.json', root);
      const response = await fetch(manifestUrl, { signal });
      if (!response.ok) throw new Error(`City pack unavailable (${response.status})`);
      const pack = await response.json() as DemoCityPackManifestV1;
      if (pack.contract !== 'DemoCityPackManifestV1' || pack.coverage !== 'bounded_chelyabinsk_center_not_whole_city'
        || pack.tileCount > 49 || pack.tileBytes > 20 * 1024 * 1024 || !pack.layout
        || pack.layout.bytes > 2 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(pack.layout.sha256)) throw new Error('Invalid bounded city manifest');
      const url = new URL(pack.layout.url, manifestUrl);
      if (url.origin !== manifestUrl.origin || !url.pathname.startsWith(new URL('.', manifestUrl).pathname)) throw new Error('City layout URL escapes its directory');
      const r = await fetch(url, { signal });
      if (!r.ok) throw new Error(`City layout unavailable (${r.status})`);
      const bytes = await r.arrayBuffer();
      if (bytes.byteLength !== pack.layout.bytes) throw new Error('City layout byte length mismatch');
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
      if (hash !== pack.layout.sha256) throw new Error('City layout hash mismatch');
      const layout = JSON.parse(new TextDecoder().decode(bytes)) as DemoLayout;
      if (!Array.isArray(layout.buildings) || !Array.isArray(layout.roads)
        || layout.buildings.length !== pack.layout.buildings || layout.roads.length !== pack.layout.roads) throw new Error('City layout feature count mismatch');
      this.seedLayout(layout);
      this.cityPack = pack;
      this.cityPackBaseUrl = new URL('.', manifestUrl).href;
      this.cityPackStatus = 'verified';
      this.cityPackError = null;
    } catch (error) {
      if (signal?.aborted) throw error;
      this.cityPackStatus = 'streaming_fallback';
      this.cityPackError = error instanceof Error ? error.message : 'City pack could not be verified';
      // No fabricated geometry. Existing streaming map may still supply genuine features.
    }
  }

  /** Call once, before renderer callbacks, using the full verified starter layout. */
  seedLayout(layout: DemoLayout) {
    if (this.assignments.size || this.householdAssignments.size) throw new Error('Starter layout must precede person assignments');
    this.registerLayout(layout);
    for (const scenario of this.scenarios) {
      for (const person of this.dataset.data[scenario.id].people) this.assignment(person);
    }
  }

  getTerritories() { return this.territories; }
  getScenarios() { return this.scenarios; }
  getSnapshot(scenario: DemoScenarioId, year: number, territoryId = ROOT): DemoSnapshot | null {
    return this.dataset.data[scenario]?.snapshots.find(s => s.year === year && s.territoryId === territoryAlias(territoryId)) ?? null;
  }
  getTimeline(scenario: DemoScenarioId, territoryId = ROOT) {
    return this.dataset.data[scenario]?.snapshots.filter(s => s.territoryId === territoryAlias(territoryId)) ?? [];
  }
  compareScenarios(left: DemoScenarioId, right: DemoScenarioId, year: number, territoryId = ROOT): DemoScenarioComparisonV1 | null {
    const a = this.getSnapshot(left, year, territoryId); const b = this.getSnapshot(right, year, territoryId);
    return a && b ? { contract: 'DemoScenarioComparisonV1', left: a, right: b, populationDelta: b.population - a.population, populationDeltaPercent: a.population ? (b.population - a.population) / a.population * 100 : null, scientificClaim: false } : null;
  }
  private active(scenario: DemoScenarioId, year: number) {
    if (!Number.isInteger(year) || year < this.manifest.startYear || year > this.manifest.endYear) return [];
    const key = `${scenario}:${year}`;
    let result = this.activeCache.get(key);
    if (!result) {
      result = this.dataset.data[scenario]?.people.filter(p => p.entryYear <= year && (p.exitYear === null || p.exitYear > year)) ?? [];
      if (this.activeCache.size > 5) this.activeCache.delete(this.activeCache.keys().next().value!);
      this.activeCache.set(key, result);
    }
    return result;
  }
  private profiles(scenario: DemoScenarioId, year: number) {
    const key = `${scenario}:${year}`;
    let result = this.profileCache.get(key);
    if (!result) {
      const people = this.active(scenario, year);
      const householdSizes = new Map<string, number>();
      for (const person of people) householdSizes.set(person.householdId, (householdSizes.get(person.householdId) ?? 0) + 1);
      result = people.map(p => fictionalProfile(p, year, scenario, this.dataset.datasetId, householdSizes.get(p.householdId)!, this.territories.find(t => t.id === p.territoryId)?.name ?? 'Челябинск'));
      if (this.profileCache.size > 2) this.profileCache.delete(this.profileCache.keys().next().value!);
      this.profileCache.set(key, result);
    }
    return result;
  }
  getPeople(query: DemoPeopleQuery = {}): DemoPage<PublicFictionalPersonV1> {
    const territoryId = territoryAlias(query.territoryId ?? ROOT);
    const text = query.query?.trim().toLocaleLowerCase('ru');
    const result = this.profiles(query.scenario ?? 'baseline', query.year ?? 2026).filter(p =>
      (territoryId === ROOT || p.territoryId === territoryId) && (!query.ageBand || p.ageBand === query.ageBand) &&
      (!query.sex || p.sex === query.sex) && (!query.employment || p.employment === query.employment) &&
      (!text || `${p.name} ${p.occupation} ${p.id}`.toLocaleLowerCase('ru').includes(text)));
    return page(result, query.offset, query.limit);
  }
  async queryPeople(query: DemoPeopleQuery = {}, signal?: AbortSignal) { signal?.throwIfAborted(); return this.getPeople(query); }
  async preparePerson(_id: string, _scenario: DemoScenarioId, _year: number, signal?: AbortSignal) { signal?.throwIfAborted(); }
  async prepareBuilding(_id: string, _minutes: number, _scenario: DemoScenarioId, _year: number, signal?: AbortSignal) { signal?.throwIfAborted(); }
  async prepareVehicle(_id: string, _minutes: number, _scenario: DemoScenarioId, _year: number, signal?: AbortSignal) { signal?.throwIfAborted(); }
  async prepareViewport(_context: DemoContextV1, signal?: AbortSignal, _viewport?: RendererViewportSnapshot) { signal?.throwIfAborted(); }
  getCohortSnapshot(_source: DemoSnapshot, _cohort: DemoCohort | null | undefined): DemoSnapshot | null { return null; }
  /** Bounded selection for rendering; the complete population is never copied into GPU buffers. */
  getVisibleCandidates(scenario: DemoScenarioId = 'baseline', year = 2026, limit = 2000, viewport?: DemoViewportQuery) {
    const take = Math.min(5000, Math.max(0, limit));
    const profiles = this.profiles(scenario, year).filter(p => p.age >= 7);
    if (!viewport) return profiles.slice(0, take);
    const territoryId = territoryAlias(viewport.territoryId ?? ROOT);
    // Legacy fixture is small. The city-scale provider overrides this with cell indexes.
    // Importantly, the budget is applied AFTER territory, activity and spatial filtering.
    return profiles.flatMap(person => {
      if ((territoryId !== ROOT && person.territoryId !== territoryId)
        || (viewport.ageBand && person.ageBand !== viewport.ageBand)
        || (viewport.sex && person.sex !== viewport.sex)
        || (viewport.employment && person.employment !== viewport.employment)) return [];
      const presence = this.getPresence(person.id, viewport.minutes, scenario, year);
      if (!presence?.position || !['outdoor', 'vehicle'].includes(presence.state)) return [];
      const distance = roadLength(presence.position, [viewport.longitude, viewport.latitude]);
      return distance <= viewport.radiusMeters ? [{ person, distance }] : [];
    }).sort((a, b) => a.distance - b.distance || a.person.id.localeCompare(b.person.id))
      .slice(0, take).map(item => item.person);
  }
  getPerson(id: string, scenario: DemoScenarioId = 'baseline', year = 2026): PublicFictionalPersonV1 | null {
    return this.profiles(scenario, year).find(p => p.id === id) ?? null;
  }

  /** Source-backed features only; assignments already made are retained when a camera tile changes. */
  registerLayout(layout: DemoLayout) {
    let changed = false;
    for (const building of layout.buildings) {
      if (!building.id || !validCoordinate(building.center)) continue;
      if (!this.buildings.has(building.id)) { this.buildings.set(building.id, building); changed = true; }
    }
    for (const source of layout.roads) {
      if (!source.id || source.coordinates.length < 2 || !source.coordinates.every(validCoordinate) || this.roads.has(source.id)) continue;
      const lengths = source.coordinates.slice(1).map((p, i) => roadLength(source.coordinates[i]!, p));
      const length = lengths.reduce((a, b) => a + b, 0);
      if (length > 5) { this.roads.set(source.id, { ...source, lengths, length }); changed = true; }
    }
    if (changed) {
      const ordered = [...this.buildings.values()].sort((a, b) => a.id.localeCompare(b.id));
      this.buildingPools.home = ordered.filter(b => !b.use || b.use === 'residential' || b.use === 'mixed').map(b => b.id);
      this.buildingPools.work = ordered.filter(b => b.use === 'work' || b.use === 'mixed' || !b.use).map(b => b.id);
      this.buildingPools.study = ordered.filter(b => b.use === 'study' || b.use === 'mixed' || !b.use).map(b => b.id);
      this.roadIds = [...this.roads.keys()].sort();
      this.walkRoadIds = this.roadIds.filter(id => this.roads.get(id)!.walkable !== false);
      this.driveRoadIds = this.roadIds.filter(id => this.roads.get(id)!.drivable !== false);
    }
  }
  getLayout(): DemoLayout { return { buildings: [...this.buildings.values()], roads: [...this.roads.values()].map(({ lengths: _lengths, length: _length, ...road }) => road) }; }
  private assignment(person: DemoPersonRecord) {
    let a = this.assignments.get(person.id);
    if (!a) { a = { home: null, work: null, study: null, road: null }; this.assignments.set(person.id, a); }
    const pick = (pool: string[], seed: string) => pool.length ? pool[stableHash(seed) % pool.length]! : null;
    let household = this.householdAssignments.get(person.householdId);
    if (!household) { household = { home: null, work: null, study: null, road: null }; this.householdAssignments.set(person.householdId, household); }
    household.home ??= pick(this.buildingPools.home, person.householdId + ':home');
    household.study ??= pick(this.buildingPools.study, person.householdId + ':study');
    household.road ??= pick(stableHash(person.householdId) % 3 === 0 ? this.driveRoadIds : this.walkRoadIds, person.householdId + ':road');
    a.home = household.home;
    a.work ??= pick(this.buildingPools.work, person.id + ':work');
    a.study = household.study;
    a.road = household.road;
    return a;
  }
  getPresence(personId: string, minutes: number, scenario: DemoScenarioId = 'baseline', year = 2026): DemoPresence | null {
    const person = this.recordIndexes.get(scenario)?.get(personId);
    if (!person || !Number.isInteger(year) || year < this.manifest.startYear || year > this.manifest.endYear || year < person.entryYear || person.exitYear !== null && year >= person.exitYear) return null;
    const a = this.assignment(person);
    const time = mod(Number.isFinite(minutes) ? minutes : 720, 1440);
    const base = { personId, buildingId: null, vehicleId: null, roadId: null, position: null, representation: 'visual_synthesis' as const };
    if (!a.home) return { ...base, state: 'unplaced', activity: 'Точное здание не назначено; житель учитывается в аналитике' };
    const seed = stableHash(person.householdId);
    // Shared household window makes passengers and their vehicle mutually consistent.
    const moving = time >= 360 && time < 1380 && mod(time + seed % 180, 180) < 18;
    if (moving && a.road) {
      const road = this.roads.get(a.road)!;
      const vehicle = seed % 3 === 0;
      const speedMps = vehicle ? 6 : 1.25;
      const first = road.coordinates[0]!; const last = road.coordinates.at(-1)!;
      const closed = first[0] === last[0] && first[1] === last[1];
      // Walking family members must remain separately visible/pickable; vehicle occupants share one anchor.
      const walkingOffset = vehicle ? 0 : stableHash(person.id + ':walk-spacing') % 700 / 100;
      const cycle = road.oneway && !closed
        ? (mod(time + seed % 180, 180) * 60 * speedMps + walkingOffset) / road.length
        : time * 60 * speedMps / road.length + (seed % 1000) / 1000 + walkingOffset / road.length;
      // Open one-way lines end the trip; there is no invented return edge or endpoint teleport.
      if (!road.oneway || closed || cycle < 1) {
        const reverse = !road.oneway && !closed && Math.floor(cycle) % 2 !== 0;
        const progress = reverse ? 1 - mod(cycle, 1) : mod(cycle, 1);
        return { ...base, state: vehicle ? 'vehicle' : 'outdoor', vehicleId: vehicle ? `demo-v-${person.householdId.slice(7)}` : null, roadId: a.road, position: sampleRoad(road, progress), routeProgress: progress, direction: reverse ? 'reverse' : 'forward', speedMps, activity: vehicle ? 'Едет по демонстрационному маршруту' : 'Идёт по улице — визуальный синтез' };
      }
    }
    const employment = employmentFor(person, year);
    const state = employment === 'employed' && time >= 540 && time < 1020 && a.work ? 'work' : employment === 'student' && time >= 480 && time < 840 && a.study ? 'study' : 'home';
    const buildingId = state === 'work' ? a.work : state === 'study' ? a.study : a.home;
    return { ...base, state, buildingId, position: this.buildings.get(buildingId!)?.center ?? null, activity: state === 'work' ? 'На работе в демонстрационном здании' : state === 'study' ? 'На занятиях' : 'Дома' };
  }
  getVehicle(id: string, minutes: number, scenario: DemoScenarioId = 'baseline', year = 2026): DemoVehicle | null {
    const occupants = this.profiles(scenario, year).filter(p => this.getPresence(p.id, minutes, scenario, year)?.vehicleId === id);
    if (!occupants.length) return null;
    const presence = this.getPresence(occupants[0]!.id, minutes, scenario, year)!;
    const large = occupants.length > 4;
    return { id, label: large ? 'Семейный минивэн' : 'Городской автомобиль', class: large ? 'minivan' : stableHash(id) % 2 ? 'sedan' : 'hatchback', occupants, occupancy: occupants.length, capacity: Math.max(large ? 7 : 4, occupants.length), roadId: presence.roadId!, representation: 'visual_synthesis' };
  }
  getBuildingOccupancy(buildingId: string, minutes: number, scenario: DemoScenarioId = 'baseline', year = 2026, offset = 0, limit = 50): DemoBuildingOccupancy {
    const people = this.profiles(scenario, year);
    let assignedResidents = 0; let assignedWorkers = 0;
    const inside: PublicFictionalPersonV1[] = [];
    for (const person of people) {
      const record = this.recordIndexes.get(scenario)!.get(person.id)!;
      const assignment = this.assignment(record);
      if (assignment.home === buildingId) assignedResidents++;
      if (assignment.work === buildingId && person.employment === 'employed') assignedWorkers++;
      if (this.getPresence(person.id, minutes, scenario, year)?.buildingId === buildingId) inside.push(person);
    }
    return { ...page(inside, offset, limit), buildingId, assignedResidents, assignedWorkers, presentNow: inside.length, representation: 'visual_synthesis' };
  }
}
