import assert from 'node:assert/strict';
import test from 'node:test';
import { createFirestoreTransactions } from '../src/firestore.mjs';
import { createQuotaStore } from '../src/quota.mjs';
import { createHandler } from '../src/handler.mjs';

class Timestamp {
  constructor(milliseconds) { this.milliseconds = milliseconds; }
  static fromMillis(milliseconds) { return new Timestamp(milliseconds); }
  toMillis() { return this.milliseconds; }
}

// A local contract double, not evidence of a live Firestore deployment.
class FirestoreDouble {
  rows = new Map();
  attempts = 0;
  conflicts = 0;
  pending = Promise.resolve();
  operations = [];
  transactionActive = false;
  collection(name) {
    this.collectionName = name;
    return { doc: (id) => ({ id }) };
  }
  runTransaction(work, options) {
    this.options = options;
    const run = this.pending.then(async () => {
      for (let attempt = 0; attempt < options.maxAttempts; attempt += 1) {
        this.attempts += 1;
        const draft = new Map(this.rows);
        this.transactionActive = true;
        let result;
        try { result = await work({
          getAll: async (...refs) => {
            this.operations.push('read');
            return refs.map(({ id }) => ({ id, exists: draft.has(id), data: () => draft.get(id) }));
          },
          set: ({ id }, data) => { this.operations.push('write'); draft.set(id, data); },
        }); } finally { this.transactionActive = false; }
        if (this.conflicts > 0) { this.conflicts -= 1; continue; }
        this.rows = draft;
        return result;
      }
      throw new Error('private SDK credential diagnostics');
    });
    this.pending = run.catch(() => {});
    return run;
  }
}

function fixture() {
  const firestore = new FirestoreDouble();
  const provider = createFirestoreTransactions({ firestore, Timestamp });
  return { firestore, provider, quota: createQuotaStore(provider) };
}
const now = Date.UTC(2026, 8, 7);
const fingerprint = 'a'.repeat(64);
const request = (extra = {}) => ({ sessionId: 'test-session', requestId: 'test-request', fingerprint, now, ...extra });

test('Firestore transaction retry commits counters once and preserves request idempotency', async () => {
  const { firestore, quota } = fixture();
  firestore.conflicts = 2;
  const result = await quota.reserve(request());
  assert.equal(result.allowed, true);
  assert.equal(firestore.attempts, 3);
  assert.deepEqual(firestore.options, { maxAttempts: 4 });
  assert.equal(firestore.rows.size, 4);
  for (const row of firestore.rows.values()) {
    assert.ok(row.expiresAt instanceof Timestamp);
    if ('count' in row.value) assert.equal(row.value.count, 1);
    assert.deepEqual(Object.keys(row).sort(), ['expiresAt', 'value']);
  }
  assert.equal((await quota.reserve(request())).reason, 'request_in_progress');
  assert.equal((await quota.reserve(request({ fingerprint: 'b'.repeat(64) }))).reason, 'request_conflict');
  await quota.finalize(result.requestKey, 'completed');
  assert.equal((await quota.reserve(request())).reason, 'already_processed');
  assert.equal(firestore.rows.get(result.requestKey).value.status, 'completed');
});

test('Firestore TTL is a Timestamp and expired records do not require physical deletion', async () => {
  const { firestore, quota, provider } = fixture();
  const result = await quota.reserve(request());
  const row = (await provider.transaction((tx) => tx.get([result.requestKey]))).get(result.requestKey);
  assert.equal(row.expiresAt, now + 2 * 86_400_000);
  assert.equal(firestore.rows.get(result.requestKey).expiresAt.toMillis(), row.expiresAt);
  assert.equal((await quota.reserve(request({ now: now + 2 * 86_400_000 }))).allowed, true);
});

