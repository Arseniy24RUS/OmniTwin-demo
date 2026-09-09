/** Bounded public fictional movement contexts. Pure browser/Node codec; no I/O. */
import { DISTRICT_IDS, writePersonRecord } from './index.mjs';
import { decodeEmbeddedPerson, decodeRosterContexts, rosterContextAt } from './spatial.mjs';

export const MOVEMENT_PAGE_SIZE = 8192;
export const MOVEMENT_CONTEXT_BYTES = 36;
export const MAX_MOVEMENT_PAGE_BYTES = 8 * 1024 * 1024;
export const MAX_MOVEMENT_CELL_CONTEXT_BYTES = 8 * 1024 * 1024;
const decodedPages = new WeakMap();
const integer = (value, max = 9_999_999) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const check = (condition, message) => { if (!condition) throw new Error(message); };
const text = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max;
const position = (value) => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite) && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 85.05112878;

function validateKey(key) {
  check(typeof key === 'string' && /^16\/(0|[1-9]\d{0,4})\/(0|[1-9]\d{0,4})$/.test(key) && key.split('/').slice(1).every((part) => Number(part) < 65536), 'Invalid movement cell key.');
}
function pageTooLarge() {
  const error = new Error('Movement page exceeds the 8 MiB serialized byte limit.');
  error.code = 'MOVEMENT_PAGE_TOO_LARGE';
  throw error;
}
function bytesOf(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new Error('Expected binary movement data.');
}
function readJson(value, maxBytes, page = false) {
  const bytes = bytesOf(value);
  if (page && bytes.length > maxBytes) pageTooLarge();
  check(bytes.length > 0 && bytes.length <= maxBytes, 'Invalid movement asset byte length.');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
function toBase64(bytes) {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 16_384) binary += String.fromCharCode(...bytes.subarray(start, start + 16_384));
  return btoa(binary);
}
function fromBase64(value, byteLength) {
  check(typeof value === 'string' && value.length === Math.ceil(byteLength / 3) * 4 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), 'Invalid movement base64 encoding.');
  const binary = atob(value);
  check(binary.length === byteLength && btoa(binary) === value, 'Noncanonical movement base64 encoding.');
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
function canonicalPerson(personIndex, raw) {
  const record = decodeEmbeddedPerson(personIndex, raw);
  const encoded = new Uint8Array(16);
  writePersonRecord(new DataView(encoded.buffer), 0, record);
  check(encoded.every((value, index) => value === raw[index]), 'Noncanonical movement person record.');
  return record;
}
function validateBuildings(buildings) {
  check(Array.isArray(buildings) && buildings.length <= MOVEMENT_PAGE_SIZE * 4, 'Invalid movement building dictionary.');
  const byIndex = new Map(); const ids = new Set();
  for (const building of buildings) {
    check(building && integer(building.index) && !byIndex.has(building.index) && text(building.id) && !ids.has(building.id) && position(building.center) && (building.districtId === null || DISTRICT_IDS.includes(building.districtId)) && ['residential', 'study', 'work', 'unknown'].includes(building.use), 'Invalid or duplicate movement building.');
    byIndex.set(building.index, building); ids.add(building.id);
  }
  return byIndex;
}
function validateHouseholds(households, count) {
  check(Array.isArray(households) && households.length <= count, 'Invalid movement household dictionary.');
  const byIndex = new Map(); const members = new Map();
  for (const household of households) {
    check(household && integer(household.householdIndex) && !byIndex.has(household.householdIndex) && Array.isArray(household.members) && household.members.length > 0 && household.members.length <= 100, 'Invalid or duplicate movement household.');
    const records = [];
    for (const member of household.members) {
      check(Array.isArray(member) && member.length === 2 && integer(member[0]) && !members.has(member[0]), 'Invalid or duplicate movement household member.');
      const raw = fromBase64(member[1], 16); const record = canonicalPerson(member[0], raw);
      check(record.householdIndex === household.householdIndex, 'Movement household record alignment mismatch.');
      records.push(record); members.set(member[0], { raw, record });
    }
    byIndex.set(household.householdIndex, records);
  }
  return { byIndex, members };
}
function validatePage(value) {
  check(value && value.contract === 'DemoMovementPageV2' && integer(value.count, MOVEMENT_PAGE_SIZE) && value.count > 0, 'Invalid movement page contract or count.');
  validateKey(value.key);
  const contexts = decodeRosterContexts(fromBase64(value.contextsBase64, value.count * MOVEMENT_CONTEXT_BYTES));
  const buildings = validateBuildings(value.buildings);
  const households = validateHouseholds(value.households, value.count);
  let previous = -1; const usedHouseholds = new Set();
  for (let ordinal = 0; ordinal < contexts.count; ordinal++) {
    const context = rosterContextAt(contexts, ordinal); const { record } = context;
    check(record.personIndex > previous, 'Movement page person indices must be sorted and unique.');
    previous = record.personIndex;
    const member = households.members.get(record.personIndex);
    check(member && member.record.householdIndex === record.householdIndex && member.raw.every((byte, index) => byte === contexts.bytes[ordinal * MOVEMENT_CONTEXT_BYTES + 4 + index]), 'Movement person is absent from, or inconsistent with, its household.');
    usedHouseholds.add(record.householdIndex);
    for (const index of [context.homeBuildingIndex, ...Object.values(context.targets)]) check(index === null || buildings.has(index), 'Movement context references missing building metadata.');
  }
  check(usedHouseholds.size === households.byIndex.size, 'Movement page contains an unrelated household.');
  const decoded = { contract: value.contract, key: value.key, count: value.count, buildings: value.buildings };
  decodedPages.set(decoded, { contexts, households: households.byIndex, buildings });
  return decoded;
}

