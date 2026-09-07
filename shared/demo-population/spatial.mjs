/** Public fictional spatial contracts. No I/O. Potential roles are not occupancy. */
import { BASE_YEAR, END_YEAR, PERSON_SHARD_SIZE, DISTRICT_IDS, hashIndex, isActive, employmentFor, recordAt, scenarioIndex } from './index.mjs';

export const SPATIAL_NONE = 0xffffffff;
export const TARGET_RECORD_BYTES = 12;
export const BUILDING_ROLE_SHARD_SIZE = 256;
export const SPATIAL_ROLES = Object.freeze(['home', 'work', 'study', 'visitor']);
export const MAX_CELL_CANDIDATES = 256;
const HEADER = 32;
const TARGET_MAGIC = 0x32544d4f;
const ROLE_MAGIC = 0x32524d4f;
const integer = (n, max = 9_999_999) => Number.isSafeInteger(n) && n >= 0 && n <= max;
const emptyTargets = () => ({ workBuildingIndex: null, studyBuildingIndex: null, visitorBuildingIndex: null });

function bytesOf(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new Error('Expected spatial binary data.');
}
function header(magic, start, count, stride, extra, length) {
  const bytes = new Uint8Array(length); const view = new DataView(bytes.buffer);
  [magic, 2, start, count, stride, extra, 0, 0].forEach((n, i) => view.setUint32(i * 4, n, true));
  return { bytes, view, startIndex: start, count };
}
function decode(value, magic) {
  const bytes = bytesOf(value); if (bytes.length < HEADER) throw new Error('Truncated spatial header.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== magic || view.getUint32(4, true) !== 2 || view.getUint32(24, true) || view.getUint32(28, true)) throw new Error('Unsupported spatial shard.');
  return { bytes, view, startIndex: view.getUint32(8, true), count: view.getUint32(12, true), stride: view.getUint32(16, true), extra: view.getUint32(20, true) };
}
function buildingIndex(value, count) { return value === SPATIAL_NONE || integer(value, count - 1); }

export function encodeTargetShard(startIndex, values, buildingCount) {
  const count = values.length / 3;
  if (!(values instanceof Uint32Array) || !integer(startIndex) || !integer(count, PERSON_SHARD_SIZE) || !count || startIndex + count > 10_000_000 || !integer(buildingCount) || !buildingCount || values.some((n) => !buildingIndex(n, buildingCount))) throw new Error('Invalid target shard.');
  const shard = header(TARGET_MAGIC, startIndex, count, TARGET_RECORD_BYTES, buildingCount, HEADER + count * TARGET_RECORD_BYTES);
  values.forEach((n, i) => shard.view.setUint32(HEADER + i * 4, n, true)); return shard.bytes;
}
export function decodeTargetShard(value) {
  const shard = decode(value, TARGET_MAGIC);
  if (!shard.count || shard.count > PERSON_SHARD_SIZE || shard.startIndex + shard.count > 10_000_000 || shard.stride !== TARGET_RECORD_BYTES || !integer(shard.extra) || !shard.extra || shard.bytes.length !== HEADER + shard.count * TARGET_RECORD_BYTES) throw new Error('Invalid target shard length.');
  for (let i = 0; i < shard.count * 3; i++) if (!buildingIndex(shard.view.getUint32(HEADER + i * 4, true), shard.extra)) throw new Error('Invalid target building index.');
  return shard;
}
export function targetAt(shard, personIndex) {
  const local = personIndex - shard.startIndex; if (!integer(local, shard.count - 1)) throw new Error('Person outside target shard.');
  const values = Array.from({ length: 3 }, (_, i) => { const n = shard.view.getUint32(HEADER + local * TARGET_RECORD_BYTES + i * 4, true); return n === SPATIAL_NONE ? null : n; });
  return { workBuildingIndex: values[0], studyBuildingIndex: values[1], visitorBuildingIndex: values[2] };
}

export function encodeRoleShard(startBuildingIndex, buildingCount, offsets, members, personCount) {
  if (!integer(startBuildingIndex) || !integer(buildingCount, BUILDING_ROLE_SHARD_SIZE) || !buildingCount || !(offsets instanceof Uint32Array) || !(members instanceof Uint32Array) || offsets.length !== buildingCount * 4 + 1 || !integer(personCount, 10_000_000) || !personCount || offsets[0] !== 0 || offsets.at(-1) !== members.length) throw new Error('Invalid building role CSR.');
  for (let row = 0; row < buildingCount * 4; row++) {
    if (offsets[row] > offsets[row + 1] || offsets[row + 1] > members.length) throw new Error('Invalid role offsets.');
    for (let i = offsets[row]; i < offsets[row + 1]; i++) if (!integer(members[i], personCount - 1) || i > offsets[row] && members[i] <= members[i - 1]) throw new Error('Role members must be sorted and unique.');
  }
  const shard = header(ROLE_MAGIC, startBuildingIndex, buildingCount, 4, personCount, HEADER + (offsets.length + members.length) * 4);
  offsets.forEach((n, i) => shard.view.setUint32(HEADER + i * 4, n, true));
  members.forEach((n, i) => shard.view.setUint32(HEADER + offsets.length * 4 + i * 4, n, true));
  return shard.bytes;
}
export function decodeRoleShard(value) {
  const shard = decode(value, ROLE_MAGIC);
  if (!shard.count || shard.count > BUILDING_ROLE_SHARD_SIZE || shard.stride !== 4 || !integer(shard.extra, 10_000_000) || !shard.extra) throw new Error('Invalid role shard header.');
  shard.memberStart = HEADER + (shard.count * 4 + 1) * 4;
  if (shard.bytes.length < shard.memberStart || (shard.bytes.length - shard.memberStart) % 4) throw new Error('Invalid role shard length.');
  const memberCount = (shard.bytes.length - shard.memberStart) / 4;
  if (shard.view.getUint32(HEADER, true) || shard.view.getUint32(shard.memberStart - 4, true) !== memberCount) throw new Error('Invalid role CSR boundary.');
  for (let row = 0; row < shard.count * 4; row++) {
    const start = shard.view.getUint32(HEADER + row * 4, true); const end = shard.view.getUint32(HEADER + (row + 1) * 4, true);
    if (start > end || end > memberCount) throw new Error('Invalid role CSR offsets.');
    let previous = -1;
    for (let i = start; i < end; i++) { const n = shard.view.getUint32(shard.memberStart + i * 4, true); if (n >= shard.extra || n <= previous) throw new Error('Invalid role CSR member.'); previous = n; }
  }
  return shard;
}
export function roleMembers(shard, buildingIndex, role, { offset = 0, limit = 100 } = {}) {
  const local = buildingIndex - shard.startIndex; const r = SPATIAL_ROLES.indexOf(role);
  if (!integer(local, shard.count - 1) || r < 0 || !integer(offset) || !integer(limit, 1024) || !limit) throw new Error('Invalid role page query.');
  const row = local * 4 + r; const start = shard.view.getUint32(HEADER + row * 4, true); const end = shard.view.getUint32(HEADER + (row + 1) * 4, true);
  const total = end - start; if (offset > total) throw new Error('Role offset outside roster.');
  const count = Math.min(limit, total - offset);
  return { members: Array.from({ length: count }, (_, i) => shard.view.getUint32(shard.memberStart + (start + offset + i) * 4, true)), total, nextOffset: offset + count < total ? offset + count : null };
}

/** Lifetime potential: runtime must re-evaluate employment and membership. */
export function potentialRoles(record) {
  let work = false; let study = false;
  for (let year = record.entryYear; year <= END_YEAR; year++) {
    if (![0, 1, 2].some((s) => record.scenarioMask & (1 << s) && (record.exitYears[s] === null || year < record.exitYears[s]))) continue;
    const employment = employmentFor(record, year); work ||= employment === 'employed'; study ||= employment === 'student';
  }
  return { work, study };
}
export function activeTargets(record, targets, year, scenario) {
  if (!isActive(record, year, scenario)) return emptyTargets();
  const employment = employmentFor(record, year);
  return { workBuildingIndex: employment === 'employed' ? targets.workBuildingIndex : null, studyBuildingIndex: employment === 'student' ? targets.studyBuildingIndex : null, visitorBuildingIndex: year - record.birthYear >= 18 ? targets.visitorBuildingIndex : null };
}

/** Only explicit source retail/public-service attributes imply visitor eligibility. */
export function visitorEligible(building) {
  const attrs = building?.sourceAttributes;
  if (!attrs || !['work', 'study'].includes(building.use)) return false;
  if (['industrial', 'warehouse', 'hangar', 'manufacture'].includes(attrs.building) || attrs.industrial || attrs.landuse === 'industrial' || ['private', 'no'].includes(attrs.access)) return false;
  const shop = typeof attrs.shop === 'string' && !['no', 'vacant', 'closed', 'disused'].includes(attrs.shop);
  return Boolean(shop || attrs.building === 'retail' || ['cafe', 'restaurant', 'fast_food', 'food_court', 'cinema', 'theatre', 'library', 'community_centre', 'arts_centre', 'marketplace', 'post_office', 'bank', 'pharmacy', 'clinic', 'hospital'].includes(attrs.amenity) || ['museum', 'gallery', 'attraction'].includes(attrs.tourism) || ['sports_centre', 'fitness_centre', 'swimming_pool'].includes(attrs.leisure));
}

export function decodeEmbeddedPerson(personIndex, value) {
  if (!integer(personIndex)) throw new Error('Invalid embedded person index.');
  let raw;
  if (typeof value === 'string') {
    if (!/^[A-Za-z0-9+/]{22}==$/.test(value)) throw new Error('Invalid embedded person encoding.');
    const decoded = atob(value); raw = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
  } else raw = bytesOf(value);
  if (raw.length !== 16) throw new Error('Invalid embedded person length.');
  const bytes = new Uint8Array(48); bytes.set(raw, 32);
  return recordAt({ view: new DataView(bytes.buffer), startIndex: personIndex, count: 1 }, personIndex);
}
export function decodeRosterContexts(value) {
  const bytes = bytesOf(value); if (bytes.length % 36 || bytes.length > 64 * 1024 * 1024) throw new Error('Invalid roster context length.');
  return { bytes, view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), count: bytes.length / 36 };
}
export function rosterContextAt(shard, ordinal) {
  if (!integer(ordinal, shard.count - 1)) throw new Error('Roster context outside page.');
  const offset = ordinal * 36; const index = shard.view.getUint32(offset, true); const values = Array.from({ length: 4 }, (_, i) => { const n = shard.view.getUint32(offset + 20 + i * 4, true); return n === SPATIAL_NONE ? null : n; });
  return { record: decodeEmbeddedPerson(index, shard.bytes.subarray(offset + 4, offset + 20)), homeBuildingIndex: values[0], targets: { workBuildingIndex: values[1], studyBuildingIndex: values[2], visitorBuildingIndex: values[3] } };
}

