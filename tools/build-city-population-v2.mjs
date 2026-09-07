/** Deterministic public-fiction compiler. Never reads research microdata or keys. */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setPriority, constants } from 'node:os';
import { DATASET_ID, BASE_YEAR, END_YEAR, SCENARIO_IDS, DISTRICT_IDS, PERSON_SHARD_SIZE, HOUSEHOLD_SHARD_SIZE, RECORD_BYTES, hashIndex, encodePersonShard, encodeHouseholdShard } from '../shared/demo-population/index.mjs';

const AGE_BANDS = ['0-17', '18-34', '35-54', '55-69', '70+'];
const EMPLOYMENT = ['child', 'student', 'employed', 'retired', 'not_employed'];
const SEXES = ['male', 'female'];
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NONE = 0xffffffff;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (condition, message) => { if (!condition) throw new Error(message); };
export function authoredFlows(scenario, year, population) {
  const step = year - BASE_YEAR;
  fail(SCENARIO_IDS.includes(scenario) && step >= 1 && step <= 10, 'Invalid authored flow context.');
  const raw = scenario === 'inflow' ? [108 + step, 86 + step, 236, 86] : scenario === 'ageing' ? [68 - step, 112 + 2 * step, 48, 110] : [95 - step, 89 + step, 111, 96];
  return Object.fromEntries(['births', 'deaths', 'immigration', 'emigration'].map((key, i) => [key, Math.round(raw[i] * population / 8246)]));
}
export function expandReference(reference) {
  fail(reference.year === 2024 && reference.ageSex?.length === 21 && Number.isSafeInteger(reference.population) && reference.population > 0, 'Expected reviewed 2024 reference with 21 age bands.');
  const pools = [new Uint32Array(106), new Uint32Array(106)];
  for (let band = 0; band < 21; band++) {
    const row = reference.ageSex[band]; const expected = band === 20 ? '100+' : `${band * 5}-${band * 5 + 4}`;
    fail(row.ageBand === expected, 'Reference age partition is incomplete.');
    const width = band === 20 ? 6 : 5;
    for (let sex = 0; sex < 2; sex++) {
      const count = row[SEXES[sex]]; fail(Number.isSafeInteger(count) && count >= 0, 'Reference counts must be nonnegative integers.');
      const rotation = hashIndex(band, sex + 424) % width;
      for (let k = 0; k < width; k++) pools[sex][band * 5 + ((k + rotation) % width)] = Math.floor(count / width) + (k < count % width ? 1 : 0);
    }
  }
  const totals = pools.map((pool) => pool.reduce((a, b) => a + b, 0));
  fail(totals[0] === reference.male && totals[1] === reference.female && totals[0] + totals[1] === reference.population, 'Reference totals do not reconcile.');
  return pools;
}
/** Small fixture and full compiler use exactly the same typed-array implementation. */
export function buildPopulation(reference) {
  const pools = expandReference(reference); const initialPopulation = reference.population;
  let capacity = initialPopulation;
  for (const scenario of SCENARIO_IDS) for (let year = 2027; year <= END_YEAR; year++) { const flow = authoredFlows(scenario, year, initialPopulation); capacity += flow.births + flow.immigration; }
  fail(capacity < 10_000_000, 'Population capacity exceeds codec contract.');
  const bytes = new Uint8Array(capacity * RECORD_BYTES); const view = new DataView(bytes.buffer);
  const dependent = new Uint8Array(capacity); const householdMemberCounts = new Uint16Array(capacity);
  let recordCount = 0; let householdCount = 0;
  function append(household, age, sex, role, entryReason = 0, scenarioMask = 7, year = BASE_YEAR) {
    fail(recordCount < capacity && age >= 0 && age <= 126 && householdMemberCounts[household] < 100, 'Synthetic population capacity violated.');
    const offset = recordCount * RECORD_BYTES;
    view.setUint32(offset, household, true); view.setUint16(offset + 4, year - age, true);
    bytes[offset + 6] = sex; bytes[offset + 7] = role | entryReason << 4; bytes[offset + 8] = scenarioMask; bytes[offset + 9] = year - BASE_YEAR;
    if (age < 18) dependent[household] |= scenarioMask;
    householdMemberCounts[household]++;
    return recordCount++;
  }
  function take(sex, minimum, maximum, preferred) {
    minimum = Math.max(0, minimum); maximum = Math.min(105, maximum); preferred = Math.max(minimum, Math.min(maximum, preferred));
    for (let distance = 0; distance <= maximum - minimum; distance++) {
      for (const age of distance === 0 ? [preferred] : [preferred + distance, preferred - distance]) {
        if (age >= minimum && age <= maximum && pools[sex][age]) { pools[sex][age]--; return { age, sex }; }
      }
    }
    return null;
  }
  function oldest(minimum, maximum) {
    for (let age = maximum; age >= minimum; age--) for (let sex = 0; sex < 2; sex++) if (pools[sex][age]) { pools[sex][age]--; return { age, sex }; }
    return null;
  }
  // Authored family construction: every minor starts with an adult at least 18 years older.
  // Within-band single ages and household relationships are assumptions, not observations.
  let child;
  while ((child = oldest(0, 17))) {
    const h = hashIndex(householdCount); const guardian = take(1, child.age + 20, Math.min(65, child.age + 40), child.age + 27 + h % 8) ?? take(0, child.age + 18, 70, child.age + 30);
    fail(guardian, 'Insufficient adult guardians in reference fixture.');
    const household = householdCount++; append(household, guardian.age, guardian.sex, 0);
    if (h % 10 < 8) {
      const partner = take(1 - guardian.sex, Math.max(18, child.age + 18, guardian.age - 6), Math.min(75, guardian.age + 8), guardian.age + (h >>> 8) % 5 - 2);
      if (partner) append(household, partner.age, partner.sex, 1);
    }
    append(household, child.age, child.sex, 2);
    const siblings = h % 20 < 3 ? 2 : h % 20 < 15 ? 1 : 0;
    for (let k = 0; k < siblings; k++) { const sibling = oldest(0, child.age); if (sibling) append(household, sibling.age, sibling.sex, 2); }
  }
  let adult;
  while ((adult = oldest(18, 105))) {
    const household = householdCount++; const h = hashIndex(household, 926); append(household, adult.age, adult.sex, 0);
    const probability = adult.age >= 80 ? 4 : adult.age < 25 ? 5 : 8;
    if (h % 10 < probability) { const partner = take(1 - adult.sex, Math.max(18, adult.age - 9), Math.min(105, adult.age + 6), adult.age - h % 4); if (partner) append(household, partner.age, partner.sex, 1); }
  }
  fail(recordCount === initialPopulation, 'Initial population synthesis did not exhaust reference.');
  const initialHouseholdCount = householdCount;
  const active = (index, scenario, offsetYear) => { const o = index * RECORD_BYTES; return (bytes[o + 8] & (1 << scenario)) && bytes[o + 9] <= offsetYear && (!bytes[o + 10 + scenario] || bytes[o + 10 + scenario] > offsetYear); };
  const exit = (index, scenario, step, reason) => { const o = index * RECORD_BYTES; fail(active(index, scenario, step - 1), 'Invalid synthetic event transition.'); bytes[o + 10 + scenario] = step; bytes[o + 13 + scenario] = reason; };
  const events = [];
  for (let scenario = 0; scenario < 3; scenario++) {
    let expected = initialPopulation;
    for (let year = 2027; year <= END_YEAR; year++) {
      const step = year - BASE_YEAR; const flow = authoredFlows(SCENARIO_IDS[scenario], year, initialPopulation);
      // Explicit oldest-first illustrative death ordering, not a calibrated mortality model.
      const ageCounts = new Uint32Array(137);
      for (let index = 0; index < recordCount; index++) if (active(index, scenario, step - 1)) ageCounts[year - view.getUint16(index * 16 + 4, true)]++;
      let remaining = flow.deaths; let cutoff = 136;
      while (cutoff > 0 && ageCounts[cutoff] < remaining) remaining -= ageCounts[cutoff--];
      let deaths = 0;
      for (let index = 0; index < recordCount; index++) if (active(index, scenario, step - 1)) {
        const age = year - view.getUint16(index * 16 + 4, true);
        if (age > cutoff || age === cutoff && remaining > 0) { exit(index, scenario, step, 1); deaths++; if (age === cutoff) remaining--; }
      }
      fail(deaths === flow.deaths, 'Death count cannot be satisfied.');
      // Stable permutation prevents first-row or district truncation. Families with minors stay intact.
      let emigrated = 0; const start = hashIndex(year, scenario + 2036) % recordCount;
      for (let n = 0; n < recordCount && emigrated < flow.emigration; n++) {
        const index = (start + n) % recordCount; const o = index * 16; const age = year - view.getUint16(o + 4, true);
        if (active(index, scenario, step) && age >= 18 && age <= 64 && !(dependent[view.getUint32(o, true)] & (1 << scenario))) { exit(index, scenario, step, 2); emigrated++; }
      }
      fail(emigrated === flow.emigration, 'Emigration count cannot be satisfied without splitting dependent families.');
      const motherStart = hashIndex(year, 1600 + scenario) % recordCount; let birthCount = 0;
      for (let n = 0; n < recordCount && birthCount < flow.births; n++) {
        const index = (motherStart + n) % recordCount; const o = index * 16; const age = year - view.getUint16(o + 4, true); const household = view.getUint32(o, true);
        if (active(index, scenario, step) && bytes[o + 6] === 1 && age >= 22 && age <= 42 && householdMemberCounts[household] < 90) { append(household, 0, hashIndex(birthCount, year) % 2, 2, 1, 1 << scenario, year); birthCount++; }
      }
      fail(birthCount === flow.births, 'Birth count cannot be satisfied by active adult households.');
      for (let n = 0; n < flow.immigration;) {
        const household = householdCount++; const h = hashIndex(n, year + scenario * 100); const size = Math.min(flow.immigration - n, h % 5 ? 2 : 1); const age = 20 + h % 36;
        for (let k = 0; k < size; k++, n++) append(household, Math.max(18, age + k * 2), (h + k) % 2, k ? 1 : 0, 2, 1 << scenario, year);
      }
      expected += flow.births - flow.deaths + flow.immigration - flow.emigration;
      let actual = 0; for (let index = 0; index < recordCount; index++) if (active(index, scenario, step)) actual++;
      fail(actual === expected, 'Population event conservation failed.');
      events.push({ scenario: SCENARIO_IDS[scenario], year, ...flow, previousPopulation: expected - flow.births + flow.deaths - flow.immigration + flow.emigration, population: actual, residual: 0 });
    }
  }
  fail(recordCount === capacity, 'Record capacity did not reconcile.');
  const offsets = new Uint32Array(householdCount + 1);
  for (let household = 0; household < householdCount; household++) offsets[household + 1] = offsets[household] + householdMemberCounts[household];
  const members = new Uint32Array(recordCount); const cursors = offsets.slice(0, householdCount);
  for (let index = 0; index < recordCount; index++) members[cursors[view.getUint32(index * 16, true)]++] = index;
  return { bytes, view, initialPopulation, initialHouseholdCount, recordCount, householdCount, offsets, members, events, reference };
}

