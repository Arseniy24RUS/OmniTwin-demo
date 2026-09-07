import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as codec from '../../../shared/demo-population/index.mjs';
import * as spatial from '../../../shared/demo-population/spatial.mjs';
import { createPopulationResolver, POPULATION_LIMITS } from '../src/population-resolver.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const base = 'https://example.github.io/OmniTwin-demo/demo-v2/';
const codecHashes = { populationCodec: 'a'.repeat(64), spatialCodec: 'b'.repeat(64) };
const request = { datasetId: codec.DATASET_ID, personId: codec.personId(0), scenario: 'baseline', year: 2026, presentationMinutes: 600 };
export function fixture(change = () => {}) {
  const files = new Map(); const calls = [];
  const records = [0, 1].map(personIndex => ({ personIndex, householdIndex: 0, birthYear: 1990 + personIndex, sex: personIndex ? 'male' : 'female', householdRole: personIndex ? 'partner' : 'head', entryYear: 2026, scenarioMask: 7, exitYears: personIndex ? [2030, null, 2031] : [null, null, null], exitReasons: personIndex ? ['death', null, 'death'] : [null, null, null] }));
  const add = (url, bytes, more = {}) => { files.set(new URL(url, base).href, bytes); return { url, sha256: hash(bytes), bytes: bytes.length, ...more }; };
  const population = { contract: 'DemoPopulationManifestV2', datasetId: codec.DATASET_ID, representation: 'fictional_demo', scientificClaim: false, predictiveValidation: false, startYear: 2026, endYear: 2036, recordCount: 2, householdCount: 1, personShardSize: codec.PERSON_SHARD_SIZE, householdShardSize: codec.HOUSEHOLD_SHARD_SIZE, personShards: [add('people/p.bin', codec.encodePersonShard(0, records), { startIndex: 0, count: 2 })], householdShards: [add('households/h.bin', codec.encodeHouseholdShard(0, [{ homeBuildingIndex: 4, districtIndex: 0, members: [0, 1] }]), { startIndex: 0, count: 1 })], territories: [{ id: 'RU-CHE-SET', name: 'Челябинск' }, { id: codec.DISTRICT_IDS[0], name: 'Центральный район' }], provenance: { sourceHashes: { codec: codecHashes.populationCodec } }, spatial: { buildingIndex: { count: 20, sha256: 'c'.repeat(64) }, geographyManifestSha256: 'd'.repeat(64) } };
  const targets = add('spatial/targets/t.bin', spatial.encodeTargetShard(0, new Uint32Array([17, spatial.SPATIAL_NONE, 18, 17, spatial.SPATIAL_NONE, 18]), 20), { startIndex: 0, count: 2 });
  targets.url = 'targets/t.bin';
  const assignments = { contract: 'DemoSpatialManifestV2', datasetId: codec.DATASET_ID, representation: 'visual_synthesis', recordCount: 2, buildingCount: 20, targetShardSize: codec.PERSON_SHARD_SIZE, targetShards: [targets], sourceHashes: { ...codecHashes, geographyManifest: 'd'.repeat(64), buildingIndex: 'c'.repeat(64) } };
  change({ files, records, population, assignments });
  const populationBytes = Buffer.from(JSON.stringify(population));
  assignments.sourceHashes.populationManifest ??= hash(populationBytes);
  const spatialBytes = Buffer.from(JSON.stringify(assignments));
  files.set(`${base}manifest.json`, populationBytes); files.set(`${base}spatial/manifest.json`, spatialBytes);
  const options = { populationUrl: `${base}manifest.json`, populationHash: hash(populationBytes), spatialUrl: `${base}spatial/manifest.json`, spatialHash: hash(spatialBytes), codec, spatial, codecHashes, fetchImpl: async (url, init) => { calls.push(String(url)); assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.ok(init.signal instanceof AbortSignal); const bytes = files.get(String(url)); return new Response(bytes ?? '', { status: bytes ? 200 : 404 }); } };
  return { files, calls, options, population, assignments };
}

