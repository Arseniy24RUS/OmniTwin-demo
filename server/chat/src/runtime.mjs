import { loadConfig } from './config.mjs';
import { createHandler, withinDeadline } from './handler.mjs';
import { createQuotaStore } from './quota.mjs';
import { connectYdb } from './ydb.mjs';
import { createOpenRouter } from './openrouter.mjs';

let initialized;
async function initialize() {
  const config = await loadConfig();
  const quota = createQuotaStore(await connectYdb(config.ydb));
  return createHandler({ config, quota, upstream: createOpenRouter({ apiKey: config.apiKey }) });
}

export async function handler(event) {
  const signal = AbortSignal.timeout(25_000);
  try {
    initialized ??= initialize().catch((error) => { initialized = undefined; throw error; });
    const ready = await withinDeadline(initialized, signal);
    return await ready(event, { signal });
  } catch {
    // Never emit exception objects, SDK diagnostics, prompts or credentials.
    const origin = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === 'origin')?.[1];
    const allowed = typeof origin === 'string' && (process.env.ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()).includes(origin);
    return { statusCode: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin', ...(allowed ? { 'Access-Control-Allow-Origin': origin } : {}) }, body: JSON.stringify({ source: 'unavailable', reason: 'service_not_configured' }), isBase64Encoded: false };
  }
}
