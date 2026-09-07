import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const DAY = 86_400_000;
export function issueSession(secret, origin, now) {
  const data = { sid: randomUUID(), origin, exp: now + DAY };
  const encoded = Buffer.from(JSON.stringify(data)).toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return { sessionToken: `${encoded}.${signature}`, expiresAt: new Date(data.exp).toISOString() };
}

export function verifySession(token, secret, origin, now) {
  if (typeof token !== 'string' || token.length > 1024) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return null;
  const expected = createHmac('sha256', secret).update(parts[0]).digest();
  const supplied = Buffer.from(parts[1], 'base64url');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  try {
    const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (typeof data.sid !== 'string' || !/^[0-9a-f-]{36}$/.test(data.sid) || data.origin !== origin || !Number.isSafeInteger(data.exp) || data.exp <= now || data.exp > now + DAY) return null;
    return data;
  } catch { return null; }
}