export function assignHomes(population, index) {
  fail(Array.isArray(index.columns) && index.columns.slice(0, 10).join('|') === 'id|lon|lat|districtId|use|areaM2|levels|heightM|capacityWeight|classificationProvenance' && Array.isArray(index.rows), 'Unsupported geographical building index.');
  const eligible = []; const cumulative = []; const capacities = []; let total = 0;
  for (let i = 0; i < index.rows.length; i++) {
    const row = index.rows[i]; const district = DISTRICT_IDS.indexOf(row[3]);
    if (row[4] === 'residential' && district >= 0 && Number.isFinite(row[8]) && row[8] > 0) { eligible.push(i); total += row[8]; cumulative.push(total); capacities.push(Math.max(1, Math.floor(row[8]))); }
  }
  fail(total > 0, 'No source-classified residential capacity is available.');
  const homes = new Uint32Array(population.householdCount); const districts = new Uint8Array(population.householdCount);
  const used = new Uint32Array(eligible.length * 33); let fallbackScans = 0; let maximumOccupancyRatio = 0;
  const pick = (target) => { let lo = 0; let hi = eligible.length - 1; while (lo < hi) { const middle = (lo + hi) >>> 1; if (cumulative[middle] > target) hi = middle; else lo = middle + 1; } return lo; };
  for (let household = 0; household < population.householdCount; household++) {
    const counts = new Uint8Array(33);
    for (let member = population.offsets[household]; member < population.offsets[household + 1]; member++) {
      const offset = population.members[member] * RECORD_BYTES; const raw = population.bytes;
      for (let scenario = 0; scenario < 3; scenario++) if (raw[offset + 8] & (1 << scenario)) {
        const exit = raw[offset + 10 + scenario] || 11;
        for (let year = raw[offset + 9]; year < exit; year++) counts[scenario * 11 + year]++;
      }
    }
    const fits = (candidate) => { const base = candidate * 33; for (let context = 0; context < 33; context++) if (used[base + context] + counts[context] > capacities[candidate]) return false; return true; };
    let selected = -1;
    for (let attempt = 0; attempt < 64; attempt++) { const candidate = pick(hashIndex(household, 74702026 + attempt * 100003) / 4294967296 * total); if (fits(candidate)) { selected = candidate; break; } }
    if (selected < 0) {
      fallbackScans++; const start = hashIndex(household, 3737) % eligible.length;
      for (let attempt = 0; attempt < eligible.length; attempt++) { const candidate = (start + attempt) % eligible.length; if (fits(candidate)) { selected = candidate; break; } }
    }
    fail(selected >= 0, 'No source-backed residential capacity fits a whole household across all scenario/year states.');
    for (let context = 0; context < 33; context++) { const slot = selected * 33 + context; used[slot] += counts[context]; maximumOccupancyRatio = Math.max(maximumOccupancyRatio, used[slot] / capacities[selected]); }
    homes[household] = eligible[selected]; districts[household] = DISTRICT_IDS.indexOf(index.rows[eligible[selected]][3]);
  }
  return { homes, districts, eligibleResidentialBuildings: eligible.length, totalCapacityWeight: total, syntheticCapacity: capacities.reduce((a, b) => a + b, 0), maximumOccupancyRatio, fallbackScans, unplacedHouseholds: 0 };
}
export function summarizePopulation(population, placement) {
  const snapshots = []; const view = population.view; const bytes = population.bytes;
  const queryIndex = { contract: 'DemoPopulationQueryIndexV2', datasetId: DATASET_ID, personShardSize: PERSON_SHARD_SIZE, axes: { districts: DISTRICT_IDS, ageBands: AGE_BANDS, sexes: SEXES, employment: EMPLOYMENT }, cohortCode: 'districtIndex*50 + ageBandIndex*10 + sexIndex*5 + employmentIndex', contexts: [], shards: Array.from({ length: Math.ceil(population.recordCount / PERSON_SHARD_SIZE) }, (_, i) => ({ startIndex: i * PERSON_SHARD_SIZE, count: Math.min(PERSON_SHARD_SIZE, population.recordCount - i * PERSON_SHARD_SIZE), contexts: [] })) };
  for (let scenario = 0; scenario < 3; scenario++) for (let year = BASE_YEAR; year <= END_YEAR; year++) {
    const step = year - BASE_YEAR;
    const shardFacets = new Uint16Array(queryIndex.shards.length * 350);
    queryIndex.contexts.push({ scenario: SCENARIO_IDS[scenario], year });
    const rows = ['RU-CHE-SET', ...DISTRICT_IDS].map((territoryId) => ({ datasetId: DATASET_ID, scenario: SCENARIO_IDS[scenario], year, stockAsOf: `${year}-01-01`, territoryId, population: 0, ageSex: AGE_BANDS.map((ageBand) => ({ ageBand, male: 0, female: 0 })), ageSexFine: Array.from({ length: 21 }, (_, band) => ({ ageBand: band === 20 ? '100+' : `${band * 5}-${band * 5 + 4}`, male: 0, female: 0 })), births: step ? 0 : null, deaths: step ? 0 : null, immigration: step ? 0 : null, emigration: step ? 0 : null, internalIn: step ? 0 : null, internalOut: step ? 0 : null, netChange: step ? 0 : null, employment: Object.fromEntries(EMPLOYMENT.map((key) => [key, 0])), households: 0, representation: 'fictional_demo', cohortCube: Array.from({ length: 50 }, (_, i) => ({ ageBand: AGE_BANDS[Math.floor(i / 10)], sex: SEXES[Math.floor(i / 5) % 2], employment: EMPLOYMENT[i % 5], population: 0 })) }));
    const activeHouseholds = new Uint8Array(population.householdCount);
    for (let index = 0; index < population.recordCount; index++) {
      const o = index * 16; if (!(bytes[o + 8] & (1 << scenario))) continue;
      const household = view.getUint32(o, true); const district = placement.districts[household] + 1; const targets = [rows[0], rows[district]];
      if (step) {
        if (bytes[o + 9] === step) for (const row of targets) row[bytes[o + 7] >>> 4 === 1 ? 'births' : 'immigration']++;
        if (bytes[o + 10 + scenario] === step) for (const row of targets) row[bytes[o + 13 + scenario] === 1 ? 'deaths' : 'emigration']++;
      }
      if (bytes[o + 9] > step || bytes[o + 10 + scenario] && bytes[o + 10 + scenario] <= step) continue;
      const age = year - view.getUint16(o + 4, true); const sex = bytes[o + 6]; const h = hashIndex(index, 142);
      const band = age < 18 ? 0 : age < 35 ? 1 : age < 55 ? 2 : age < 70 ? 3 : 4;
      const job = age < 7 ? 0 : age < 18 || age < 23 && h % 3 !== 0 ? 1 : age >= 65 ? 3 : h % 13 === 0 ? 4 : 2;
      shardFacets[Math.floor(index / PERSON_SHARD_SIZE) * 350 + (district - 1) * 50 + band * 10 + sex * 5 + job]++;
      for (const row of targets) { row.population++; row.ageSex[band][SEXES[sex]]++; row.ageSexFine[Math.min(20, Math.floor(age / 5))][SEXES[sex]]++; row.employment[EMPLOYMENT[job]]++; row.cohortCube[band * 10 + sex * 5 + job].population++; if (!activeHouseholds[household]) row.households++; }
      activeHouseholds[household] = 1;
    }
    for (const row of rows) {
      if (step) row.netChange = row.births - row.deaths + row.immigration - row.emigration;
      fail(row.cohortCube.reduce((sum, cell) => sum + cell.population, 0) === row.population, 'Cohort cube mismatch.');
      const previous = snapshots.find((item) => item.scenario === row.scenario && item.territoryId === row.territoryId && item.year === year - 1);
      if (previous) fail(previous.population + row.netChange === row.population, 'District stock/event conservation failed.');
      snapshots.push(row);
    }
    for (let shard = 0; shard < queryIndex.shards.length; shard++) { const counts = []; for (let code = 0; code < 350; code++) { const count = shardFacets[shard * 350 + code]; if (count) counts.push(code, count); } queryIndex.shards[shard].contexts.push(counts); }
  }
  for (const scenario of SCENARIO_IDS) {
    const baseline = snapshots.find((row) => row.year === BASE_YEAR && row.scenario === scenario && row.territoryId === 'RU-CHE-SET');
    fail(JSON.stringify(baseline.ageSexFine) === JSON.stringify(population.reference.ageSex), 'Exact baseline age/sex marginal mismatch.');
  }
  return { contract: 'DemoPopulationSummariesV2', datasetId: DATASET_ID, snapshots, eventLedger: population.events, scientificClaim: false, predictiveValidation: false, queryIndex };
}
async function writeAsset(directory, stem, value, extension = 'bin') {
  const bytes = typeof value === 'string' ? Buffer.from(value) : value; const hash = sha(bytes); const url = `${stem}-${hash.slice(0, 16)}.${extension}`;
  await mkdir(dirname(join(directory, url)), { recursive: true }); await writeFile(join(directory, url), bytes);
  return { url, sha256: hash, bytes: bytes.length };
}
export async function compilePopulation({ root = ROOT, output = join(root, 'apps/web/public/demo-v2'), geographyManifest = join(root, 'apps/web/public/city-v2/manifest.json') } = {}) {
  const sourcePath = join(root, 'apps/web/public/demo/observed-chelyabinsk-v1.json'); const sourceBytes = await readFile(sourcePath); const source = JSON.parse(sourceBytes); const reference = source.snapshots.find((row) => row.year === 2024);
  const geoBytes = await readFile(geographyManifest); const geography = JSON.parse(geoBytes); const indexBytes = await readFile(resolve(dirname(geographyManifest), geography.buildingIndex.url));
  fail(sha(indexBytes) === geography.buildingIndex.sha256 && indexBytes.length === geography.buildingIndex.bytes, 'Geography artifact checksum mismatch.');
  const population = buildPopulation(reference); const placement = assignHomes(population, JSON.parse(indexBytes)); const summaries = summarizePopulation(population, placement); const queryIndex = summaries.queryIndex; delete summaries.queryIndex;
  await mkdir(output, { recursive: true });
  const personShards = []; const householdShards = [];
  for (let startIndex = 0; startIndex < population.recordCount; startIndex += PERSON_SHARD_SIZE) { const count = Math.min(PERSON_SHARD_SIZE, population.recordCount - startIndex); personShards.push({ ...await writeAsset(output, `people/${String(startIndex).padStart(7, '0')}`, encodePersonShard(startIndex, population.bytes.subarray(startIndex * 16, (startIndex + count) * 16))), startIndex, count }); }
  for (let startIndex = 0; startIndex < population.householdCount; startIndex += HOUSEHOLD_SHARD_SIZE) {
    const count = Math.min(HOUSEHOLD_SHARD_SIZE, population.householdCount - startIndex); const households = Array.from({ length: count }, (_, i) => { const h = startIndex + i; return { homeBuildingIndex: placement.homes[h], districtIndex: placement.districts[h], members: Array.from(population.members.subarray(population.offsets[h], population.offsets[h + 1])) }; });
    householdShards.push({ ...await writeAsset(output, `households/${String(startIndex).padStart(7, '0')}`, encodeHouseholdShard(startIndex, households)), startIndex, count });
  }
  const summaryAsset = await writeAsset(output, 'summaries', JSON.stringify(summaries), 'json');
  const queryAsset = await writeAsset(output, 'query-index', JSON.stringify(queryIndex), 'json');
  const sourceHashes = { observedReference: sha(sourceBytes), compiler: sha(await readFile(fileURLToPath(import.meta.url))), codec: sha(await readFile(join(root, 'shared/demo-population/index.mjs'))) };
  const manifest = { contract: 'DemoPopulationManifestV2', datasetId: DATASET_ID, version: '2.0.0', representation: 'fictional_demo', scientificClaim: false, predictiveValidation: false, startYear: BASE_YEAR, endYear: END_YEAR, initialPopulation: population.initialPopulation, initialHouseholdCount: population.initialHouseholdCount, recordCount: population.recordCount, householdCount: population.householdCount, seed: 8082026, personShardSize: PERSON_SHARD_SIZE, householdShardSize: HOUSEHOLD_SHARD_SIZE, personShards, householdShards, summaries: summaryAsset, territories: [{ id: 'RU-CHE-SET', name: 'Челябинский городской округ', parentId: null }, ...DISTRICT_IDS.map((id) => ({ id, name: geography.coverage.districts.find((row) => row.id === id).name, parentId: 'RU-CHE-SET' }))], scenarios: [{ id: 'baseline', label: 'Базовый', description: 'Иллюстративное продолжение авторских потоков демонабора.', scientificClaim: false }, { id: 'inflow', label: 'Приток населения', description: 'Вымышленный сценарий повышенного притока; не прогноз.', scientificClaim: false }, { id: 'ageing', label: 'Старение', description: 'Вымышленный сценарий сокращения и старения; не прогноз.', scientificClaim: false }], spatial: { status: 'assigned', representation: 'visual_synthesis', geographyManifestUrl: '../city-v2/manifest.json', geographyManifestSha256: sha(geoBytes), buildingIndex: { ...geography.buildingIndex, url: `../city-v2/${geography.buildingIndex.url}` }, eligibleResidentialBuildings: placement.eligibleResidentialBuildings, unplacedHouseholds: placement.unplacedHouseholds }, provenance: { source: 'Reviewed public 2024 Chelyabinsk age/sex aggregate; fictional 2026 population copies these marginals by explicit owner decision.', sourceId: reference.sourceId, referenceYear: 2024, referencePopulation: reference.population, sourceHashes, assumptions: ['All residents, households, relationships, jobs, daily locations and future events are fictional; weight=1, one compact record per person, not weighted representatives.', 'The 2024 age/sex marginals are copied as an illustrative 2026 baseline, not asserted as a 2026 observation or causal forecast.', 'Single ages are distributed as evenly as integers permit within each observed five-year band; the open 100+ band is explicitly assigned ages 100..105.', 'Every initial minor has an adult guardian at least 18 years older. Partner/sibling composition is authored and not calibrated to household observations.', 'Annual flow counts preserve legacy authored scenario formulas scaled by 1177058/8246 and rounded independently to integers. Death ordering is oldest-first; this is not a mortality model.', 'Births enter active female age22..42 households; emigration excludes households ever containing minors. No pregnancy, behavioral calibration or predictive validation is claimed.', 'Whole households are capacity-weighted onto source-classified residential buildings within resolved official districts; footprint/levels-derived weights are visual assumptions, not observed occupancy.', 'Unknown-use buildings and unresolved districts are ineligible; no fake district or building observations are invented.'], legacyDatasetRetained: 'omnitwin-public-fictional-chelyabinsk-v1' }, licenses: ['OpenStreetMap geography: ODbL-1.0; see city-v2 SOURCES and manifest.', 'Observed aggregate provenance and source restrictions retained in observed-reference manifest. Fictional records contain no research microdata.'] };
  manifest.queryIndex = queryAsset;
  if (manifest.spatial.buildingIndex.gzip) manifest.spatial.buildingIndex.gzip.url = `../city-v2/${geography.buildingIndex.gzip.url}`;
  manifest.spatial.capacityRule = { representation: 'visual_synthesis', formula: 'max(1,floor(capacityWeight))', total: placement.syntheticCapacity, maximumOccupancyRatioAcross33Contexts: placement.maximumOccupancyRatio, deterministicFallbackScans: placement.fallbackScans };
  manifest.provenance.assumptions.push('Residential capacity is an explicit hard synthetic bound max(1,floor(source capacityWeight)), checked jointly for every scenario/year. Entire households must fit; capacity is not an observed building occupancy. Compilation fails if no complete assignment fits.');
  manifest.totalAssetBytes = [...personShards, ...householdShards, summaryAsset, queryAsset].reduce((sum, asset) => sum + asset.bytes, 0);
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`; await writeFile(join(output, 'manifest.json.next'), manifestBytes); await rename(join(output, 'manifest.json.next'), join(output, 'manifest.json'));
  return { datasetId: DATASET_ID, initialPopulation: population.initialPopulation, recordCount: population.recordCount, householdCount: population.householdCount, personShards: personShards.length, householdShards: householdShards.length, totalAssetBytes: manifest.totalAssetBytes, manifestSha256: sha(manifestBytes), maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* OS may disallow adjusting this process; never adjust other processes. */ }
  const started = Date.now();
  compilePopulation().then((result) => { fail(result.maxRssMiB < 512, 'Compiler exceeded the 512MiB release memory budget.'); process.stdout.write(`${JSON.stringify({ ...result, elapsedMs: Date.now() - started })}\n`); }).catch((error) => { process.stderr.write(`Population compilation failed: ${error.message}\n`); process.exitCode = 1; });
}
