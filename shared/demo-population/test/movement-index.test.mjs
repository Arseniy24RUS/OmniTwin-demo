import assert from 'node:assert/strict';
import test from 'node:test';
import { DISTRICT_IDS, encodePersonShard } from '../index.mjs';
import { SPATIAL_NONE, householdTripFor, presenceFor } from '../spatial.mjs';
import { encodeMovementPage, decodeMovementPage, movementContextAt, decodeMovementCellContext } from '../movement-index.mjs';

const key = '16/43951/20675';
const jsonBytes = (value) => new TextEncoder().encode(JSON.stringify(value));
const wire = (bytes) => JSON.parse(new TextDecoder().decode(bytes));
const rawPerson = (householdIndex = 2, overrides = {}) => encodePersonShard(1, [{ householdIndex, birthYear: 1990, sex: 'female', scenarioMask: 7, entryYear: 2026, ...overrides }]).subarray(32);
const member = (index, raw) => [index, Buffer.from(raw).toString('base64')];
function fixture() {
  const raw = rawPerson(); const child = rawPerson(2, { birthYear: 2020, householdRole: 'child' });
  const contexts = new Uint8Array(36); const view = new DataView(contexts.buffer);
  view.setUint32(0, 1, true); contexts.set(raw, 4);
  [4, 5, SPATIAL_NONE, SPATIAL_NONE].forEach((value, i) => view.setUint32(20 + i * 4, value, true));
  return { key, contexts, households: [{ householdIndex: 2, members: [member(1, raw), member(3, child)] }], buildings: [{ index: 4, id: 'source:home', center: [61.4, 55.16], districtId: DISTRICT_IDS[0], use: 'residential' }, { index: 5, id: 'source:work', center: [61.41, 55.16], districtId: DISTRICT_IDS[0], use: 'work' }] };
}
function cellFixture() {
  return { contract: 'DemoMovementCellContextV2', key, bindings: [[4, 10, 11]], roads: ['walk', 'car'].map((mode, i) => ({ index: 10 + i, sourceRoadIndex: 5, mode, id: `source:corridor:${mode}`, coordinates: [[61.4, 55.16], [61.41, 55.16]], oneway: false, walkable: true, drivable: true, segments: [{ fromNodeId: 'osm-node:1', toNodeId: 'osm-node:2' }], connectivity: 'source_node_ids', semantics: 'connected_source_road_local_visual_synthesis_not_home_work_route' })) };
}

test('movement page roundtrips canonical contexts and complete household context', () => {
  const input = fixture(); const bytes = encodeMovementPage(input); const decoded = decodeMovementPage(bytes);
  assert.equal(decoded.count, 1); assert.equal(decoded.key, key); assert.deepEqual(decoded.buildings, input.buildings);
  assert.equal(wire(bytes).contextsBase64, Buffer.from(input.contexts).toString('base64'));
  const context = movementContextAt(decoded, 0);
  assert.equal(context.record.personIndex, 1); assert.equal(context.homeBuildingIndex, 4); assert.equal(context.districtIndex, 0);
  assert.deepEqual(context.targets, { workBuildingIndex: 5, studyBuildingIndex: null, visitorBuildingIndex: null });
  assert.deepEqual(context.householdRecords.map((r) => r.personIndex), [1, 3]);
  assert.deepEqual(encodeMovementPage(input), bytes);
  const padded = new Uint8Array(bytes.length + 5); padded.set(bytes, 3);
  assert.equal(decodeMovementPage(padded.subarray(3, 3 + bytes.length)).count, 1);
  assert.throws(() => movementContextAt(decoded, 1)); assert.throws(() => movementContextAt({}, 0));
  for (const scenario of ['baseline', 'inflow', 'ageing']) for (let year = 2026; year <= 2036; year++) {
    assert.doesNotThrow(() => householdTripFor(context.householdRecords, year, scenario));
    assert.equal(presenceFor(context.record, context.targets, context.homeBuildingIndex, year, scenario, 600, { householdRecords: context.householdRecords }).active, true);
  }
});

