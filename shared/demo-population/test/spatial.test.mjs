import assert from 'node:assert/strict';
import test from 'node:test';
import { SPATIAL_NONE, encodeTargetShard, decodeTargetShard, targetAt, encodeRoleShard, decodeRoleShard, roleMembers, activeTargets, buildDestinationPools, selectDestination, spatialCellKey, decodeEmbeddedPerson, decodeRosterContexts, rosterContextAt, presenceFor, dailyMovement, visitorEligible, householdHasVehicle, householdTripFor, decodeHouseholdTripMasks, householdTripParticipantAt } from '../spatial.mjs';
import { encodePersonShard, decodePersonShard, recordAt, hashIndex, SCENARIO_IDS } from '../index.mjs';

const person = (personIndex = 1) => recordAt(decodePersonShard(encodePersonShard(personIndex, [{ householdIndex: personIndex, birthYear: 1990, sex: 'female', scenarioMask: 1, entryYear: 2026, exitYears: [2030, null, null], exitReasons: ['death', null, null] }])), personIndex);

test('compact targets roundtrip with explicit unplaced values and strict bounds', () => {
  const bytes = encodeTargetShard(5, new Uint32Array([2, SPATIAL_NONE, 3, SPATIAL_NONE, 1, SPATIAL_NONE]), 4);
  const shard = decodeTargetShard(bytes);
  assert.equal(bytes.length, 32 + 2 * 12);
  assert.deepEqual(targetAt(shard, 5), { workBuildingIndex: 2, studyBuildingIndex: null, visitorBuildingIndex: 3 });
  assert.deepEqual(targetAt(shard, 6), { workBuildingIndex: null, studyBuildingIndex: 1, visitorBuildingIndex: null });
  assert.throws(() => targetAt(shard, 7));
  assert.throws(() => decodeTargetShard(bytes.subarray(0, bytes.length - 1)));
  assert.throws(() => encodeTargetShard(0, new Uint32Array([4, 1, 2]), 4));
});

test('building-role CSR is complete but reads are paginated and bounded', () => {
  const offsets = new Uint32Array([0, 2, 3, 3, 4, 5, 5, 5, 5]);
  const bytes = encodeRoleShard(8, 2, offsets, new Uint32Array([1, 3, 4, 2, 0]), 5);
  const shard = decodeRoleShard(bytes);
  assert.deepEqual(roleMembers(shard, 8, 'home', { limit: 1 }), { members: [1], total: 2, nextOffset: 1 });
  assert.deepEqual(roleMembers(shard, 8, 'home', { offset: 1, limit: 1 }), { members: [3], total: 2, nextOffset: null });
  assert.deepEqual(roleMembers(shard, 8, 'study'), { members: [], total: 0, nextOffset: null });
  assert.throws(() => roleMembers(shard, 8, 'home', { limit: 1025 }));
  assert.throws(() => roleMembers(shard, 8, 'invented'));
  assert.throws(() => roleMembers(shard, 7, 'home'));
  assert.throws(() => encodeRoleShard(8, 2, offsets, new Uint32Array([3, 1, 4, 2, 0]), 5));
});

test('potential destinations never imply activity outside membership or employment', () => {
  const record = { personIndex: 1, birthYear: 2010, entryYear: 2026, scenarioMask: 1, exitYears: [2029, null, null] };
  const targets = { workBuildingIndex: 2, studyBuildingIndex: 3, visitorBuildingIndex: 4 };
  assert.deepEqual(activeTargets(record, targets, 2026, 'baseline'), { workBuildingIndex: null, studyBuildingIndex: 3, visitorBuildingIndex: null });
  assert.deepEqual(activeTargets(record, targets, 2029, 'baseline'), { workBuildingIndex: null, studyBuildingIndex: null, visitorBuildingIndex: null });
  assert.deepEqual(activeTargets(record, targets, 2026, 'inflow'), { workBuildingIndex: null, studyBuildingIndex: null, visitorBuildingIndex: null });
});

