import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildPopulation, assignHomes, summarizePopulation, authoredFlows } from '../../../tools/build-city-population-v2.mjs';
import { encodePersonShard, decodePersonShard, recordAt, isActive } from '../index.mjs';

const reference = { year: 2024, population: 4200, male: 2100, female: 2100, ageSex: Array.from({ length: 21 }, (_, i) => ({ ageBand: i === 20 ? '100+' : `${i * 5}-${i * 5 + 4}`, male: 100, female: 100 })) };
const geography = { columns: ['id', 'lon', 'lat', 'districtId', 'use', 'areaM2', 'levels', 'heightM', 'capacityWeight', 'classificationProvenance'], rows: [
  ['home-a', 61, 55, 'RU-CHE-SET-CEN', 'residential', 200, 5, 15, 5500, 'test_capacity'],
  ['home-b', 61.1, 55, 'RU-CHE-SET-MET', 'residential', 20, 1, 3, 500, 'test_capacity'],
  ['unknown', 61.2, 55, 'RU-CHE-SET-CEN', 'unknown', 20000, 30, 90, 0, 'unknown'],
  ['unresolved', 61.2, 55, null, 'residential', 20000, 30, 90, 3000, 'osm'],
] };
test('fixture compiler preserves exact 21 age/sex marginals, all stock/flows and shared baseline', () => {
  const population = buildPopulation(reference); const placement = assignHomes(population, geography); const summaries = summarizePopulation(population, placement);
  assert.equal(population.initialPopulation, 4200); assert.equal(summaries.snapshots.length, 264); assert.equal(summaries.eventLedger.length, 30);
  assert.deepEqual(summaries.snapshots[0].ageSexFine, reference.ageSex);
  const shard = decodePersonShard(encodePersonShard(0, population.bytes));
  let initial = 0;
  for (let i = 0; i < population.recordCount; i++) {
    const record = recordAt(shard, i);
    if (record.entryYear === 2026) { initial++; assert.equal(record.scenarioMask, 7); }
    else assert.ok([1, 2, 4].includes(record.scenarioMask));
    assert.ok(record.householdIndex < population.householdCount);
    if (record.birthYear > 2008 && record.entryYear === 2026) {
      const hh = record.householdIndex; const members = Array.from(population.members.subarray(population.offsets[hh], population.offsets[hh + 1])).map((index) => recordAt(shard, index));
      assert.ok(members.some((member) => member.entryYear === 2026 && member.birthYear <= record.birthYear - 18));
    }
    for (const [s, scenario] of ['baseline', 'inflow', 'ageing'].entries()) if (record.exitYears[s]) assert.equal(isActive(record, record.exitYears[s], scenario), false);
  }
  assert.equal(initial, 4200);
  assert.equal(population.offsets[population.householdCount], population.recordCount);
  assert.equal(new Set(population.members).size, population.recordCount);
  assert.ok(Array.from(placement.homes).every((home) => home === 0 || home === 1));
  assert.ok(Array.from(placement.homes).filter((home) => home === 0).length > population.householdCount * 0.8);
  assert.ok(placement.maximumOccupancyRatio <= 1);
  const cramped = { ...geography, rows: geography.rows.slice(0, 2).map((row) => row.map((value, column) => column === 8 ? 1 : value)) };
  assert.throws(() => assignHomes(population, cramped), /capacity fits/);
  for (const [contextIndex, context] of summaries.queryIndex.contexts.entries()) {
    const total = summaries.queryIndex.shards.reduce((sum, shard) => sum + shard.contexts[contextIndex].filter((_, i) => i % 2).reduce((a, b) => a + b, 0), 0);
    assert.equal(total, summaries.snapshots.find((row) => row.scenario === context.scenario && row.year === context.year && row.territoryId === 'RU-CHE-SET').population);
  }
  for (const row of summaries.snapshots) {
    assert.equal(row.cohortCube.reduce((n, c) => n + c.population, 0), row.population);
    if (row.year > 2026) { const previous = summaries.snapshots.find((r) => r.scenario === row.scenario && r.territoryId === row.territoryId && r.year === row.year - 1); assert.equal(previous.population + row.births - row.deaths + row.immigration - row.emigration, row.population); }
  }
});
test('fixture compilation is byte-deterministic and invalid reference fails closed', () => {
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash(buildPopulation(reference).bytes), hash(buildPopulation(reference).bytes));
  assert.throws(() => buildPopulation({ ...reference, population: 4201 }), /reconcile/);
  assert.throws(() => buildPopulation({ ...reference, year: 2026 }), /2024/);
  assert.throws(() => assignHomes({ householdCount: 1 }, { ...geography, rows: geography.rows.slice(2) }), /No source/);
  assert.deepEqual(authoredFlows('baseline', 2027, 8246), { births: 94, deaths: 90, immigration: 111, emigration: 96 });
});
