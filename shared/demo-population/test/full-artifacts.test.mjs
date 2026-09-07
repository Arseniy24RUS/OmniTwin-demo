import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { decodePersonShard, decodeHouseholdShard, recordAt, householdMembers, isActive, employmentFor, PERSON_SHARD_SIZE, HOUSEHOLD_SHARD_SIZE } from '../index.mjs';

const directory = new URL('../../../apps/web/public/demo-v2/', import.meta.url);
const sha = (value) => createHash('sha256').update(value).digest('hex');
test('local generated artifacts pass SHA, coverage, marginals, CSR and facet checks', { skip: !existsSync(new URL('manifest.json', directory)) }, async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', directory)));
  assert.equal(manifest.initialPopulation, 1177058);
  const summaries = JSON.parse(await readFile(new URL(manifest.summaries.url, directory)));
  const query = JSON.parse(await readFile(new URL(manifest.queryIndex.url, directory)));
  const reference = JSON.parse(await readFile(new URL('../../../apps/web/public/demo/observed-chelyabinsk-v1.json', import.meta.url))).snapshots.find((row) => row.year === 2024);
  const seen = new Uint8Array(manifest.recordCount); const householdByPerson = new Uint32Array(manifest.recordCount);
  const initialByHousehold = new Uint16Array(manifest.householdCount);
  const ageSex = Array.from({ length: 21 }, (_, i) => ({ ageBand: i === 20 ? '100+' : `${i * 5}-${i * 5 + 4}`, male: 0, female: 0 }));
  let initial = 0; let covered = 0; let totalBytes = 0;
  for (const [position, asset] of manifest.personShards.entries()) {
    assert.equal(asset.startIndex, position * PERSON_SHARD_SIZE); const bytes = await readFile(new URL(asset.url, directory));
    assert.equal(bytes.length, asset.bytes); assert.equal(sha(bytes), asset.sha256); totalBytes += bytes.length;
    const shard = decodePersonShard(bytes); assert.equal(shard.count, asset.count); covered += shard.count;
    for (let local = 0; local < shard.count; local++) {
      const offset = 32 + local * 16; const index = shard.startIndex + local; const hh = shard.view.getUint32(offset, true); householdByPerson[index] = hh;
      assert.ok(hh < manifest.householdCount);
      if (shard.bytes[offset + 9] === 0) { initial++; initialByHousehold[hh]++; assert.equal(shard.bytes[offset + 8], 7); ageSex[Math.min(20, Math.floor((2026 - shard.view.getUint16(offset + 4, true)) / 5))][shard.bytes[offset + 6] ? 'female' : 'male']++; }
      // Decode sampled records through the actual client/server boundary, not just raw arrays.
      if (local % 127 === 0) { const record = recordAt(shard, index); assert.ok(['child', 'student', 'employed', 'retired', 'not_employed'].includes(employmentFor(record, 2036))); if (record.entryYear > 2026) assert.equal(isActive(record, 2026, 'baseline'), false); }
    }
  }
  assert.equal(initial, 1177058); assert.equal(covered, manifest.recordCount); assert.deepEqual(ageSex, reference.ageSex);
  let households = 0;
  for (const [position, asset] of manifest.householdShards.entries()) {
    assert.equal(asset.startIndex, position * HOUSEHOLD_SHARD_SIZE); const bytes = await readFile(new URL(asset.url, directory));
    assert.equal(bytes.length, asset.bytes); assert.equal(sha(bytes), asset.sha256); totalBytes += bytes.length;
    const shard = decodeHouseholdShard(bytes); households += shard.count;
    for (let local = 0; local < shard.count; local++) {
      const hh = householdMembers(shard, shard.startIndex + local); assert.notEqual(hh.homeBuildingIndex, null); assert.ok(hh.districtIndex >= 0 && hh.districtIndex < 7);
      for (const index of hh.members) { assert.ok(index < manifest.recordCount); assert.equal(householdByPerson[index], hh.householdIndex); assert.equal(seen[index], 0); seen[index] = 1; }
    }
  }
  assert.equal(households, manifest.householdCount); assert.equal(seen.every((n) => n === 1), true); assert.equal(initialByHousehold.filter((count) => count > 0).length, manifest.initialHouseholdCount);
  for (const asset of [manifest.summaries, manifest.queryIndex]) { const bytes = await readFile(new URL(asset.url, directory)); assert.equal(bytes.length, asset.bytes); assert.equal(sha(bytes), asset.sha256); totalBytes += bytes.length; }
  assert.equal(totalBytes, manifest.totalAssetBytes);
  const geo = await readFile(new URL(manifest.spatial.geographyManifestUrl, directory)); assert.equal(sha(geo), manifest.spatial.geographyManifestSha256);
  for (const [contextIndex, context] of query.contexts.entries()) {
    const city = summaries.snapshots.find((row) => row.scenario === context.scenario && row.year === context.year && row.territoryId === 'RU-CHE-SET');
    const count = query.shards.reduce((sum, row) => sum + row.contexts[contextIndex].filter((_, i) => i % 2).reduce((a, b) => a + b, 0), 0);
    assert.equal(count, city.population);
    assert.equal(city.cohortCube.reduce((sum, cell) => sum + cell.population, 0), city.population);
    if (context.year === 2026) assert.deepEqual(city.ageSexFine, reference.ageSex);
    else { const previous = summaries.snapshots.find((row) => row.scenario === context.scenario && row.year === context.year - 1 && row.territoryId === 'RU-CHE-SET'); assert.equal(previous.population + city.births - city.deaths + city.immigration - city.emigration, city.population); }
  }
  assert.ok(fileURLToPath(directory).endsWith('demo-v2\\') || fileURLToPath(directory).endsWith('demo-v2/'));
});
