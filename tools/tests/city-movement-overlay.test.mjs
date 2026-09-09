import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { preflightMovementOverlay, compileMovementOverlay } from '../build-city-movement-overlay-v2.mjs';
import { DATASET_ID, encodePersonShard, encodeHouseholdShard } from '../../shared/demo-population/index.mjs';
import { encodeRoleShard, spatialCellKey, SPATIAL_NONE as NONE } from '../../shared/demo-population/spatial.mjs';
import { decodeMovementCellContext, decodeMovementPage, movementContextAt } from '../../shared/demo-population/movement-index.mjs';
import { localBoundsToGeographic } from '../visual/geometry.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const origin = [61.39466, 55.1654];
const geo = ([e, n]) => localBoundsToGeographic([e, n, e, n], origin).slice(0, 2);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'omnitwin-overlay-test-'));
  t.after(async () => { assert.equal(dirname(root), tmpdir()); assert.ok(root.split(/[\\/]/).at(-1).startsWith('omnitwin-overlay-test-')); await rm(root, { recursive: true, force: true }); });
  const base = join(root, 'source'); await mkdir(base);
  const put = async (url, value) => { const bytes = value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(JSON.stringify(value)); await writeFile(join(base, url), bytes); return { url, bytes: bytes.length, sha256: hash(bytes) }; };
  const records = [0, 0, 1, 2].map((householdIndex, i) => ({ householdIndex, birthYear: i === 1 ? 2016 : 1990, sex: 'female', entryYear: 2026, scenarioMask: 7 }));
  const personBytes = encodePersonShard(0, records), people = await put('people.bin', personBytes);
  const hh = await put('households.bin', encodeHouseholdShard(0, [{ homeBuildingIndex: 0, districtIndex: 0, members: [0, 1] }, { homeBuildingIndex: 2, districtIndex: 0, members: [2] }, { homeBuildingIndex: 0, districtIndex: 0, members: [3] }]));
  const buildings = [[0, [1000, 0], 'residential'], [1, [0, 0], 'work'], [2, [50, 0], 'residential'], [3, [-1000, 0], 'study'], [4, [-30, 20], 'unknown']].map(([i, p, use]) => [`building-${i}`, ...geo(p), 'RU-CHE-SET-CEN', use]);
  const buildingIndex = await put('building-index.json', { contract: 'DemoBuildingIndexV2', rows: buildings });
  const road = (id, north, className, drivable) => ({ id, coordinates: [-400, -100, 100, 400].map(e => geo([e, north])), nodeIds: [0, 1, 2, 3].map(n => `${id}:n${n}`), oneway: false, walkable: true, drivable, className, bridge: false, tunnel: false, layer: 0 });
  const roads = [road('source-footway', 5, 'footway', false), road('source-carriageway', -25, 'secondary', true)];
  const key = spatialCellKey(...origin), bbox = localBoundsToGeographic([-1500, -1500, 1500, 1500], origin);
  const cell = await put('cell.json', { contract: 'DemoCityCellV2', key, bbox, buildings: [], roads });
  const geography = await put('geography.json', { contract: 'DemoCityPackManifestV2', datasetVersion: 'fixture', cellZoom: 16, bounds: bbox, buildingIndex: { ...buildingIndex, count: buildings.length }, cells: [{ ...cell, key, bbox, roadCount: 2, buildingCount: 0 }] });
  const population = await put('population.json', { contract: 'DemoPopulationManifestV2', datasetId: DATASET_ID, representation: 'fictional_demo', scientificClaim: false, recordCount: 4, householdCount: 3, personShards: [{ ...people, startIndex: 0, count: 4 }], householdShards: [{ ...hh, startIndex: 0, count: 3 }] });
  const targets = [[0, 1, NONE, 1], [0, NONE, 3, NONE], [2, 1, NONE, 0], [0, NONE, NONE, 0]];
  const roleRows = Array.from({ length: buildings.length * 4 }, () => []);
  targets.forEach((values, person) => values.forEach((b, role) => { if (b !== NONE) roleRows[b * 4 + role].push(person); }));
  const members = roleRows.flat(), offsets = new Uint32Array(roleRows.length + 1); roleRows.forEach((rows, i) => { offsets[i + 1] = offsets[i] + rows.length; });
  const roles = await put('roles.bin', encodeRoleShard(0, buildings.length, offsets, new Uint32Array(members), 4));
  const contexts = new Uint8Array(members.length * 36), view = new DataView(contexts.buffer);
  members.forEach((person, ordinal) => { const at = ordinal * 36; view.setUint32(at, person, true); contexts.set(personBytes.subarray(32 + person * 16, 48 + person * 16), at + 4); targets[person].forEach((b, i) => view.setUint32(at + 20 + i * 4, b, true)); });
  const details = await put('contexts.bin', contexts);
  const sourceHashes = { populationManifest: population.sha256, geographyManifest: geography.sha256, buildingIndex: buildingIndex.sha256 };
  for (const [field, file] of [['populationCodec', 'index.mjs'], ['spatialCodec', 'spatial.mjs']]) sourceHashes[field] = hash(await readFile(join(REPO, 'shared/demo-population', file)));
  const spatial = await put('spatial.json', { contract: 'DemoSpatialManifestV2', datasetId: DATASET_ID, representation: 'visual_synthesis', scientificClaim: false, recordCount: 4, householdCount: 3, buildingCount: 5, sourceHashes, roleShards: [{ ...roles, firstIndex: 0, count: 5, members: members.length, contexts: { ...details, recordBytes: 36 } }] });
  return { root, base, put, options: { root, spatialManifest: join(base, spatial.url), populationManifest: join(base, population.url), geographyManifest: join(base, geography.url), origin, coreRadiusMeters: 100, guardRadiusMeters: 1500, pageSize: 1 }, contexts, targets };
}