export function householdHasVehicle(householdIndex) { return integer(householdIndex) && hashIndex(householdIndex, 9152026) % 3 === 0; }
function householdTripWindow(householdIndex) { const startMinute = 1200 + hashIndex(householdIndex, 9162026) % 46; return { startMinute, endMinute: startMinute + 45 }; }
/** Fictional shared evening trip: first active adult drives at most seven people. */
export function householdTripFor(householdRecords, year, scenario) {
  if (!Array.isArray(householdRecords) || !householdRecords.length || householdRecords.length > 100) throw new Error('Invalid household trip records.');
  const household = householdRecords[0].householdIndex;
  if (householdRecords.some((record) => record.householdIndex !== household) || new Set(householdRecords.map((record) => record.personIndex)).size !== householdRecords.length) throw new Error('Mixed household trip records.');
  if (!integer(year, END_YEAR) || year < BASE_YEAR) throw new Error('Invalid household trip year.');
  scenarioIndex(scenario);
  if (!householdHasVehicle(household)) return null;
  const active = householdRecords.filter((record) => isActive(record, year, scenario)).sort((a, b) => a.personIndex - b.personIndex);
  const driver = active.find((record) => year - record.birthYear >= 18); if (!driver) return null;
  const passengerIndices = [driver.personIndex, ...active.filter((record) => record !== driver).slice(0, 6).map((record) => record.personIndex)].sort((a, b) => a - b);
  return { householdIndex: household, driverPersonIndex: driver.personIndex, passengerIndices, vehicleId: `demo2-v-${String(driver.personIndex).padStart(7, '0')}`, ...householdTripWindow(household) };
}
export function decodeHouseholdTripMasks(value) {
  const bytes = bytesOf(value); if (bytes.length % 5 || bytes.length > 16 * 1024 * 1024) throw new Error('Invalid household trip masks.');
  for (let i = 4; i < bytes.length; i += 5) if (bytes[i] & 254) throw new Error('Invalid reserved household trip mask bits.');
  return { bytes, count: bytes.length / 5 };
}
export function householdTripParticipantAt(shard, ordinal, year, scenario) {
  if (!integer(ordinal, shard.count - 1) || !integer(year, END_YEAR) || year < BASE_YEAR) throw new Error('Invalid household trip mask context.');
  const bit = scenarioIndex(scenario) * 11 + year - BASE_YEAR;
  return Boolean(shard.bytes[ordinal * 5 + (bit >>> 3)] & (1 << (bit & 7)));
}

