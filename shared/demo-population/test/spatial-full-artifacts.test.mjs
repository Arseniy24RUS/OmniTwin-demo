import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { isActive } from '../index.mjs';
import { decodeRoleShard, decodeRosterContexts, rosterContextAt, decodeHouseholdTripMasks, householdTripParticipantAt, presenceFor, decodeEmbeddedPerson, householdTripFor } from '../spatial.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const directory = resolve(root, 'apps/web/public/demo-v2/spatial');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const asset = async (descriptor) => { const bytes = await readFile(resolve(directory, descriptor.url)); assert.equal(bytes.length, descriptor.bytes); assert.equal(hash(bytes), descriptor.sha256); return bytes; };
const publishedSpatialSha256 = 'ec886d770baa1bbb83afab4973b857a6d50d9a1eac0135c1f90508a88557567d';
const publishedProducers = 'shared/demo-population/test/fixtures/published-spatial-v1-producers/';

test('full spatial artifacts pin their exact producer generation and preserve large source-mall visitors', async (t) => {
  let bytes; try { bytes = await readFile(resolve(directory, 'manifest.json')); } catch (error) { if (error.code === 'ENOENT') return t.skip('Run the offline spatial compiler first.'); throw error; }
  const manifest = JSON.parse(bytes);
  assert.ok(bytes.length <= 2 * 1024 * 1024);
  // The existing public base remains immutable when an additive movement
  // overlay changes its producers. Only this exact already-published manifest
  // may resolve producer hashes to the archived, byte-identical release code.
  // Runtime decoders and source manifests must still match today's active bytes.
  const historical = hash(bytes) === publishedSpatialSha256;
  for (const [field, path] of [['populationManifest', 'apps/web/public/demo-v2/manifest.json'], ['geographyManifest', 'apps/web/public/city-v2/manifest.json'], ['populationCodec', 'shared/demo-population/index.mjs'], ['spatialCodec', 'shared/demo-population/spatial.mjs'],
    ['routeCorridorCodec', historical ? publishedProducers + 'route-corridors.mjs.txt' : 'shared/demo-population/route-corridors.mjs'],
    ['compiler', historical ? publishedProducers + 'build-city-spatial-v2.mjs.txt' : 'tools/build-city-spatial-v2.mjs']]) {
    assert.equal(manifest.sourceHashes[field], hash(await readFile(resolve(root, path))), field);
  }
  assert.equal(manifest.recordCount, 2119871); assert.equal(manifest.stats.unplacedHome, 0); assert.ok(manifest.stats.visitor > 1_000_000);
  const report = [];
  for (const buildingIndex of [38850, 47927, 49874, 50866, 64661]) {
    const descriptor = manifest.roleShards.find((row) => buildingIndex >= row.firstIndex && buildingIndex < row.firstIndex + row.count);
    const roles = decodeRoleShard(await asset(descriptor)); const contexts = decodeRosterContexts(await asset(descriptor.contexts));
    const masks = decodeHouseholdTripMasks(await asset(descriptor.contexts.householdTripMasks)); assert.equal(masks.count, contexts.count);
    const reportRow = { buildingIndex, potentialVisitors: 0, activeVisitors2026: 0, visitorsAt1000: 0, workersAt1000: 0, presentAt1000: 0 };
    const seen = new Set();
    for (let role = 0; role < 4; role++) {
      const row = (buildingIndex - roles.startIndex) * 4 + role; const start = roles.view.getUint32(32 + row * 4, true); const end = roles.view.getUint32(36 + row * 4, true);
      if (role === 3) reportRow.potentialVisitors = end - start;
      for (let ordinal = start; ordinal < end; ordinal++) {
        const context = rosterContextAt(contexts, ordinal); const record = context.record;
        if (role === 3 && isActive(record, 2026, 'baseline') && 2026 - record.birthYear >= 18) reportRow.activeVisitors2026++;
        const state = presenceFor(record, context.targets, context.homeBuildingIndex, 2026, 'baseline', 600, { householdTripParticipant: householdTripParticipantAt(masks, ordinal, 2026, 'baseline') });
        if (state.buildingIndex !== buildingIndex || state.role !== ['home', 'work', 'study', 'visitor'][role]) continue;
        assert.ok(!seen.has(record.personIndex), 'One person cannot be present twice in a building.'); seen.add(record.personIndex);
        reportRow.presentAt1000++; if (role === 3) reportRow.visitorsAt1000++; if (role === 1) reportRow.workersAt1000++;
      }
    }
    assert.ok(reportRow.potentialVisitors > 32); assert.ok(reportRow.visitorsAt1000 > 0); report.push(reportRow);
  }
  t.diagnostic(JSON.stringify({ manifestSha256: hash(bytes), malls: report }));
});

test('largest candidate cells retain bounded people, complete households and connected source bindings', async (t) => {
  let manifest; try { manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'))); } catch (error) { if (error.code === 'ENOENT') return t.skip('Run the offline spatial compiler first.'); throw error; }
  for (const descriptor of [...manifest.candidateCells].sort((a, b) => b.bytes - a.bytes).slice(0, 3)) {
    assert.ok(descriptor.bytes <= 2 * 1024 * 1024); const cell = JSON.parse(await asset(descriptor));
    assert.equal(cell.people.length, descriptor.count); assert.ok(cell.people.length <= 256);
    const households = new Map(cell.households.map(([index, members]) => [index, members.map(([personIndex, raw]) => decodeEmbeddedPerson(personIndex, raw))]));
    const roads = new Map(cell.roads.map((road) => [road.index, road]));
    for (const row of cell.people) {
      const record = decodeEmbeddedPerson(row[0], row[1]); assert.equal(record.householdIndex, row[2]); assert.ok(households.get(row[2]).some((r) => r.personIndex === row[0]));
      const trip = householdTripFor(households.get(row[2]), 2026, 'baseline'); if (trip) assert.ok(trip.passengerIndices.length <= 7);
      assert.ok(row[7] === null || roads.get(row[7]).walkable); assert.ok(row[8] === null || roads.get(row[8]).drivable);
    }
    for (const road of roads.values()) {
      assert.equal(road.connectivity, 'source_node_ids'); assert.ok(road.lengthMeters > 0 && road.lengthMeters <= 1500.001); assert.ok(road.segments.length <= 12);
      for (let i = 1; i < road.segments.length; i++) assert.equal(road.segments[i - 1].toNodeId, road.segments[i].fromNodeId);
      assert.ok(road.segments.every((segment) => road.sourceRoadIds.includes(segment.roadId)));
    }
  }
});
