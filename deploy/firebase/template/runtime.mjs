import { ALLOWED_ORIGIN } from './policy.mjs';

/** Lazy, credential-free at import. Initialization and processing share 25s. */
export function createFirebaseRuntime({ initialize, withinDeadline, deadlineMs = 25_000 }) {
  if (typeof initialize !== 'function' || typeof withinDeadline !== 'function' || !Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 25_000) throw new Error('Invalid runtime configuration.');
  let ready;
  function getReady() {
    if (!ready) {
      const attempt = Promise.resolve().then(initialize).then((handler) => {
        if (typeof handler !== 'function') throw new Error('Invalid initialized handler.');
        return handler;
      });
      ready = attempt;
      // A failed attempt can be retried, but never start parallel initializers.
      void attempt.catch(() => { if (ready === attempt) ready = undefined; });
    }
    return ready;
  }
  return async function runtime(event) {
    const headers = Object.fromEntries(Object.entries(event?.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    const origin = headers.origin;
    const allowed = origin === ALLOWED_ORIGIN;
    const response = (statusCode, reason, extra = {}) => ({
      statusCode,
      headers: {
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin',
        ...(allowed ? { 'Access-Control-Allow-Origin': origin } : {}), ...extra,
      },
      body: statusCode === 204 ? '' : JSON.stringify({ source: 'unavailable', reason }),
      isBase64Encoded: false,
    });
    // Reject unsupported traffic and answer preflight before touching secrets,
    // profiles or Admin SDK. CORS is not authentication or an abuse barrier.
    if (!allowed) return response(403, 'origin_not_allowed');
    if (!['/session', '/chat'].includes(event.path)) return response(404, 'not_found');
    if (event.httpMethod === 'OPTIONS') return response(204, undefined, { 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' });
    if (event.httpMethod !== 'POST') return response(405, 'method_not_allowed');
    const controller = new AbortController();
    // Keep this referenced: a never-settling initialization still must respond.
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    try {
      const handler = await withinDeadline(getReady(), controller.signal);
      if (controller.signal.aborted) throw new Error('Runtime deadline reached.');
      return await withinDeadline(Promise.resolve().then(() => handler(event, { signal: controller.signal })), controller.signal);
    } catch {
      // Do not log or serialize initialization, provider or credential errors.
      return response(503, 'service_not_configured');
    } finally { clearTimeout(timer); }
  };
}