/** Area/floor weighted, same-district visual synthesis, never observed capacity. */
export function buildDestinationPools(rows) {
  const pools = new Map();
  rows.forEach((row, buildingIndex) => {
    if (!Array.isArray(row) || !['work', 'study'].includes(row[4]) || !DISTRICT_IDS.includes(row[3])) return;
    if (!Number.isFinite(row[5]) || row[5] <= 0) throw new Error('Invalid classified building area.');
    const floors = Number.isFinite(row[6]) && row[6] > 0 ? row[6] : 1;
    const weight = Math.max(1, Math.min(100_000, row[5] * floors));
    const key = `${row[3]}:${row[4]}`; let pool = pools.get(key);
    if (!pool) { pool = { buildings: [], cumulative: [], total: 0 }; pools.set(key, pool); }
    pool.total += weight; pool.buildings.push(buildingIndex); pool.cumulative.push(pool.total);
  });
  return pools;
}
export function selectDestination(pools, districtId, role, personIndex, seed = 9042026) {
  const pool = pools.get(`${districtId}:${role}`); if (!pool) return null;
  const value = hashIndex(personIndex, seed) / 0x100000000 * pool.total;
  let low = 0; let high = pool.cumulative.length - 1;
  while (low < high) { const middle = (low + high) >>> 1; if (value < pool.cumulative[middle]) high = middle; else low = middle + 1; }
  return pool.buildings[low];
}
export function spatialCellKey(lon, lat, zoom = 16) {
  if (!Number.isFinite(lon) || Math.abs(lon) > 180 || !Number.isFinite(lat) || Math.abs(lat) > 85.05112878 || !integer(zoom, 22)) throw new Error('Invalid spatial cell position.');
  const size = 2 ** zoom;
  const x = Math.min(size - 1, Math.floor((lon + 180) / 360 * size));
  const y = Math.min(size - 1, Math.max(0, Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * size)));
  return `${zoom}/${x}/${y}`;
}

