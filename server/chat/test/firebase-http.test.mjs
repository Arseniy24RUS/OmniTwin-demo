import assert from 'node:assert/strict';
import test from 'node:test';
import { createFirebaseHttpHandler } from '../src/firebase-http.mjs';
import { createHandler } from '../src/handler.mjs';
import { createQuotaStore } from '../src/quota.mjs';
import { MemoryTransactions } from './support.mjs';

const origin = 'https://example.github.io';
function request(overrides = {}) {
  return { method: 'POST', path: '/session', url: '/session', headers: { origin, 'content-type': 'application/json' }, rawBody: Buffer.from('{}'), query: {}, ...overrides };
}
function response() {
  return {
    statusCode: null, headers: {}, body: undefined, ended: false,
    status(code) { this.statusCode = code; return this; },
    set(headers) { Object.assign(this.headers, headers); return this; },
    send(body) { this.body = body; this.ended = true; return this; },
    end() { this.ended = true; return this; },
  };
}
function setup() {
  let calls = 0;
  const core = createHandler({
    config: { origins: [origin], sessionSecret: 'a'.repeat(64), datasetId: 'fictional-test', profileHash: 'b'.repeat(64), profiles: new Map([['person-1', { id: 'person-1', name: 'Анна' }]]) },
    quota: createQuotaStore(new MemoryTransactions()),
    upstream: async () => { calls += 1; return { reply: 'Здравствуйте!', model: 'approved-test-model' }; },
  });
  const adapter = createFirebaseHttpHandler({ handler: core, origins: [origin] });
  const invoke = async (req) => { const res = response(); await adapter(req, res); return res; };
  return { invoke, calls: () => calls };
}

test('Firebase HTTP preserves raw body bytes, method, path, headers and query transport', async () => {
  const bytes = Buffer.from('{"message":"Привет"}');
  const query = { tag: ['a', 'b'], nested: { key: 'value' } };
  let seen;
  const adapter = createFirebaseHttpHandler({ origins: [origin], handler: async (event) => {
    seen = event; return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: '{"ok":true}', isBase64Encoded: false };
  } });
  const res = response();
  await adapter(request({ path: '/chat', url: '/chat?tag=a&tag=b', rawBody: bytes, query, headers: { origin, 'content-type': 'application/json; charset=utf-8', 'x-test': 'transport' } }), res);
  assert.equal(seen.httpMethod, 'POST'); assert.equal(seen.path, '/chat');
  assert.equal(seen.isBase64Encoded, true);
  assert.deepEqual(Buffer.from(seen.body, 'base64'), bytes);
  assert.deepEqual(seen.queryStringParameters, query);
  assert.equal(seen.headers['x-test'], 'transport');
  assert.equal(res.statusCode, 200); assert.equal(res.body, '{"ok":true}');
});

test('Firebase HTTP enforces raw 8KB before core JSON parsing and never reads parsed body', async () => {
  let calls = 0;
  const adapter = createFirebaseHttpHandler({ origins: [origin], handler: async () => { calls += 1; throw new Error('must not run'); } });
  const req = request({ rawBody: Buffer.from('я'.repeat(4097)) });
  Object.defineProperty(req, 'body', { get() { throw new Error('Parsed body must not be inspected.'); } });
  const res = response(); await adapter(req, res);
  assert.equal(res.statusCode, 413); assert.equal(JSON.parse(res.body).reason, 'input_too_large');
  assert.equal(res.headers['Access-Control-Allow-Origin'], origin); assert.equal(calls, 0);
  const boundary = setup();
  const accepted = await boundary.invoke(request({ rawBody: Buffer.from(`{}${' '.repeat(8190)}`) }));
  assert.equal(accepted.statusCode, 200);
});

test('Firebase HTTP OPTIONS has no body, preserves strict CORS and allowed methods', async () => {
  const s = setup();
  const res = await s.invoke(request({ method: 'OPTIONS', rawBody: undefined }));
  assert.equal(res.statusCode, 204); assert.equal(res.body, undefined); assert.equal(res.ended, true);
  assert.equal(res.headers['Access-Control-Allow-Methods'], 'POST, OPTIONS');
  const denied = await s.invoke(request({ method: 'OPTIONS', headers: { origin: 'https://attacker.example' }, rawBody: undefined }));
  assert.equal(denied.statusCode, 403); assert.equal(denied.headers['Access-Control-Allow-Origin'], undefined);
  assert.equal((await s.invoke(request({ method: 'GET', rawBody: undefined }))).statusCode, 405);
  assert.equal((await s.invoke(request({ path: '/chat/other' }))).statusCode, 404);
});

test('Firebase HTTP rejects malformed bodies and transport without spending or exposing input', async () => {
  const s = setup();
  for (const rawBody of [undefined, '{}', Buffer.from('{private malformed'), Buffer.from('null'), Buffer.from('[]')]) {
    const res = await s.invoke(request({ rawBody }));
    assert.equal(res.statusCode, 400); assert.equal(JSON.parse(res.body).reason, 'invalid_input');
    assert.equal(res.body.includes('private'), false);
  }
  assert.equal((await s.invoke(request({ method: undefined }))).statusCode, 400);
  assert.equal((await s.invoke(request({ headers: { origin, 'content-type': 'text/plain' } }))).statusCode, 400);
  assert.equal(s.calls(), 0);
});

test('Firebase HTTP keeps session/chat behavior and duplicate idempotency unchanged', async () => {
  const s = setup();
  const sessionToken = JSON.parse((await s.invoke(request())).body).sessionToken;
  const input = { personId: 'person-1', datasetId: 'fictional-test', scenario: 'baseline', year: 2026, presentationMinutes: 600, message: 'Здравствуйте', sessionToken, requestId: 'firebase_request_001' };
  const res = await s.invoke(request({ path: '/chat', rawBody: Buffer.from(JSON.stringify(input)) }));
  assert.equal(res.statusCode, 200); assert.equal(JSON.parse(res.body).source, 'llm');
  const duplicate = await s.invoke(request({ path: '/chat', rawBody: Buffer.from(JSON.stringify(input)) }));
  assert.equal(duplicate.statusCode, 409); assert.equal(JSON.parse(duplicate.body).reason, 'already_processed');
  assert.equal(s.calls(), 1);
});

test('Firebase HTTP sanitizes thrown errors and invalid/oversized internal responses', async () => {
  for (const handler of [
    async () => { throw new Error('private provider secret'); },
    async () => ({ statusCode: 200, headers: {}, body: 's'.repeat(8193) }),
    async () => ({ statusCode: 700, headers: {}, body: 'private provider secret' }),
    async () => ({ statusCode: 200, headers: { 'x-header': 'invalid\r\nsecret' }, body: '{}' }),
  ]) {
    const adapter = createFirebaseHttpHandler({ handler, origins: [origin] });
    const res = response(); await adapter(request(), res);
    assert.equal(res.statusCode, 503); assert.equal(JSON.parse(res.body).reason, 'server_unavailable');
    assert.equal(res.body.includes('secret'), false); assert.equal(res.headers['Access-Control-Allow-Origin'], origin);
  }
});
