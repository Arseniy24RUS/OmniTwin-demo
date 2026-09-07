import { describe, expect, it, vi } from 'vitest';
import { applyCityTilePack, loadCityTilePack } from '../renderer/cityTilePack';
import type { StyleSpecification } from 'maplibre-gl';
import { readFile } from 'node:fs/promises';

const version = '20260830_080001_pt';
const packId = `chelyabinsk-center-${version}`;
const sourceTiles = `https://tiles.openfreemap.org/planet/${version}/{z}/{x}/{y}.pbf`;
const source = { tilejson: '3.0.0', tiles: [sourceTiles], minzoom: 0, maxzoom: 14, bounds: [-180, -85.05113, 180, 85.05113] };
async function fixture() {
  const bytes = new TextEncoder().encode(JSON.stringify(source));
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((v) => v.toString(16).padStart(2, '0')).join('');
  return { contract: 'DemoCityPackManifestV1', packId, datasetVersion: version,
    sourceTileJSON: 'https://tiles.openfreemap.org/planet', sourceTiles,
    sourceSnapshot: { url: `${packId}/source-tilejson.json`, bytes: bytes.length, sha256: hash },
    minzoom: 10, maxzoom: 14, tileCount: 1, tileBytes: 123,
    tiles: [{ z: 14, x: 10986, y: 5169, url: `${packId}/tiles/14/10986/5169.pbf`, bytes: 123, sha256: 'a'.repeat(64) }] };
}
async function loader(mutate?: (manifest: Awaited<ReturnType<typeof fixture>>) => void) {
  const manifest = await fixture();
  mutate?.(manifest);
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) =>
    new Response(JSON.stringify(String(input).endsWith('manifest.json') ? manifest : source)));
  const pack = await loadCityTilePack({ baseUrl: '/OmniTwin-demo/', origin: 'https://example.github.io', fetcher });
  return { pack, fetcher };
}

describe('bounded local city tiles', () => {
  it('accepts the shipped source snapshot and maps the complete declared local inventory', async () => {
    const cityDirectory = new URL('../../public/city/', import.meta.url);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const relative = String(input).split('/city/')[1]!;
      return new Response(await readFile(new URL(relative, cityDirectory)));
    });
    const pack = await loadCityTilePack({ origin: 'https://example.org', baseUrl: '/OmniTwin-demo/', fetcher });
    expect(pack).not.toBeNull();
    expect(pack!.manifest.tileCount).toBe(pack!.manifest.tiles.length);
    for (const tile of pack!.manifest.tiles) {
      const remote = pack!.manifest.sourceTiles.replace('{z}', String(tile.z)).replace('{x}', String(tile.x)).replace('{y}', String(tile.y));
      expect(pack!.transformRequest(remote, 'Tile').url).toBe(`https://example.org/OmniTwin-demo/city/${tile.url}`);
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('loads under a Pages prefix and redirects only exactly covered pinned tile requests', async () => {
    const { pack, fetcher } = await loader();
    expect(pack).not.toBeNull();
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'https://example.github.io/OmniTwin-demo/city/manifest.json',
      `https://example.github.io/OmniTwin-demo/city/${packId}/source-tilejson.json`,
    ]);
    const covered = sourceTiles.replace('{z}', '14').replace('{x}', '10986').replace('{y}', '5169');
    expect(pack!.transformRequest(covered, 'Tile')).toEqual({ url: `https://example.github.io/OmniTwin-demo/city/${packId}/tiles/14/10986/5169.pbf` });
    for (const url of [covered.replace('5169.pbf', '5179.pbf'), `${covered}?token=other`,
      covered.replace(version, '20260901_000001_pt'), covered.replace('tiles.openfreemap.org', 'example.org')]) {
      expect(pack!.transformRequest(url, 'Tile')).toEqual({ url });
    }
    expect(pack!.transformRequest(covered, 'Source')).toEqual({ url: covered });
  });

  it('pins the vector source while preserving global online zoom/bounds and unrelated style data', async () => {
    const { pack } = await loader();
    const style: StyleSpecification = { version: 8, glyphs: '/glyphs/{fontstack}/{range}.pbf',
      sources: { openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
        other: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } }, layers: [] };
    const original = structuredClone(style);
    const patched = applyCityTilePack(style, pack);
    expect(style).toEqual(original);
    expect(patched.sources.openmaptiles).toMatchObject({ type: 'vector', tiles: [sourceTiles], minzoom: 0, maxzoom: 14, bounds: source.bounds });
    expect(patched.sources.openmaptiles).not.toHaveProperty('url');
    expect(patched.sources.other).toBe(style.sources.other);
    expect(patched.layers).toBe(style.layers);
    expect(applyCityTilePack(style, null)).toBe(style);
  });

  it('returns null when the optional manifest is absent, malformed or fails integrity checks', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('missing', { status: 404 }));
    expect(await loadCityTilePack({ origin: 'https://example.org', fetcher })).toBeNull();
    expect((await loader((m) => { m.sourceSnapshot.sha256 = '0'.repeat(64); })).pack).toBeNull();
    expect((await loader((m) => { m.sourceSnapshot.bytes += 1; })).pack).toBeNull();
    expect((await loader((m) => { m.tileCount = 500_000; })).pack).toBeNull();
  });

  it('rejects remote/path escapes, duplicate coordinates and unexpected provider templates before snapshot fetch', async () => {
    for (const mutate of [
      (m: Awaited<ReturnType<typeof fixture>>) => { m.tiles[0]!.url = '../private.pbf'; },
      (m: Awaited<ReturnType<typeof fixture>>) => { m.sourceSnapshot.url = 'https://outside.test/snapshot.json'; },
      (m: Awaited<ReturnType<typeof fixture>>) => { m.sourceTiles = 'https://outside.test/{z}/{x}/{y}.pbf'; },
      (m: Awaited<ReturnType<typeof fixture>>) => { m.tiles.push(m.tiles[0]!); m.tileCount = 2; m.tileBytes = 246; },
    ]) {
      const { pack, fetcher } = await loader(mutate);
      expect(pack).toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
});