test('V2 canonical profile equals shared frontend profile and household is scenario/year active', async () => {
  const f = fixture(); const resolve = createPopulationResolver(f.options);
  assert.equal(f.calls.length, 0);
  const result = await resolve(request);
  const record = codec.recordAt(codec.decodePersonShard(f.files.get(`${base}people/p.bin`)), 0);
  assert.deepEqual(result.profile, codec.profileFor(record, 2026, 'baseline', { householdSize: 2, territoryId: codec.DISTRICT_IDS[0], territoryName: 'Центральный район' }));
  assert.deepEqual(result.presence, { ...spatial.presenceFor(record, { workBuildingIndex: 17, studyBuildingIndex: null, visitorBuildingIndex: 18 }, 4, 2026, 'baseline', 600), representation: 'visual_synthesis' });
  assert.match(result.profileHash, /^[a-f0-9]{64}$/); assert.equal(f.calls.length, 5);
  assert.equal((await resolve({ ...request, year: 2031 })).profile.householdSize, 1);
  assert.equal((await resolve({ ...request, year: 2031, scenario: 'inflow' })).profile.householdSize, 2);
  assert.equal(await resolve({ ...request, personId: codec.personId(1), year: 2031 }), null);
  assert.equal(f.calls.length, 5, 'verified shards reused without profile cache or household census');
  const householdRecords = [0, 1].map(index => codec.recordAt(codec.decodePersonShard(f.files.get(`${base}people/p.bin`)), index));
  const evening = await resolve({ ...request, presentationMinutes: 1230 });
  assert.deepEqual(evening.presence, { ...spatial.presenceFor(record, { workBuildingIndex: 17, studyBuildingIndex: null, visitorBuildingIndex: 18 }, 4, 2026, 'baseline', 1230, { householdRecords }), representation: 'visual_synthesis' });
});

test('malformed IDs/context never fetch and out-of-range/inactive IDs never resolve', async () => {
  const f = fixture(); const resolve = createPopulationResolver(f.options);
  for (const patch of [{ personId: 'demo2-p-1' }, { personId: 'demo2-p-0000001/../' }, { datasetId: 'observed' }, { scenario: '__proto__' }, { year: 2025 }, { presentationMinutes: -1 }]) assert.equal(await resolve({ ...request, ...patch }), null);
  assert.equal(f.calls.length, 0);
  assert.equal(await resolve({ ...request, personId: 'demo2-p-9999999' }), null);
  assert.equal(f.calls.length, 2);
});

test('both pinned manifests, codec lineage and spatial population binding fail closed', async () => {
  for (const patch of [{ populationHash: '0'.repeat(64) }, { spatialHash: '0'.repeat(64) }, { codecHashes: { ...codecHashes, spatialCodec: '0'.repeat(64) } }]) {
    const f = fixture(); await assert.rejects(createPopulationResolver({ ...f.options, ...patch })(request));
  }
  const f = fixture(({ assignments }) => { assignments.sourceHashes.populationManifest = '0'.repeat(64); });
  await assert.rejects(createPopulationResolver(f.options)(request));
  for (const value of [undefined, 'not-a-digest']) {
    const missing = fixture(({ population, assignments }) => {
      population.spatial.geographyManifestSha256 = value; population.spatial.buildingIndex.sha256 = value;
      assignments.sourceHashes.geographyManifest = value; assignments.sourceHashes.buildingIndex = value;
    });
    await assert.rejects(createPopulationResolver(missing.options)(request));
  }
});

test('every binary shard digest, header range and household reverse membership is verified', async () => {
  for (const suffix of ['people/p.bin', 'households/h.bin', 'spatial/targets/t.bin']) {
    const f = fixture(); f.files.set(`${base}${suffix}`, new Uint8Array(f.files.get(`${base}${suffix}`).length));
    await assert.rejects(createPopulationResolver(f.options)(request));
  }
  const f = fixture(({ files, population }) => {
    const bytes = codec.encodeHouseholdShard(0, [{ homeBuildingIndex: 4, districtIndex: 0, members: [1] }]);
    files.set(`${base}households/h.bin`, bytes); Object.assign(population.householdShards[0], { bytes: bytes.length, sha256: hash(bytes) });
  });
  await assert.rejects(createPopulationResolver(f.options)(request));
});

test('absolute/external/traversal asset URLs and overlapping or oversized shard tables are rejected', async () => {
  for (const url of ['https://attacker.example/p.bin', '../outside.bin', '//attacker.example/p.bin', '%2e%2e/p.bin', 'people\\p.bin']) {
    const f = fixture(({ population }) => { population.personShards[0].url = url; });
    await assert.rejects(createPopulationResolver(f.options)(request));
    assert.ok(f.calls.every(url => url.startsWith(base)));
  }
  for (const mutate of [p => p.personShards.push(p.personShards[0]), p => p.personShards[0].startIndex = 1, p => p.householdShards[0].bytes = 99_000_000, p => p.recordCount = 10_000_001]) {
    const f = fixture(({ population }) => mutate(population)); await assert.rejects(createPopulationResolver(f.options)(request));
  }
});

