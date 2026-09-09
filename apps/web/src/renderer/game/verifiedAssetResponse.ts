export interface GameAssetIntegrity {
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
}

export const CITY_ASSET_IDLE_TIMEOUT_MS = 25_000;

/** A transport stall must reach TilesRenderer's load-error path. AbortError is
 * reserved for explicit disposal; the library intentionally ignores that name. */
export class CityAssetStallError extends Error {
  constructor() { super('City asset transfer made no byte progress for 25 seconds.'); this.name = 'CityAssetStallError'; }
}

function transferScope(external?: AbortSignal | null) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const progress = () => {
    stop();
    if (!controller.signal.aborted) timer = setTimeout(() => controller.abort(new CityAssetStallError()), CITY_ASSET_IDLE_TIMEOUT_MS);
  };
  const abort = () => { stop(); controller.abort(external?.reason); };
  if (external?.aborted) abort(); else { external?.addEventListener('abort', abort, {once: true}); progress(); }
  return {signal: controller.signal, progress, stop, dispose: () => { stop(); external?.removeEventListener('abort', abort); }};
}

/** Includes time waiting for headers and cancels even a non-cooperative fetch
 * adapter. A late response is closed instead of being retained after timeout. */
async function fetchWithSignal(url: string, init: RequestInit, fetcher: typeof fetch, signal: AbortSignal): Promise<Response> {
  signal.throwIfAborted();
  return new Promise<Response>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, {once: true});
    Promise.resolve().then(() => { signal.throwIfAborted(); return fetcher(url, {...init, signal}); }).then(response => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) { void response.body?.cancel().catch(() => {}); reject(signal.reason); }
      else resolve(response);
    }, error => { signal.removeEventListener('abort', abort); reject(signal.aborted ? signal.reason : error); });
  });
}

/** One watchdog covers headers and decoded body bytes. Progress resets it;
 * there is no total deadline or automatic retry that can starve a slow child. */
export async function fetchVerifiedAsset(asset: GameAssetIntegrity, init: RequestInit = {}, fetcher: typeof fetch = fetch): Promise<Response> {
  const scope = transferScope(init.signal);
  try {
    const response = await fetchWithSignal(asset.url, init, fetcher, scope.signal);
    return await readVerifiedAsset(response, asset, scope.signal, scope.progress, scope.stop);
  } finally { scope.dispose(); }
}

/** Verify decoded HTTP bytes before any GLB/image parser receives the response. */
export async function verifiedAssetResponse(
  response: Response, asset: GameAssetIntegrity, signal?: AbortSignal | null,
): Promise<Response> {
  const scope = transferScope(signal);
  try { return await readVerifiedAsset(response, asset, scope.signal, scope.progress, scope.stop); }
  finally { scope.dispose(); }
}

async function readVerifiedAsset(response: Response, asset: GameAssetIntegrity, signal: AbortSignal,
  progress: () => void, complete: () => void): Promise<Response> {
  if (!response.ok || response.redirected || (response.url && response.url !== asset.url) || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new Error('Invalid city asset response.');
  }
  const encoding = response.headers.get('content-encoding');
  if ((!encoding || encoding === 'identity') && Number(response.headers.get('content-length') ?? 0) > asset.bytes) {
    void response.body.cancel().catch(() => {});
    throw new Error('City asset size exceeds its integrity descriptor.');
  }
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, {once: true});
  try {
    signal?.throwIfAborted();
    const bytes = new Uint8Array(asset.bytes);
    let offset = 0;
    for (;;) {
      const {done, value} = await reader.read();
      signal?.throwIfAborted();
      if (done) { complete(); break; }
      if (offset + value.byteLength > bytes.byteLength) throw new Error('City asset size exceeds its integrity descriptor.');
      bytes.set(value, offset); offset += value.byteLength;
      if (value.byteLength) progress();
    }
    if (offset !== asset.bytes || !globalThis.crypto?.subtle) throw new Error('City asset integrity mismatch.');
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    signal?.throwIfAborted();
    if (digest !== asset.sha256) throw new Error('City asset integrity mismatch.');
    // The browser has already decoded transport compression; don't copy its headers.
    return new Response(bytes, {headers: {'content-type': response.headers.get('content-type') ?? 'application/octet-stream'}});
  } catch (error) {
    // A broken transport's cancellation promise must not retain its reservation.
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
