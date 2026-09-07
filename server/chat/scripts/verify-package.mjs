import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { unzipSync } from 'fflate';
import { createHandler } from '../src/handler.mjs';
import { createQuotaStore } from '../src/quota.mjs';
import { MemoryTransactions } from '../test/support.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'dist');
const zipped = await readFile(resolve(output, 'demo-chat-function.zip'));
const evidence = JSON.parse(await readFile(resolve(output, 'package-evidence.json'), 'utf8'));
assert.equal(createHash('sha256').update(zipped).digest('hex'), evidence.sha256);
const entries = unzipSync(zipped);
assert.deepEqual(Object.keys(entries).sort(), evidence.files);
assert.equal(evidence.deployed, false); assert.equal(evidence.liveInferenceVerified, false);
const stage = await mkdtemp(resolve(output, 'verify-'));
try {
  for (const [name, bytes] of Object.entries(entries)) {
    const target = resolve(stage, name);
    const inside = relative(stage, target);
    if (isAbsolute(inside) || inside.startsWith(`..${sep}`) || inside === '..') throw new Error('Unsafe archive path.');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  const packageManifest = JSON.parse(await readFile(resolve(stage, 'package.json'), 'utf8'));
  assert.equal(packageManifest.type, 'commonjs');
  const entry = createRequire(import.meta.url)(resolve(stage, 'index.js'));
  assert.deepEqual(Object.keys(entry), ['handler']);
  assert.equal(typeof entry.handler, 'function');
  const { loadConfig } = await import(pathToFileURL(resolve(stage, 'src/config.mjs')).href);
  // These values are deliberate local test fixtures, never live credentials.
  const env = { OPENROUTER_API_KEY: 'local-test-not-a-real-key', SESSION_SIGNING_SECRET: 'local-test-only-'.repeat(4), ALLOWED_ORIGINS: 'https://example.github.io', PROFILE_MANIFEST_SHA256: evidence.profileSha256, YDB_ENDPOINT: 'grpcs://local-test.invalid', YDB_DATABASE: '/local-test' };
  const config = await loadConfig(env);
  assert.equal(config.profiles.size, evidence.profiles);
  await assert.rejects(loadConfig({ ...env, PROFILE_MANIFEST_SHA256: '0'.repeat(64) }), /digest mismatch/);
  await assert.rejects(loadConfig({ ...env, ALLOWED_ORIGINS: 'https://example.github.io/path' }), /origins/);
  await assert.rejects(loadConfig({ ...env, PROFILE_MANIFEST_PATH: '../../package.json' }), /inside/);
  let checked = 0;
  for (const profile of config.profiles.values()) {
    for (const scenario of ['baseline', 'inflow', 'ageing']) {
      for (const year of [2026, 2031, 2036]) {
        const dates = profile.membership[scenario];
        if (!dates || year < dates.entryYear || (dates.exitYear !== null && year >= dates.exitYear)) continue;
        const current = config.profileForYear(profile, year, scenario);
        assert.equal(current.id, profile.id);
        assert.equal(current.name, profile.name);
        assert.ok(Number.isInteger(current.householdSize) && current.householdSize > 0);
        if (year - profile.birthYear >= 65) assert.equal(current.occupation, 'пенсионер');
        checked += 1;
      }
    }
  }
  let paidCalls = 0;
  const handler = createHandler({ config, quota: createQuotaStore(new MemoryTransactions()), upstream: async () => { paidCalls++; return { reply: 'Локальный проверочный ответ.', model: 'local-test-only' }; } });
  const event = (path, data) => ({ httpMethod: 'POST', path, headers: { origin: env.ALLOWED_ORIGINS, 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const sessionToken = JSON.parse((await handler(event('/session', {}))).body).sessionToken;
  const candidate = [...config.profiles.values()].find((p) => p.membership.baseline?.entryYear <= 2026 && (p.membership.baseline.exitYear === null || p.membership.baseline.exitYear > 2026));
  const input = { personId: candidate.id, datasetId: config.datasetId, scenario: 'baseline', year: 2026, presentationMinutes: 600, message: 'Здравствуйте!', sessionToken, requestId: 'local_package_verification_001' };
  assert.equal((await handler(event('/chat', input))).statusCode, 200);
  assert.equal((await handler(event('/chat', input))).statusCode, 409);
  assert.equal(paidCalls, 1); // Counts ONLY the injected local test function.
  console.log(JSON.stringify({ archiveSha256: evidence.sha256, profiles: config.profiles.size, profileScenarioYearChecks: checked, commonJsEntryVerified: true, packageConfigVerified: true, upstream: 'local_test_double_only', networkRequests: 0, liveInferenceVerified: false }));
} finally {
  // Delete only this unique directory created under our own generated output.
  const expectedPrefix = `${resolve(output, 'verify-')}`;
  if (!stage.startsWith(expectedPrefix) || dirname(stage) !== output) throw new Error('Unsafe temporary cleanup target.');
  await rm(stage, { recursive: true, force: false });
}