test('destination synthesis uses classified same-district buildings only and is deterministic', () => {
  const rows = [
    ['unknown', 61.4, 55.16, 'RU-CHE-SET-CEN', 'unknown', 99999, 99],
    ['work-a', 61.4, 55.16, 'RU-CHE-SET-CEN', 'work', 100, 2],
    ['study-a', 61.4, 55.16, 'RU-CHE-SET-CEN', 'study', 100, 1],
    ['work-b', 61.4, 55.16, 'RU-CHE-SET-KAL', 'work', 100, 2],
  ];
  const pools = buildDestinationPools(rows);
  assert.equal(selectDestination(pools, 'RU-CHE-SET-CEN', 'work', 1), 1);
  assert.equal(selectDestination(pools, 'RU-CHE-SET-CEN', 'study', 1), 2);
  assert.equal(selectDestination(pools, 'RU-CHE-SET-LEN', 'study', 1), null);
  assert.equal(selectDestination(pools, null, 'work', 1), null);
  assert.equal(selectDestination(pools, 'RU-CHE-SET-CEN', 'work', 1), selectDestination(pools, 'RU-CHE-SET-CEN', 'work', 1));
  assert.match(spatialCellKey(61.4026, 55.1644), /^16\/\d+\/\d+$/);
  assert.throws(() => spatialCellKey(NaN, 55));
});

test('embedded and roster records preserve canonical membership without source shard downloads', () => {
  const record = person(); const raw = encodePersonShard(1, [record]).subarray(32);
  assert.deepEqual(decodeEmbeddedPerson(1, Buffer.from(raw).toString('base64')), record);
  const bytes = new Uint8Array(36); const view = new DataView(bytes.buffer);
  view.setUint32(0, 1, true); bytes.set(raw, 4);
  [2, 3, SPATIAL_NONE, 4].forEach((n, i) => view.setUint32(20 + i * 4, n, true));
  assert.deepEqual(rosterContextAt(decodeRosterContexts(bytes), 0), { record, homeBuildingIndex: 2, targets: { workBuildingIndex: 3, studyBuildingIndex: null, visitorBuildingIndex: 4 } });
  assert.equal(decodeRosterContexts(new Uint8Array()).count, 0);
  assert.throws(() => decodeEmbeddedPerson(1, 'invalid'));
  assert.throws(() => decodeRosterContexts(bytes.subarray(1)));
  assert.throws(() => rosterContextAt(decodeRosterContexts(bytes), 1));
});

test('shared presence is deterministic, context-gated, and heterogeneous at 10:00', () => {
  const targets = { workBuildingIndex: 3, studyBuildingIndex: null, visitorBuildingIndex: 4 };
  assert.equal(presenceFor(person(), targets, 2, 2030, 'baseline', 600).active, false);
  assert.equal(presenceFor(person(), targets, 2, 2026, 'inflow', 600).active, false);
  assert.equal(presenceFor(person(), targets, null, 2026, 'baseline', 600).role, 'unplaced');
  const roles = new Set(); let moving = 0;
  for (let i = 0; i < 1000; i++) {
    const record = person(i); const p = presenceFor(record, targets, 2, 2026, 'baseline', 600);
    assert.deepEqual(p, presenceFor(record, targets, 2, 2026, 'baseline', 600));
    roles.add(p.role); if (['travel', 'leisure'].includes(p.role)) { moving++; assert.equal(p.buildingIndex, null); assert.ok(p.progress >= 0 && p.progress <= 1); }
  }
  assert.ok(roles.has('work') && roles.has('home') && roles.has('travel') && roles.has('leisure'));
  assert.ok(moving > 100 && moving < 500);
});

