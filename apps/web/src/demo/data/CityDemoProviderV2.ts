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
import { decodeMovementPage, movementContextAt, decodeMovementCellContext } from '../../../../../shared/demo-population/movement-index.mjs';
import movementCodecSource from '../../../../../shared/demo-population/movement-index.mjs?raw';
import { corridorIntersectsBounds, movementContextKey, movementScheduleSamples, movementWindow } from './movementContinuity';
import { loadMovementPreviewOverlay, type MovementPreviewOverlay, type MovementPreviewOverlayOptions } from './MovementPreviewOverlay';
import { MovementPresenceCache } from './MovementPresenceCache';

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
  movementIndex?: DemoAsset;
}
type Bounds = readonly [number, number, number, number];
interface MovementCell { key:string; bbox:Bounds; context:DemoAsset; pages:(DemoAsset & {count:number;firstPersonIndex:number;lastPersonIndex:number})[] }
interface MovementManifest { contract:'DemoMovementIndexManifestV2'; datasetId:string; representation:'visual_synthesis'; scientificClaim:false; cellZoom:16; pageSize:number; sourceHashes:{populationManifest:string;geographyManifest:string;spatialCodec:string;codec:string}; cells:MovementCell[] }
interface CachedMovementPage {page:ReturnType<typeof decodeMovementPage>;bytes:number;contexts:(ReturnType<typeof movementContextAt>|undefined)[];scheduleKey:string|null;origins:((number|null)[]|undefined)[]}
export interface MovementCoverage { mode:'lifetime_sample'|'activity_index'; status:'loading'|'ready'|'partial'|'error'; reason:string|null; cellsAvailable:number; cellsScanned:number; pagesAvailable:number; pagesScanned:number; recordsScanned:number; eligiblePeople:number; eligibleVehicles:number; networkBytes:number; decodedBytes:number; retainedCandidates:number }
export interface CommittedMovementGeneration {
  generation:number; contextKey:string; viewportRevision:string|null; bounds:Bounds|null;
  validFromMinutes:number; validUntilMinutes:number; status:'ready'|'partial';
}
export interface MovementReadiness { pendingGeneration:number|null; committed:CommittedMovementGeneration|null; lastError:string|null }
const MOVEMENT_BUDGET = { cells:64, pages:128, network:12*1024*1024, decoded:24*1024*1024, records:131072, retained:10000 };
const blankCoverage = (indexed:boolean):MovementCoverage => ({mode:indexed?'activity_index':'lifetime_sample',status:'loading',reason:null,cellsAvailable:0,cellsScanned:0,pagesAvailable:0,pagesScanned:0,recordsScanned:0,eligiblePeople:0,eligibleVehicles:0,networkBytes:0,decodedBytes:0,retainedCandidates:0});
const intersectsBounds = (a:Bounds,b:Bounds) => a[0]<=b[2]&&a[2]>=b[0]&&a[1]<=b[3]&&a[3]>=b[1];
const insideBounds = (point:readonly number[],bounds:Bounds) => point[0]!>=bounds[0]&&point[0]!<=bounds[2]&&point[1]!>=bounds[1]&&point[1]!<=bounds[3];
type Targets = { workBuildingIndex: number | null; studyBuildingIndex: number | null; visitorBuildingIndex: number | null };
type Road = DemoLayout['roads'][number] & { index: number; oneway: boolean; walkable: boolean; drivable: boolean; closed?:boolean; segments?:readonly {fromNodeId:string;toNodeId:string|null}[] };
type Building = Pick<CityBuildingV2, 'index' | 'id' | 'center' | 'districtId' | 'use'> & { walkRoadIndex?: number | null; carRoadIndex?: number | null };
interface SpatialDependencies {metadata:Map<number,Building>;bindings:Map<number,[number|null,number|null]>;routes:Map<number,Road>}
interface PersonState { record: CompactPerson; home: number | null; district: number | null; targets: Targets; walk: number | null; car: number | null; householdSize: number | null; householdContext?: string; householdRecords?: CompactPerson[]; dependencies?:SpatialDependencies }
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
/** Reuse only exactly equal verified motion geometry, never an ID-only match. */
function sameMovementRoad(a:Road,b:ReturnType<typeof decodeMovementCellContext>['roads'][number]):boolean {
  return a.id===b.id&&a.index===b.index&&a.oneway===b.oneway&&a.walkable===b.walkable&&a.drivable===b.drivable&&a.closed===b.closed
    &&a.coordinates.length===b.coordinates.length&&a.coordinates.every((point,i)=>point[0]===b.coordinates[i]![0]&&point[1]===b.coordinates[i]![1])
    &&a.segments?.length===b.segments?.length&&(a.segments??[]).every((segment,i)=>segment.fromNodeId===b.segments![i]!.fromNodeId&&segment.toNodeId===b.segments![i]!.toNodeId);
}

