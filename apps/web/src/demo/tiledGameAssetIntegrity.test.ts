import {createHash} from 'node:crypto';
import {describe, expect, it, vi} from 'vitest';
import {createGameAssetPolicy} from '../renderer/game/TiledGameLayer';
import type {CityVisualTileset} from '../renderer/game/cityVisualPack';

const rootUrl = 'https://assets.example/quarter/tileset.json';
const url = 'https://assets.example/quarter/tiles/coarse.glb';
const payload = new TextEncoder().encode('verified GLB fixture');
const options = {
  tilesetUrl: rootUrl,
  initialTileset: {root: {content: {uri: 'tiles/coarse.glb'}}} as CityVisualTileset,
  assetUrls: [rootUrl, url],
  assetIntegrity: [{url, bytes: payload.byteLength, sha256: createHash('sha256').update(payload).digest('hex')}],
};
const policyFor = (response: Response) => createGameAssetPolicy(options, vi.fn<typeof fetch>().mockResolvedValue(response))!;

describe('streamed city asset integrity before decode', () => {
  it('returns verified bytes and MIME type without retaining transport encoding headers', async () => {
    const response = await policyFor(new Response(payload, {headers: {'content-type': 'model/gltf-binary', 'content-encoding': 'gzip', 'content-length': '100'}})).fetchData(url);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(payload);
    expect(response.headers.get('content-type')).toBe('model/gltf-binary');
    expect(response.headers.has('content-encoding')).toBe(false);
  });

  it('rejects same-length corruption and truncation before handing bytes to loaders', async () => {
    const corrupt = payload.slice(); corrupt[2] ^= 1;
    for (const bytes of [corrupt, payload.slice(1)]) {
      await expect(policyFor(new Response(bytes)).fetchData(url)).rejects.toThrow(/integrity/i);
    }
  });

  it('cancels oversized streams even when content-length is missing', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({
      start(controller) {controller.enqueue(new Uint8Array(payload.length + 1));}, cancel,
    }));
    await expect(policyFor(response).fetchData(url)).rejects.toThrow(/size|integrity/i);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('aborts a pending stream and releases its reader', async () => {
    const controller = new AbortController(), cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({cancel});
    const pending = policyFor(new Response(body)).fetchData(url, {signal: controller.signal});
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({name: 'AbortError'});
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it('rejects missing, duplicate and unrelated integrity entries before network use', () => {
    for (const assetIntegrity of [[], [options.assetIntegrity[0], options.assetIntegrity[0]], [{...options.assetIntegrity[0], url: url + '.other'}]]) {
      expect(() => createGameAssetPolicy({...options, assetIntegrity})).toThrow(/integrity|inventory/i);
    }
  });

  it('rejects redirected responses and cancels unread oversized HTTP bodies', async () => {
    const redirected = new Response(payload);
    Object.defineProperty(redirected, 'redirected', {value: true});
    await expect(policyFor(redirected).fetchData(url)).rejects.toThrow(/response|redirect/i);
    const cancel = vi.fn();
    const tooLarge = new Response(new ReadableStream({cancel}), {headers: {'content-length': '999999999'}});
    await expect(policyFor(tooLarge).fetchData(url)).rejects.toThrow(/size|integrity/i);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
