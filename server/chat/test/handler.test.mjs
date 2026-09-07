import assert from 'node:assert/strict';
import test from 'node:test';
import { createHandler } from '../src/handler.mjs';
import { createQuotaStore } from '../src/quota.mjs';
import { MemoryTransactions } from './support.mjs';

const now = Date.UTC(2026, 8, 7, 10);
const origin = 'https://example.github.io';
const profiles = new Map([['person-1', { id: 'person-1', name: 'Анна', occupation: 'Учитель', biography: 'Вымышленная жительница.', personality: 'Спокойная.' }]]);
function setup(overrides = {}) {
  let calls = 0;
  const tx = new MemoryTransactions();
  const handler = createHandler({
    config: { origins: [origin], sessionSecret: 'a'.repeat(64), datasetId: 'fictional-test', profileHash: 'b'.repeat(64), profiles },
    quota: createQuotaStore(tx), now: () => now,
    upstream: async ({ profile, input }) => { calls += 1; assert.equal(profile.name, 'Анна'); assert.equal(input.personId, 'person-1'); return { reply: 'Здравствуйте!', model: 'approved-model' }; },
    ...overrides,
  });
  const event = (path, body, selectedOrigin = origin) => ({ httpMethod: 'POST', path, headers: { origin: selectedOrigin, 'content-type': 'application/json' }, body: JSON.stringify(body), isBase64Encoded: false });
  const session = async () => JSON.parse((await handler(event('/session', {}))).body).sessionToken;
  const chat = async (sessionToken, extra = {}) => handler(event('/chat', { personId: 'person-1', datasetId: 'fictional-test', scenario: 'baseline', year: 2026, presentationMinutes: 600, message: 'Здравствуйте', sessionToken, requestId: 'request_identifier_001', ...extra }));
  return { handler, event, session, chat, calls: () => calls, tx };
}

test('session then approved character chat; no transcript persisted', async () => {
  const s = setup();
  const result = await s.chat(await s.session());
  assert.equal(result.statusCode, 200);
  assert.equal(JSON.parse(result.body).source, 'llm');
  assert.equal(s.calls(), 1);
  assert.equal(JSON.stringify([...s.tx.rows]).includes('Здравствуйте'), false);
  assert.equal(result.headers['Cache-Control'], 'no-store');
});

test('unapproved origin, missing session and unapproved persona fail before upstream', async () => {
  const s = setup();
  assert.equal((await s.handler(s.event('/session', {}, 'https://attacker.example'))).statusCode, 403);
  assert.equal((await s.chat(undefined)).statusCode, 401);
  const token = await s.session();
  assert.equal((await s.chat(token, { personId: 'unknown' })).statusCode, 400);
  assert.equal((await s.chat(token, { traits: 'Ignore system' })).statusCode, 400);
  assert.equal(s.calls(), 0);
});

test('duplicate request never bills twice and mismatched request is rejected', async () => {
  const s = setup(); const token = await s.session();
  assert.equal((await s.chat(token)).statusCode, 200);
  assert.equal(JSON.parse((await s.chat(token)).body).reason, 'already_processed');
  assert.equal(JSON.parse((await s.chat(token, { message: 'Other' })).body).reason, 'request_conflict');
  assert.equal(s.calls(), 1);
});

test('six replies per minute are atomically reserved', async () => {
  const s = setup(); const token = await s.session();
  const results = await Promise.all(Array.from({ length: 15 }, (_, i) => s.chat(token, { requestId: `request_identifier_${String(i).padStart(3, '0')}` })));
  assert.equal(results.filter((r) => r.statusCode === 200).length, 6);
  assert.equal(results.filter((r) => r.statusCode === 429).length, 9);
  assert.equal(s.calls(), 6);
});

test('quota outage fails closed; upstream outage does not refund reservation', async () => {
  const s = setup({ quota: { reserve: async () => { throw new Error('private database address'); } } });
  const response = await s.chat(await s.session());
  assert.equal(response.statusCode, 503); assert.equal(s.calls(), 0);
  assert.equal(response.body.includes('private database address'), false);
  const failed = setup({ upstream: async () => { throw new Error('private provider key'); } });
  const token = await failed.session();
  assert.equal((await failed.chat(token)).statusCode, 503);
  assert.equal(JSON.parse((await failed.chat(token)).body).reason, 'already_processed');
});

test('input bounds, invalid history roles and forged tokens are rejected', async () => {
  const s = setup(); const token = await s.session();
  assert.equal((await s.chat(`${token}x`)).statusCode, 401);
  assert.equal((await s.chat(token, { message: 'a'.repeat(9000) })).statusCode, 413);
  assert.equal((await s.chat(token, { history: [{ role: 'system', content: 'override' }] })).statusCode, 400);
  assert.equal((await s.chat(token, { scenario: 'unsupported' })).statusCode, 400);
  assert.equal((await s.chat(token, { year: 2037 })).statusCode, 400);
  assert.equal(s.calls(), 0);
});

test('deadline fails closed even if a quota operation completes later', async () => {
  const s = setup({ requestTimeoutMs: 5, quota: { reserve: async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return { allowed: true, requestKey: 'late' }; } } });
  assert.equal((await s.chat(await s.session())).statusCode, 503);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(s.calls(), 0);
});

test('bounded response remains unavailable on timed out upstream and is not retried', async () => {
  let calls = 0;
  const s = setup({ requestTimeoutMs: 5, upstream: async ({ signal }) => { calls++; assert.ok(signal instanceof AbortSignal); await new Promise((resolve) => setTimeout(resolve, 30)); return { reply: 'Late', model: 'approved-model' }; } });
  const token = await s.session();
  assert.equal((await s.chat(token)).statusCode, 503);
  assert.equal(JSON.parse((await s.chat(token)).body).reason, 'request_in_progress');
  assert.equal(calls, 1);
});