test('movement uses bound eligible source geometry and never reverses a one-way road', () => {
  let i = 0; while (hashIndex(i, 9122026) % 3 !== 0) i++;
  const record = person(i); const presence = { active: true, role: 'travel', age: 36, progress: 0.25, direction: 'return' };
  const road = { id: 'osm-road:1', coordinates: [[61.4, 55.16], [61.41, 55.16]], oneway: true, walkable: true, drivable: true };
  let minute = 600; let forward; while (!(forward = dailyMovement(record, presence, { walkRoad: road, carRoad: road }, minute))) minute += 0.1;
  assert.equal(forward.mode, 'vehicle'); assert.equal(forward.vehicleId, `demo2-v-${String(i).padStart(7, '0')}`);
  assert.equal(forward.direction, 'forward'); assert.ok(forward.longitude >= 61.4 && forward.longitude <= 61.41); assert.ok([7, 8, 9, 10].includes(forward.speedMps));
  assert.equal(forward.routeMode, 'once'); assert.ok(forward.endpointOpacity >= 0 && forward.endpointOpacity <= 1);
  assert.equal(dailyMovement(record, presence, {}, 600), null);
  assert.equal(dailyMovement(record, { ...presence, active: false }, { walkRoad: road }, 600), null);
  assert.equal(dailyMovement(record, { ...presence, age: 17 }, { walkRoad: { ...road, oneway: false }, carRoad: road }, 600).mode, 'pedestrian');
  assert.throws(() => dailyMovement(record, presence, { carRoad: { ...road, coordinates: [[NaN, 55], [61, 55]] } }, 600));
});

test('visitor eligibility uses source retail/public attributes, not unknown or industrial geometry', () => {
  assert.equal(visitorEligible({ use: 'work', sourceAttributes: { building: 'commercial', shop: 'mall' } }), true);
  assert.equal(visitorEligible({ use: 'work', sourceAttributes: { building: 'retail' } }), true);
  assert.equal(visitorEligible({ use: 'work', sourceAttributes: { amenity: 'library' } }), true);
  assert.equal(visitorEligible({ use: 'work', sourceAttributes: { building: 'industrial', shop: 'yes' } }), false);
  assert.equal(visitorEligible({ use: 'unknown', sourceAttributes: { shop: 'mall' } }), false);
  assert.equal(visitorEligible({ use: 'work', sourceAttributes: { building: 'commercial' } }), false);
  assert.equal(visitorEligible({ use: 'work', sourceAttributes: { shop: 'vacant' } }), false);
});

