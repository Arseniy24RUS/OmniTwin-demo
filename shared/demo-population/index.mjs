/** Pure browser/Node codec for public fictional residents. No I/O or credentials. */
export const DATASET_ID = 'omnitwin-fictional-city-v2';
export const BASE_YEAR = 2026;
export const END_YEAR = 2036;
export const PERSON_SHARD_SIZE = 8192;
export const HOUSEHOLD_SHARD_SIZE = 4096;
export const RECORD_BYTES = 16;
export const HEADER_BYTES = 32;
export const SCENARIO_IDS = Object.freeze(['baseline', 'inflow', 'ageing']);
export const DISTRICT_IDS = Object.freeze(['RU-CHE-SET-CEN', 'RU-CHE-SET-KAL', 'RU-CHE-SET-KUR', 'RU-CHE-SET-LEN', 'RU-CHE-SET-MET', 'RU-CHE-SET-SOV', 'RU-CHE-SET-TRA']);
const PERSON_MAGIC = 0x32504d4f;
const HOUSEHOLD_MAGIC = 0x32484d4f;
const NONE = 0xffffffff;
const ROLES = ['head', 'partner', 'child', 'other'];
const ENTRIES = ['initial', 'birth', 'immigration'];
const EXITS = [null, 'death', 'emigration'];
const integer = (value, max = 9_999_999) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const indexId = (prefix, value) => { if (!integer(value)) throw new Error('Invalid resident index.'); return `${prefix}${String(value).padStart(7, '0')}`; };
export const personId = (index) => indexId('demo2-p-', index);
export const householdId = (index) => indexId('demo2-h-', index);
export function parsePersonId(id) { return typeof id === 'string' && /^demo2-p-\d{7}$/.test(id) ? Number(id.slice(8)) : null; }
export function scenarioIndex(scenario) { const index = SCENARIO_IDS.indexOf(scenario); if (index < 0) throw new Error('Invalid fictional scenario.'); return index; }
export function hashIndex(value, seed = 8082026) {
  let hash = (value ^ seed) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  return (hash ^ (hash >>> 16)) >>> 0;
}
export function stableHash(value) { let hash = 2166136261; for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619); return hash >>> 0; }
function bytesOf(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new Error('Expected binary population shard.');
}
function viewOf(bytes) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
function header(bytes, magic, start, count, stride, members = 0) {
  const view = viewOf(bytes);
  [magic, 2, start, count, stride, members, 0, 0].forEach((n, i) => view.setUint32(i * 4, n, true));
  return view;
}
function decoded(value, magic) {
  const bytes = bytesOf(value); if (bytes.length < HEADER_BYTES) throw new Error('Truncated population header.');
  const view = viewOf(bytes);
  if (view.getUint32(0, true) !== magic || view.getUint32(4, true) !== 2 || view.getUint32(24, true) || view.getUint32(28, true)) throw new Error('Unsupported population shard.');
  return { bytes, view, startIndex: view.getUint32(8, true), count: view.getUint32(12, true), stride: view.getUint32(16, true), memberCount: view.getUint32(20, true) };
}
export function writePersonRecord(view, offset, record) {
  const role = ROLES.indexOf(record.householdRole ?? 'head'); const entry = ENTRIES.indexOf(record.entryReason ?? 'initial');
  if (!integer(record.householdIndex) || !integer(record.birthYear, END_YEAR) || record.birthYear < 1900 || record.birthYear > record.entryYear || !['male', 'female'].includes(record.sex) || role < 0 || entry < 0 || !integer(record.scenarioMask, 7) || record.scenarioMask === 0 || !integer(record.entryYear - BASE_YEAR, 10)) throw new Error('Invalid compact resident.');
  view.setUint32(offset, record.householdIndex, true); view.setUint16(offset + 4, record.birthYear, true);
  view.setUint8(offset + 6, record.sex === 'female' ? 1 : 0); view.setUint8(offset + 7, role | (entry << 4));
  view.setUint8(offset + 8, record.scenarioMask); view.setUint8(offset + 9, record.entryYear - BASE_YEAR);
  for (let s = 0; s < 3; s++) {
    const year = record.exitYears?.[s] ?? null; const reason = EXITS.indexOf(record.exitReasons?.[s] ?? null);
    if (reason < 0 || (year === null) !== (reason === 0) || year !== null && (!integer(year - BASE_YEAR, 10) || year <= record.entryYear)) throw new Error('Invalid resident lifetime.');
    view.setUint8(offset + 10 + s, year === null ? 0 : year - BASE_YEAR); view.setUint8(offset + 13 + s, reason);
  }
}
export function encodePersonShard(startIndex, records) {
  const raw = ArrayBuffer.isView(records) ? bytesOf(records) : null;
  const count = raw ? raw.length / RECORD_BYTES : records.length;
  if (!integer(startIndex) || !integer(count, PERSON_SHARD_SIZE) || !count || startIndex + count > 10_000_000) throw new Error('Invalid person shard range.');
  const bytes = new Uint8Array(HEADER_BYTES + count * RECORD_BYTES); const view = header(bytes, PERSON_MAGIC, startIndex, count, RECORD_BYTES);
  if (raw) bytes.set(raw, HEADER_BYTES);
  else records.forEach((record, i) => writePersonRecord(view, HEADER_BYTES + i * RECORD_BYTES, record));
  return bytes;
}
export function decodePersonShard(value) {
  const shard = decoded(value, PERSON_MAGIC);
  if (!shard.count || shard.count > PERSON_SHARD_SIZE || shard.stride !== RECORD_BYTES || shard.memberCount !== 0 || shard.startIndex + shard.count > 10_000_000 || shard.bytes.length !== HEADER_BYTES + shard.count * RECORD_BYTES) throw new Error('Invalid person shard length.');
  return shard;
}
export function recordAt(shard, personIndex) {
  const local = personIndex - shard.startIndex;
  if (!integer(local, shard.count - 1)) throw new Error('Person index outside shard.');
  const offset = HEADER_BYTES + local * RECORD_BYTES; const view = shard.view;
  const householdIndex = view.getUint32(offset, true); const role = view.getUint8(offset + 7);
  const record = { personIndex, id: personId(personIndex), householdIndex, householdId: householdId(householdIndex), birthYear: view.getUint16(offset + 4, true), sex: view.getUint8(offset + 6) === 1 ? 'female' : 'male', householdRole: ROLES[role & 15], scenarioMask: view.getUint8(offset + 8), entryYear: BASE_YEAR + view.getUint8(offset + 9), entryReason: ENTRIES[role >>> 4], exitYears: [], exitReasons: [] };
  if (view.getUint8(offset + 6) > 1 || !record.householdRole || !record.entryReason || record.birthYear < 1900 || record.birthYear > record.entryYear || record.entryYear > END_YEAR || record.scenarioMask < 1 || record.scenarioMask > 7) throw new Error('Invalid person shard record.');
  for (let s = 0; s < 3; s++) {
    const exit = view.getUint8(offset + 10 + s); const reason = view.getUint8(offset + 13 + s);
    if (exit > 10 || reason > 2 || (exit === 0) !== (reason === 0) || exit && BASE_YEAR + exit <= record.entryYear) throw new Error('Invalid person shard membership.');
    record.exitYears.push(exit ? BASE_YEAR + exit : null); record.exitReasons.push(EXITS[reason]);
  }
  return record;
}
export function isActive(record, year, scenario) {
  const s = scenarioIndex(scenario);
  return Number.isInteger(year) && year >= BASE_YEAR && year <= END_YEAR && Boolean(record.scenarioMask & (1 << s)) && record.entryYear <= year && (record.exitYears[s] === null || record.exitYears[s] > year);
}
export function recordForScenario(record, scenario) { const s = scenarioIndex(scenario); return { ...record, exitYear: record.exitYears[s], exitReason: record.exitReasons[s] }; }
export function encodeHouseholdShard(startIndex, households) {
  const count = households.length; const memberCount = households.reduce((n, row) => n + row.members.length, 0);
  if (!integer(startIndex) || !integer(count, HOUSEHOLD_SHARD_SIZE) || !count || !integer(memberCount, count * 100)) throw new Error('Invalid household shard range.');
  const bytes = new Uint8Array(HEADER_BYTES + count * 8 + (count + 1 + memberCount) * 4);
  const view = header(bytes, HOUSEHOLD_MAGIC, startIndex, count, 8, memberCount); const offsetStart = HEADER_BYTES + count * 8; const memberStart = offsetStart + (count + 1) * 4;
  let cursor = 0;
  households.forEach((row, i) => {
    if (!row.members.length || row.members.some((member) => !integer(member)) || new Set(row.members).size !== row.members.length || row.homeBuildingIndex != null && !integer(row.homeBuildingIndex) || row.districtIndex != null && !integer(row.districtIndex, 6)) throw new Error('Invalid household membership.');
    view.setUint32(HEADER_BYTES + i * 8, row.homeBuildingIndex ?? NONE, true); view.setUint8(HEADER_BYTES + i * 8 + 4, row.districtIndex ?? 255);
    view.setUint32(offsetStart + i * 4, cursor, true);
    for (const member of row.members) view.setUint32(memberStart + cursor++ * 4, member, true);
  });
  view.setUint32(offsetStart + count * 4, cursor, true); return bytes;
}
export function decodeHouseholdShard(value) {
  const shard = decoded(value, HOUSEHOLD_MAGIC);
  if (!shard.count || shard.count > HOUSEHOLD_SHARD_SIZE || shard.stride !== 8 || shard.memberCount > shard.count * 100 || shard.bytes.length !== HEADER_BYTES + shard.count * 8 + (shard.count + 1 + shard.memberCount) * 4) throw new Error('Invalid household shard length.');
  shard.offsetStart = HEADER_BYTES + shard.count * 8; shard.memberStart = shard.offsetStart + (shard.count + 1) * 4;
  if (shard.view.getUint32(shard.offsetStart, true) !== 0 || shard.view.getUint32(shard.offsetStart + shard.count * 4, true) !== shard.memberCount) throw new Error('Invalid household CSR boundary.');
  return shard;
}
export function householdMembers(shard, householdIndex) {
  const local = householdIndex - shard.startIndex; if (!integer(local, shard.count - 1)) throw new Error('Household index outside shard.');
  const start = shard.view.getUint32(shard.offsetStart + local * 4, true); const end = shard.view.getUint32(shard.offsetStart + (local + 1) * 4, true);
  if (start > end || end > shard.memberCount || end - start > 100) throw new Error('Invalid household CSR offsets.');
  const home = shard.view.getUint32(HEADER_BYTES + local * 8, true); const district = shard.view.getUint8(HEADER_BYTES + local * 8 + 4);
  if (district !== 255 && district > 6) throw new Error('Invalid household district.');
  return { householdIndex, homeBuildingIndex: home === NONE ? null : home, districtIndex: district === 255 ? null : district, members: Array.from({ length: end - start }, (_, i) => shard.view.getUint32(shard.memberStart + (start + i) * 4, true)) };
}
export const coarseAgeBand = (age) => age < 18 ? '0-17' : age < 35 ? '18-34' : age < 55 ? '35-54' : age < 70 ? '55-69' : '70+';
export function employmentFor(record, year) {
  const age = year - record.birthYear; const h = hashIndex(record.personIndex, 142);
  return age < 7 ? 'child' : age < 18 || age < 23 && h % 3 !== 0 ? 'student' : age >= 65 ? 'retired' : h % 13 === 0 ? 'not_employed' : 'employed';
}
const NAMES = { female: ['Анна', 'Мария', 'Елена', 'Ольга', 'София', 'Наталья', 'Ирина', 'Алина', 'Валерия', 'Дарья', 'Вера', 'Полина'], male: ['Александр', 'Михаил', 'Андрей', 'Дмитрий', 'Иван', 'Артём', 'Сергей', 'Денис', 'Павел', 'Максим', 'Роман', 'Никита'] };
const SURNAMES = ['Волков', 'Соколов', 'Морозов', 'Лебедев', 'Орлов', 'Кузнецов', 'Белов', 'Зайцев', 'Смирнов', 'Попов', 'Крылов', 'Миронов', 'Фролов'];
const JOBS = ['учитель', 'инженер', 'врач', 'дизайнер', 'специалист по логистике', 'библиотекарь', 'технолог', 'разработчик', 'повар', 'архитектор'];
const INTERESTS = ['прогулки по набережной', 'книги', 'велосипед', 'фотография', 'театр', 'садоводство', 'музыка', 'история города', 'спорт', 'рисование'];
export function profileFor(record, year, scenario, { householdSize, territoryId = 'RU-CHE-SET', territoryName = 'Челябинск' } = {}) {
  if (!isActive(record, year, scenario) || !integer(householdSize, 100) || !householdSize) throw new Error('Unavailable fictional profile context.');
  const h = hashIndex(record.personIndex); const employment = employmentFor(record, year);
  const name = `${NAMES[record.sex][h % 12]} ${SURNAMES[(h >>> 8) % SURNAMES.length]}${record.sex === 'female' ? 'а' : ''}`;
  const occupation = employment === 'employed' ? JOBS[(h >>> 12) % JOBS.length] : { child: 'дошкольник', student: 'учащийся', retired: 'пенсионер', not_employed: 'сейчас не работает' }[employment];
  const interests = [...new Set([INTERESTS[(h >>> 16) % 10], INTERESTS[(h >>> 20) % 10]])];
  return { contract: 'PublicFictionalPersonV1', id: record.id, name, age: year - record.birthYear, ageBand: coarseAgeBand(year - record.birthYear), sex: record.sex, employment, occupation, householdId: record.householdId, householdSize, territoryId, territoryName, biography: `Вымышленный житель демонстрационного Челябинска. ${occupation[0].toUpperCase() + occupation.slice(1)}. Интересы: ${interests.join(', ')}. Биография и размещение созданы для интерфейса и не описывают реального человека.`, interests, scenario, demographicYear: year, datasetId: DATASET_ID, representation: 'fictional_demo', spatialRepresentation: 'visual_synthesis', isFictional: true };
}
