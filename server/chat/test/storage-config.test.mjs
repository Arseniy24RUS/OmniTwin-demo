import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStorageConfiguration, populationConfiguration } from '../src/config.mjs';

test('V2 is opt-in through all four non-secret pins, never a partially configured fallback', () => {
  assert.equal(populationConfiguration({}), null);
  const env = { V2_POPULATION_MANIFEST_URL: 'https://example.github.io/demo-v2/manifest.json', V2_POPULATION_MANIFEST_SHA256: 'a'.repeat(64), V2_SPATIAL_MANIFEST_URL: 'https://example.github.io/demo-v2/spatial/manifest.json', V2_SPATIAL_MANIFEST_SHA256: 'b'.repeat(64) };
  assert.equal(populationConfiguration(env).populationHash, env.V2_POPULATION_MANIFEST_SHA256);
  for (const name of Object.keys(env)) { const missing = { ...env }; delete missing[name]; assert.throws(() => populationConfiguration(missing)); }
  assert.throws(() => populationConfiguration({ ...env, V2_SPATIAL_MANIFEST_SHA256: 'bad' }));
});

test('Yandex remains the default and still requires its explicit endpoint and database', () => {
  assert.throws(() => validateStorageConfiguration({}));
  assert.deepEqual(validateStorageConfiguration({ YDB_ENDPOINT: 'grpcs://example.test:2135', YDB_DATABASE: '/test' }), {
    ydb: { endpoint: 'grpcs://example.test:2135', database: '/test', table: 'demo_chat_state' },
  });
});

test('Firebase storage is explicitly selected without dummy YDB configuration', () => {
  assert.deepEqual(validateStorageConfiguration({}, { storage: 'firestore' }), { firestore: { collection: 'demo_chat_state' } });
  assert.deepEqual(validateStorageConfiguration({ FIRESTORE_COLLECTION: 'isolated_quota' }, { storage: 'firestore' }), { firestore: { collection: 'isolated_quota' } });
  for (const collection of ['nested/path', '..', '', '__private__', 'MixedCase', 'with-hyphen', 'x'.repeat(64)]) {
    assert.throws(() => validateStorageConfiguration({ FIRESTORE_COLLECTION: collection }, { storage: 'firestore' }));
  }
  assert.throws(() => validateStorageConfiguration({}, { storage: 'unknown' }));
});