test('shared household vehicles have one active adult driver and consistent passengers across33 contexts', () => {
  let householdIndex = 0; while (!householdHasVehicle(householdIndex)) householdIndex++;
  const records = Array.from({ length: 9 }, (_, i) => ({ ...person(i), householdIndex, birthYear: i < 2 ? 1990 : 2020, scenarioMask: 7, exitYears: i === 0 ? [2030, 2031, 2032] : [null, null, null] }));
  const rawMasks = new Uint8Array(records.length * 5);
  for (let scenario = 0; scenario < 3; scenario++) for (let year = 2026; year <= 2036; year++) {
    const trip = householdTripFor(records, year, SCENARIO_IDS[scenario]);
    assert.equal(trip.passengerIndices.length, 7); assert.ok(trip.passengerIndices.includes(trip.driverPersonIndex));
    assert.equal(trip.driverPersonIndex, year < records[0].exitYears[scenario] ? 0 : 1);
    const bit = scenario * 11 + year - 2026;
    for (const index of trip.passengerIndices) rawMasks[index * 5 + (bit >>> 3)] |= 1 << (bit & 7);
  }
  const masks = decodeHouseholdTripMasks(rawMasks); const targets = { workBuildingIndex: 2, studyBuildingIndex: 3, visitorBuildingIndex: 4 };
  const road = { id: 'source-corridor:shared', coordinates: [[61.4, 55.16], [61.41, 55.16]], oneway: false, walkable: true, drivable: true };
  for (const scenario of SCENARIO_IDS) for (let year = 2026; year <= 2036; year++) {
    const trip = householdTripFor(records, year, scenario); const minute = trip.startMinute + 12; const vehicles = new Set();
    for (const record of records) {
      const participant = householdTripParticipantAt(masks, record.personIndex, year, scenario);
      assert.equal(participant, trip.passengerIndices.includes(record.personIndex));
      const full = presenceFor(record, targets, 1, year, scenario, minute, { householdRecords: records });
      const compact = presenceFor(record, targets, 1, year, scenario, minute, { householdTripParticipant: participant });
      assert.equal(full.role, compact.role); assert.equal(full.buildingIndex, compact.buildingIndex); assert.equal(full.tripPurpose, compact.tripPurpose);
      if (participant) {
        const movement = dailyMovement(record, full, { carRoad: road, walkRoad: road }, minute);
        assert.equal(movement.mode, 'vehicle'); vehicles.add(movement.vehicleId);
        assert.equal(dailyMovement(record, full, { walkRoad: road }, minute), null);
      }
    }
    assert.deepEqual([...vehicles], [trip.vehicleId]);
  }
  const bad = rawMasks.slice(); bad[4] |= 128; assert.throws(() => decodeHouseholdTripMasks(bad));
  assert.throws(() => householdTripParticipantAt(masks, 9, 2026, 'baseline'));
  assert.throws(() => householdTripParticipantAt(masks, 0, 2025, 'baseline'));
});

test('physical motion is continuous, uses speed buckets, and hides open one-way resets', () => {
  let index = 0; while (hashIndex(index, 9122026) % 3 !== 0) index++;
  const record = person(index); const presence = { active: true, role: 'travel', age: 36, progress: 0.25, direction: 'outbound' };
  const line = { id: 'osm-road:physical', coordinates: [[61.4, 55.16], [61.41, 55.16]], oneway: false, walkable: true, drivable: true };
  const scale = 111_195 * Math.cos(55.16 * Math.PI / 180); const directions = new Set();
  for (let second = 0; second < 200; second++) {
    const a = dailyMovement(record, presence, { carRoad: line }, 600 + second / 60);
    const b = dailyMovement(record, presence, { carRoad: line }, 600 + (second + 0.1) / 60);
    assert.equal(a.routeMode, 'ping_pong'); directions.add(a.direction);
    assert.ok(Math.abs(b.longitude - a.longitude) * scale <= a.speedMps * 0.1 + 1e-6);
    if (a.direction === b.direction) assert.ok(Math.abs(Math.abs(b.longitude - a.longitude) * scale - a.speedMps * 0.1) < 1e-6);
  }
  assert.deepEqual([...directions].sort(), ['forward', 'reverse']);
  const oneway = { ...line, oneway: true }; let hidden = 0; let previous = null;
  for (let second = 0; second < 250; second++) {
    const current = dailyMovement(record, presence, { carRoad: oneway }, 600 + second / 60);
    if (!current) { hidden++; previous = null; continue; }
    assert.equal(current.direction, 'forward'); if (previous) assert.ok(current.progress >= previous.progress);
    previous = current;
  }
  assert.ok(hidden >= 6);
  const closed = { ...line, oneway: true, coordinates: [[61.4, 55.16], [61.41, 55.16], [61.41, 55.17], [61.4, 55.16]], segments: [{ fromNodeId: 'osm-node:1', toNodeId: 'osm-node:1' }] };
  for (let second = 0; second < 250; second += 10) { const movement = dailyMovement(record, presence, { carRoad: closed }, 600 + second / 60); assert.equal(movement.routeMode, 'loop'); assert.equal(movement.endpointOpacity, 1); }
  const walking = dailyMovement(record, { ...presence, age: 17 }, { walkRoad: line }, 600); assert.equal(walking.speedMps, 1.2);
});
