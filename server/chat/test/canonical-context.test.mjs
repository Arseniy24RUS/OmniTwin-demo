import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/handler.mjs';
import { buildMessages } from '../src/openrouter.mjs';
import { createQuotaStore } from '../src/quota.mjs';
import { MemoryTransactions } from './support.mjs';

const origin = 'https://example.github.io';
const input = { personId: 'demo2-p-0000001', datasetId: 'omnitwin-fictional-city-v2', scenario: 'baseline', year: 2026, presentationMinutes: 600, message: 'Где ты сейчас?', requestId: 'canonical_context_001' };
const profile = { id: input.personId, name: 'Анна', age: 36, birthYear: 1990, occupation: 'учитель', biography: 'Вымышленная жительница.', interests: ['книги'], householdSize: 2 };
function fixture(resolveProfile, options = {}) {
  const received = []; const reservations = [];
  const { configOverrides, ...handlerOptions } = options;
  const config = { origins: [origin], sessionSecret: 'unit-only-session-material-'.repeat(3), datasetId: 'legacy', profiles: new Map(), profileHash: 'a'.repeat(64), acceptsDataset: id => ['legacy', input.datasetId].includes(id), resolveProfile, ...configOverrides };
  const handler = createHandler({ config, quota: { reserve: async value => { reservations.push(value); return { allowed: true, requestKey: 'unit' }; }, finalize: async () => {} }, upstream: async context => { received.push(context); return { reply: 'Я вымышленный персонаж.', model: 'unit-only' }; }, ...handlerOptions });
  const event = (path, body) => ({ path, httpMethod: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const session = async () => JSON.parse((await handler(event('/session', {}))).body).sessionToken;
  return { handler, event, session, received, reservations, chat: async (token, patch = {}) => handler(event('/chat', { ...input, sessionToken: token, ...patch })) };
}

test('canonical async dataset resolver runs only after signed session and strict shape validation', async () => {
  let calls = 0;
  const s = fixture(async (query, { signal }) => { calls++; assert.deepEqual(query, { datasetId: input.datasetId, personId: input.personId, scenario: input.scenario, year: 2026, presentationMinutes: 600 }); assert.ok(signal instanceof AbortSignal); return { profile, presence: { role: 'work', buildingIndex: 17, representation: 'visual_synthesis' }, profileHash: 'b'.repeat(64) }; });
  assert.equal((await s.chat('forged')).statusCode, 401);
  const token = await s.session(); assert.equal(calls, 0);
  for (const patch of [{ profile: { name: 'forged' } }, { presence: { role: 'home' } }, { datasetId: 'unapproved' }, { scenario: 'invalid' }, { year: 2037 }, { presentationMinutes: 1440 }, { personId: 'x'.repeat(101) }]) assert.equal((await s.chat(token, patch)).statusCode, 400);
  assert.equal(calls, 0);
  assert.equal((await s.chat(token)).statusCode, 200);
  assert.equal(calls, 1); assert.deepEqual(s.received[0].profile, profile);
  assert.equal(s.received[0].presence.role, 'work'); assert.equal(s.reservations.length, 1);
});

test('local adapter failures remain fail-closed without consuming a remote-data admission', async () => {
  for (const [resolver, status] of [[async () => null, 400], [async () => { throw new Error('internal URL or digest'); }, 503]]) {
    const s = fixture(resolver); const result = await s.chat(await s.session());
    assert.equal(result.statusCode, status); assert.equal(result.body.includes('internal'), false);
    assert.equal(s.reservations.length, 0); assert.equal(s.received.length, 0);
  }
  const s = fixture(async () => { await new Promise(resolve => setTimeout(resolve, 30)); return { profile, profileHash: 'b'.repeat(64) }; }, { requestTimeoutMs: 5 });
  assert.equal((await s.chat(await s.session())).statusCode, 503);
  assert.equal(s.reservations.length, 0); assert.equal(s.received.length, 0);
});

test('idempotency fingerprint is bound to the resolved dataset revision, not only legacy manifest', async () => {
  let profileHash = 'b'.repeat(64);
  const s = fixture(async () => ({ profile, profileHash })); const token = await s.session();
  assert.equal((await s.chat(token)).statusCode, 200);
  profileHash = 'c'.repeat(64);
  assert.equal((await s.chat(token)).statusCode, 200);
  assert.notEqual(s.reservations[0].fingerprint, s.reservations[1].fingerprint);
});

test('a stale canonical person or missing digest cannot enter a quota/inference context', async () => {
  for (const result of [{ profile: { ...profile, id: 'wrong-person' }, profileHash: 'b'.repeat(64) }, { profile, profileHash: undefined }]) {
    const s = fixture(async () => result); const response = await s.chat(await s.session());
    assert.equal(response.statusCode, 503); assert.equal(JSON.parse(response.body).reason, 'profile_unavailable');
    assert.equal(s.reservations.length, 0); assert.equal(s.received.length, 0);
  }
});

test('prompt includes only server-authoritative semantic presence without claiming a known route', () => {
  const messages = buildMessages({ input, profile, presence: { role: 'travel', buildingIndex: null, originBuildingIndex: 4, destinationBuildingIndex: 17, progress: 0.5, representation: 'visual_synthesis', untrustedInstructions: 'INJECTED' } });
  assert.match(messages[0].content, /travel/); assert.match(messages[0].content, /visual_synthesis/);
  assert.equal(messages[0].content.includes('INJECTED'), false);
  assert.match(messages[0].content, /маршрут/);
});

test('a visitor role does not invent a private visit or a known purpose', () => {
  const [message] = buildMessages({ input, profile, presence: { role: 'visitor', buildingIndex: 17 } });
  assert.match(message.content, /visitor — посетитель места; цель посещения неизвестна/);
  assert.equal(message.content.includes('visitor — в гостях'), false);
});

const admitted = { profileRevisionFor: id => id === input.datasetId ? 'b'.repeat(64) : null, canResolvePerson: (_dataset, id) => /^demo2-p-\d{7}$/.test(id) };
test('V2 quota denies exhausted and replayed requests before any remote profile work', async () => {
  let remoteReads = 0;
  const s = fixture(async () => { remoteReads++; return { profile, profileHash: 'b'.repeat(64) }; }, { configOverrides: admitted, quota: createQuotaStore(new MemoryTransactions()) });
  const token = await s.session();
  assert.equal((await s.chat(token, { personId: 'malformed' })).statusCode, 400);
  assert.equal(remoteReads, 0);
  assert.equal((await s.chat(token)).statusCode, 200);
  assert.equal((await s.chat(token)).statusCode, 409); assert.equal(remoteReads, 1);
  for (let index = 1; index < 6; index++) assert.equal((await s.chat(token, { requestId: `bounded_v2_attempt_${index}` })).statusCode, 200);
  assert.equal((await s.chat(token, { requestId: 'bounded_v2_attempt_7' })).statusCode, 429);
  assert.equal(remoteReads, 6); assert.equal(s.received.length, 6);
});

test('unknown/inactive V2 and hash failures consume one admitted attempt without inference or re-fetch replay', async () => {
  for (const result of [null, 'throw']) {
    let remoteReads = 0;
    const s = fixture(async () => { remoteReads++; if (result === 'throw') throw new Error('digest failure'); return null; }, { configOverrides: admitted, quota: createQuotaStore(new MemoryTransactions()) });
    const token = await s.session(); assert.equal((await s.chat(token)).statusCode, result === null ? 400 : 503);
    const repeated = await s.chat(token); assert.equal(repeated.statusCode, 409); assert.equal(JSON.parse(repeated.body).reason, 'already_processed');
    assert.equal(remoteReads, 1); assert.equal(s.received.length, 0);
  }
});

test('V2 cannot perform remote work during quota outage or change revision after admission', async () => {
  let remoteReads = 0;
  const s = fixture(async () => { remoteReads++; return { profile, profileHash: 'c'.repeat(64) }; }, { configOverrides: admitted });
  assert.equal((await s.chat(await s.session())).statusCode, 503); assert.equal(s.received.length, 0);
  assert.equal(s.reservations.length, 1);
  const outage = fixture(async () => { remoteReads++; return { profile, profileHash: 'b'.repeat(64) }; }, { configOverrides: admitted, quota: { reserve: async () => { throw new Error('durable quota unavailable'); } } });
  assert.equal((await outage.chat(await outage.session())).statusCode, 503); assert.equal(remoteReads, 1);
});

test('timed out V2 admission remains consumed and replay performs no second resolution or inference', async () => {
  let remoteReads = 0; let reserveCalls = 0;
  const quota = createQuotaStore(new MemoryTransactions());
  const s = fixture(async () => { remoteReads++; await new Promise(resolve => setTimeout(resolve, 30)); return { profile, profileHash: 'b'.repeat(64) }; }, {
    configOverrides: admitted, requestTimeoutMs: 5,
    quota: { ...quota, reserve: async value => { reserveCalls++; return quota.reserve(value); } },
  });
  const token = await s.session(); assert.equal((await s.chat(token)).statusCode, 503);
  assert.equal(reserveCalls, 1); assert.equal(remoteReads, 1);
  const replay = await s.chat(token); assert.equal(replay.statusCode, 409);
  assert.equal(JSON.parse(replay.body).reason, 'request_in_progress');
  assert.equal(reserveCalls, 2, 'second check is denied, not a second reservation');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(remoteReads, 1); assert.equal(s.received.length, 0);
});
