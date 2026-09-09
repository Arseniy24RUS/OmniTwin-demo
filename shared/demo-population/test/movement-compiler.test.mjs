import assert from 'node:assert/strict';
import test from 'node:test';
import { cellsForCorridor, compileMovementIndex } from '../../../tools/build-city-movement-index-v2.mjs';
import { spatialCellKey, encodeRoleShard, SPATIAL_NONE } from '../spatial.mjs';
import { DATASET_ID, encodePersonShard } from '../index.mjs';
import { decodeMovementPage, movementContextAt, decodeMovementCellContext } from '../movement-index.mjs';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

test('route index covers crossed cells and not just the assigned building position', () => {
  const route = { coordinates: [[61.40, 55.16], [61.415, 55.16]] };
  const cells = cellsForCorridor(route);
  assert.ok(cells.size > 2);
  for (let i = 0; i <= 100; i++) assert.ok(cells.has(spatialCellKey(61.40 + 0.015 * i / 100, 55.16)));
  assert.deepEqual([...cells].sort(), [...cellsForCorridor({ coordinates: [...route.coordinates].reverse() })].sort());
});

test('route-cell traversal preserves vertical, corner and zero-length positions', () => {
  for (const coordinates of [[[61.4, 55.15], [61.4, 55.17]], [[61.4, 55.16], [61.4, 55.16]], [[61.4, 55.16], [61.415, 55.17]]]) {
    const cells = cellsForCorridor({ coordinates });
    for (let i = 0; i <= 100; i++) assert.ok(cells.has(spatialCellKey(coordinates[0][0] + (coordinates[1][0] - coordinates[0][0]) * i / 100, coordinates[0][1] + (coordinates[1][1] - coordinates[0][1]) * i / 100)));
  }
});

test('additive compiler deduplicates complete route-cell memberships and retains full households', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'omnitwin-movement-test-')); t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'); const directory = join(temporary, 'spatial'); await mkdir(directory);
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const put = async (url, value) => { const bytes = Buffer.from(value); await writeFile(join(directory, url), bytes); return { url, bytes: bytes.length, sha256: hash(bytes) }; };
  const buildings = [['h0', 61.401, 55.16, 'RU-CHE-SET-CEN', 'residential'], ['h1', 61.403, 55.16, 'RU-CHE-SET-CEN', 'residential'], ['w', 61.406, 55.16, 'RU-CHE-SET-CEN', 'work'], ['s', 61.409, 55.16, 'RU-CHE-SET-CEN', 'study']];
  const buildingIndex = await put('buildings.json', JSON.stringify({ rows: buildings }));
  const population = await put('population.json', JSON.stringify({ recordCount: 3, householdCount: 2 }));
  const geography = await put('geography.json', JSON.stringify({ buildingIndex: { ...buildingIndex, count: 4 } }));
  const sourceHashes = { populationManifest: population.sha256, geographyManifest: geography.sha256, buildingIndex: buildingIndex.sha256 };
  for (const [field, path] of [['populationCodec', 'shared/demo-population/index.mjs'], ['spatialCodec', 'shared/demo-population/spatial.mjs'], ['routeCorridorCodec', 'shared/demo-population/route-corridors.mjs']]) sourceHashes[field] = hash(await readFile(join(root, path)));
  const raw = encodePersonShard(0, [0, 0, 1].map((householdIndex, i) => ({ householdIndex, birthYear: i === 1 ? 2016 : 1990, sex: 'female', entryYear: 2026, scenarioMask: 7 }))).subarray(32);
  const personRows = [[0, 2, SPATIAL_NONE, 2], [0, SPATIAL_NONE, 3, 2], [1, 2, SPATIAL_NONE, 2]];
  const roleRows = [[0, 1], [], [], [], [2], [], [], [], [], [0, 2], [], [0, 1, 2], [], [], [1], []];
  const members = roleRows.flat(); const offsets = new Uint32Array(17); for (let i = 0; i < 16; i++) offsets[i + 1] = offsets[i] + roleRows[i].length;
  const roles = await put('roles.bin', encodeRoleShard(0, 4, offsets, new Uint32Array(members), 3));
  const details = new Uint8Array(members.length * 36); const view = new DataView(details.buffer);
  members.forEach((person, ordinal) => { const at = ordinal * 36; view.setUint32(at, person, true); details.set(raw.subarray(person * 16, person * 16 + 16), at + 4); personRows[person].forEach((b, i) => view.setUint32(at + 20 + i * 4, b, true)); });
  const contexts = await put('contexts.bin', details);
  const corridor = (index, mode) => ({ index, sourceRoadIndex: 0, mode, id: `corridor:${mode}`, coordinates: [[61.4, 55.16], [61.415, 55.16]], oneway: false, walkable: true, drivable: true, connectivity: 'source_node_ids', semantics: 'connected_source_road_local_visual_synthesis_not_home_work_route', segments: [{ fromNodeId: 'a', toNodeId: 'b' }] });
  const bindings = await put('bindings.json', JSON.stringify({ contract: 'DemoHomeRoadBindingsV2', firstIndex: 0, count: 4, bindings: buildings.map((_, i) => [i, 0, 1]), roads: [corridor(0, 'walk'), corridor(1, 'car')] }));
  const initial = { contract: 'DemoSpatialManifestV2', datasetId: DATASET_ID, representation: 'visual_synthesis', recordCount: 3, householdCount: 2, buildingCount: 4, sourceHashes, bindingShards: [{ ...bindings, firstIndex: 0, count: 4 }], roleShards: [{ ...roles, firstIndex: 0, count: 4, members: members.length, contexts }] };
  const spatial = await put('manifest.json', JSON.stringify(initial)); const options = { root, spatialManifest: join(directory, spatial.url), populationManifest: join(directory, population.url), geographyManifest: join(directory, geography.url), pageSize: 2 };
  const first = await compileMovementIndex(options); const parent = JSON.parse(await readFile(options.spatialManifest)); const manifest = JSON.parse(await readFile(join(directory, parent.movementIndex.url)));
  assert.ok(manifest.stats.expandedAssociations > manifest.stats.uniqueAssociations); assert.equal(manifest.stats.uniqueAssociations, manifest.cells.length * 3); assert.equal(first.published, true);
  for (const cell of manifest.cells) {
    const base = join(directory, 'movement'); const context = decodeMovementCellContext(await readFile(join(base, cell.context.url))); assert.equal(context.bindings.length, 4); assert.equal(context.roads.length, 2);
    const ids = []; for (const page of cell.pages) { const decoded = decodeMovementPage(await readFile(join(base, page.url))); assert.ok(decoded.count <= 2); for (let i = 0; i < decoded.count; i++) { const row = movementContextAt(decoded, i); ids.push(row.record.personIndex); assert.equal(row.householdRecords.length, row.record.householdIndex ? 1 : 2); } }
    assert.deepEqual(ids, [0, 1, 2]);
  }
  const repeat = await compileMovementIndex(options); assert.equal(repeat.movementManifest.sha256, first.movementManifest.sha256); assert.equal(repeat.spatialManifestSha256, first.spatialManifestSha256);
});
