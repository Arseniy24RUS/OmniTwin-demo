import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuotaStore } from '../src/quota.mjs';
import { MemoryTransactions } from './support.mjs';

test('daily session quota survives minute changes and global quota spans sessions', async () => {
  const q = createQuotaStore(new MemoryTransactions());
  const day = Date.UTC(2026, 8, 7);
  const reserve = (i, sessionId, offset = i) => q.reserve({ sessionId, requestId: `request-${i}`, fingerprint: `fingerprint-${i}`, now: day + offset * 60_000 });
  for (let i = 0; i < 30; i++) assert.equal((await reserve(i, 'one')).allowed, true);
  assert.equal((await reserve(30, 'one')).reason, 'rate_limited');
  for (let i = 30; i < 100; i++) assert.equal((await reserve(i, `session-${i}`)).allowed, true);
  assert.equal((await reserve(100, 'new-session')).reason, 'rate_limited');
  assert.equal((await q.reserve({ sessionId: 'one', requestId: 'next-day', fingerprint: 'next-day', now: day + 86_400_000 })).allowed, true);
});

test('global daily quota remains atomic under simultaneous sessions', async () => {
  const q = createQuotaStore(new MemoryTransactions());
  const result = await Promise.all(Array.from({ length: 130 }, (_, i) => q.reserve({ sessionId: `session-${i}`, requestId: `request-${i}`, fingerprint: `${i}`, now: 1_800_000_000_000 })));
  assert.equal(result.filter((r) => r.allowed).length, 100);
});

test('expired records are ignored before asynchronous TTL removal', async () => {
  const tx = new MemoryTransactions(); const q = createQuotaStore(tx);
  const request = { sessionId: 'one', requestId: 'request', fingerprint: 'fingerprint', now: 1_800_000_000_000 };
  const first = await q.reserve(request);
  assert.equal(first.allowed, true);
  for (const row of tx.rows.values()) row.expiresAt = request.now - 1;
  assert.equal((await q.reserve(request)).allowed, true);
});
