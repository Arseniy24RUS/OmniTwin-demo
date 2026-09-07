import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStorageConfiguration } from '../src/config.mjs';

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