test('response stream size, request download budget, cache LRU and concurrent resolutions are bounded', async () => {
  const f = fixture(); const small = createPopulationResolver({ ...f.options, limits: { maxRequestAssets: 2 } });
  await assert.rejects(small(request), /budget/i);
  const evict = fixture(); const resolve = createPopulationResolver({ ...evict.options, limits: { maxCacheEntries: 1 } });
  await resolve(request); const first = evict.calls.length; await resolve(request);
  assert.ok(evict.calls.length > first, 'a one-entry LRU refetches evicted verified shards');
  const huge = fixture(); huge.options.fetchImpl = async () => new Response(new Uint8Array(POPULATION_LIMITS.maxManifestBytes + 1));
  await assert.rejects(createPopulationResolver(huge.options)(request), /size|large|budget/i);
  const concurrent = fixture(); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fetcher = concurrent.options.fetchImpl;
  const bounded = createPopulationResolver({ ...concurrent.options, limits: { maxConcurrent: 1 }, fetchImpl: async (...args) => { await gate; return fetcher(...args); } });
  const pending = bounded(request); await assert.rejects(bounded(request), /busy/i); release(); await pending;
  const byteBudget = fixture(); await assert.rejects(createPopulationResolver({ ...byteBudget.options, limits: { maxRequestBytes: 32 } })(request), /budget/);
  const noRetention = fixture(); const tinyCache = createPopulationResolver({ ...noRetention.options, limits: { maxCacheBytes: 32 } });
  await tinyCache(request); const firstRead = noRetention.calls.length; await tinyCache(request); assert.ok(noRetention.calls.length > firstRead);
  assert.throws(() => createPopulationResolver({ ...fixture().options, limits: { maxCacheBytes: POPULATION_LIMITS.maxCacheBytes + 1 } }));
});

test('matching SHA cannot override binary header ranges or reverse household membership', async () => {
  for (const mutate of [
    (records) => codec.encodePersonShard(1, records),
    (records) => codec.encodePersonShard(0, [records[0], { ...records[1], householdIndex: 1 }]),
  ]) {
    const malformed = fixture(({ files, records, population }) => {
      const bytes = mutate(records); files.set(`${base}people/p.bin`, bytes);
      Object.assign(population.personShards[0], { bytes: bytes.length, sha256: hash(bytes) });
    });
    await assert.rejects(createPopulationResolver(malformed.options)(request), /range|reverse/);
  }
});

test('failed hashes are not retained and an aborted response stream releases the resolver slot', async () => {
  const f = fixture(); const resolve = createPopulationResolver(f.options); const path = `${base}spatial/targets/t.bin`; const correct = f.files.get(path);
  f.files.set(path, new Uint8Array(correct.length)); await assert.rejects(resolve(request), /digest/);
  f.files.set(path, correct); assert.equal((await resolve(request)).profile.id, request.personId);
  let aborted = false;
  const timed = fixture(); const fetcher = timed.options.fetchImpl;
  const timeout = createPopulationResolver({ ...timed.options, limits: { timeoutMs: 5, maxConcurrent: 1 }, fetchImpl: async (url, init) => {
    if (aborted) return fetcher(url, init);
    return new Response(new ReadableStream({ start(controller) { init.signal.addEventListener('abort', () => { aborted = true; controller.error(new Error('Expired fixture stream.')); }, { once: true }); } }));
  } });
  await assert.rejects(timeout(request), /Expired/); assert.equal(aborted, true);
  assert.equal((await timeout(request)).profile.id, request.personId);
});

test('transport compression length does not replace the pinned decoded shard byte length', async () => {
  const f = fixture();
  const resolve = createPopulationResolver({ ...f.options, fetchImpl: async url => new Response(f.files.get(String(url)), { headers: { 'content-encoding': 'gzip', 'content-length': '20' } }) });
  assert.equal((await resolve(request)).profile.id, request.personId);
  const incorrect = createPopulationResolver({ ...f.options, fetchImpl: async () => new Response(new Uint8Array(20), { headers: { 'content-encoding': 'gzip', 'content-length': '20' } }) });
  await assert.rejects(incorrect(request), /digest|size/);
});