/** Encode the existing canonical 36-byte roster contexts without person reformatting. */
export function encodeMovementPage({ key, contexts, households, buildings }) {
  check(contexts instanceof Uint8Array && contexts.length > 0 && contexts.length % MOVEMENT_CONTEXT_BYTES === 0 && contexts.length <= MOVEMENT_PAGE_SIZE * MOVEMENT_CONTEXT_BYTES, 'Invalid movement context buffer.');
  const value = { contract: 'DemoMovementPageV2', key, count: contexts.length / MOVEMENT_CONTEXT_BYTES, contextsBase64: toBase64(contexts), households, buildings };
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.length > MAX_MOVEMENT_PAGE_BYTES) pageTooLarge();
  validatePage(value);
  return bytes;
}
export function decodeMovementPage(bytes) {
  return validatePage(readJson(bytes, MAX_MOVEMENT_PAGE_BYTES, true));
}
export function movementContextAt(decoded, ordinal) {
  const state = decodedPages.get(decoded);
  check(state && integer(ordinal, state.contexts.count - 1), 'Movement context ordinal outside decoded page.');
  const context = rosterContextAt(state.contexts, ordinal);
  const districtId = state.buildings.get(context.homeBuildingIndex)?.districtId;
  const districtIndex = DISTRICT_IDS.indexOf(districtId);
  return { ...context, householdRecords: state.households.get(context.record.householdIndex), districtIndex: districtIndex < 0 ? null : districtIndex };
}

/** Preserve both source corridor modes; activity decides which is used later. */
export function decodeMovementCellContext(bytes) {
  const value = readJson(bytes, MAX_MOVEMENT_CELL_CONTEXT_BYTES);
  check(value && value.contract === 'DemoMovementCellContextV2', 'Invalid movement cell context contract.');
  validateKey(value.key);
  check(Array.isArray(value.bindings) && value.bindings.length <= 100_000 && Array.isArray(value.roads) && value.roads.length <= 100_000, 'Invalid movement cell dictionary bounds.');
  const roads = new Map(); const ids = new Set();
  for (const road of value.roads) {
    check(road && integer(road.index) && !roads.has(road.index) && integer(road.sourceRoadIndex) && ['walk', 'car'].includes(road.mode) && road.index === road.sourceRoadIndex * 2 + Number(road.mode === 'car') && text(road.id) && !ids.has(road.id), 'Invalid or duplicate movement corridor identity.');
    check(typeof road.oneway === 'boolean' && typeof road.walkable === 'boolean' && typeof road.drivable === 'boolean' && (road.mode === 'walk' ? road.walkable : road.drivable), 'Invalid movement corridor mode flags.');
    check(Array.isArray(road.coordinates) && road.coordinates.length >= 2 && road.coordinates.length <= 100_000 && road.coordinates.every(position), 'Invalid movement corridor geometry.');
    check(road.connectivity === 'source_node_ids' && road.semantics === 'connected_source_road_local_visual_synthesis_not_home_work_route' && Array.isArray(road.segments) && road.segments.length >= 1 && road.segments.length <= 12 && road.segments.every((segment) => segment && text(segment.fromNodeId) && (segment.toNodeId === null || text(segment.toNodeId))), 'Invalid movement corridor source contract.');
    roads.set(road.index, road); ids.add(road.id);
  }
  const buildings = new Set();
  for (const binding of value.bindings) {
    check(Array.isArray(binding) && binding.length === 3 && integer(binding[0]) && !buildings.has(binding[0]), 'Invalid or duplicate movement cell binding.');
    buildings.add(binding[0]);
    for (let mode = 1; mode <= 2; mode++) {
      const index = binding[mode]; const road = roads.get(index);
      check(index === null || integer(index) && road && road.mode === (mode === 1 ? 'walk' : 'car'), 'Movement binding references a missing or wrong-mode corridor.');
    }
  }
  return value;
}
