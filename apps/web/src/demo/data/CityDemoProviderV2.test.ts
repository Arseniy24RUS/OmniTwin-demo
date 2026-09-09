import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { CityDemoProviderV2, type PopulationManifestV2 } from './CityDemoProviderV2';
import { CityPackV2 } from './CityPackV2';
import { VerifiedShardStore } from './VerifiedShardStore';
import type { MovementPreviewOverlay } from './MovementPreviewOverlay';
import { DATASET_ID, decodePersonShard, recordAt, encodePersonShard, encodeHouseholdShard, profileFor, isActive, employmentFor, coarseAgeBand } from '../../../../../shared/demo-population/index.mjs';
import { encodeTargetShard, SPATIAL_NONE, presenceFor, dailyMovement } from '../../../../../shared/demo-population/spatial.mjs';
import { decodeMovementCellContext, encodeMovementPage } from '../../../../../shared/demo-population/movement-index.mjs';
import * as movementCodec from '../../../../../shared/demo-population/movement-index.mjs';
import { MovementPresenceCache } from './MovementPresenceCache';
import type { DemoAsset, DemoContextV1, DemoLegacyExport, DemoScenarioId, DemoSnapshot } from '../types';

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
  const spatial:ConstructorParameters<typeof CityDemoProviderV2>[0]['spatial'] = { contract: 'DemoSpatialManifestV2', datasetId: DATASET_ID, recordCount: 4, targetShardSize: 8192, roleShardSize: 256, sourceHashes: { populationManifest: '', geographyManifest: '' }, targetShards: [{ ...target, url: 'targets.bin', startIndex: 0, count: 4 }], roleShards: [], bindingShards: [], candidateCells: [] };
  const legacy = { contract: 'OriginalSyntheticBundleExportV1', sourceRunId: 'synthetic-chelyabinsk-v1', run: {}, completion: {}, geography: [], population: [], events_aggregate: [] } as DemoLegacyExport;
  const providerOptions = { manifest, summaries: { snapshots: snapshots as ConstructorParameters<typeof CityDemoProviderV2>[0]['summaries']['snapshots'] }, queryIndex, geography, spatial, legacy, baseURL: 'https://fixture.test/demo-v2/', request };
  const provider = new CityDemoProviderV2(providerOptions);
  return { provider, requests, records, spatial, providerOptions, asset, people, buildings };
}

async function movementFixture(padded=false,controller?:AbortController,once=false){
  const base=await fixture();const key='16/43951/20675';const family=[base.records[0]!,base.records[1]!,base.records[3]!];
  const targets={workBuildingIndex:2,studyBuildingIndex:null,visitorBuildingIndex:null};
  const minutes=Array.from({length:1440},(_,i)=>i).find(minute=>['travel','leisure'].includes(presenceFor(base.records[0]!,targets,0,2026,'baseline',minute,{householdRecords:family}).role!))!;
  const makePage=(index:number,stem:string)=>{
    const contexts=new Uint8Array(36),view=new DataView(contexts.buffer);view.setUint32(0,index,true);contexts.set(base.people.subarray(32+index*16,48+index*16),4);
    [0,index===0?2:SPATIAL_NONE,index===3?3:SPATIAL_NONE,SPATIAL_NONE].forEach((value,i)=>view.setUint32(20+i*4,value,true));
    const bytes=encodeMovementPage({key,contexts,households:[{householdIndex:0,members:family.map(record=>[record.personIndex,Buffer.from(base.people.subarray(32+record.personIndex*16,48+record.personIndex*16)).toString('base64')])}],buildings:base.buildings.map(b=>({...b,center:b.center as[number,number],districtId:b.districtId!,use:b.use as'residential'|'work'|'study'}))});
    const payload=padded?new Uint8Array(8*1024*1024).fill(32):bytes;if(padded)payload.set(bytes);
    return {...base.asset(`spatial/movement/${stem}.json`,payload),url:`${stem}.json`,count:1,firstPersonIndex:index,lastPersonIndex:index};
  };
  const movementRoads=['walk','car'].map((mode,index)=>({index,sourceRoadIndex:0,mode,id:`source:${mode}`,coordinates:[[61.399,55.16],[61.405,55.16]],oneway:once,walkable:true,drivable:true,segments:[{fromNodeId:'osm-node:1',toNodeId:'osm-node:2'}],connectivity:'source_node_ids',semantics:'connected_source_road_local_visual_synthesis_not_home_work_route'}));
  const contextAsset=base.asset('spatial/movement/context.json',{contract:'DemoMovementCellContextV2',key,bindings:base.buildings.map(b=>[b.index,0,1]),roads:movementRoads});
  const pages=padded?[makePage(0,'first'),makePage(0,'second')]:[makePage(3,'future'),makePage(0,'first'),makePage(0,'duplicate')];
  const movement:NonNullable<ConstructorParameters<typeof CityDemoProviderV2>[0]['movement']>={contract:'DemoMovementIndexManifestV2',datasetId:DATASET_ID,representation:'visual_synthesis',scientificClaim:false,cellZoom:16,pageSize:2048,sourceHashes:{populationManifest:'',geographyManifest:'',spatialCodec:'',codec:''},cells:[{key,bbox:[61.399,55.159,61.405,55.161],context:{...contextAsset,url:'context.json'},pages}]};
  const request:typeof fetch=async(input,init)=>{const response=await base.providerOptions.request(input,init);if(controller&&String(input).endsWith('/first.json'))setTimeout(()=>controller.abort(),0);return response;};
  const provider=new CityDemoProviderV2({...base.providerOptions,movement,request});
  const context:DemoContextV1={datasetId:DATASET_ID,scenario:'baseline',year:2026,territoryId:'RU-CHE-SET',cohort:null,presentationMinutes:minutes,weather:'clear',playing:false,speed:1,camera:{longitude:61.402,latitude:55.16,zoom:17,pitch:55,bearing:0}};
  const viewport={camera:context.camera,bbox:[61.398,55.159,61.406,55.161] as const,widthCss:1920,heightCss:1080,revision:'fixture'};
  const sharedMovement=(minute:number)=>dailyMovement(base.records[0]!,presenceFor(base.records[0]!,targets,0,2026,'baseline',minute,{householdRecords:family}),{walkRoad:movementRoads[0]!,carRoad:movementRoads[1]!},minute);
  return{...base,provider,context,viewport,sharedMovement,movement,movementRoads};
}

