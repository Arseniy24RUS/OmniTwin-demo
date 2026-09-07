import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrivateSecretsOperator } from '../scripts/private-secrets.mjs';

const projectId = 'omnitwin-demo';
const projectNumber = '679501553916';
const secretName = 'OPENROUTER_API_KEY';
const token = 'fake_access_token_only_for_unit_tests';
const key = 'sk-or-v1-fake_key_only_for_unit_tests_123456';
const base = 'https://secretmanager.googleapis.com/v1';
const resource = (name = secretName, project = projectNumber) => `projects/${project}/secrets/${name}`;
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function setup(responses) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error('No fake response; network is prohibited.');
    return next;
  };
  return { calls, operator: createPrivateSecretsOperator({ accessToken: token, fetchImpl }) };
}

test('creates only absent demo secret metadata then adds one in-memory version', async () => {
  const { operator, calls } = setup([json({}, 404), json({ name: resource() }), json({}), json({ name: `${resource()}/versions/1` })]);
  const result = await operator.ensureOpenRouterKey(key);
  assert.deepEqual(result, { status: 'version_added', name: secretName, versionId: '1' });
  assert.equal(calls.length, 4);
  assert.equal(calls[0].url, `${base}/projects/${projectId}/secrets/${secretName}`);
  assert.equal(calls[1].url, `${base}/projects/${projectId}/secrets?secretId=${secretName}`);
  assert.deepEqual(JSON.parse(calls[1].options.body), { replication: { automatic: {} }, labels: { application: 'omnitwin-demo', scope: 'demo-only' } });
  assert.equal(calls[2].url, `${base}/projects/${projectId}/secrets/${secretName}/versions?pageSize=1`);
  assert.equal(calls[3].url, `${base}/projects/${projectId}/secrets/${secretName}:addVersion`);
  assert.deepEqual(JSON.parse(calls[3].options.body), { payload: { data: Buffer.from(key).toString('base64') } });
  assert.deepEqual(calls.map((call) => call.options.method), ['GET', 'POST', 'GET', 'POST']);
  for (const call of calls) {
    assert.equal(new URL(call.url).origin, 'https://secretmanager.googleapis.com');
    assert.equal(call.options.redirect, 'error');
    assert.ok(call.options.signal instanceof AbortSignal);
    assert.equal(call.options.headers.Authorization, `Bearer ${token}`);
    assert.equal(call.url.includes(token), false); assert.equal(call.url.includes(key), false);
  }
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test('any existing version is never overwritten or accessed, including disabled/destroyed versions', async () => {
  for (const state of ['ENABLED', 'DISABLED', 'DESTROYED']) {
    const { operator, calls } = setup([json({ name: resource() }), json({ versions: [{ name: `${resource()}/versions/12`, state }], nextPageToken: 'more' })]);
    const result = await operator.ensureOpenRouterKey(key);
    assert.deepEqual(result, { status: 'existing_versions', name: secretName, versionId: '12', needsVerification: true });
    assert.deepEqual(calls.map((call) => call.options.method), ['GET', 'GET']);
    assert.equal(calls.some((call) => call.url.includes(':access')), false);
  }
});

test('independent signing secrets are generated internally only for empty secrets', async () => {
  const values = [];
  for (let i = 0; i < 2; i += 1) {
    const name = 'SESSION_SIGNING_SECRET';
    const { operator, calls } = setup([json({ name: resource(name, projectId) }), json({ versions: [] }), json({ name: `${resource(name)}/versions/1` })]);
    const result = await operator.ensureSessionSigningSecret();
    const generated = Buffer.from(JSON.parse(calls[2].options.body).payload.data, 'base64').toString('utf8');
    assert.match(generated, /^[a-f0-9]{128}$/);
    assert.equal(JSON.stringify(result).includes(generated), false);
    values.push(generated);
  }
  assert.notEqual(values[0], values[1]);
});

test('403, invalid returned targets and malformed listings all fail closed without secret reflection', async () => {
  const cases = [
    [json({ error: { message: key } }, 403)],
    [json({ name: resource(secretName, 'another-project') })],
    [json({ name: resource() }), json({ versions: [{ name: `${resource('OTHER_SECRET')}/versions/1` }] })],
    [json({ name: resource() }), json({ versions: [], nextPageToken: 'unverified' })],
    [json({ name: resource() }), json({ totalSize: 1 })],
    [json({ name: resource() }), json({ versions: 'not-an-array' })],
    [json({ name: resource() }), json({ versions: null })],
    [json({ name: resource() }), json({ error: { message: key } })],
    [json({ name: resource() }), json({ error: { message: key } }, 403)],
  ];
  for (const responses of cases) {
    const { operator, calls } = setup(responses);
    const result = await operator.ensureOpenRouterKey(key);
    assert.equal(result.needsVerification, true);
    assert.notEqual(result.status, 'version_added');
    assert.equal(calls.some((call) => call.options.method === 'POST'), false);
    assert.equal(JSON.stringify(result).includes(key), false);
  }
});

test('ambiguous addVersion is not retried, including a repeated call to the same operator', async () => {
  const { operator, calls } = setup([json({ name: resource() }), json({}), new Error(`private transport ${key} ${token}`)]);
  const result = await operator.ensureOpenRouterKey(key);
  assert.deepEqual(result, { status: 'version_add_outcome_unknown', name: secretName, needsVerification: true });
  const repeated = await operator.ensureOpenRouterKey(key);
  assert.equal(repeated.status, 'already_attempted');
  assert.equal(calls.length, 3);
  assert.equal(calls.filter((call) => call.url.endsWith(':addVersion')).length, 1);
  assert.equal(JSON.stringify([result, repeated]).includes(key), false);
  assert.equal(JSON.stringify([result, repeated]).includes(token), false);
});

test('creation conflict and invalid addVersion success require manual verification without retries', async () => {
  for (const responses of [
    [json({}, 404), json({ error: { message: key } }, 409)],
    [json({}, 404), new Error(key)],
    [json({ name: resource() }), json({}), json({ name: `${resource(secretName, 'wrong-project')}/versions/1` })],
  ]) {
    const { operator, calls } = setup(responses);
    const result = await operator.ensureOpenRouterKey(key);
    assert.equal(result.needsVerification, true);
    assert.equal(JSON.stringify(result).includes(key), false);
    assert.equal(calls.filter((call) => call.options.method === 'POST').length, 1);
  }
});

test('metadata inspection and concurrent duplicate calls cannot access contents or add twice', async () => {
  const { operator, calls } = setup([json({ name: resource() }), json({}), json({ name: `${resource()}/versions/1` })]);
  const results = await Promise.all([operator.ensureOpenRouterKey(key), operator.ensureOpenRouterKey(key)]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['already_attempted', 'version_added']);
  assert.equal(calls.length, 3);
  const read = setup([json({ name: resource() }), json({ versions: [{ name: `${resource()}/versions/1` }] })]);
  assert.equal((await read.operator.inspectSecret(secretName)).status, 'existing_versions');
  assert.equal(read.calls.every((call) => call.options.method === 'GET'), true);
  const before = read.calls.length;
  assert.deepEqual(await read.operator.inspectSecret('../OTHER_SECRET'), { status: 'invalid_input' });
  assert.equal(read.calls.length, before);
});

test('wrong configuration and malformed key cannot reach fetch or disclose supplied inputs', async () => {
  for (const options of [{ projectId: 'other-project' }, { expectedProjectNumber: '123' }, { accessToken: `${token}\nheader` }]) {
    assert.throws(() => createPrivateSecretsOperator({ accessToken: token, ...options }), (error) => error.message === 'Invalid private-secret operator configuration.');
  }
  const { operator, calls } = setup([]);
  assert.deepEqual(await operator.ensureOpenRouterKey('short'), { status: 'invalid_input', name: secretName });
  assert.equal(calls.length, 0);
});