/** Compact city-scale provider. The compatibility dataset contains snapshots, never million-row objects. */
export class CityDemoProviderV2 extends StaticDemoProvider {
  readonly cityPackV2: CityPackV2;
  readonly populationManifestV2: PopulationManifestV2;
  private readonly store: VerifiedShardStore;
  private readonly spatialStore: VerifiedShardStore;
  private readonly queryIndex: QueryIndex;
  private readonly spatial: SpatialManifest;
  private readonly movement:MovementManifest|null;
  private readonly movementStore:VerifiedShardStore;
  private readonly decodedMovementPages=new Map<string,CachedMovementPage>();
  private readonly movementPageCacheBudget=MOVEMENT_BUDGET.decoded;
  private movementPageCacheBytes=0;
  private movementPageCacheRows=0;
  private movementPageCacheHits=0;
  private movementPageCacheMisses=0;
  private readonly movementPresence=new MovementPresenceCache();
  /** Budget accounts verified serialized bytes, not engine-specific JS object overhead. */
  get movementPageCacheStats(){return{entries:this.decodedMovementPages.size,serializedBytes:this.movementPageCacheBytes,maxSerializedBytes:this.movementPageCacheBudget,contextRows:this.movementPageCacheRows,maxContextRows:MOVEMENT_BUDGET.records,hits:this.movementPageCacheHits,misses:this.movementPageCacheMisses,householdTrips:this.movementPresence.stats};}
  private readonly preview:MovementPreviewOverlay|null;
  private readonly previewDependencies:SpatialDependencies={metadata:new Map(),bindings:new Map(),routes:new Map()};
  get movementPreviewOverlay(){return this.preview?{scope:'local_preview' as const,delivery:this.preview.activation?'public_pinned' as const:'local_preview' as const,
    chatCompatibility:this.preview.activation?.chatCompatibility??'pending' as const,bounds:[...this.preview.manifest.bounds] as Bounds,version:this.preview.manifest.version}:null;}
  private movementState = blankCoverage(false);
  private movementBounds:Bounds|null = null;
  get movementCoverage():MovementCoverage { return {...this.movementState}; }
  private pendingMovementGeneration:number|null = null;
  private committedMovementGeneration:CommittedMovementGeneration|null = null;
  private committedMovementCoverage:MovementCoverage|null = null;
  private movementError:string|null = null;
  /** Validity is simulation time fixed at request start, never extended on a slow commit. */
  get movementReadiness():MovementReadiness { const committed=this.committedMovementGeneration;return {pendingGeneration:this.pendingMovementGeneration,committed:committed?{...committed,bounds:committed.bounds?[...committed.bounds] as Bounds:null}:null,lastError:this.movementError}; }
  private readonly records = new Map<number, CompactPerson>();
  private readonly householdsV2 = new Map<number, Household>();
  private readonly prepared = new Map<number, PersonState>();
  private visible = new Map<number, PersonState>();
  private readonly metadata = new Map<number, Building>();
  private readonly routes = new Map<number, Road>();
  /** References only, bounded by the last committed 8,192-road dependency map. */
  private movementRoutes = new Map<number,Road>();
  private readonly bindings = new Map<number, [number | null, number | null]>();
  private readonly buildingRosters = new Map<string, { context: string; assignedResidents: number; assignedWorkers: number; assignedStudents: number; visitorsNow: number; inside: PersonState[] }>();
  private lastPage: { key: string; page: DemoPage<PublicFictionalPersonV1> } | null = null;
  private viewportEpoch = 0;

  constructor(options: { manifest: PopulationManifestV2; summaries: { snapshots: CubeSnapshot[] }; queryIndex: QueryIndex; legacy: DemoLegacyExport; geography: CityPackV2; spatial: SpatialManifest; movement?:MovementManifest; movementPreviewOverlay?:MovementPreviewOverlay; baseURL: string; request?: typeof fetch }) {
    const { manifest, summaries } = options;
    const scenarioData = (id: DemoScenarioId) => ({ id, people: [], snapshots: summaries.snapshots.filter((row) => row.scenario === id) });
    const data: DemoDataset['data'] = { baseline: scenarioData('baseline'), inflow: scenarioData('inflow'), ageing: scenarioData('ageing') };
    const compatibility: DemoDatasetManifestV1 = { contract: 'DemoDatasetManifestV1', datasetId: manifest.datasetId, version: manifest.version, representation: 'fictional_demo', scientificClaim: false, predictiveValidation: false, startYear: manifest.startYear, endYear: manifest.endYear, initialPopulation: manifest.initialPopulation, seed: manifest.seed, assets: { summaries: manifest.summaries }, provenance: { source: manifest.provenance.source, sourceHashes: manifest.provenance.sourceHashes, notes: manifest.provenance.notes ?? manifest.provenance.assumptions?.join(' ') ?? 'Fictional public city; no scientific or predictive claims.' }, licenses: manifest.licenses };
    super({ datasetId: manifest.datasetId, territories: manifest.territories, scenarios: manifest.scenarios, data }, compatibility, options.legacy);
    this.populationManifestV2 = manifest; this.queryIndex = options.queryIndex; this.spatial = options.spatial; this.cityPackV2 = options.geography;
    this.store = new VerifiedShardStore(options.baseURL, 12 * 1024 * 1024, options.request); this.spatialStore = new VerifiedShardStore(new URL('spatial/', options.baseURL).href, 12 * 1024 * 1024, options.request);
    this.movement=options.movement??null; this.movementState=blankCoverage(Boolean(this.movement));
    const movementBase=new URL('.',new URL(options.spatial.movementIndex?.url??'movement/manifest.json',new URL('spatial/',options.baseURL))).href;
    this.movementStore=new VerifiedShardStore(movementBase,MOVEMENT_BUDGET.decoded,options.request);
    this.preview=options.movementPreviewOverlay??null;
    if(this.preview){
      if(this.preview.manifest.datasetId!==manifest.datasetId||this.preview.manifest.recordCount!==manifest.recordCount||this.preview.manifest.householdCount!==manifest.householdCount)throw new Error('Movement preview population size mismatch');
      for(const [index,walk,car]of this.preview.bindings.bindings)this.previewDependencies.bindings.set(index,[walk,car]);
      for(const road of this.preview.bindings.roads)this.previewDependencies.routes.set(road.index,{...road,coordinates:road.coordinates.map(point=>[point[0]!,point[1]!] as[number,number])});
    }
    this.cityPackStatus = 'verified'; this.cityPackBaseUrl = this.cityPackV2.baseURL;
  }

