import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirebaseRuntime } from '../template/runtime.mjs';
import { ALLOWED_ORIGIN } from '../template/policy.mjs';
import { withinDeadline } from '../../../server/chat/src/handler.mjs';

const event = { httpMethod: 'POST', path: '/session', headers: { origin: ALLOWED_ORIGIN, 'content-type': 'application/json' }, body: '{}' };
const ok = { statusCode: 200, headers: {}, body: '{}' };

test('preflight, rejected origin and unknown route never initialize runtime', async () => {
  let calls = 0;
  const runtime = createFirebaseRuntime({ withinDeadline, initialize: async () => { calls += 1; throw new Error('Sensitive SDK diagnostic'); } });
  assert.equal((await runtime({ ...event, httpMethod: 'OPTIONS' })).statusCode, 204);
  assert.equal((await runtime({ ...event, path: '/not-found' })).statusCode, 404);
  assert.equal((await runtime({ ...event, httpMethod: 'GET' })).statusCode, 405);
  const rejected = await runtime({ ...event, headers: { origin: 'https://attacker.example' } });
  assert.equal(rejected.statusCode, 403);
  assert.equal(rejected.headers['Access-Control-Allow-Origin'], undefined);
  assert.equal(calls, 0);
});

test('initialization is lazy, shared by overlapping requests and reused when ready', async () => {
  let calls = 0;
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  const seenSignals = [];
  const runtime = createFirebaseRuntime({ withinDeadline, initialize: async () => { calls += 1; await ready; return async (_event, { signal }) => { seenSignals.push(signal); return ok; }; } });
  assert.equal(calls, 0);
  const requests = [runtime(event), runtime(event)];
  release();
  assert.deepEqual(await Promise.all(requests), [ok, ok]);
  assert.equal(await runtime(event), ok);
  assert.equal(calls, 1);
  assert.equal(seenSignals.length, 3);
  assert.ok(seenSignals.every((signal) => signal instanceof AbortSignal && !signal.aborted));
});

test('initialization failure is safely serialized and a subsequent attempt may recover', async () => {
  let calls = 0;
  const runtime = createFirebaseRuntime({ withinDeadline, initialize: async () => { if (++calls === 1) throw new Error('private-key and SDK diagnostic must not escape'); return async () => ok; } });
  const failed = await runtime(event);
  assert.equal(failed.statusCode, 503);
  assert.deepEqual(JSON.parse(failed.body), { source: 'unavailable', reason: 'service_not_configured' });
  assert.equal(JSON.stringify(failed).includes('private-key'), false);
  assert.equal(await runtime(event), ok);
  assert.equal(calls, 2);
});

test('never-settling initialization returns inside a bounded readiness deadline', async () => {
  let calls = 0;
  const runtime = createFirebaseRuntime({ withinDeadline, deadlineMs: 20, initialize: () => { calls += 1; return new Promise(() => {}); } });
  const started = performance.now();
  assert.equal((await runtime(event)).statusCode, 503);
  assert.ok(performance.now() - started < 1000);
  assert.equal((await runtime(event)).statusCode, 503);
  assert.equal(calls, 1, 'a stuck initializer must not spawn duplicates');
});

test('a handler receives the shared abort signal and cannot outlive the response deadline', async () => {
  let signal;
  const runtime = createFirebaseRuntime({ withinDeadline, deadlineMs: 20, initialize: async () => async (_event, options) => { signal = options.signal; return new Promise(() => {}); } });
  assert.equal((await runtime(event)).statusCode, 503);
  assert.equal(signal.aborted, true);
});

test('invalid initialization result and synchronous handler errors fail closed without diagnostics', async () => {
  for (const initialize of [async () => ({}), async () => () => { throw new Error('secret from SDK'); }]) {
    const result = await createFirebaseRuntime({ initialize, withinDeadline })(event);
    assert.equal(result.statusCode, 503);
    assert.equal(result.body.includes('secret'), false);
  }
  assert.throws(() => createFirebaseRuntime({ initialize: async () => () => {}, withinDeadline, deadlineMs: 30_000 }), /Invalid runtime/);
});
