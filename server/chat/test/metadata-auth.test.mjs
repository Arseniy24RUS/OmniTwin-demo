import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetadataAuth } from '../src/metadata-auth.mjs';

test('metadata credentials refresh after idle by expiry, without a background timer', async () => {
  let now = 1_800_000_000_000; let calls = 0;
  const auth = createMetadataAuth({ now: () => now, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token');
    assert.deepEqual(options.headers, { 'Metadata-Flavor': 'Google' }); assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify({ access_token: `local-test-token-${calls}`, expires_in: 43200, token_type: 'Bearer' }));
  } });
  const first = await Promise.all([auth.getAuthMetadata(), auth.getAuthMetadata(), auth.getAuthMetadata()]);
  assert.equal(calls, 1);
  assert.deepEqual(first[0].get('x-ydb-auth-ticket'), ['local-test-token-1']);
  now += 601_000;
  const fresh = await auth.getAuthMetadata();
  assert.equal(calls, 2); assert.deepEqual(fresh.get('x-ydb-auth-ticket'), ['local-test-token-2']);
});

test('metadata failure and malformed expiry cannot authorize database access', async () => {
  const invalid = createMetadataAuth({ fetchImpl: async () => new Response(JSON.stringify({ access_token: 'local-test-token', expires_in: -1 })) });
  await assert.rejects(invalid.getAuthMetadata());
  const failed = createMetadataAuth({ fetchImpl: async () => new Response('private diagnostic', { status: 503 }) });
  await assert.rejects(failed.getAuthMetadata(), /unavailable/);
});