/** Shared profile/roster/frame schedule. Travelling endpoints are not a route. */
export function presenceFor(record, targets, homeBuildingIndex, year, scenario, minutes, { householdRecords, householdTripParticipant = false } = {}) {
  if (!Number.isFinite(minutes) || minutes < 0 || minutes >= 1440 || !integer(year, END_YEAR) || year < BASE_YEAR) throw new Error('Invalid presence time.');
  if (!isActive(record, year, scenario)) return { active: false, role: null, buildingIndex: null };
  if (homeBuildingIndex === null) return { active: true, role: 'unplaced', buildingIndex: null };
  const active = activeTargets(record, targets, year, scenario);
  const trip = householdRecords ? householdTripFor(householdRecords, year, scenario) : null;
  if (trip && trip.householdIndex !== record.householdIndex) throw new Error('Presence household mismatch.');
  const participating = householdRecords ? Boolean(trip?.passengerIndices.includes(record.personIndex)) : householdTripParticipant;
  const sharedWindow = participating ? householdTripWindow(record.householdIndex) : null;
  if (sharedWindow && minutes >= sharedWindow.startMinute && minutes < sharedWindow.endMinute) return { active: true, role: 'leisure', buildingIndex: null, originBuildingIndex: homeBuildingIndex, destinationBuildingIndex: homeBuildingIndex, progress: (minutes - sharedWindow.startMinute) / 45, direction: 'outbound', tripPurpose: 'shared_household_source_road_outing', age: year - record.birthYear, ...(trip ? { vehicleDriverIndex: trip.driverPersonIndex, vehicleId: trip.vehicleId, passengerIndices: trip.passengerIndices } : {}) };
  const householdClock = hashIndex(record.householdIndex, 9102026); const clock = hashIndex(record.personIndex, 9112026);
  const workStart = 450 + householdClock % 210; const studyStart = 450 + householdClock % 60;
  const main = active.workBuildingIndex !== null ? { index: active.workBuildingIndex, role: 'work', start: workStart, end: workStart + 480 }
    : active.studyBuildingIndex !== null ? { index: active.studyBuildingIndex, role: 'study', start: studyStart, end: studyStart + 360 } : null;
  const desiredVisitorStart = 540 + clock % 675;
  // Preserve work/study and their travel windows. A conflicting visit moves to
  // the available evening interval rather than counting one person twice.
  const visitorStart = main && desiredVisitorStart < main.end + 30 && desiredVisitorStart + 45 > main.start - 30
    ? main.end + 30 + clock % Math.max(1, 1216 - main.end - 30)
    : desiredVisitorStart;
  const visitorConflicts = sharedWindow && visitorStart - 30 < sharedWindow.endMinute && visitorStart + 75 > sharedWindow.startMinute;
  const windows = [...(main ? [main] : []), ...(active.visitorBuildingIndex !== null && !visitorConflicts ? [{ index: active.visitorBuildingIndex, role: 'visitor', start: visitorStart, end: visitorStart + 45 }] : [])];
  // One authored local outing, spread over daytime rather than a synchronized
  // rush-hour animation. It follows only a bound source road, not a claimed trip.
  const leisureStart = 540 + clock % 420;
  if (minutes >= leisureStart && minutes < leisureStart + 45) {
    const origin = windows.find((window) => leisureStart >= window.start && leisureStart + 45 <= window.end)?.index ?? homeBuildingIndex;
    // Do not overlap a scheduled main/visitor commute or cross its endpoint.
    const overlaps = windows.some((window) => leisureStart < window.start && leisureStart + 45 > window.start - 30 || leisureStart < window.end + 30 && leisureStart + 45 > window.end);
    if (!overlaps) return { active: true, role: 'leisure', buildingIndex: null, originBuildingIndex: origin, destinationBuildingIndex: origin, progress: (minutes - leisureStart) / 45, direction: 'outbound', tripPurpose: 'local_source_road_outing', age: year - record.birthYear };
  }
  for (const window of windows) {
    if (minutes >= window.start && minutes < window.end) return { active: true, role: window.role, buildingIndex: window.index };
    if (minutes >= window.start - 30 && minutes < window.start) return { active: true, role: 'travel', buildingIndex: null, originBuildingIndex: homeBuildingIndex, destinationBuildingIndex: window.index, progress: (minutes - window.start + 30) / 30, direction: 'outbound', age: year - record.birthYear };
    if (minutes >= window.end && minutes < window.end + 30) return { active: true, role: 'travel', buildingIndex: null, originBuildingIndex: window.index, destinationBuildingIndex: homeBuildingIndex, progress: (minutes - window.end) / 30, direction: 'return', age: year - record.birthYear };
  }
  return { active: true, role: 'home', buildingIndex: homeBuildingIndex };
}