async function overlayFixture(noWalk=false){
  const base=await movementFixture(),cell=base.movement.cells[0]!;
  const roads=base.movementRoads.map((road,i)=>({...road,index:2_000_000+i,sourceRoadIndex:1_000_000,id:`source-mode-v2:${road.mode}`,coordinates:road.coordinates.map(([lon,lat])=>[lon,lat!+(i===0?.0002:0)])}));
  const raw={contract:'DemoMovementCellContextV2',key:cell.key,bindings:[0,2].map(index=>[index,noWalk?null:2_000_000,2_000_001]),roads};
  const asset=base.asset('spatial/movement/overlay-context.json',raw),descriptor={...asset,url:'overlay-context.json',key:cell.key};
  const baseURL='https://fixture.test/demo-v2/spatial/movement/';
  // The loader boundary is independently tested; these are small verified assets.
  const preview={baseURL,store:new VerifiedShardStore(baseURL,8*1024*1024,base.providerOptions.request),bindings:decodeMovementCellContext(new TextEncoder().encode(JSON.stringify(raw))),manifest:{
    contract:'DemoMovementOverlayV2',version:'source-mode-v2',datasetId:DATASET_ID,representation:'visual_synthesis',scientificClaim:false,scope:'local_preview',chatCompatibility:'pending',
    baseHashes:{spatial:'0'.repeat(64),population:'1'.repeat(64),geography:'2'.repeat(64)},overlayCodecSha256:'3'.repeat(64),
    sourceHashes:{},indexNamespace:{kind:'local_overlay',sourceRoadIndexBase:1_000_000,ordering:'lexicographic_verified_source_road_id',notGlobalGeographyOrdinals:true},
    bounds:[61.398,55.159,61.406,55.161],sourceBounds:[61.39,55.15,61.42,55.17],origin:[61.402,55.16,0],coveredBuildingIndices:[0,2],bindings:descriptor,
    cells:[{...cell,count:3,context:descriptor}],cellZoom:16,pageSize:2048,maxPageSize:8192,maxPageBytes:8*1024*1024,recordCount:4,householdCount:2,buildingCount:4,stats:{},semantics:{},
  }} as MovementPreviewOverlay;
  return{...base,preview,provider:new CityDemoProviderV2({...base.providerOptions,movement:base.movement,movementPreviewOverlay:preview})};
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
  it('paging never replaces a prepared canonical profile or its current assignment with a thin list row', async () => {
    const { provider } = await fixture(); const id = 'demo2-p-0000000';
    await provider.preparePerson(id, 'baseline', 2026);
    const profile = provider.getPerson(id, 'baseline', 2026);
    const presence = provider.getPresence(id, 690, 'baseline', 2026);
    const page = await provider.queryPeople({ scenario:'baseline', year:2026, limit:1 });
    expect(page.items[0]).toEqual(profile);
    expect(provider.getPerson(id, 'baseline', 2026)).toEqual(profile);
    expect(provider.getPresence(id, 690, 'baseline', 2026)).toEqual(presence);
    expect((await provider.queryPeople({ query:id, scenario:'baseline', year:2026 })).items[0]).toEqual(profile);
  });
  it('profile and presence use the same complete visible state over an older thin list cache', async () => {
    const { provider } = await fixture(); const id = 'demo2-p-0000000';
    await provider.queryPeople({ limit:1 });
    type CachedState = { householdRecords?: unknown[]; householdSize:number|null; householdContext?:string };
    const caches = provider as unknown as { prepared:Map<number,CachedState>; visible:Map<number,CachedState> };
    const thin = caches.prepared.get(0)!;
    await provider.preparePerson(id, 'baseline', 2026);
    const complete = {...caches.prepared.get(0)!};
    caches.visible.set(0, complete);
    caches.prepared.set(0, {...thin, householdRecords:undefined, householdSize:null, householdContext:undefined});
    expect(provider.getPerson(id, 'baseline', 2026)?.householdSize).toBe(2);
    expect((await provider.queryPeople({ query:id })).items[0]?.householdSize).toBe(2);
  });
  it('cohort cubes give exact stocks but do not invent household/event breakdowns; aborts fail promptly', async () => {
    const { provider, requests } = await fixture(); const snapshot = provider.getSnapshot('baseline', 2026)!;
    const cohort = provider.getCohortSnapshot(snapshot, { sex: 'male', ageBand: '0-17' })!; expect(cohort.population).toBe(1); expect(cohort.households).toBeNull(); expect(cohort.births).toBeNull();
    const controller = new AbortController(); controller.abort(); await expect(provider.queryPeople({}, controller.signal)).rejects.toThrow(); expect(requests).toHaveLength(0);
  });
  it('distinguishes a covered empty roster from an absent index and clears previously valid results', async () => {
    const { provider, spatial } = await fixture(); const id = 'openmaptiles_buildings:100';
    await provider.prepareBuilding(id, 690, 'baseline', 2026);
    expect(provider.getBuildingOccupancy(id, 690).coverageStatus).toBe('no_index');
    spatial.roleShards.push({url:'unused.bin',bytes:32,sha256:'0'.repeat(64),firstIndex:0,count:4,members:0,contexts:{url:'unused-context.bin',bytes:1,sha256:'0'.repeat(64),recordBytes:36}});
    await provider.prepareBuilding(id, 690, 'baseline', 2026);
    expect(provider.getBuildingOccupancy(id, 690)).toMatchObject({coverageStatus:'covered',presentNow:0});
    vi.spyOn(provider.cityPackV2, 'loadBuilding').mockResolvedValue(null);
    await provider.prepareBuilding(id, 690, 'baseline', 2026);
    expect(provider.getBuildingOccupancy(id, 690).coverageStatus).toBe('no_index');
    expect(provider.getBuildingOccupancy('openmaptiles_buildings:999990', 690).coverageStatus).toBe('no_index');
  });
  it('uses complete route memberships, filters activity before the actor cap, and deduplicates IDs',async()=>{
    const {provider,context,viewport}=await movementFixture();await provider.prepareViewport(context,undefined,viewport);
    const candidates=provider.getVisibleCandidates('baseline',2026,1,{longitude:61.402,latitude:55.16,radiusMeters:2000,minutes:context.presentationMinutes});
    expect(candidates.map(p=>p.id)).toEqual(['demo2-p-0000000']);
    expect(provider.movementCoverage).toMatchObject({mode:'activity_index',status:'ready',pagesScanned:3,recordsScanned:3,retainedCandidates:1});
    const pedestrianPresence=provider.getPresence(candidates[0]!.id,context.presentationMinutes)!;
    expect(pedestrianPresence.roadId).toMatch(/^source:/);
    expect(pedestrianPresence.state).toBe('outdoor');
    expect(pedestrianPresence.vehicleId).toBeNull();
    expect(pedestrianPresence.activity).toMatch(/^Пешком · /);
    await provider.prepareViewport(context,undefined,{...viewport,bbox:[61.4055,55.159,61.406,55.161],revision:'outside'});
    expect(provider.getVisibleCandidates('baseline',2026,100,{longitude:61.402,latitude:55.16,radiusMeters:2000,minutes:context.presentationMinutes})).toEqual([]);
  });
  it('reports bounded partial movement coverage before exceeding the wire budget',async()=>{
    const {provider,context,viewport,requests}=await movementFixture(true);await provider.prepareViewport(context,undefined,viewport);
    expect(provider.movementCoverage).toMatchObject({status:'partial',reason:'network_budget',pagesScanned:1});
    expect(provider.movementCoverage.networkBytes).toBeLessThanOrEqual(12*1024*1024);
    expect(requests.some(url=>url.endsWith('/second.json'))).toBe(false);
  });
  it('cancels between movement evaluation chunks without publishing a partial frame',async()=>{
    const controller=new AbortController();const {provider,context,viewport}=await movementFixture(false,controller);
    await expect(provider.prepareViewport(context,controller.signal,viewport)).rejects.toThrow();
    expect(provider.getVisibleCandidates()).toEqual([]);
  });
  it('retains an upcoming departure and admits it five seconds later without another request',async()=>{
    const {provider,context,viewport,requests}=await movementFixture();const before=context.presentationMinutes-5/60;
    await provider.prepareViewport({...context,presentationMinutes:before},undefined,viewport);const requestCount=requests.length;
    const query=(minutes:number)=>provider.getVisibleCandidates('baseline',2026,10,{longitude:61.402,latitude:55.16,radiusMeters:2000,minutes});
    expect(query(before)).toEqual([]);expect(query(before+5/60).map(p=>p.id)).toEqual(['demo2-p-0000000']);
    expect(requests.length).toBe(requestCount);
  });
  it('retains a spatial entrant outside the initial viewport position, with no extra network at five seconds',async()=>{
    const {provider,context,viewport,requests,sharedMovement}=await movementFixture();const now=context.presentationMinutes+1;
    const next=sharedMovement(now+5/60)!;const bbox=[next.longitude-.00002,next.latitude-.00002,next.longitude+.00002,next.latitude+.00002] as const;
    await provider.prepareViewport({...context,presentationMinutes:now},undefined,{...viewport,bbox});const requestCount=requests.length;
    const query=(minutes:number)=>provider.getVisibleCandidates('baseline',2026,10,{longitude:61.402,latitude:55.16,radiusMeters:2000,minutes});
    expect(query(now)).toEqual([]);expect(query(now+5/60).map(p=>p.id)).toEqual(['demo2-p-0000000']);expect(requests.length).toBe(requestCount);
  });
  it('retains an actor hidden in a one-way reset gap so its same ID reappears without refetching',async()=>{
    const {provider,context,viewport,requests,sharedMovement}=await movementFixture(false,undefined,true);
    const second=Array.from({length:180},(_,i)=>context.presentationMinutes*60+i*5).find(time=>!sharedMovement(time/60)&&sharedMovement((time+5)/60));
    expect(second).toBeDefined();const now=second!/60;
    await provider.prepareViewport({...context,presentationMinutes:now},undefined,viewport);const requestCount=requests.length;
    const query=(minutes:number)=>provider.getVisibleCandidates('baseline',2026,10,{longitude:61.402,latitude:55.16,radiusMeters:2000,minutes});
    expect(query(now)).toEqual([]);expect(query(now+5/60).map(p=>p.id)).toEqual(['demo2-p-0000000']);expect(requests.length).toBe(requestCount);
  });
  it('keeps a committed generation during slow and aborted replacements without extending its simulation validity at 16x',async()=>{
    const {provider,context,viewport}=await movementFixture();await provider.prepareViewport(context,undefined,viewport);
    const committed=provider.movementReadiness.committed!;expect(committed.validUntilMinutes-committed.validFromMinutes).toBe(2);
    let finish!:(value:Awaited<ReturnType<typeof provider.cityPackV2.updateViewport>>)=>void;
    vi.spyOn(provider.cityPackV2,'updateViewport').mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const controller=new AbortController();const pending=provider.prepareViewport({...context,speed:16,presentationMinutes:context.presentationMinutes+1},controller.signal,viewport).catch(error=>error);
    expect(provider.movementReadiness.pendingGeneration).not.toBeNull();expect(provider.movementReadiness.committed).toEqual(committed);
    expect(provider.getVisibleCandidates('baseline',2026,10,{longitude:61.402,latitude:55.16,radiusMeters:2000,minutes:context.presentationMinutes+5/60})).toHaveLength(1);
    controller.abort();finish([]);expect(await pending).toBeInstanceOf(DOMException);
    expect(provider.movementReadiness.committed).toEqual(committed);expect(provider.movementReadiness.pendingGeneration).toBeNull();
    expect(committed.validUntilMinutes).toBeLessThan(context.presentationMinutes+10*16/60);
  });
  it('a superseded geography completion cannot replace newer ready movement coverage with loading',async()=>{
    const {provider,context,viewport}=await movementFixture();
    let finish!:(value:Awaited<ReturnType<typeof provider.cityPackV2.updateViewport>>)=>void;
    vi.spyOn(provider.cityPackV2,'updateViewport').mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const stale=provider.prepareViewport(context,undefined,viewport).catch(error=>error);
    await provider.prepareViewport(context,undefined,{...viewport,revision:'newer'});
    expect(provider.movementCoverage.status).toBe('ready');const generation=provider.movementReadiness.committed;
    finish([]);expect(await stale).toBeInstanceOf(DOMException);
    expect(provider.movementCoverage.status).toBe('ready');expect(provider.movementReadiness.committed).toEqual(generation);
  });
  it('keeps the last committed selection if replacement geometry fails',async()=>{
    const {provider,context,viewport}=await movementFixture();await provider.prepareViewport(context,undefined,viewport);
    const committed=provider.movementReadiness.committed;const before=provider.getPresence('demo2-p-0000000',context.presentationMinutes);
    vi.spyOn(provider.cityPackV2,'updateViewport').mockRejectedValueOnce(new Error('fixture unavailable'));
    await expect(provider.prepareViewport(context,undefined,viewport)).rejects.toThrow('fixture unavailable');
    expect(provider.movementReadiness).toMatchObject({pendingGeneration:null,committed,lastError:'index_unavailable'});
    expect(provider.getPresence('demo2-p-0000000',context.presentationMinutes)).toEqual(before);
  });
  it('materializes profiles only after activity filtering and the requested output cap',async()=>{
    const {provider,context,viewport}=await movementFixture();await provider.prepareViewport(context,undefined,viewport);
    const profiles=vi.spyOn(provider as unknown as {profile:(...args:unknown[])=>unknown},'profile');
    const query={longitude:61.402,latitude:55.16,radiusMeters:2000,minutes:context.presentationMinutes};
    expect(provider.getVisibleCandidates('baseline',2026,0,query)).toEqual([]);
    expect(profiles).not.toHaveBeenCalled();
    expect(provider.getVisibleCandidates('baseline',2026,10,{...query,minutes:0})).toEqual([]);
    expect(profiles).not.toHaveBeenCalled();
    expect(provider.getVisibleCandidates('baseline',2026,1,query)).toHaveLength(1);
    expect(profiles).toHaveBeenCalledTimes(1);
  });
  it('keeps verified corridor object identity and fixed-time presence across a warm temporal refresh',async()=>{
    const {provider,context,viewport,requests}=await movementFixture();await provider.prepareViewport(context,undefined,viewport);
    const id='demo2-p-0000000',before=provider.getPresence(id,context.presentationMinutes)!;
    const road=provider.getLayout().roads.find(row=>row.id===before.roadId);expect(road).toBeDefined();
    const requestCount=requests.length;
    await provider.prepareViewport({...context,presentationMinutes:context.presentationMinutes+1.5},undefined,viewport);
    expect(provider.getPresence(id,context.presentationMinutes)).toEqual(before);
    expect(provider.getLayout().roads.find(row=>row.id===before.roadId)).toBe(road);
    expect(requests.length).toBe(requestCount);
  });
  it('decodes immutable page content once across duplicate URLs and warm temporal refreshes',async()=>{
    const {provider,context,viewport}=await movementFixture();const decode=vi.spyOn(movementCodec,'decodeMovementPage');
    try{
      await provider.prepareViewport(context,undefined,viewport);expect(decode).toHaveBeenCalledTimes(2);
      const presence=provider.getPresence('demo2-p-0000000',context.presentationMinutes);
      await provider.prepareViewport({...context,presentationMinutes:context.presentationMinutes+1.5},undefined,viewport);
      expect(decode).toHaveBeenCalledTimes(2);expect(provider.getPresence('demo2-p-0000000',context.presentationMinutes)).toEqual(presence);
    }finally{decode.mockRestore();}
  });
  it('reuses decoded canonical movement rows through repeated viewport requests without changing routes or passengers',async()=>{
    const {provider,context,viewport}=await movementFixture(),at=vi.spyOn(movementCodec,'movementContextAt');
    try{
      await provider.prepareViewport(context,undefined,viewport);
      const before=provider.getVisibleCandidates('baseline',2026,5000,{longitude:61.402,latitude:55.16,radiusMeters:2500,minutes:context.presentationMinutes}).map(p=>({profile:p,presence:provider.getPresence(p.id,context.presentationMinutes)}));
      const decoded=at.mock.calls.length;
      for(let i=0;i<3;i++)await provider.prepareViewport(context,undefined,{...viewport,revision:`wheel-${i}`});
      expect(at.mock.calls.length,'warm camera changes must not reconstruct verified person/target rows').toBe(decoded);
      const after=provider.getVisibleCandidates('baseline',2026,5000,{longitude:61.402,latitude:55.16,radiusMeters:2500,minutes:context.presentationMinutes}).map(p=>({profile:p,presence:provider.getPresence(p.id,context.presentationMinutes)}));
      expect(after).toEqual(before);
    }finally{at.mockRestore();}
  });
  it('reuses an exact schedule window but recomputes corridor membership for a changed viewport',async()=>{
    const {provider,context,viewport}=await movementFixture(),presence=vi.spyOn(MovementPresenceCache.prototype,'presence');
    try{
      await provider.prepareViewport(context,undefined,viewport);expect(provider.movementCoverage.retainedCandidates).toBeGreaterThan(0);presence.mockClear();
      await provider.prepareViewport(context,undefined,{...viewport,bbox:[61.399,55.1605,61.405,55.161],revision:'outside-road'});
      expect(provider.movementCoverage.retainedCandidates).toBe(0);
      expect(presence,'unchanged immutable schedule must not run again for a camera-only request').not.toHaveBeenCalled();
      await provider.prepareViewport({...context,presentationMinutes:context.presentationMinutes+1.5},undefined,viewport);
      expect(presence).toHaveBeenCalled();
    }finally{presence.mockRestore();}
  });
  it('evicts decoded pages under its byte budget and revalidates them on the next use',async()=>{
    const {provider,context,viewport,movement}=await movementFixture();
    const cache=provider as unknown as{movementPageCacheBudget:number;movementPageCacheBytes:number};
    cache.movementPageCacheBudget=Math.max(...movement.cells[0]!.pages.map(page=>page.bytes));
    const decode=vi.spyOn(movementCodec,'decodeMovementPage');
    try{
      await provider.prepareViewport(context,undefined,viewport);expect(decode).toHaveBeenCalledTimes(2);
      expect(cache.movementPageCacheBytes).toBeLessThanOrEqual(cache.movementPageCacheBudget);
      await provider.prepareViewport({...context,presentationMinutes:context.presentationMinutes+1.5},undefined,viewport);
      expect(decode).toHaveBeenCalledTimes(4);expect(cache.movementPageCacheBytes).toBeLessThanOrEqual(cache.movementPageCacheBudget);
    }finally{decode.mockRestore();}
  });
  it('does not admit corrupted bytes to the decoded cache or bypass verified transport checks on a warm key',async()=>{
    const {provider,context,viewport,asset}=await movementFixture();await provider.prepareViewport(context,undefined,viewport);
    const committed=provider.movementReadiness.committed;
    const internal=provider as unknown as{movementStore:VerifiedShardStore};internal.movementStore.clear();
    asset('spatial/movement/first.json',{corrupted:true});
    const decode=vi.spyOn(movementCodec,'decodeMovementPage');
    try{
      await expect(provider.prepareViewport({...context,presentationMinutes:context.presentationMinutes+1.5},undefined,viewport)).rejects.toThrow(/byte length|hash/i);
      expect(decode).not.toHaveBeenCalled();expect(provider.movementReadiness.committed).toEqual(committed);
    }finally{decode.mockRestore();}
  });
  it('checks cancellation after dependency pinning and never publishes an aborted generation',async()=>{
    const {provider,context,viewport}=await movementFixture();await provider.prepareViewport(context,undefined,viewport);
    const committed=provider.movementReadiness.committed,controller=new AbortController();
    const internal=provider as unknown as {pinDependencies:(...args:unknown[])=>unknown};
    const original=internal.pinDependencies.bind(provider);
    vi.spyOn(internal,'pinDependencies').mockImplementationOnce((...args)=>{const value=original(...args);controller.abort();return value;});
    await expect(provider.prepareViewport({...context,presentationMinutes:context.presentationMinutes+1.5},controller.signal,viewport)).rejects.toThrow();
    expect(provider.movementReadiness.committed).toEqual(committed);
  });
  it('pins prior verified origins omitted by a partial refresh without retaining its whole viewport',async()=>{
    const {provider,context,viewport}=await movementFixture();await provider.prepareViewport(context,undefined,viewport);
    type Dependencies={metadata:Map<number,unknown>;bindings:Map<number,[number|null,number|null]>;routes:Map<number,unknown>};
    type State={dependencies:Dependencies;[field:string]:unknown};
    const internal=provider as unknown as{visible:Map<number,State>;pinDependencies:(state:State,source:Dependencies,previous:Dependencies)=>Dependencies};
    const previous=internal.visible.get(0)!;
    const partial:Dependencies={metadata:new Map([[0,previous.dependencies.metadata.get(0)]]),bindings:new Map([[0,[0,1]]]),routes:new Map(previous.dependencies.routes)};
    const pinned=internal.pinDependencies({...previous,dependencies:partial},partial,previous.dependencies);
    expect(pinned.bindings.get(2)).toEqual(previous.dependencies.bindings.get(2));
    expect([...pinned.metadata.keys()].sort()).toEqual([0,2]);
    expect(pinned.routes.get(0)).toBe(previous.dependencies.routes.get(0));
  });
  it('uses opt-in preview bindings for both visible actors and prepared profiles without changing canonical identity',async()=>{
    const {provider,context,viewport,records}=await overlayFixture();await provider.prepareViewport(context,undefined,viewport);
    const id='demo2-p-0000000',presence=provider.getPresence(id,context.presentationMinutes)!;
    expect(presence).toMatchObject({state:'outdoor',roadId:'source-mode-v2:walk'});
    expect(presence.position![1]).toBeCloseTo(55.1602,10);
    expect(provider.getVisibleCandidates('baseline',2026,10,{longitude:61.402,latitude:55.16,radiusMeters:2000,minutes:context.presentationMinutes}).map(row=>row.id)).toEqual([id]);
    await provider.preparePerson(id,'baseline',2026);
    expect(provider.getPresence(id,context.presentationMinutes)).toEqual(presence);
    expect(provider.getPerson(id)).toEqual(profileFor(records[0]!,2026,'baseline',{householdSize:2,territoryId:'RU-CHE-SET-CEN',territoryName:'Центральный район'}));
    expect(provider.movementPreviewOverlay).toMatchObject({scope:'local_preview',chatCompatibility:'pending'});
    expect(provider.movementCoverage.recordsScanned).toBe(6);
  });
  it('preserves source person/household records, profiles and home/work/study assignments when the same overlay is publicly delivered',async()=>{
    const f=await overlayFixture(),baseline=new CityDemoProviderV2({...f.providerOptions,movement:f.movement});
    const publicPreview:MovementPreviewOverlay={...f.preview,activation:{contract:'CityMovementActivationV1',version:1,datasetId:DATASET_ID,presentation:'bounded_source_overlay',chatCompatibility:'pending',
      baseHashes:f.preview.manifest.baseHashes,manifest:{url:`https://storage.googleapis.com/omnitwin-demo-city-assets/packs/${'a'.repeat(64)}/movement-overlay-v2/manifest-${'b'.repeat(16)}.json`,bytes:1,sha256:'b'.repeat(64)}}};
    const publicProvider=new CityDemoProviderV2({...f.providerOptions,movement:f.movement,movementPreviewOverlay:publicPreview});
    type State={record:unknown;home:unknown;district:unknown;targets:unknown;householdRecords:unknown;householdSize:unknown};
    const state=(p:CityDemoProviderV2,i:number)=>{const row=(p as unknown as {prepared:Map<number,State>}).prepared.get(i)!;return {record:row.record,home:row.home,district:row.district,targets:row.targets,householdRecords:row.householdRecords,householdSize:row.householdSize};};
    for(const year of [2026,2027])for(const scenario of ['baseline','inflow','ageing'] as const)for(const index of [0,1,2]){
      const id=`demo2-p-${String(index).padStart(7,'0')}`;await baseline.preparePerson(id,scenario,year);await publicProvider.preparePerson(id,scenario,year);
      expect(publicProvider.getPerson(id)).toEqual(baseline.getPerson(id));expect(state(publicProvider,index)).toEqual(state(baseline,index));
    }
    expect(publicProvider.movementPreviewOverlay).toMatchObject({delivery:'public_pinned',scope:'local_preview',chatCompatibility:'pending'});
    expect(publicPreview.manifest).toBe(f.preview.manifest);
  });
  it('does not fall back to an old carriageway when preview explicitly has no walking binding',async()=>{
    const {provider,context,viewport}=await overlayFixture(true);await provider.prepareViewport(context,undefined,viewport);
    await provider.preparePerson('demo2-p-0000000','baseline',2026);
    expect(provider.getPresence('demo2-p-0000000',context.presentationMinutes)).toMatchObject({state:'unplaced',roadId:null});
    expect(provider.getVisibleCandidates('baseline',2026,10,{longitude:61.402,latitude:55.16,radiusMeters:2000,minutes:context.presentationMinutes})).toEqual([]);
  });
  it('rejects preview candidate totals in place of the canonical base population totals',async()=>{
    const {providerOptions,movement,preview}=await overlayFixture();
    expect(()=>new CityDemoProviderV2({...providerOptions,movement,movementPreviewOverlay:{...preview,manifest:{...preview.manifest,recordCount:1}}})).toThrow('Movement preview population size mismatch');
  });
  it('rejects a preview cell that overrides origins outside its verified global dictionary',async()=>{
    const {provider,context,viewport,preview,asset}=await overlayFixture();
    const changed={...preview.bindings,bindings:[...preview.bindings.bindings,[1,2_000_000,2_000_001]]};
    const descriptor=asset('spatial/movement/outside-origin.json',changed);
    preview.manifest.cells[0]!.context={...descriptor,url:'outside-origin.json'};
    await expect(provider.prepareViewport(context,undefined,viewport)).rejects.toThrow('Movement preview cell dictionary mismatch');
    expect(provider.movementReadiness.committed).toBeNull();
  });
  it('rejects per-cell preview geometry that disagrees with the global pinned binding asset',async()=>{
    const {provider,context,viewport,preview,asset}=await overlayFixture();
    const changed={...preview.bindings,roads:preview.bindings.roads.map(road=>({...road,coordinates:road.coordinates.map(([x,y])=>[x,y!+.01])}))};
    const descriptor=asset('spatial/movement/changed-route.json',changed);
    preview.manifest.cells[0]!.context={...descriptor,url:'changed-route.json'};
    await expect(provider.prepareViewport(context,undefined,viewport)).rejects.toThrow('Movement preview cell dictionary mismatch');
  });
  it('bounds accumulated pinned geometry and keeps the last generation on overflow',async()=>{
    const {provider,context,viewport}=await movementFixture();await provider.prepareViewport(context,undefined,viewport);
    const committed=provider.movementReadiness.committed;
    type Dependencies={metadata:Map<number,unknown>;bindings:Map<number,unknown>;routes:Map<number,unknown>};
    const internal=provider as unknown as {pinDependencies:(...args:unknown[])=>Dependencies},original=internal.pinDependencies.bind(provider);
    vi.spyOn(internal,'pinDependencies').mockImplementationOnce((...args)=>{
      const value=original(...args),road=value.routes.get(0);for(let i=2;i<8193;i++)value.routes.set(i,road);return value;
    });
    await expect(provider.prepareViewport({...context,presentationMinutes:context.presentationMinutes+1.5},undefined,viewport)).rejects.toThrow('Movement retained dependency budget exceeded');
    expect(provider.movementReadiness.committed).toEqual(committed);
  });
  it('loads only geography in general plan and clears near actors without clearing selected profiles',async()=>{
    const {provider,context,viewport,requests}=await movementFixture();await provider.prepareViewport(context,undefined,viewport);
    await provider.preparePerson('demo2-p-0000000','baseline',2026);const selected=provider.getPerson('demo2-p-0000000');
    const requestCount=requests.length;const camera={...context.camera,zoom:14};
    await provider.prepareViewport({...context,camera},undefined,{...viewport,camera,revision:'general-plan'});
    expect(requests.length).toBe(requestCount);expect(provider.getVisibleCandidates()).toEqual([]);
    expect(provider.getPerson('demo2-p-0000000')).toEqual(selected);
    expect(provider.movementCoverage).toMatchObject({status:'ready',reason:'aggregate_only',pagesScanned:0,recordsScanned:0,decodedBytes:0});
  });
  it('committed actors retain their verified road dependencies when unrelated cache entries are evicted',async()=>{
    const {provider,context,viewport}=await movementFixture();await provider.prepareViewport(context,undefined,viewport);
    const before=provider.getPresence('demo2-p-0000000',context.presentationMinutes);
    expect(['outdoor','vehicle']).toContain(before?.state);
    const caches=provider as unknown as{routes:Map<number,unknown>;bindings:Map<number,unknown>;metadata:Map<number,unknown>};
    caches.routes.clear();caches.bindings.clear();caches.metadata.clear();
    expect(provider.getPresence('demo2-p-0000000',context.presentationMinutes)).toEqual(before);
    expect(provider.getLayout().roads.some(road=>road.id===before?.roadId)).toBe(true);
  });
  it('rejects a pinned manifest mismatch before any companion or legacy request', async () => {
    const request = vi.fn(async () => new Response('{}', { status: 200 })); vi.stubGlobal('fetch', request);
    try { await expect(CityDemoProviderV2.loadCity('https://cdn.fixture.test/assets/', undefined, { applicationBaseURL: 'https://app.fixture.test/demo/', populationManifestSha256: '0'.repeat(64) })).rejects.toThrow('Population manifest pin mismatch'); expect(request).toHaveBeenCalledTimes(1); }
    finally { vi.unstubAllGlobals(); }
  });
});
