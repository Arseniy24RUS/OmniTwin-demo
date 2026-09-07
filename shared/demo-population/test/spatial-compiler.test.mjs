import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileSpatial, nearestRoadBindings } from '../../../tools/build-city-spatial-v2.mjs';
import { DATASET_ID, encodePersonShard, encodeHouseholdShard } from '../index.mjs';
import { SPATIAL_NONE, decodeRoleShard, roleMembers, decodeTargetShard, targetAt, decodeRosterContexts, rosterContextAt, decodeHouseholdTripMasks } from '../spatial.mjs';

const district = 'RU-CHE-SET-CEN';
const rows = [
  ['home', 61.4026, 55.1644, district, 'residential', 100, 2, 6, 200, 'source', []],
  ['work', 61.404, 55.1644, district, 'work', 500, 2, 6, 1000, 'source', []],
  ['study', 61.405, 55.1644, district, 'study', 200, 2, 6, 400, 'source', []],
  ['unknown', 61.405, 55.1644, district, 'unknown', 99999, 20, 60, 99999, 'unknown', []],
];
const roads = [{ id: 'osm-road:2', coordinates: [[61.40, 55.1644], [61.41, 55.1644]], nodeIds: ['osm-node:1', 'osm-node:2'], oneway: true, walkable: true, drivable: false }, { id: 'osm-road:1', coordinates: [[61.40, 55.1644], [61.41, 55.1644]], nodeIds: ['osm-node:1', 'osm-node:2'], oneway: true, walkable: false, drivable: true }];

test('nearest bindings are source-eligible, deterministic under order changes, and bounded', () => {
  const needed = new Uint8Array([1, 0, 0, 0]); const first = nearestRoadBindings(rows, roads, needed);
  assert.deepEqual([...first.bindings.slice(0, 2)], [0, 1]); assert.equal(first.bindings[2], SPATIAL_NONE);
  const reversed = nearestRoadBindings(rows, [...roads].reverse(), needed);
  assert.equal(roads[first.bindings[0]].id, [...roads].reverse()[reversed.bindings[0]].id);
  const far = nearestRoadBindings([[...rows[0].slice(0, 1), 62, 56, ...rows[0].slice(3)]], roads, new Uint8Array([1]));
  assert.deepEqual([...far.bindings], [SPATIAL_NONE, SPATIAL_NONE]);
});

test('offline compiler preserves all role members and self-contained candidates reproducibly', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'omnitwin-spatial-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const popDir = join(temporary, 'population'); const geoDir = join(temporary, 'geography');
  await mkdir(popDir); await mkdir(geoDir);
  const put = async (directory, url, value) => { const bytes = Buffer.from(value); await writeFile(join(directory, url), bytes); return { url, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; };
  const records = Array.from({ length: 6 }, (_, i) => ({ householdIndex: i < 3 ? 0 : 1, birthYear: i === 2 ? 2015 : 1990, sex: i % 2 ? 'female' : 'male', scenarioMask: 7, entryYear: 2026, exitYears: [null, null, null], exitReasons: [null, null, null] }));
  const people = await put(popDir, 'people.bin', encodePersonShard(0, records));
  const households = await put(popDir, 'households.bin', encodeHouseholdShard(0, [{ homeBuildingIndex: 0, districtIndex: 0, members: [0, 1, 2] }, { homeBuildingIndex: null, districtIndex: null, members: [3, 4, 5] }]));
  const buildingIndex = await put(geoDir, 'buildings.json', JSON.stringify({ columns: ['id', 'lon', 'lat', 'districtId', 'use', 'areaM2', 'levels', 'heightM', 'capacityWeight', 'classificationProvenance', 'aliases'], rows }));
  const roadIndex = await put(geoDir, 'roads.json', JSON.stringify({ contract: 'DemoRoadIndexV2', roads }));
  const metadata = await put(geoDir, 'metadata.json', JSON.stringify({ contract: 'DemoBuildingPageV2', firstIndex: 0, buildings: rows.map((row, index) => ({ index, id: row[0], use: row[4], sourceAttributes: index === 1 ? { building: 'retail', shop: 'mall' } : {} })) }));
  const populationManifest = join(popDir, 'manifest.json'); const geographyManifest = join(geoDir, 'manifest.json');
  await writeFile(populationManifest, JSON.stringify({ contract: 'DemoPopulationManifestV2', datasetId: DATASET_ID, representation: 'fictional_demo', scientificClaim: false, recordCount: 6, householdCount: 2, personShards: [{ ...people, startIndex: 0, count: 6 }], householdShards: [{ ...households, startIndex: 0, count: 2 }], spatial: { buildingIndex } }));
  await writeFile(geographyManifest, JSON.stringify({ contract: 'DemoCityPackManifestV2', buildingIndex: { ...buildingIndex, count: 4 }, roadIndex: { ...roadIndex, count: 2 }, buildingPages: [{ ...metadata, firstIndex: 0, count: 4 }] }));
  const output = join(temporary, 'output'); const result = await compileSpatial({ populationManifest, geographyManifest, output });
  const repeat = await compileSpatial({ populationManifest, geographyManifest, output: join(temporary, 'repeat') });
  assert.equal(result.manifestSha256, repeat.manifestSha256);
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json')));
  assert.equal(manifest.stats.home, 3); assert.equal(manifest.stats.unplacedHome, 3);
  const target = decodeTargetShard(await readFile(join(output, manifest.targetShards[0].url)));
  assert.equal(targetAt(target, 2).studyBuildingIndex, 2); assert.equal(targetAt(target, 3).workBuildingIndex, null);
  const role = decodeRoleShard(await readFile(join(output, manifest.roleShards[0].url)));
  assert.deepEqual(roleMembers(role, 0, 'home').members, [0, 1, 2]); assert.equal(roleMembers(role, 3, 'work').total, 0);
  const contexts = decodeRosterContexts(await readFile(join(output, manifest.roleShards[0].contexts.url)));
  assert.equal(contexts.count, manifest.roleShards[0].members); assert.equal(rosterContextAt(contexts, 0).record.personIndex, 0);
  const tripMasks = decodeHouseholdTripMasks(await readFile(join(output, manifest.roleShards[0].contexts.householdTripMasks.url)));
  assert.equal(tripMasks.count, contexts.count);
  const cell = JSON.parse(await readFile(join(output, manifest.candidateCells[0].url)));
  assert.ok(cell.people.length <= 256); assert.equal(cell.households[0][1].length, 3); assert.equal(cell.people[0][1].length, 24);
  assert.ok(cell.buildings.every((b) => b.walkRoadIndex !== null && b.carRoadIndex !== null)); assert.equal(cell.roads.length, 2);
});
