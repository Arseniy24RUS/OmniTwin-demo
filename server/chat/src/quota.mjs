import { createHash } from 'node:crypto';

const DAY = 86_400_000;
const digest = (text) => createHash('sha256').update(text).digest('hex');
export const DEFAULT_LIMITS = Object.freeze({ sessionMinute: 6, sessionDay: 30, globalDay: 100 });

/** The transaction provider MUST offer serializable read-write atomicity. */
export function createQuotaStore(provider, limits = DEFAULT_LIMITS) {
  if (!provider?.transaction) throw new Error('A durable transaction provider is required.');
  return {
    async reserve({ sessionId, requestId, fingerprint, now }) {
      const day = Math.floor(now / DAY);
      const minute = Math.floor(now / 60_000);
      const sessionHash = digest(sessionId);
      const requestKey = `request:${digest(`${sessionId}:${requestId}`)}`;
      const counters = [
        { key: `session-minute:${sessionHash}:${minute}`, limit: limits.sessionMinute, expiresAt: (minute + 1) * 60_000 },
        { key: `session-day:${sessionHash}:${day}`, limit: limits.sessionDay, expiresAt: (day + 1) * DAY },
        { key: `global-day:${day}`, limit: limits.globalDay, expiresAt: (day + 1) * DAY },
      ];
      return provider.transaction(async (tx) => {
        const rows = await tx.get([requestKey, ...counters.map((row) => row.key)]);
        const existing = rows.get(requestKey);
        if (existing && existing.expiresAt > now) {
          if (existing.value.fingerprint !== fingerprint) return { allowed: false, reason: 'request_conflict' };
          return { allowed: false, reason: existing.value.status === 'started' ? 'request_in_progress' : 'already_processed' };
        }
        for (const counter of counters) {
          const row = rows.get(counter.key);
          const count = row && row.expiresAt > now ? row.value.count : 0;
          if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid quota record.');
          if (count >= counter.limit) return { allowed: false, reason: 'rate_limited' };
          counter.value = { count: count + 1 };
        }
        await tx.put([
          ...counters.map(({ key, value, expiresAt }) => ({ key, value, expiresAt })),
          { key: requestKey, value: { fingerprint, status: 'started' }, expiresAt: now + 2 * DAY },
        ]);
        return { allowed: true, requestKey };
      });
    },
    async finalize(requestKey, status) {
      if (!['completed', 'failed'].includes(status)) throw new Error('Invalid request status.');
      await provider.transaction(async (tx) => {
        const record = (await tx.get([requestKey])).get(requestKey);
        if (!record) throw new Error('Missing request reservation.');
        await tx.put([{ ...record, value: { fingerprint: record.value.fingerprint, status } }]);
      });
    },
  };
}