test('Firestore quota concurrent local contract checks respect session and global limits', async () => {
  const first = fixture();
  const sameSession = await Promise.all(Array.from({ length: 15 }, (_, i) => first.quota.reserve(request({ requestId: `request-${i}` }))));
  assert.equal(sameSession.filter((r) => r.allowed).length, 6);
  const second = fixture();
  const distinctSessions = await Promise.all(Array.from({ length: 110 }, (_, i) => second.quota.reserve(request({ sessionId: `session-${i}` }))));
  assert.equal(distinctSessions.filter((r) => r.allowed).length, 100);
});

test('Firestore rejects reads after writes, blind writes, malformed rows and collection paths', async () => {
  const { firestore, provider } = fixture();
  for (const collection of ['parent/child', '', '../state', '__internal__']) {
    assert.throws(() => createFirestoreTransactions({ firestore, Timestamp, collection }), /Invalid/);
  }
  for (const maxAttempts of [0, 5, Infinity]) {
    assert.throws(() => createFirestoreTransactions({ firestore, Timestamp, maxAttempts }), /Invalid/);
  }
  const row = { key: 'global-day:1', value: { count: 1 }, expiresAt: now };
  await assert.rejects(provider.transaction(async (tx) => {
    await tx.get([row.key]); await tx.put([row]); await tx.get([row.key]);
  }), /Quota transaction unavailable/);
  await assert.rejects(provider.transaction((tx) => tx.put([row])), /Quota transaction unavailable/);
  assert.equal(firestore.rows.size, 0);
  for (const badRow of [
    { ...row, value: { count: -1 } },
    { ...row, value: { count: 1, message: 'private transcript' } },
    { ...row, expiresAt: NaN },
    { ...row, key: '../another/document' },
    { ...row, value: { fingerprint, status: 'unknown' } },
  ]) {
    await assert.rejects(provider.transaction(async (tx) => { await tx.get([row.key]); await tx.put([badRow]); }), /Quota transaction unavailable/);
  }
  assert.equal(firestore.rows.size, 0);
});

test('Firestore corrupt or unavailable storage fails closed with bounded sanitized retry errors', async () => {
  const { firestore, quota } = fixture();
  firestore.conflicts = 10;
  await assert.rejects(quota.reserve(request()), (error) => error.message === 'Quota transaction unavailable.' && error.cause === undefined);
  assert.equal(firestore.attempts, 4);
  assert.equal(firestore.rows.size, 0);
  firestore.conflicts = 0;
  firestore.rows.set(`global-day:${Math.floor(now / 86_400_000)}`, { value: { count: 1 }, expiresAt: 'not-a-timestamp' });
  await assert.rejects(quota.reserve(request()), /Quota transaction unavailable/);
});

test('Firestore transaction retries never re-run the LLM or store its transcript', async () => {
  const { firestore, quota } = fixture();
  const origin = 'https://example.github.io';
  let calls = 0;
  const handler = createHandler({
    config: { origins: [origin], sessionSecret: 's'.repeat(64), datasetId: 'fictional-test', profileHash: 'b'.repeat(64), profiles: new Map([['person-1', { id: 'person-1', name: 'Анна' }]]) },
    quota, now: () => now,
    upstream: async () => {
      assert.equal(firestore.transactionActive, false);
      calls += 1;
      return { reply: 'Private reply stays out of storage.', model: 'test-model' };
    },
  });
  const event = (path, body) => ({ httpMethod: 'POST', path, headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const sessionToken = JSON.parse((await handler(event('/session', {}))).body).sessionToken;
  const input = { personId: 'person-1', datasetId: 'fictional-test', scenario: 'baseline', year: 2026, presentationMinutes: 600, message: 'Private user message.', sessionToken, requestId: 'request_identifier_001' };
  firestore.conflicts = 2;
  assert.equal((await handler(event('/chat', input))).statusCode, 200);
  assert.equal((await handler(event('/chat', input))).statusCode, 409);
  assert.equal(calls, 1);
  const stored = JSON.stringify([...firestore.rows]);
  assert.equal(stored.includes('Private'), false);
  assert.equal(stored.includes(sessionToken), false);
  assert.equal(stored.includes('person-1'), false);
});
