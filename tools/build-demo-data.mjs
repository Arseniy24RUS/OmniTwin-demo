/** Tiny, explicitly fictional presentation fixture. This is NOT the demographic model. */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { stableHash, ageBandFor, employmentFor, fictionalProfile } from '../apps/web/src/demo/data/fictionalProfile.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'apps/web/public/demo');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const DATASET = 'omnitwin-public-fictional-chelyabinsk-v1';
const BANDS = ['0-17', '18-34', '35-54', '55-69', '70+'];
const RANGES = [[0, 17], [18, 34], [35, 54], [55, 69], [70, 89]];
const scenarios = [
  { id: 'baseline', label: 'Базовый', description: 'Иллюстративная траектория со сдержанными изменениями.', scientificClaim: false },
  { id: 'inflow', label: 'Приток населения', description: 'Иллюстрация повышенного притока новых жителей, не оценка политики.', scientificClaim: false },
  { id: 'ageing', label: 'Старение населения', description: 'Иллюстрация уменьшения притока и усиления старения, не прогноз.', scientificClaim: false },
];
await mkdir(out, { recursive: true });
const importAt = process.argv.indexOf('--import-legacy');
if (importAt >= 0) {
  const source = resolve(process.argv[importAt + 1]);
  const pyAt = process.argv.indexOf('--python');
  const python = pyAt >= 0 ? process.argv[pyAt + 1] : 'python';
  const runBytes = await readFile(join(source, 'run.json'));
  const run = JSON.parse(runBytes);
  assert.equal(run.runId, 'synthetic-chelyabinsk-v1');
  assert.equal(run.scientificClaim, false);
  for (const file of ['population.parquet', 'events_aggregate.parquet', 'geography.parquet']) {
    const bytes = await readFile(join(source, file));
    assert.ok(bytes.length < 100_000, 'Only the tiny bundled fixture is eligible');
    assert.equal(sha(bytes), run.hashes[file], 'Original fixture hash mismatch');
  }
  const result = spawnSync(python, ['-c', 'import pyarrow.parquet as p,json,pathlib,sys; r=pathlib.Path(sys.argv[1]); print(json.dumps({n:p.read_table(r/(n+".parquet")).to_pylist() for n in ["geography","population","events_aggregate"]},ensure_ascii=True,default=str))', source], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || 'Unable to export bounded legacy Parquet');
  const legacy = { contract: 'OriginalSyntheticBundleExportV1', sourceRunId: run.runId, run, completion: JSON.parse(await readFile(join(source, 'completion.json'), 'utf8')), ...JSON.parse(result.stdout) };
  await writeFile(join(out, 'legacy-synthetic-chelyabinsk-v1.json'), JSON.stringify(legacy));
}
const legacyBytes = await readFile(join(out, 'legacy-synthetic-chelyabinsk-v1.json'));
const legacy = JSON.parse(legacyBytes);
const territories = legacy.geography.filter(g => g.id === 'RU-CHE-SET' || g.parent_id === 'RU-CHE-SET').map(g => ({ id: g.id, name: g.name_ru, parentId: g.id === 'RU-CHE-SET' ? null : 'RU-CHE-SET' }));
const districts = territories.filter(g => g.parentId);
const initial = [];
let index = 0;
for (const territory of districts) {
  const rows = legacy.population.filter(r => r.geography_id === territory.id && r.stock_as_of === '2026-01-01');
  const total = rows.reduce((n, r) => n + r.value, 0);
  const householdCount = Math.ceil(total / 2.7);
  let local = 0;
  for (const row of rows) {
    const [lower, upper] = RANGES[BANDS.indexOf(row.age_band)];
    for (let i = 0; i < row.value; i += 1) {
      const id = `demo-p-${sha(Buffer.from(`initial:${index++}`)).slice(0, 14)}`;
      const age = lower + stableHash(id + ':age') % (upper - lower + 1);
      initial.push({ id, birthYear: 2026 - age, sex: row.sex, householdId: `demo-h-${sha(Buffer.from(territory.id + ':' + (local++ % householdCount))).slice(0, 12)}`, territoryId: territory.id, entryYear: 2026, exitYear: null, entryReason: 'initial', exitReason: null });
    }
  }
}
assert.equal(initial.length, 8246);
const data = {};
const eventFields = ['births', 'deaths', 'immigration', 'emigration', 'internalIn', 'internalOut'];
const emptyEvents = () => Object.fromEntries(eventFields.map(k => [k, 0]));
for (const scenario of scenarios) {
  const people = initial.map(p => ({ ...p }));
  const snapshots = [];
  const active = year => people.filter(p => p.entryYear <= year && (p.exitYear === null || p.exitYear > year));
  let previousByTerritory = new Map();
  for (let year = 2026; year <= 2036; year += 1) {
    const events = new Map(territories.map(t => [t.id, emptyEvents()]));
    const countEvent = (territoryId, field) => { events.get(territoryId)[field]++; events.get('RU-CHE-SET')[field]++; };
    if (year > 2026) {
      const step = year - 2026;
      // Authored counts demonstrate contrasting paths; they are NOT fitted rates or predictions.
      const counts = scenario.id === 'inflow' ? { births: 108 + step, deaths: 86 + step, immigration: 236, emigration: 86 }
        : scenario.id === 'ageing' ? { births: 68 - step, deaths: 112 + step * 2, immigration: 48, emigration: 110 }
          : { births: 95 - step, deaths: 89 + step, immigration: 111, emigration: 96 };
      const candidates = active(year);
      const deaths = [...candidates].sort((a, b) => (a.birthYear - b.birthYear) || stableHash(a.id + year) - stableHash(b.id + year)).slice(0, counts.deaths);
      for (const person of deaths) { person.exitYear = year; person.exitReason = 'death'; countEvent(person.territoryId, 'deaths'); }
      const emigrants = active(year).filter(p => year - p.birthYear >= 18 && year - p.birthYear <= 64).sort((a, b) => stableHash(a.id + ':out:' + year) - stableHash(b.id + ':out:' + year)).slice(0, counts.emigration);
      for (const person of emigrants) { person.exitYear = year; person.exitReason = 'emigration'; countEvent(person.territoryId, 'emigration'); }
      const families = active(year).filter(p => year - p.birthYear >= 22 && year - p.birthYear <= 42);
      for (const [kind, count] of [['birth', counts.births], ['immigration', counts.immigration]]) {
        for (let i = 0; i < count; i += 1) {
          const id = `demo-p-${sha(Buffer.from(`${scenario.id}:${year}:${kind}:${i}`)).slice(0, 14)}`;
          const h = stableHash(id);
          const family = families[h % families.length];
          const territoryId = kind === 'birth' ? family.territoryId : districts[h % districts.length].id;
          people.push({ id, birthYear: kind === 'birth' ? year : year - (18 + (h % 38)), sex: h % 2 ? 'female' : 'male', householdId: kind === 'birth' ? family.householdId : `demo-h-${sha(Buffer.from(id)).slice(0, 12)}`, territoryId, entryYear: year, exitYear: null, entryReason: kind, exitReason: null });
          countEvent(territoryId, kind === 'birth' ? 'births' : 'immigration');
        }
      }
    }
    const current = active(year);
    for (const territory of territories) {
      const rows = territory.parentId === null ? current : current.filter(p => p.territoryId === territory.id);
      const ageSex = BANDS.map(ageBand => ({ ageBand, male: 0, female: 0 }));
      const employment = { child: 0, student: 0, employed: 0, retired: 0, not_employed: 0 };
      for (const person of rows) { ageSex[BANDS.indexOf(ageBandFor(year - person.birthYear))][person.sex]++; employment[employmentFor(person, year)]++; }
      const e = events.get(territory.id);
      const netChange = year === 2026 ? null : e.births - e.deaths + e.immigration - e.emigration + e.internalIn - e.internalOut;
      if (year > 2026) assert.equal(rows.length - previousByTerritory.get(territory.id), netChange);
      snapshots.push({ datasetId: DATASET, scenario: scenario.id, year, stockAsOf: `${year}-01-01`, territoryId: territory.id, population: rows.length, ageSex, ...(year === 2026 ? Object.fromEntries(eventFields.map(k => [k, null])) : e), netChange, employment, households: new Set(rows.map(p => p.householdId)).size, representation: 'fictional_demo' });
      previousByTerritory.set(territory.id, rows.length);
    }
  }
  data[scenario.id] = { id: scenario.id, people, snapshots };
}
const dataset = { datasetId: DATASET, territories, scenarios, data };
const profileMap = new Map();
for (const s of scenarios) {
  const householdSizesByYear = new Map();
  for (let year = 2026; year <= 2036; year++) {
    const sizes = new Map();
    for (const p of data[s.id].people) if (p.entryYear <= year && (p.exitYear === null || p.exitYear > year)) sizes.set(p.householdId, (sizes.get(p.householdId) ?? 0) + 1);
    householdSizesByYear.set(year, sizes);
  }
  for (const p of data[s.id].people) {
    let profile = profileMap.get(p.id);
    if (!profile) {
      const publicProfile = fictionalProfile(p, p.entryYear, s.id, DATASET, householdSizesByYear.get(p.entryYear).get(p.householdId), territories.find(t => t.id === p.territoryId).name);
      profile = { ...publicProfile, birthYear: p.birthYear, membership: {}, householdSizes: {} };
      profileMap.set(p.id, profile);
    }
    profile.membership[s.id] = { entryYear: p.entryYear, exitYear: p.exitYear };
    profile.householdSizes[s.id] = Array.from({ length: 11 }, (_, index) => {
      const year = 2026 + index;
      return p.entryYear <= year && (p.exitYear === null || p.exitYear > year) ? householdSizesByYear.get(year).get(p.householdId) : null;
    });
  }
}
const files = {
  'dataset.json': JSON.stringify(dataset),
  'chat-profiles.json': JSON.stringify({ datasetId: DATASET, representation: 'fictional_demo', scientificClaim: false, profiles: [...profileMap.values()] }),
};
const assets = { legacy: { url: 'legacy-synthetic-chelyabinsk-v1.json', sha256: sha(legacyBytes), bytes: legacyBytes.length } };
for (const [name, content] of Object.entries(files)) {
  await writeFile(join(out, name), content);
  assets[name === 'dataset.json' ? 'dataset' : 'chatProfiles'] = { url: name, sha256: sha(content), bytes: Buffer.byteLength(content) };
}
const manifest = {
  contract: 'DemoDatasetManifestV1', datasetId: DATASET, version: '1.0.0', representation: 'fictional_demo', scientificClaim: false, predictiveValidation: false,
  startYear: 2026, endYear: 2036, initialPopulation: 8246, seed: 8082026, assets,
  provenance: { source: 'OmniTwin authored deterministic public fictional fixture', notes: 'Original legacy aggregates preserved. New people, annual transitions and scenarios are fictional interface examples, not observations, calibrated simulations or predictions. Only demo allocation labels use district identifiers; these do not validate geographic placement.', sourceHashes: legacy.run.hashes },
  licenses: ['Generated fictional fixture: provided for this OmniTwin demonstration. No real person records. Original synthetic aggregate provenance retained.'],
};
await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ datasetId: DATASET, initialPopulation: initial.length, scenarios: scenarios.map(s => ({ id: s.id, endPopulation: data[s.id].snapshots.find(r => r.year === 2036 && r.territoryId === 'RU-CHE-SET').population })), assets }, null, 2));