const roadMetrics = new WeakMap();
function metricsFor(road) {
  if (roadMetrics.has(road)) return roadMetrics.get(road);
  const lengths = []; let total = 0;
  for (let i = 1; i < road.coordinates.length; i++) {
    const a = road.coordinates[i - 1]; const b = road.coordinates[i];
    if (![a, b].every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 85.05112878)) throw new Error('Invalid movement source road.');
    const length = Math.hypot((b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180), b[1] - a[1]) * 111_195;
    lengths.push(length); total += length;
  }
  const a = road.coordinates[0]; const b = road.coordinates.at(-1);
  const samePosition = a[0] === b[0] && a[1] === b[1];
  const closed = samePosition && (road.segments?.length ? road.segments[0].fromNodeId === road.segments.at(-1).toNodeId : road.closed === true);
  const metrics = { lengths, total, closed }; roadMetrics.set(road, metrics); return metrics;
}

/** Physical-speed local presentation, never an inferred building-to-building trip. */
export function dailyMovement(record, presence, { walkRoad = null, carRoad = null } = {}, minutes) {
  if (!presence?.active || !['travel', 'leisure'].includes(presence.role)) return null;
  if (!Number.isFinite(minutes) || minutes < 0 || minutes >= 1440 || !Number.isFinite(presence.progress) || presence.progress < 0 || presence.progress > 1) throw new Error('Invalid movement time.');
  const shared = presence.tripPurpose === 'shared_household_source_road_outing';
  if (shared && (!carRoad?.drivable || !integer(presence.vehicleDriverIndex))) return null;
  const driving = shared || presence.age >= 18 && hashIndex(record.personIndex, 9122026) % 3 === 0 && carRoad?.drivable === true;
  const road = driving ? carRoad : walkRoad?.walkable === true ? walkRoad : null;
  if (!road || !Array.isArray(road.coordinates) || road.coordinates.length < 2) return null;
  const { lengths, total, closed } = metricsFor(road); if (total === 0) return null;
  const driverIndex = shared ? presence.vehicleDriverIndex : record.personIndex;
  const speedMps = driving ? 7 + hashIndex(driverIndex, 9172026) % 4 : 1.2;
  const routeMode = closed ? 'loop' : road.oneway ? 'once' : 'ping_pong';
  const travelSeconds = total / speedMps;
  const period = routeMode === 'once' ? travelSeconds + 6 : routeMode === 'ping_pong' ? travelSeconds * 2 : travelSeconds;
  const seconds = (minutes * 60 + hashIndex(driverIndex, 9192026) / 0x100000000 * period) % period;
  // The terminal reset of an open one-way corridor is hidden, never reversed
  // or interpolated as an aerial shortcut. Indoor presence is unchanged.
  if (routeMode === 'once' && seconds >= travelSeconds) return null;
  const reverse = routeMode === 'ping_pong' && seconds > travelSeconds;
  const traveled = reverse ? total * 2 - seconds * speedMps : seconds * speedMps;
  const progress = Math.max(0, Math.min(1, traveled / total));
  const endpointOpacity = routeMode === 'once' ? Math.max(0, Math.min(1, traveled / 15, (total - traveled) / 15)) : 1;
  let distance = progress * total; let segment = 0;
  while (segment < lengths.length - 1 && distance > lengths[segment]) distance -= lengths[segment++];
  const a = road.coordinates[segment]; const b = road.coordinates[segment + 1]; const t = lengths[segment] ? distance / lengths[segment] : 0;
  return { longitude: a[0] + (b[0] - a[0]) * t, latitude: a[1] + (b[1] - a[1]) * t, heading: (Math.atan2((b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180), b[1] - a[1]) * 180 / Math.PI + (reverse ? 180 : 0) + 360) % 360, routeId: road.id, progress, mode: driving ? 'vehicle' : 'pedestrian', vehicleId: driving ? `demo2-v-${String(driverIndex).padStart(7, '0')}` : null, direction: reverse ? 'reverse' : 'forward', speedMps, routeMode, endpointOpacity, semantics: 'source_polyline_presentation_not_commute_corridor' };
}