test('preflight is read-only, pins bases, includes every core-associated person and estimates bounded assets', async t => {
  const f = await fixture(t), before = await readFile(f.options.spatialManifest);
  const plan = await preflightMovementOverlay(f.options);
  assert.deepEqual(plan.coveredBuildingIndices, [1, 2]); assert.equal(plan.stats.uniqueCandidates, 2);
  assert.equal(plan.stats.households, 2); assert.equal(plan.stats.householdMembers, 3);
  assert.equal(plan.baseHashes.spatial, hash(before)); assert.ok(plan.estimatedRawOutputBytes > 0);
  assert.ok(plan.withinLimits); assert.deepEqual(await readFile(f.options.spatialManifest), before);
  await assert.rejects(readFile(join(f.root, '.cache/movement-mode-v2/manifest.json')), { code: 'ENOENT' });
});

test('overlay preserves canonical contexts/full households, both modes, and every corridor-cell membership', async t => {
  const f = await fixture(t), plan = await preflightMovementOverlay(f.options);
  const before = await Promise.all([f.options.spatialManifest, f.options.populationManifest, f.options.geographyManifest].map(p => readFile(p)));
  const result = await compileMovementOverlay({ ...f.options, expectedBaseHashes: plan.baseHashes });
  const { manifest } = result, output = dirname(result.manifestPath);
  assert.equal(manifest.contract, 'DemoMovementOverlayV2'); assert.equal(manifest.scope, 'local_preview'); assert.equal(manifest.chatCompatibility, 'pending');
  assert.deepEqual(manifest.coveredBuildingIndices, [1, 2]); assert.equal(manifest.indexNamespace.sourceRoadIndexBase, 1000000);
  const binding = decodeMovementCellContext(await readFile(join(output, manifest.bindings.url)));
  assert.deepEqual(binding.bindings.map(row => row[0]), [1, 2]);
  for (const road of binding.roads) { assert.ok(road.sourceRoadIndex >= 1000000); assert.equal(road.index, road.sourceRoadIndex * 2 + Number(road.mode === 'car')); assert.ok(road.id.startsWith('source-mode-v2:')); }
  for (const cell of manifest.cells) {
    const members = [];
    assert.equal(cell.count, cell.pages.reduce((sum, p) => sum + p.count, 0));
    decodeMovementCellContext(await readFile(join(output, cell.context.url)));
    for (const descriptor of cell.pages) {
      const bytes = await readFile(join(output, descriptor.url)); assert.equal(hash(bytes), descriptor.sha256);
      const page = decodeMovementPage(bytes);
      for (let i = 0; i < page.count; i++) { const row = movementContextAt(page, i); members.push(row.record.personIndex); assert.deepEqual(row.householdRecords.map(p => p.personIndex), row.record.personIndex === 0 ? [0, 1] : [2]); assert.equal(row.homeBuildingIndex, f.targets[row.record.personIndex][0]); }
    }
    assert.deepEqual(members, [0, 2]);
  }
  assert.deepEqual(await Promise.all([f.options.spatialManifest, f.options.populationManifest, f.options.geographyManifest].map(p => readFile(p))), before);
  const again = await compileMovementOverlay({ ...f.options, expectedBaseHashes: plan.baseHashes });
  assert.equal(again.manifestDescriptor.sha256, result.manifestDescriptor.sha256);
});

test('changed source pins, bad source hash, and candidate overflow abort instead of truncating', async t => {
  const f = await fixture(t), plan = await preflightMovementOverlay(f.options);
  await assert.rejects(compileMovementOverlay({ ...f.options, expectedBaseHashes: { ...plan.baseHashes, spatial: '0'.repeat(64) } }), /pin|changed/i);
  await assert.rejects(preflightMovementOverlay({ ...f.options, maxCandidates: 1 }), /candidate.*limit/i);
  await writeFile(join(f.base, 'cell.json'), '{}');
  await assert.rejects(preflightMovementOverlay(f.options), /hash|length/i);
});

test('output may never target source/public directories and page limits stay codec-compatible', async t => {
  const f = await fixture(t);
  await assert.rejects(compileMovementOverlay({ ...f.options, output: f.base }), /output.*cache/i);
  await assert.rejects(preflightMovementOverlay({ ...f.options, pageSize: 8193 }), /page/i);
});
