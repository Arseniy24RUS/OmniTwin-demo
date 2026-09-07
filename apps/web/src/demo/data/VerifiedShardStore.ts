import type { DemoAsset } from '../types';

type ByteDescriptor = Pick<DemoAsset, 'bytes' | 'sha256'>;

function validateDescriptor(descriptor: ByteDescriptor, maxBytes: number, label: string): void {
  if (!descriptor || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes <= 0 || descriptor.bytes > maxBytes) throw new Error(`${label} exceeds memory budget`);
  if (!/^[a-f0-9]{64}$/.test(descriptor.sha256)) throw new Error(`Invalid ${label.toLowerCase()} hash`);
}

async function verifyHash(bytes: Uint8Array<ArrayBuffer>, descriptor: ByteDescriptor, label: string): Promise<void> {
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer))].map(x => x.toString(16).padStart(2, '0')).join('');
  if (hash !== descriptor.sha256) throw new Error(`${label} hash mismatch`);
}

/** Never collect the full inflated response before enforcing the raw byte cap. */
async function readExactBytes(stream: ReadableStream<Uint8Array>, expected: number, label: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const bytes = new Uint8Array(expected);
  let received = 0;
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      if (received + value.byteLength > expected) throw new Error(`${label} byte length exceeds manifest`);
      bytes.set(value, received); received += value.byteLength;
    }
    if (received !== expected) throw new Error(`${label} byte length mismatch`);
    return bytes;
  } catch (error) {
    // Do not await a custom transport's potentially stalled cancellation hook.
    cancel(); throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

/** Byte-bounded LRU. Cancellation never publishes partially verified content. */
export class VerifiedShardStore {
  private readonly cache = new Map<string, ArrayBuffer>();
  private readonly base: URL;
  retainedBytes = 0;
  loadedBytes = 0;
  constructor(readonly baseUrl: string, readonly maxBytes = 12 * 1024 * 1024,
    private readonly request: typeof fetch = (input, init) => globalThis.fetch(input, init)) {
    this.base = new URL(baseUrl);
    if (!['https:', 'http:'].includes(this.base.protocol) || this.base.username || this.base.password || this.base.search || this.base.hash) throw new Error('Shard base origin not approved');
    if (!this.base.pathname.endsWith('/')) this.base.pathname += '/';
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Invalid shard memory budget');
  }

  private assetUrl(path: string): URL {
    // Check before URL normalization, which otherwise erases dot segments.
    let decoded: string;
    try { decoded = decodeURIComponent(path); } catch { throw new Error('Invalid shard path encoding'); }
    if (typeof path !== 'string' || !path || /%2f|%5c/i.test(path) || /[\\\u0000-\u0020\u007f%]/.test(decoded)
      || /(?:^|\/)\.{1,2}(?:\/|$|[?#])/.test(decoded)) throw new Error('Shard path traversal not approved');
    const url = new URL(path, this.base);
    if (url.origin !== this.base.origin || url.username || url.password) throw new Error('Shard origin not approved');
    if (!url.pathname.startsWith(this.base.pathname) || url.search || url.hash) throw new Error('Shard path outside approved base');
    return url;
  }

  async read(asset: DemoAsset, signal?: AbortSignal): Promise<ArrayBuffer> {
    signal?.throwIfAborted();
    validateDescriptor(asset, this.maxBytes, 'Shard');
    const rawUrl = this.assetUrl(asset.url);
    const compressed = asset.gzip;
    if (compressed !== undefined) validateDescriptor(compressed, this.maxBytes, 'Compressed shard');
    const url = compressed ? this.assetUrl(compressed.url) : rawUrl;
    const key = `${rawUrl.href}:${asset.sha256}:${asset.bytes}:${compressed ? `${url.href}:${compressed.sha256}:${compressed.bytes}` : 'raw'}`;
    const retained = this.cache.get(key);
    if (retained) { this.cache.delete(key); this.cache.set(key, retained); return retained; }
    if (compressed && typeof DecompressionStream === 'undefined') throw new Error('Gzip shard decoding is unavailable');
    const response = await this.request(url, { signal, redirect: 'error' });
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      signal?.throwIfAborted();
      if (!response.ok) throw new Error(`Городской пакет недоступен (${response.status})`);
      if (response.redirected || response.url && this.assetUrl(response.url).href !== url.href) throw new Error('Shard redirect not approved');
      if (compressed && response.headers.has('Content-Encoding')) throw new Error('Explicit gzip shard must not use Content-Encoding');
      if (compressed && response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/gzip') throw new Error('Explicit gzip shard requires application/gzip Content-Type');
      if (!response.body) throw new Error('Missing shard response body');
      bytes = await readExactBytes(response.body, compressed?.bytes ?? asset.bytes, compressed ? 'Compressed shard' : 'Shard', signal);
      if (compressed) {
        await verifyHash(bytes, compressed, 'Compressed shard');
        signal?.throwIfAborted();
        const source = new ReadableStream<BufferSource>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
        bytes = await readExactBytes(source.pipeThrough(new DecompressionStream('gzip')), asset.bytes, 'Decoded shard', signal);
      }
      await verifyHash(bytes, asset, 'Shard');
    } catch (error) { void response.body?.cancel().catch(() => {}); throw error; }
    signal?.throwIfAborted();
    // Concurrent reads may finish together; count one retained buffer, not two.
    const existing = this.cache.get(key);
    if (existing) { this.cache.delete(key); this.cache.set(key, existing); return existing; }
    while (this.retainedBytes + bytes.byteLength > this.maxBytes && this.cache.size) {
      const oldest = this.cache.keys().next().value!;
      this.retainedBytes -= this.cache.get(oldest)!.byteLength; this.cache.delete(oldest);
    }
    this.cache.set(key, bytes.buffer); this.retainedBytes += bytes.byteLength; this.loadedBytes += bytes.byteLength;
    return bytes.buffer;
  }
  async json<T>(asset: DemoAsset, signal?: AbortSignal): Promise<T> {
    return JSON.parse(new TextDecoder().decode(await this.read(asset, signal))) as T;
  }
  clear() { this.cache.clear(); this.retainedBytes = 0; }
}