test('movement pages reject duplicate, unsorted, truncated and over-budget contexts', () => {
  const input = fixture(); const doubled = new Uint8Array(72); doubled.set(input.contexts); doubled.set(input.contexts, 36);
  assert.throws(() => encodeMovementPage({ ...input, contexts: doubled }));
  new DataView(doubled.buffer).setUint32(0, 3, true);
  doubled.set(Buffer.from(input.households[0].members[1][1], 'base64'), 4);
  assert.throws(() => encodeMovementPage({ ...input, contexts: doubled }), /sorted and unique/);
  assert.throws(() => encodeMovementPage({ ...input, contexts: input.contexts.subarray(1) }));
  assert.throws(() => encodeMovementPage({ ...input, contexts: new Uint8Array(8193 * 36) }));
  assert.throws(() => decodeMovementPage(new Uint8Array(8 * 1024 * 1024 + 1)), { code: 'MOVEMENT_PAGE_TOO_LARGE' });
  const value = wire(encodeMovementPage(input)); value.count = 2; assert.throws(() => decodeMovementPage(jsonBytes(value)));
  value.count = 1; value.contextsBase64 += '='; assert.throws(() => decodeMovementPage(jsonBytes(value)));
});

test('movement pages support the full 8192-row schema ceiling without Node-only decoding', () => {
  const input = fixture(); input.contexts = new Uint8Array(8192 * 36); input.households = [];
  const view = new DataView(input.contexts.buffer);
  for (let i = 0; i < 8192; i++) {
    const raw = rawPerson(i); view.setUint32(i * 36, i, true); input.contexts.set(raw, i * 36 + 4);
    [4, 5, SPATIAL_NONE, SPATIAL_NONE].forEach((value, j) => view.setUint32(i * 36 + 20 + j * 4, value, true));
    input.households.push({ householdIndex: i, members: [member(i, raw)] });
  }
  const decoded = decodeMovementPage(encodeMovementPage(input));
  assert.equal(decoded.count, 8192); assert.equal(movementContextAt(decoded, 8191).record.personIndex, 8191);
  const oversized = fixture(); oversized.buildings[0].id = 'x'.repeat(8 * 1024 * 1024);
  assert.throws(() => encodeMovementPage(oversized), { code: 'MOVEMENT_PAGE_TOO_LARGE' });
});

test('movement pages validate raw records and household alignment, inclusion and uniqueness', () => {
  for (const mutate of [
    (x) => { x.contexts[10] = 2; },
    (x) => { x.households[0].householdIndex = 9; },
    (x) => { x.households[0].members.shift(); },
    (x) => { x.households[0].members.push(x.households[0].members[0]); },
    (x) => { x.households.push(x.households[0]); },
    (x) => { x.households[0].members[0] = member(1, rawPerson(2, { birthYear: 1991 })); },
    (x) => { x.households[0].members[0][1] = 'AAAAAAAAAAAAAAAAAAAAAB=='; },
  ]) { const input = fixture(); mutate(input); assert.throws(() => encodeMovementPage(input)); }
});

test('movement pages require valid unique building metadata for every assigned target', () => {
  for (const mutate of [
    (x) => { x.buildings.pop(); },
    (x) => { x.buildings.push(x.buildings[0]); },
    (x) => { x.buildings[0].center[0] = NaN; },
    (x) => { x.buildings[0].districtId = 'invented'; },
    (x) => { x.buildings[0].use = 'invented'; },
    (x) => { x.key = '16/65536/1'; },
  ]) { const input = fixture(); mutate(input); assert.throws(() => encodeMovementPage(input)); }
  const input = fixture(); new DataView(input.contexts.buffer).setUint32(20, SPATIAL_NONE, true);
  assert.equal(movementContextAt(decodeMovementPage(encodeMovementPage(input)), 0).districtIndex, null);
});

test('cell context preserves canonical walk and car corridors and all route fields', () => {
  const input = cellFixture(); const decoded = decodeMovementCellContext(jsonBytes(input));
  assert.deepEqual(decoded, input); assert.notEqual(decoded.roads[0].index, decoded.roads[1].index);
  const nullable = cellFixture(); nullable.bindings[0][2] = null;
  assert.equal(decodeMovementCellContext(jsonBytes(nullable)).bindings[0][2], null);
});

test('cell context rejects dangling, duplicate, mode-swapped and invalid corridors', () => {
  for (const mutate of [
    (x) => { x.roads.pop(); },
    (x) => { x.roads.push(x.roads[0]); },
    (x) => { x.bindings.push(x.bindings[0]); },
    (x) => { x.bindings[0] = [4, 11, 10]; },
    (x) => { x.roads[0].mode = 'car'; },
    (x) => { x.roads[0].walkable = false; },
    (x) => { x.roads[0].coordinates[0][1] = 90; },
    (x) => { x.roads[0].oneway = 0; },
    (x) => { x.contract = 'invented'; },
  ]) { const input = cellFixture(); mutate(input); assert.throws(() => decodeMovementCellContext(jsonBytes(input))); }
  assert.throws(() => decodeMovementCellContext(new Uint8Array(8 * 1024 * 1024 + 1)));
});
