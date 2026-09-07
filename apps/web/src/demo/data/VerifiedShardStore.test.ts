import { describe, expect, it, vi } from 'vitest';
import { VerifiedShardStore } from './VerifiedShardStore';
import { webcrypto } from 'node:crypto';
import { gzipSync } from 'node:zlib';

async function asset(text: string, name: string) {
  const body = new TextEncoder().encode(text);
  const hash = Buffer.from(await webcrypto.subtle.digest('SHA-256', body)).toString('hex');
  return { descriptor: { url: name, sha256: hash, bytes: body.length }, body };
}

async function gzipAsset(text: string, name = 'cell.json') {
  const raw = await asset(text, name);
  const compressed = new Uint8Array(gzipSync(raw.body));
  return { ...raw, compressed, descriptor: { ...raw.descriptor, gzip: { url: `${name}.gz`, bytes: compressed.length,
    sha256: Buffer.from(await webcrypto.subtle.digest('SHA-256', compressed)).toString('hex') } } };
}
describe('bounded immutable city shard store', () => {
  it('invokes default browser fetch with its global receiver, never the store instance', async () => {
    const fixture = await asset('aaaa', 'a.bin');
    vi.stubGlobal('fetch', function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(new Response(fixture.body));
    });
    try {
      const store = new VerifiedShardStore('https://example.org/demo/', 8);
      expect(new Uint8Array(await store.read(fixture.descriptor))).toEqual(fixture.body);
    } finally { vi.unstubAllGlobals(); }
  });
  it('rejects unverified data, evicts by bytes, and reuses retained buffers', async () => {
    const a = await asset('aaaa', 'a.bin'); const b = await asset('bbbbb', 'b.bin');
    let calls = 0;
    const store = new VerifiedShardStore('https://example.org/demo/', 8, async url => {
      calls++; return new Response(String(url).endsWith('a.bin') ? a.body : b.body);
    });
    const first = await store.read(a.descriptor);
    expect(await store.read(a.descriptor)).toBe(first); expect(calls).toBe(1);
    await store.read(b.descriptor); expect(store.retainedBytes).toBe(5);
    await store.read(a.descriptor); expect(calls).toBe(3);
    await expect(store.read({ ...a.descriptor, sha256: 'f'.repeat(64) })).rejects.toThrow(/hash/i);
  });
  it('does not publish aborted loads and forbids cross-origin or oversized shards', async () => {
    const a = await asset('aaaa', 'a.bin'); const controller = new AbortController(); controller.abort();
    const store = new VerifiedShardStore('https://example.org/demo/', 8, async () => new Response(a.body));
    await expect(store.read(a.descriptor, controller.signal)).rejects.toThrow();
    expect(store.retainedBytes).toBe(0);
    await expect(store.read({ ...a.descriptor, url: 'https://evil.example/a.bin' })).rejects.toThrow(/origin/);
    await expect(store.read({ ...a.descriptor, bytes: 9 })).rejects.toThrow(/budget/);
  });
  it('verifies explicit gzip transport and raw payload, caches only the decoded bytes', async () => {
    const fixture = await gzipAsset(JSON.stringify({ people: Array(30).fill('fictional') }));
    const request = vi.fn<typeof fetch>(async () => new Response(fixture.compressed, { headers: { 'Content-Type': 'application/gzip' } }));
    const store = new VerifiedShardStore('https://example.org/demo/', 1024, request);
    const first = await store.read(fixture.descriptor);
    expect(new Uint8Array(first)).toEqual(fixture.body);
    expect(request.mock.calls[0]![0].toString()).toBe('https://example.org/demo/cell.json.gz');
    expect(await store.read(fixture.descriptor)).toBe(first);
    expect(request).toHaveBeenCalledTimes(1);
    expect(store.retainedBytes).toBe(fixture.body.length);
    expect(store.loadedBytes).toBe(fixture.body.length);
  });
  it('rejects compressed tampering without falling back to raw', async () => {
    const fixture = await gzipAsset('A'.repeat(200)); const corrupted = fixture.compressed.slice(); corrupted[10] ^= 1;
    const request = vi.fn(async () => new Response(corrupted, { headers: { 'Content-Type': 'application/gzip' } }));
    const store = new VerifiedShardStore('https://example.org/demo/', 1024, request);
    await expect(store.read(fixture.descriptor)).rejects.toThrow(/compressed.*hash/i);
    expect(request).toHaveBeenCalledTimes(1);
    expect(store.retainedBytes).toBe(0);
  });
  it('verifies the raw hash independently after successful gzip verification', async () => {
    const fixture = await gzipAsset('A'.repeat(200));
    const store = new VerifiedShardStore('https://example.org/demo/', 1024, async () => new Response(fixture.compressed, { headers: { 'Content-Type': 'application/gzip' } }));
    await expect(store.read({ ...fixture.descriptor, sha256: 'f'.repeat(64) })).rejects.toThrow(/shard hash mismatch/i);
    expect(store.retainedBytes).toBe(0);
  });
  it('stops a decompression bomb at the declared raw byte limit without caching it', async () => {
    const fixture = await gzipAsset('A'.repeat(1_000_000));
    const store = new VerifiedShardStore('https://example.org/demo/', 2048, async () => new Response(fixture.compressed, { headers: { 'Content-Type': 'application/gzip' } }));
    await expect(store.read({ ...fixture.descriptor, bytes: 128 })).rejects.toThrow(/decoded.*byte.*exceeds/i);
    expect(store.retainedBytes).toBe(0);
    expect(store.loadedBytes).toBe(0);
  });
  it('rejects content-encoded gzip instead of confusing decoded bytes with compressed bytes', async () => {
    const fixture = await gzipAsset('A'.repeat(200));
    const request = vi.fn(async () => new Response(fixture.body, { headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'gzip' } }));
    const store = new VerifiedShardStore('https://example.org/demo/', 1024, request);
    await expect(store.read(fixture.descriptor)).rejects.toThrow(/content-encoding/i);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each(['../outside.bin', 'nested/../a.bin', '%2e%2e/a.bin', '%252e%252e/a.bin', '..\\a.bin', '/demo-other/a.bin'])('rejects base-path traversal before requesting %s', async url => {
    const fixture = await asset('aaaa', 'a.bin'); const request = vi.fn(async () => new Response(fixture.body));
    const store = new VerifiedShardStore('https://example.org/demo/', 1024, request);
    await expect(store.read({ ...fixture.descriptor, url })).rejects.toThrow(/path/i);
    expect(request).not.toHaveBeenCalled();
  });
  it('also rejects an unsafe gzip URL and refuses redirects', async () => {
    const fixture = await gzipAsset('A'.repeat(200)); const request = vi.fn<typeof fetch>(async () => new Response(fixture.compressed, { headers: { 'Content-Type': 'application/gzip' } }));
    const store = new VerifiedShardStore('https://example.org/demo/', 1024, request);
    await expect(store.read({ ...fixture.descriptor, gzip: { ...fixture.descriptor.gzip, url: '../outside.gz' } })).rejects.toThrow(/path/i);
    expect(request).not.toHaveBeenCalled();
    await store.read(fixture.descriptor);
    expect(request.mock.calls[0]![1]).toMatchObject({ redirect: 'error' });
  });
  it('cancels a pending body read promptly on abort, even when the transport does not propagate the signal', async () => {
    const fixture = await gzipAsset('A'.repeat(200)); const controller = new AbortController(); const cancel = vi.fn();
    let started!: () => void; const pending = new Promise<void>(resolve => { started = resolve; });
    const request: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({ pull() { started(); }, cancel }), { headers: { 'Content-Type': 'application/gzip' } });
    const store = new VerifiedShardStore('https://example.org/demo/', 1024, request);
    const reading = store.read(fixture.descriptor, controller.signal);
    await pending; controller.abort();
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(store.retainedBytes).toBe(0);
  });
  it('keeps gzip cache eviction byte-bounded and reconciles concurrent duplicate reads', async () => {
    const a = await gzipAsset('A'.repeat(50), 'a.json'); const b = await gzipAsset('B'.repeat(50), 'b.json');
    const request = vi.fn<typeof fetch>(async url => new Response(String(url).endsWith('a.json.gz') ? a.compressed : b.compressed, { headers: { 'Content-Type': 'application/gzip' } }));
    const store = new VerifiedShardStore('https://example.org/demo/', 64, request);
    const [first, second] = await Promise.all([store.read(a.descriptor), store.read(a.descriptor)]);
    expect(first).toBe(second); expect(store.retainedBytes).toBe(50);
    await store.read(b.descriptor); expect(store.retainedBytes).toBe(50);
    await store.read(a.descriptor); expect(store.retainedBytes).toBe(50);
    expect(request).toHaveBeenCalledTimes(4);
  });
  it('cancels the decoding output if abort arrives during inflation and publishes no partial result', async () => {
    const fixture = await gzipAsset('A'.repeat(200)); const controller = new AbortController(); const cancel = vi.fn();
    let started!: () => void; const pending = new Promise<void>(resolve => { started = resolve; });
    // Delay the decoder boundary deterministically; successful/bomb tests use the native decoder.
    class DelayedDecoder {
      readable = new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(fixture.body.slice(0, 8)); }, pull() { started(); }, cancel });
      writable = new WritableStream<BufferSource>();
    }
    vi.stubGlobal('DecompressionStream', DelayedDecoder);
    try {
      const store = new VerifiedShardStore('https://example.org/demo/', 1024, async () => new Response(fixture.compressed, { headers: { 'Content-Type': 'application/gzip' } }));
      const reading = store.read(fixture.descriptor, controller.signal);
      await pending; controller.abort();
      await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(store.retainedBytes).toBe(0); expect(store.loadedBytes).toBe(0);
    } finally { vi.unstubAllGlobals(); }
  });
  it('fails closed for unavailable or incorrectly served gzip, with no second request', async () => {
    const fixture = await gzipAsset('A'.repeat(200));
    for (const response of [new Response(null, { status: 404 }), new Response(fixture.compressed), new Response(fixture.compressed, { headers: { 'Content-Type': 'text/plain' } })]) {
      const request = vi.fn<typeof fetch>(async () => response);
      const store = new VerifiedShardStore('https://example.org/demo/', 1024, request);
      await expect(store.read(fixture.descriptor)).rejects.toThrow(); expect(request).toHaveBeenCalledTimes(1);
      expect(store.retainedBytes).toBe(0);
    }
  });
  it('checks exact compressed and decoded lengths independently', async () => {
    const fixture = await gzipAsset('A'.repeat(200));
    const request: typeof fetch = async () => new Response(fixture.compressed, { headers: { 'Content-Type': 'application/gzip' } });
    for (const delta of [-1, 1]) {
      const store = new VerifiedShardStore('https://example.org/demo/', 1024, request);
      await expect(store.read({ ...fixture.descriptor, gzip: { ...fixture.descriptor.gzip, bytes: fixture.compressed.length + delta } })).rejects.toThrow(/compressed shard byte length/i);
      expect(store.retainedBytes).toBe(0);
    }
    const store = new VerifiedShardStore('https://example.org/demo/', 1024, request);
    await expect(store.read({ ...fixture.descriptor, bytes: fixture.body.length + 1 })).rejects.toThrow(/decoded shard byte length mismatch/i);
  });
});
