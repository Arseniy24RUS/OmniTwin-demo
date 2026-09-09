import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { validateCityActivation, createCityActivation, cityActivationPayload, assertDeploymentProject } from '../scripts/city-activation.mjs';
import { parseConfigureArguments, writeCityActivation } from '../scripts/configure-city.mjs';
import { verifyDeployment } from '../scripts/verify-deployment.mjs';

const projectId = 'omnitwin-demo';
const base = `https://storage.googleapis.com/omnitwin-demo-city-assets/packs/${'a'.repeat(64)}/`;
const options = { projectId, packBaseUrl: base, populationManifestSha256: 'b'.repeat(64), spatialManifestSha256: 'c'.repeat(64) };
const legacy = { version: 1, projectId, v2: null };

test('explicit activation is all four approved immutable pins or legacy only', () => {
  const active = createCityActivation(options);
  assert.deepEqual(validateCityActivation(active), active);
  assert.deepEqual(validateCityActivation(legacy), legacy);
  assert.equal(active.v2.V2_POPULATION_MANIFEST_URL, `${base}demo-v2/manifest.json`);
  assert.equal(active.v2.V2_SPATIAL_MANIFEST_URL, `${base}demo-v2/spatial/manifest.json`);
  for (const key of Object.keys(active.v2)) {
    const partial = structuredClone(active); delete partial.v2[key];
    assert.throws(() => validateCityActivation(partial), /Invalid|Incomplete/);
  }
  for (const invalid of [null, {}, { ...legacy, projectId: 'another-project' }, { ...legacy, version: 2 }, { ...legacy, v2: {} }, { ...legacy, apiKey: 'not-a-secret' }]) {
    assert.throws(() => validateCityActivation(invalid), /Invalid|Incomplete/);
  }
});

test('foreign, mixed-pack and noncanonical URLs or malformed hashes fail closed', () => {
  const active = createCityActivation(options);
  for (const url of [base.replace('https:', 'http:'), base.replace('omnitwin-demo-city-assets', 'other-bucket'), base.replace('/packs/', '/raw/'), `${base}?x=1`, base.replace('storage.googleapis.com', 'user@storage.googleapis.com'), base.replace('storage.googleapis.com', 'storage.googleapis.com:443')]) {
    assert.throws(() => createCityActivation({ ...options, packBaseUrl: url }), /Invalid|Unapproved/);
  }
  const mixed = structuredClone(active);
  mixed.v2.V2_SPATIAL_MANIFEST_URL = mixed.v2.V2_SPATIAL_MANIFEST_URL.replace('a'.repeat(64), 'd'.repeat(64));
  assert.throws(() => validateCityActivation(mixed), /Invalid|Unapproved/);
  for (const sha of ['', 'B'.repeat(64), 'b'.repeat(63), `${'b'.repeat(64)}\n`]) assert.throws(() => createCityActivation({ ...options, populationManifestSha256: sha }), /Invalid/);
});

test('generated runtime module is deterministic, complete, and independent of shell V2 variables', async () => {
  const active = cityActivationPayload(createCityActivation(options));
  const again = cityActivationPayload(createCityActivation(options));
  assert.equal(active.module, again.module);
  const generated = await import(`data:text/javascript;base64,${Buffer.from(active.module).toString('base64')}`);
  assert.deepEqual(generated.CITY_ACTIVATION_ENV, createCityActivation(options).v2);
  assert.equal(generated.CITY_ACTIVATION_SHA256, active.sha256);
  assert.equal(generated.CITY_DEPLOYMENT_LABELS['omnitwin-city-pin-a'] + generated.CITY_DEPLOYMENT_LABELS['omnitwin-city-pin-b'], active.sha256);
  assert.equal(generated.CITY_DEPLOYMENT_LABELS['omnitwin-city-mode'], 'v2');
  assert.ok(Object.values(generated.CITY_DEPLOYMENT_LABELS).every(value => value.length <= 63));
  assert.equal(Object.isFrozen(generated.CITY_ACTIVATION_ENV), true);
  assert.equal(active.module.includes('process.env'), false);
  assert.deepEqual(cityActivationPayload(legacy).env, {});
  assertDeploymentProject(projectId);
  assert.throws(() => assertDeploymentProject('another-project'), /project/);
  assert.throws(() => assertDeploymentProject(undefined), /project/);
});

test('configuration CLI defaults to preview and rejects ambiguous or partial intent', () => {
  const args = ['--project', projectId, '--pack-base-url', base, '--population-sha256', options.populationManifestSha256, '--spatial-sha256', options.spatialManifestSha256];
  assert.equal(parseConfigureArguments(args).write, false);
  assert.deepEqual(parseConfigureArguments(['--project', projectId, '--legacy']).activation, legacy);
  for (const invalid of [[], ['--legacy'], args.slice(0, -2), [...args, '--legacy'], [...args, '--write'], [...args, '--project', projectId], [...args, '--secret', 'not-a-secret']]) assert.throws(() => parseConfigureArguments(invalid), /Invalid|Usage|requires/);
  assert.equal(parseConfigureArguments([...args, '--write', '--expect-current', 'd'.repeat(64)]).write, true);
});

test('explicit local writes compare the reviewed prior hash and never follow symlinks', async t => {
  const temp = await mkdtemp(resolve(tmpdir(), 'omnitwin-city-config-test-'));
  t.after(async () => { assert.ok(temp.startsWith(resolve(tmpdir(), 'omnitwin-city-config-test-'))); await rm(temp, { recursive: true, force: true }); });
  const path = resolve(temp, 'city-activation.json');
  await writeFile(path, JSON.stringify(legacy));
  const sha = cityActivationPayload(legacy).sha256;
  await assert.rejects(writeCityActivation(path, createCityActivation(options), '0'.repeat(64)), /changed/);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), legacy);
  await writeCityActivation(path, createCityActivation(options), sha);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), createCityActivation(options));
  await assert.rejects(writeCityActivation(path, legacy, sha), /changed/);
  const linked = resolve(temp, 'linked-directory');
  await symlink(temp, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(writeCityActivation(resolve(linked, 'city-activation.json'), legacy, cityActivationPayload(createCityActivation(options)).sha256), /regular|Symlink/);
});

test('deployment read-back requires exact project, revision, all-latest traffic and both pin label halves', () => {
  const pins = cityActivationPayload(createCityActivation(options));
  const metadata = { name: 'projects/omnitwin-demo/locations/europe-west1/functions/chatApi', state: 'ACTIVE', environment: 'GEN_2', labels: pins.labels, serviceConfig: { revision: 'chatapi-00002-abc', uri: 'https://chatapi-avypjak2xq-ew.a.run.app', allTrafficOnLatestRevision: true } };
  assert.deepEqual(verifyDeployment(metadata, pins), { projectId, revision: 'chatapi-00002-abc', mode: 'v2', activationSha256: pins.sha256, configurationVerified: true, liveInferenceVerified: false });
  for (const invalid of [
    { ...metadata, name: metadata.name.replace('omnitwin-demo', 'another-project') },
    { ...metadata, state: 'DEPLOYING' },
    { ...metadata, labels: { ...pins.labels, 'omnitwin-city-pin-b': '0'.repeat(32) } },
    { ...metadata, serviceConfig: { ...metadata.serviceConfig, revision: '' } },
    { ...metadata, serviceConfig: { ...metadata.serviceConfig, allTrafficOnLatestRevision: false } },
    { ...metadata, serviceConfig: { ...metadata.serviceConfig, uri: 'https://attacker.example' } },
  ]) assert.throws(() => verifyDeployment(invalid, pins), /Deployment/);
});