  static async loadCity(baseURL = '/', signal?: AbortSignal, options: { applicationBaseURL?: string; populationManifestSha256?: string; spatialManifestSha256?: string; movementPreviewOverlay?:Pick<MovementPreviewOverlayOptions,'manifestUrl'|'manifestSha256'|'manifestBytes'|'activation'> } = {}): Promise<CityDemoProviderV2> {
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
    let movement:MovementManifest|undefined;
    if(spatial.movementIndex){
      if(spatial.movementIndex.bytes>8*1024*1024)throw new Error('Movement manifest exceeds budget');
      const movementStore=new VerifiedShardStore(new URL('spatial/',manifestURL).href);
      movement=await movementStore.json<MovementManifest>(spatial.movementIndex,signal);
      if(movement.contract!=='DemoMovementIndexManifestV2'||movement.datasetId!==manifest.datasetId||movement.representation!=='visual_synthesis'||movement.scientificClaim!==false||movement.cellZoom!==16||!Number.isSafeInteger(movement.pageSize)||movement.pageSize<1||movement.pageSize>8192||movement.sourceHashes.populationManifest!==spatial.sourceHashes.populationManifest||movement.sourceHashes.geographyManifest!==spatial.sourceHashes.geographyManifest||movement.sourceHashes.spatialCodec!==spatial.sourceHashes.spatialCodec||movement.sourceHashes.codec!==await hash(new TextEncoder().encode(movementCodecSource).buffer)||!Array.isArray(movement.cells)||movement.cells.length>10000||new Set(movement.cells.map(c=>c.key)).size!==movement.cells.length)throw new Error('Movement index requires matching canonical rules and data');
      for(const cell of movement.cells)if(!Array.isArray(cell.bbox)||cell.bbox.length!==4||!cell.bbox.every(Number.isFinite)||cell.bbox[0]>cell.bbox[2]||cell.bbox[1]>cell.bbox[3]||!Array.isArray(cell.pages)||cell.pages.some(p=>!Number.isSafeInteger(p.count)||p.count<1||p.count>8192||!Number.isSafeInteger(p.firstPersonIndex)||p.firstPersonIndex<0||!Number.isSafeInteger(p.lastPersonIndex)||p.lastPersonIndex<p.firstPersonIndex||p.lastPersonIndex>=manifest.recordCount))throw new Error('Invalid movement cell descriptor');
    }
    const [legacy, observed, geography] = await Promise.all([legacyStore.json<DemoLegacyExport>(legacyManifest.assets.legacy!, signal), legacyStore.json<unknown>(legacyManifest.assets.observedCity!, signal), CityPackV2.load(new URL('city-v2/', root).href, geo, signal)]);
    const movementPreviewOverlay=options.movementPreviewOverlay?await loadMovementPreviewOverlay({...options.movementPreviewOverlay,signal,baseHashes:{spatial:await hash(spatialBytes),population:await hash(bytes),geography:manifest.spatial.geographyManifestSha256}}):undefined;
    const provider = new CityDemoProviderV2({ manifest, summaries, queryIndex, legacy, geography, spatial, movement, movementPreviewOverlay, baseURL: new URL('.', manifestURL).href });
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
  private cachedState(index: number) { return this.visible.get(index) ?? this.prepared.get(index); }
  /** Retain only this person's at-most-four origins, never an entire prior viewport. */
  private pinDependencies(state:PersonState,source:SpatialDependencies,previous=state.dependencies):SpatialDependencies {
    const pinned:SpatialDependencies={metadata:new Map(),bindings:new Map(),routes:new Map()};
    for(const index of [state.home,state.targets.workBuildingIndex,state.targets.studyBuildingIndex,state.targets.visitorBuildingIndex])if(index!==null){
      const building=source.metadata.get(index)??previous?.metadata.get(index);if(building)pinned.metadata.set(index,building);
      const binding=source.bindings.get(index),complete=binding&&binding.every(road=>road===null||source.routes.has(road));
      const dependencies=this.previewDependencies.bindings.has(index)?this.previewDependencies:complete?source:previous;const pair=dependencies?.bindings.get(index);if(!pair)continue;
      pinned.bindings.set(index,pair);for(const roadIndex of pair)if(roadIndex!==null){const road=dependencies!.routes.get(roadIndex);if(road)pinned.routes.set(roadIndex,road);}
    }
    return pinned;
  }
  private async state(index: number, signal?: AbortSignal): Promise<PersonState> {
    const existing = this.cachedState(index); if (existing) return existing;
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
        // Paging must not discard the complete assignment/household already
        // resolved for the map or inspector. A list row is only a fallback.
        const state: PersonState = this.cachedState(record.personIndex) ?? { record, home: hh.homeBuildingIndex, district: hh.districtIndex, targets: emptyTargets(), walk: null, car: null, householdSize: null };
        boundedSet(this.records, record.personIndex, record, 4096); boundedSet(this.prepared, record.personIndex, state, 4096); items.push(this.profile(state, scenario, year)!); if (items.length >= limit) break;
      }
      if (items.length >= limit) break;
    }
    signal?.throwIfAborted(); const page = result(items, total, offset, limit); this.lastPage = { key: JSON.stringify(query), page }; return page;
  }
  override getPerson(id: string, scenario: DemoScenarioId = 'baseline', year = 2026) { const index = parsePersonId(id); const state = index === null ? null : this.cachedState(index); return state ? this.profile(state, scenario, year) : null; }
  override async preparePerson(id: string, scenario: DemoScenarioId, year: number, signal?: AbortSignal) {
    const index = parsePersonId(id); if (index === null || index >= this.populationManifestV2.recordCount) return;
    const state = await this.state(index, signal); if (!isActive(state.record, year, scenario)) return;
    const hh = await this.household(state.record.householdIndex, signal); let size = 0; const householdRecords: CompactPerson[] = [];
    for (const member of hh.members) { const memberRecord = await this.resident(member, signal); householdRecords.push(memberRecord); if (isActive(memberRecord, year, scenario)) size++; }
    const asset = this.spatial.targetShards[Math.floor(index / this.spatial.targetShardSize)]!; state.targets = targetAt(decodeTargetShard(await this.spatialStore.read(asset, signal)), index); state.householdSize = size; state.householdContext = `${scenario}:${year}`; state.householdRecords = householdRecords;
    for (const buildingIndex of [state.home, state.targets.workBuildingIndex, state.targets.studyBuildingIndex, state.targets.visitorBuildingIndex]) if (buildingIndex !== null) { const building = await this.cityPackV2.loadBuildingByIndex(buildingIndex, signal); if (building) boundedSet(this.metadata, building.index, building, 16384); await this.loadBinding(buildingIndex, signal); }
    const binding = state.home === null ? null : this.bindings.get(state.home); state.walk = binding?.[0] ?? null; state.car = binding?.[1] ?? null; state.dependencies=this.pinDependencies(state,{metadata:this.metadata,bindings:this.bindings,routes:this.routes}); boundedSet(this.prepared, index, state, 4096);
  }
  private async loadBinding(building: number, signal?: AbortSignal) {
    const preview=this.previewDependencies.bindings.get(building);
    if(preview){boundedSet(this.bindings,building,preview,16384);for(const index of preview)if(index!==null)boundedSet(this.routes,index,this.previewDependencies.routes.get(index)!,8192);return;}
    const existing=this.bindings.get(building);if(existing&&existing.every(index=>index===null||this.routes.has(index)))return;
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
    for(const state of new Set([...this.visible.values(),...this.prepared.values()]))if(state.dependencies){for(const building of state.dependencies.metadata.values())if(!buildings.has(building.id))buildings.set(building.id,building as CityBuildingV2);for(const road of state.dependencies.routes.values())roads.set(road.id,road);}
    return { buildings: [...buildings.values()], roads: [...roads.values()] };
  }
  override async prepareViewport(context: DemoContextV1, signal?: AbortSignal, viewport?: RendererViewportSnapshot) {
    const bbox = viewport ? [...viewport.bbox] as [number, number, number, number] : undefined;
    const epoch = ++this.viewportEpoch; this.pendingMovementGeneration=epoch;this.movementError=null;
    try {
    const cells = await this.cityPackV2.updateViewport(viewport?.camera ?? context.camera, bbox, signal); const visible = new Map<number, PersonState>();
    signal?.throwIfAborted(); if(epoch!==this.viewportEpoch)throw new DOMException('Superseded viewport','AbortError');
    if((viewport?.camera??context.camera).zoom<15.5){this.visible=visible;this.movementBounds=null;this.movementState={...blankCoverage(Boolean(this.movement)),status:'ready',reason:'aggregate_only'};this.committedMovementGeneration=null;this.committedMovementCoverage=null;return;}
    if(this.movement||this.preview){ await this.prepareMovementViewport(context,viewport?.camera??context.camera,bbox,epoch,signal,viewport?.revision??null);return; }
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
    signal?.throwIfAborted(); if (epoch !== this.viewportEpoch) throw new DOMException('Superseded viewport', 'AbortError'); this.visible = visible; this.movementBounds=null;
    this.movementState={...blankCoverage(false),status:'partial',reason:'lifetime_sample',cellsAvailable:cells.length,cellsScanned:cells.length,retainedCandidates:visible.size};
    this.commitMovementReadiness(context,viewport?.revision??null,epoch);
    } catch(error) {
      if(epoch===this.viewportEpoch){this.movementError=signal?.aborted?'aborted':'index_unavailable';this.movementState=signal?.aborted&&this.committedMovementCoverage?{...this.committedMovementCoverage}:{...(this.committedMovementCoverage??this.movementState),status:'error',reason:this.movementError};}
      throw error;
    } finally {if(epoch===this.viewportEpoch)this.pendingMovementGeneration=null;}
  }
  private commitMovementReadiness(context:DemoContextV1,viewportRevision:string|null,epoch:number){
    if(epoch!==this.viewportEpoch)throw new DOMException('Superseded viewport','AbortError');
    this.committedMovementGeneration={generation:epoch,contextKey:movementContextKey(context),viewportRevision,bounds:this.movementBounds?[...this.movementBounds] as Bounds:null,...movementWindow(context.presentationMinutes),status:this.movementState.status==='partial'?'partial':'ready'};
    this.committedMovementCoverage={...this.movementState};this.movementError=null;
  }
  /** Called only after VerifiedShardStore has accepted the exact manifest bytes.
   * Keep first-use codec validation intact; immutable warm refreshes reuse it.
   * Source codec compatibility is already pinned for this provider instance.
   */
  private movementPage(bytes:ArrayBuffer,asset:MovementCell['pages'][number],cellKey:string){
    if(bytes.byteLength!==asset.bytes)throw new Error('Movement page byte length mismatch');
    const key=`DemoMovementPageV2:${asset.sha256}:${asset.bytes}`;
    const cached=this.decodedMovementPages.get(key);
    const entry:CachedMovementPage=cached??{page:decodeMovementPage(bytes),bytes:asset.bytes,contexts:[],scheduleKey:null,origins:[]},page=entry.page;
    if(page.key!==cellKey||page.count!==asset.count)throw new Error('Movement page descriptor mismatch');
    const first=entry.contexts[0]??=movementContextAt(page,0),last=entry.contexts[page.count-1]??=movementContextAt(page,page.count-1);
    if(first.record.personIndex!==asset.firstPersonIndex||last.record.personIndex!==asset.lastPersonIndex)throw new Error('Movement page range mismatch');
    if(cached){this.movementPageCacheHits++;this.decodedMovementPages.delete(key);this.decodedMovementPages.set(key,cached);}
    else{
      this.movementPageCacheMisses++;
      while(this.decodedMovementPages.size&&(this.movementPageCacheBytes+asset.bytes>this.movementPageCacheBudget||this.decodedMovementPages.size>=MOVEMENT_BUDGET.pages||this.movementPageCacheRows+page.count>MOVEMENT_BUDGET.records)){
        const oldest=this.decodedMovementPages.keys().next().value!,removed=this.decodedMovementPages.get(oldest)!;this.movementPageCacheBytes-=removed.bytes;this.movementPageCacheRows-=removed.page.count;this.decodedMovementPages.delete(oldest);
      }
      if(asset.bytes<=this.movementPageCacheBudget&&page.count<=MOVEMENT_BUDGET.records){this.decodedMovementPages.set(key,entry);this.movementPageCacheBytes+=asset.bytes;this.movementPageCacheRows+=page.count;}
    }
    return entry;
  }
  private async prepareMovementViewport(context:DemoContextV1,camera:DemoContextV1['camera'],supplied:Bounds|undefined,epoch:number,signal?:AbortSignal,viewportRevision:string|null=null){
    const radius=Math.min(3000,Math.max(350,700*2**(16.5-camera.zoom))),dy=radius/110540,dx=radius/(111320*Math.cos(camera.latitude*Math.PI/180));
    const bounds:Bounds=supplied??[camera.longitude-dx,camera.latitude-dy,camera.longitude+dx,camera.latitude+dy];
    const cells=[...(this.preview?.manifest.cells??[]).map(cell=>({...cell,preview:true})),...(this.movement?.cells??[]).map(cell=>({...cell,preview:false}))]
      .filter(cell=>intersectsBounds(cell.bbox,bounds)).sort((a,b)=>Number(b.preview)-Number(a.preview)||distance([(a.bbox[0]+a.bbox[2])/2,(a.bbox[1]+a.bbox[3])/2],[camera.longitude,camera.latitude])-distance([(b.bbox[0]+b.bbox[2])/2,(b.bbox[1]+b.bbox[3])/2],[camera.longitude,camera.latitude])||a.key.localeCompare(b.key));
    const coverage=blankCoverage(true); coverage.cellsAvailable=cells.length; coverage.pagesAvailable=cells.reduce((sum,c)=>sum+c.pages.length,0); this.movementState=coverage;
    const visible=new Map<number,PersonState>(),entities=new Set<string>();
    const staged:SpatialDependencies={metadata:new Map(),bindings:new Map(),routes:new Map()};
    const scheduleSamples=movementScheduleSamples(context.presentationMinutes),roadIntersections=new Map<number,boolean>();
    const scheduleKey=JSON.stringify([context.year,context.scenario,scheduleSamples]);
    const hasCorridor=(origin:number|null,previous?:SpatialDependencies)=>{
      if(origin===null)return false;const dependencies=this.previewDependencies.bindings.has(origin)?this.previewDependencies:staged.bindings.has(origin)?staged:previous;const binding=dependencies?.bindings.get(origin);if(!binding)return false;
      return binding.some(index=>{if(index===null)return false;const road=dependencies!.routes.get(index);if(!road)return false;
        if(!roadIntersections.has(index))roadIntersections.set(index,corridorIntersectsBounds(road.coordinates,bounds));return roadIntersections.get(index);});
    };
    const check=()=>{signal?.throwIfAborted();if(epoch!==this.viewportEpoch)throw new DOMException('Superseded viewport','AbortError');};
    const partial=(reason:string)=>{coverage.status='partial';coverage.reason=reason;};
    const read=async(asset:DemoAsset,store:VerifiedShardStore)=>{
      check();if(asset.bytes>8*1024*1024)throw new Error('Movement asset exceeds page budget');
      if(coverage.decodedBytes+asset.bytes>MOVEMENT_BUDGET.decoded){partial('decoded_budget');return null;}
      if(coverage.networkBytes+(asset.gzip?.bytes??asset.bytes)>MOVEMENT_BUDGET.network){partial('network_budget');return null;}
      const loaded=store.loadedBytes;const bytes=await store.read(asset,signal);check();
      if(store.loadedBytes!==loaded)coverage.networkBytes+=asset.gzip?.bytes??asset.bytes;
      coverage.decodedBytes+=bytes.byteLength;return bytes;
    };
    try{
      scan:for(const cell of cells){
        if(coverage.cellsScanned>=MOVEMENT_BUDGET.cells){partial('cell_budget');break;}
        const store=cell.preview?this.preview!.store:this.movementStore;
        const rawContext=await read(cell.context,store);if(!rawContext)break;
        const cellContext=decodeMovementCellContext(rawContext);if(cellContext.key!==cell.key)throw new Error('Movement cell key mismatch');
        if(cell.preview){
          for(const [index,walk,car]of cellContext.bindings){const pair=this.previewDependencies.bindings.get(index);if(!pair||pair[0]!==walk||pair[1]!==car)throw new Error('Movement preview cell dictionary mismatch');}
          for(const road of cellContext.roads){const canonical=this.previewDependencies.routes.get(road.index);if(!canonical||!sameMovementRoad(canonical,road))throw new Error('Movement preview cell dictionary mismatch');}
        }
        if(staged.bindings.size+cellContext.bindings.filter(([index])=>!staged.bindings.has(index)).length>16384||staged.routes.size+cellContext.roads.filter(road=>!staged.routes.has(road.index)).length>8192){partial('dependency_budget');break;}
        for(const [index,walk,car]of cellContext.bindings)staged.bindings.set(index,[walk,car]);
        for(const road of cellContext.roads){
          const previous=this.previewDependencies.routes.get(road.index)??staged.routes.get(road.index)??this.movementRoutes.get(road.index);
          staged.routes.set(road.index,previous&&sameMovementRoad(previous,road)?previous:{...road,coordinates:road.coordinates.map(point=>[point[0]!,point[1]!] as [number,number])});
        }
        coverage.cellsScanned++;
        for(const descriptor of cell.pages){
          if(coverage.pagesScanned>=MOVEMENT_BUDGET.pages){partial('page_budget');break scan;}
          if(coverage.recordsScanned+descriptor.count>MOVEMENT_BUDGET.records){partial('record_budget');break scan;}
          const bytes=await read(descriptor,store);if(!bytes)break scan;
          const cachedPage=this.movementPage(bytes,descriptor,cell.key),page=cachedPage.page;
          if(cachedPage.scheduleKey!==scheduleKey){cachedPage.scheduleKey=scheduleKey;cachedPage.origins=[];}
          if(staged.metadata.size+page.buildings.filter(building=>!staged.metadata.has(building.index)).length>16384){partial('metadata_budget');break scan;}
          for(const building of page.buildings)staged.metadata.set(building.index,building);
          coverage.pagesScanned++;
          let sliceStart=performance.now();
          for(let ordinal=0;ordinal<page.count;ordinal++){
            if(ordinal%1024===0||performance.now()-sliceStart>=4){await new Promise<void>(resolve=>setTimeout(resolve,0));check();sliceStart=performance.now();}
            coverage.recordsScanned++;const item=cachedPage.contexts[ordinal]??=movementContextAt(page,ordinal),record=item.record;
            if(visible.has(record.personIndex)||!isActive(record,context.year,context.scenario)||context.year-record.birthYear<7)continue;
            const districtId=item.districtIndex===null?ROOT:DISTRICT_IDS[item.districtIndex]!;
            if(!matches({ageBand:coarseAgeBand(context.year-record.birthYear),sex:record.sex,employment:employmentFor(record,context.year),territoryId:districtId},{territoryId:context.territoryId,...context.cohort}))continue;
            // Keep potential entrants for the committed validity window, including
            // people currently indoors or hidden in an open-road reset gap. The
            // exact shared position/activity is still checked only at draw time.
            const previous=this.cachedState(record.personIndex)?.dependencies;
            // Only the source schedule is reusable. Route availability, retained
            // dependencies and intersection with the current viewport stay live.
            let origins=cachedPage.origins[ordinal];
            if(!origins){origins=[];for(const minute of scheduleSamples){const current=this.movementPresence.presence(record,item.targets,item.homeBuildingIndex,context.year,context.scenario,minute,item.householdRecords);
              const origin=current.originBuildingIndex??current.buildingIndex??item.homeBuildingIndex;if(['travel','leisure'].includes(current.role??'')&&!origins.includes(origin))origins.push(origin);
            }cachedPage.origins[ordinal]=origins;}
            const potential=origins.some(origin=>hasCorridor(origin,previous));
            if(!potential)continue;
            const binding=item.homeBuildingIndex===null?null:staged.bindings.get(item.homeBuildingIndex);
            const state:PersonState={record,home:item.homeBuildingIndex,district:item.districtIndex,targets:item.targets,walk:binding?.[0]??null,car:binding?.[1]??null,householdSize:null,householdRecords:item.householdRecords,dependencies:staged};
            if(visible.size>=MOVEMENT_BUDGET.retained){partial('candidate_budget');break scan;}
            state.householdSize=item.householdRecords.filter(r=>isActive(r,context.year,context.scenario)).length;state.householdContext=`${context.scenario}:${context.year}`;
            visible.set(record.personIndex,state);
          }
        }
      }
      check();if(coverage.status==='loading')coverage.status='ready';coverage.retainedCandidates=visible.size;
      if(this.preview&&coverage.status==='ready'&&cells.some(cell=>cell.preview)
        &&(!insideBounds([bounds[0],bounds[1]],this.preview.manifest.sourceBounds)||!insideBounds([bounds[2],bounds[3]],this.preview.manifest.sourceBounds)))partial('preview_boundary');
      let pinnedCount=0,sliceStart=performance.now();
      const pinnedRoads=new Set<number>(),pinnedBindings=new Set<number>(),pinnedBuildings=new Set<number>();
      for(const state of visible.values()){
        // A partial refresh may omit an origin scanned in the previous generation.
        // Preserve only this re-read person's four verified origins, not old actors.
        state.dependencies=this.pinDependencies(state,staged,this.cachedState(state.record.personIndex)?.dependencies);
        for(const index of state.dependencies.routes.keys())pinnedRoads.add(index);
        for(const index of state.dependencies.bindings.keys())pinnedBindings.add(index);
        for(const index of state.dependencies.metadata.keys())pinnedBuildings.add(index);
        if(pinnedRoads.size>8192||pinnedBindings.size>16384||pinnedBuildings.size>16384)throw new Error('Movement retained dependency budget exceeded');
        const presence=this.presence(state,context.presentationMinutes,context.scenario,context.year);
        if(presence?.position&&['vehicle','outdoor'].includes(presence.state)&&insideBounds(presence.position,bounds))entities.add(presence.vehicleId??state.record.id);
        if(++pinnedCount%128===0||performance.now()-sliceStart>=4){await new Promise<void>(resolve=>setTimeout(resolve,0));check();sliceStart=performance.now();}
      }
      check();coverage.eligibleVehicles=[...entities].filter(id=>id.startsWith('demo2-v-')).length;coverage.eligiblePeople=entities.size-coverage.eligibleVehicles;
      this.movementRoutes=staged.routes;this.visible=visible;this.movementBounds=bounds;this.movementState={...coverage};this.commitMovementReadiness(context,viewportRevision,epoch);
    }catch(error){if(epoch===this.viewportEpoch&&!signal?.aborted){this.movementState={...coverage,status:'error',reason:'index_unavailable'};}throw error;}
  }
  private presence(state: PersonState, minutes: number, scenario: DemoScenarioId, year: number): DemoPresence | null {
    const minute = ((minutes % 1440) + 1440) % 1440; const current = this.movementPresence.presence(state.record, state.targets, state.home, year, scenario, minute, state.householdRecords); if (!current.active) return null;
    const base = { personId: state.record.id, buildingId: null, vehicleId: null, roadId: null, position: null, representation: 'visual_synthesis' as const };
    const dependencies=state.dependencies??{metadata:this.metadata,bindings:this.bindings,routes:this.routes};
    const origin = current.originBuildingIndex ?? current.buildingIndex ?? state.home; const binding = origin === null ? null : dependencies.bindings.get(origin);
    const walkIndex = binding ? binding[0] : origin === state.home ? state.walk : null; const carIndex = binding ? binding[1] : origin === state.home ? state.car : null;
    const movement = dailyMovement(state.record, current, { walkRoad: dependencies.routes.get(walkIndex ?? -1) ?? null, carRoad: dependencies.routes.get(carIndex ?? -1) ?? null }, minute);
    if (movement) { const movingPresence: DemoPresence & { routeMode: 'ping_pong' | 'loop' | 'once'; endpointOpacity: number } = { ...base, state: movement.mode === 'vehicle' ? 'vehicle' : 'outdoor', vehicleId: movement.vehicleId, roadId: movement.routeId, position: [movement.longitude, movement.latitude], routeProgress: movement.progress, direction: movement.direction, speedMps: movement.speedMps, routeMode: movement.routeMode, endpointOpacity: movement.endpointOpacity, activity: movement.mode === 'vehicle' ? 'В автомобиле · вымышленная локальная поездка по исходному дорожному коридору' : 'Пешком · вымышленная локальная прогулка по исходному дорожному коридору' }; return movingPresence; }
    const building = current.buildingIndex === null ? null : dependencies.metadata.get(current.buildingIndex);
    const stateName = current.role === 'visitor' ? 'shopping' : current.role === 'work' || current.role === 'study' || current.role === 'home' ? current.role : 'unplaced';
    return { ...base, state: stateName, buildingId: building?.id ?? null, position: building?.center ?? null, activity: stateName === 'work' ? 'На работе — визуальный синтез' : stateName === 'study' ? 'На занятиях — визуальный синтез' : stateName === 'shopping' ? 'В гостевом посещении — визуальный синтез' : stateName === 'home' ? 'Дома' : 'Маршрут или размещение недоступны; житель остаётся в учёте' };
  }
  override getPresence(id: string, minutes: number, scenario: DemoScenarioId = 'baseline', year = 2026) { const index = parsePersonId(id); const state = index === null ? null : this.cachedState(index); return state ? this.presence(state, minutes, scenario, year) : null; }
  override getVisibleCandidates(scenario: DemoScenarioId = 'baseline', year = 2026, limit = 2000, viewport?: DemoViewportQuery) {
    const cap=Math.min(5000,Math.max(0,Math.floor(limit)));if(!cap)return [];
    const accepted = new Map<string,{ state:PersonState; distance: number }>();
    for (const state of this.visible.values()) {
      const record=state.record,age=year-record.birthYear;if(age<7||!isActive(record,year,scenario))continue;
      if(viewport&&!matches({ageBand:coarseAgeBand(age),sex:record.sex,employment:employmentFor(record,year),territoryId:state.district===null?ROOT:DISTRICT_IDS[state.district]!},viewport))continue;
      const presence=this.presence(state,viewport?.minutes??720,scenario,year);
      if(!presence?.position||!['vehicle','outdoor'].includes(presence.state)||this.movementBounds&&!insideBounds(presence.position,this.movementBounds))continue;
      const d=viewport?distance(presence.position,[viewport.longitude,viewport.latitude]):0;if(viewport&&d>viewport.radiusMeters)continue;
      const key=presence.vehicleId??record.id,previous=accepted.get(key);if(!previous||record.id<previous.state.record.id)accepted.set(key,{state,distance:d});
    }
    // Biographies and trait arrays are needed only for the selected output rows.
    return [...accepted.values()].sort((a,b)=>a.distance-b.distance||a.state.record.id.localeCompare(b.state.record.id)).slice(0,cap).map(row=>this.profile(row.state,scenario,year)!);
  }
  override async prepareBuilding(id: string, minutes: number, scenario: DemoScenarioId, year: number, signal?: AbortSignal) {
    this.buildingRosters.delete(id);
    const building = await this.cityPackV2.loadBuilding(id, signal); if (!building) return; this.buildingRosters.delete(building.id); boundedSet(this.metadata, building.index, building, 16384);
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
        const known = this.cachedState(record.personIndex); const homeBuilding = home === null ? null : this.metadata.get(home); const districtId = homeBuilding?.districtId ?? building.districtId; const district = districtId ? DISTRICT_IDS.indexOf(districtId) : -1;
        roster.inside.push(known ?? { record, home, district: district < 0 ? null : district, targets, walk: null, car: null, householdSize: null });
      }
    }
    roster.inside.sort((a, b) => a.record.personIndex - b.record.personIndex); signal?.throwIfAborted(); boundedSet(this.buildingRosters, building.id, roster, 2); if (id !== building.id) boundedSet(this.buildingRosters, id, roster, 2);
  }
  override getBuildingOccupancy(id: string, minutes: number, scenario: DemoScenarioId = 'baseline', year = 2026, offset = 0, limit = 50) {
    const roster = this.buildingRosters.get(id); const current = roster?.context === `${scenario}:${year}:${Math.floor(minutes)}` ? roster : null; const page = windowFor({ offset, limit });
    const inside = current?.inside ?? []; const items = inside.slice(page.offset, page.offset + page.limit).map((state) => this.profile(state, scenario, year)!).filter(Boolean);
    return { ...result(items, inside.length, page.offset, page.limit), buildingId: id, coverageStatus: current ? 'covered' as const : 'no_index' as const, assignedResidents: current?.assignedResidents ?? 0, assignedWorkers: current?.assignedWorkers ?? 0, assignedStudents: current?.assignedStudents ?? 0, visitorsNow: current?.visitorsNow ?? 0, presentNow: inside.length, representation: 'visual_synthesis' as const };
  }
  override async prepareVehicle(id: string, minutes: number, scenario: DemoScenarioId, year: number, signal?: AbortSignal) {
    const match = /^demo2-v-(\d{7})$/.exec(id); if (!match) return; const driverIndex = Number(match[1]); await this.preparePerson(personId(driverIndex), scenario, year, signal);
    const driver = this.prepared.get(driverIndex); if (!driver?.householdRecords) return;
    for (const member of driver.householdRecords) if (member.personIndex !== driverIndex && isActive(member, year, scenario)) await this.preparePerson(member.id, scenario, year, signal);
  }
  override getVehicle(id: string, minutes: number, scenario: DemoScenarioId = 'baseline', year = 2026) {
    const match = /^demo2-v-(\d{7})$/.exec(id); if (!match) return null; const index = Number(match[1]); const state = this.cachedState(index);
    if (!state) return null;
    const householdSize = state.householdRecords?.filter((member) => isActive(member, year, scenario)).length ?? null;
    const members = state.householdRecords ?? [state.record];
    const occupants = members.flatMap((record) => { const personState = this.cachedState(record.personIndex) ?? { ...state, record, targets: emptyTargets(), householdSize, householdContext: `${scenario}:${year}` }; const profile = this.presence(personState, minutes, scenario, year)?.vehicleId === id ? this.profile(personState, scenario, year) : null; return profile ? [profile] : []; });
    if (!occupants.length) return null; const presence = this.getPresence(occupants[0]!.id, minutes, scenario, year)!; return { id, label: occupants.length > 4 ? 'Семейный минивэн' : 'Городской автомобиль', class: occupants.length > 4 ? 'minivan' as const : 'sedan' as const, occupants, occupancy: occupants.length, capacity: Math.max(occupants.length, occupants.length > 4 ? 7 : 4), roadId: presence.roadId!, representation: 'visual_synthesis' as const };
  }
}
