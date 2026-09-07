import { createRequire } from 'node:module';
const { TokenAuthService } = createRequire(import.meta.url)('ydb-sdk');

const METADATA_URL = 'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token';

/** Refresh on use, including after a suspended function resumes. No keepalive. */
export function createMetadataAuth({ fetchImpl = fetch, now = Date.now } = {}) {
  let cached;
  let refreshing;
  async function refresh() {
    const startedAt = now();
    const response = await fetchImpl(METADATA_URL, { headers: { 'Metadata-Flavor': 'Google' }, redirect: 'error', signal: AbortSignal.timeout(2000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Service-account token unavailable.'); }
    const body = await response.text();
    if (Buffer.byteLength(body) > 8192) throw new Error('Invalid metadata response.');
    const data = JSON.parse(body);
    if (typeof data.access_token !== 'string' || data.access_token.length < 10 || data.access_token.length > 4096 || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error('Invalid metadata response.');
    cached = { token: data.access_token, expiresAt: startedAt + Math.max(0, Math.min(data.expires_in - 60, 600)) * 1000 };
  }
  return {
    async getAuthMetadata() {
      if (!cached || cached.expiresAt <= now()) {
        refreshing ??= refresh().finally(() => { refreshing = undefined; });
        await refreshing;
      }
      return new TokenAuthService(cached.token).getAuthMetadata();
    },
  };
}
