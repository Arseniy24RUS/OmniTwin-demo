import assert from 'node:assert/strict';
import test from 'node:test';
import { encodePersonShard, decodePersonShard, recordAt, personId, parsePersonId, isActive, profileFor, encodeHouseholdShard, decodeHouseholdShard, householdMembers } from '../index.mjs';

test('compact person records round-trip shared and scenario-specific membership', () => {
  const bytes = encodePersonShard(8192, [
    { householdIndex: 17, birthYear: 1990, sex: 'female', householdRole: 'head', scenarioMask: 7, entryYear: 2026, entryReason: 'initial', exitYears: [null, 2030, null], exitReasons: [null, 'emigration', null] },
    { householdIndex: 17, birthYear: 2028, sex: 'male', householdRole: 'child', scenarioMask: 1, entryYear: 2028, entryReason: 'birth', exitYears: [null, null, null], exitReasons: [null, null, null] },
  ]);
  const shard = decodePersonShard(bytes);
  assert.equal(bytes.byteLength, 32 + 2 * 16);
  const mother = recordAt(shard, 8192);
  assert.equal(mother.id, 'demo2-p-0008192');
  assert.equal(mother.householdId, 'demo2-h-0000017');
  assert.equal(parsePersonId(mother.id), 8192);
  assert.equal(isActive(mother, 2029, 'inflow'), true);
  assert.equal(isActive(mother, 2030, 'inflow'), false);
  assert.equal(isActive(mother, 2036, 'baseline'), true);
  assert.equal(isActive(recordAt(shard, 8193), 2027, 'baseline'), false);
  assert.equal(isActive(recordAt(shard, 8193), 2028, 'inflow'), false);
  assert.throws(() => recordAt(shard, 1));
  assert.throws(() => decodePersonShard(bytes.subarray(0, bytes.length - 1)));
  assert.equal(parsePersonId('demo2-p-1'), null);
  assert.equal(parsePersonId('../demo2-p-0008192'), null);
  assert.throws(() => personId(-1));
});

test('household CSR preserves all stable member IDs and optional source-backed home index', () => {
  const bytes = encodeHouseholdShard(12, [
    { members: [1, 2, 3], homeBuildingIndex: 8, districtIndex: 4 },
    { members: [7], homeBuildingIndex: null, districtIndex: null },
  ]);
  const shard = decodeHouseholdShard(bytes);
  assert.deepEqual(householdMembers(shard, 12), { householdIndex: 12, members: [1, 2, 3], homeBuildingIndex: 8, districtIndex: 4 });
  assert.deepEqual(householdMembers(shard, 13).members, [7]);
  assert.equal(householdMembers(shard, 13).homeBuildingIndex, null);
  assert.throws(() => householdMembers(shard, 14));
});

test('profiles are deterministic fictional content and require live membership and household state', () => {
  const record = recordAt(decodePersonShard(encodePersonShard(0, [{ householdIndex: 0, birthYear: 1921, sex: 'female', householdRole: 'head', scenarioMask: 7, entryYear: 2026, entryReason: 'initial', exitYears: [null, null, null], exitReasons: [null, null, null] }])), 0);
  const options = { householdSize: 1, territoryId: 'RU-CHE-SET', territoryName: 'Челябинск' };
  const profile = profileFor(record, 2026, 'baseline', options);
  assert.deepEqual(profileFor(record, 2026, 'baseline', options), profile);
  assert.equal(profile.age, 105); assert.equal(profile.occupation, 'пенсионер');
  assert.equal(profile.isFictional, true); assert.equal(profile.datasetId, 'omnitwin-fictional-city-v2');
  assert.throws(() => profileFor(record, 2025, 'baseline', options));
  assert.throws(() => profileFor(record, 2026, 'baseline', { householdSize: 0 }));
});
