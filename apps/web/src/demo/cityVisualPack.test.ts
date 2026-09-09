import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { loadCityVisualPack } from '../renderer/game/cityVisualPack';

const manifestUrl = 'https://assets.example.org/immutable/quarter/manifest.json';
const populationDatasetId = 'omnitwin-fictional-city-v2';
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const glb = { uri: `tiles/coarse-${'a'.repeat(16)}.glb`, sha256: 'a'.repeat(64), bytes: 100 };
const texture = { uri: `materials/atlas-${'b'.repeat(16)}.png`, sha256: 'b'.repeat(64), bytes: 200, width: 64, height: 64, role: 'atlas' };
function fixture() {
  const origin = [61.39466, 55.1654, 0];
  const bounds = [61.385, 55.160, 61.405, 55.171];
  const tileset = { asset: { version: '1.1', tilesetVersion: 'omnitwin-city-visual-v1' }, geometricError: 128,
    root: { boundingVolume: { box: [0, 0, 10, 600, 0, 0, 0, 600, 0, 0, 0, 10] },
      geometricError: 32, refine: 'REPLACE', transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1],
      content: { uri: glb.uri }, children: [], extras: { origin, bounds, coordinateSystem: 'east-up-south',
        boundingVolumeCoordinateSystem: 'east-north-up', units: 'metres', coverage: 'bounded_quarter',
        representation: 'source_geometry_with_visual_synthesis' } } };
  const manifest = { contract: 'CityVisualPackManifestV1', version: 1, origin, bounds,
    coordinateSystem: 'east-up-south', tileFrame: 'east-north-up_to_ecef', coverage: 'bounded_quarter',
    source: { packId: 'chelyabinsk-test', datasetVersion: 'c'.repeat(64), manifestSha256: 'd'.repeat(64),
      cells: [{ key: '16/43943/20675', sha256: 'e'.repeat(64), bytes: 100 }] },
    populationCompatibility: { datasetId: populationDatasetId, sourceDatasetVersion: 'c'.repeat(64),
      canonicalIds: ['openmaptiles_buildings:123'], reassignments: 0, populationMutated: false },
    art: { representation: 'visual_synthesis', textures: { atlasUri: `../${texture.uri}` } },
    semantics: { uri: 'semantics.json', bytes: 100, sha256: 'f'.repeat(64) },
    tileset: { uri: 'tileset.json', bytes: 1, sha256: '0'.repeat(64) }, assets: [{ ...glb }], textureAssets: [{ ...texture }],
    stats: { buildings: 1, tiles: 1 }, limitations: ['Bounded fictional visual synthesis.'] };
  return { manifest, tileset };
}
function transport(value = fixture(), options: { body?: string; pin?: boolean } = {}) {
  const body = options.body ?? JSON.stringify(value.tileset);
  if (options.pin !== false) value.manifest.tileset = { uri: 'tileset.json', bytes: new TextEncoder().encode(body).length, sha256: hash(body) };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    if (String(input) === manifestUrl) return new Response(JSON.stringify(value.manifest));
    if (String(input) === new URL('tileset.json', manifestUrl).href) return new Response(body);
    throw new Error('Unexpected asset request: tests never fetch models or profiles');
  });
  return { fetcher, load: () => loadCityVisualPack({ manifestUrl, populationDatasetId, fetcher }) };
}
function metricFixture() {
  const value = fixture();
  const roles = ['baseColor', 'normal', 'orm'] as const;
  const assets = roles.map((role, index) => {
    const sha256 = String(index + 1).repeat(64), sourceId = 'brick_wall_001', filename = `${sourceId}_${role}_1k.jpg`;
    return { uri: `materials/${sourceId}-${role}-${sha256.slice(0, 16)}.jpg`, sha256, bytes: 1024, width: 1024, height: 1024,
      role, colorSpace: role === 'baseColor' ? 'sRGB' : 'linear', sourceId, filename, resolution: '1k',
      sourceUrl: `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/${sourceId}/${filename}`,
      sourcePage: `https://polyhaven.com/a/${sourceId}`, license: 'CC0-1.0', licenseUrl: 'https://polyhaven.com/license',
      providerMd5: 'a'.repeat(32), representation: 'visual_synthesis', encoding: 'provider-authored-jpeg' };
  });
  const library = { contract: 'CityMaterialLibraryV2', version: 2, mode: 'metric_repeat', representation: 'visual_synthesis',
    provider: 'Poly Haven', license: 'CC0-1.0', licenseUrl: 'https://polyhaven.com/license', sourceCatalogSha256: 'b'.repeat(64), assets,
    materials: { brick: { baseColorUri: `../${assets[0].uri}`, normalUri: `../${assets[1].uri}`, ormUri: `../${assets[2].uri}`,
      repeatMeters: [1.5, 1.5], normalScale: 0.45, sourceId: 'brick_wall_001', license: 'CC0-1.0' } } };
  Object.assign(value.manifest, { materialLibrary: library });
  Object.assign(value.manifest.assets[0], { canonicalIds: [...value.manifest.populationCompatibility.canonicalIds] });
  return { value, library };
}

describe('verified bounded city visual pack', () => {
  it('allows metric CC0 materials and pins every shared image without downloading it', async () => {
    const { value, library } = metricFixture(); const { load, fetcher } = transport(value);
    const pack = await load();
    expect(pack.manifest.materialLibrary).toEqual(library);
    for (const material of library.assets) {
      expect(pack.assetUrls).toContain(new URL(material.uri, manifestUrl).href);
      expect(pack.assetIntegrity).toContainEqual({ url: new URL(material.uri, manifestUrl).href, bytes: material.bytes, sha256: material.sha256 });
    }
    expect(pack.manifest.assets[0].canonicalIds).toEqual(['openmaptiles_buildings:123']);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects missing, mismatched or oversized metric texture assignments before fetching the tileset', async () => {
    for (const mutate of [
      (library: ReturnType<typeof metricFixture>['library']) => { library.assets[0].colorSpace = 'linear'; },
      (library: ReturnType<typeof metricFixture>['library']) => { library.assets[0].uri = `materials/brick_wall_001-baseColor-${'0'.repeat(16)}.jpg`; },
      (library: ReturnType<typeof metricFixture>['library']) => { library.assets[0].width = 4096; },
      (library: ReturnType<typeof metricFixture>['library']) => { library.assets[0].bytes = 2 * 1024 * 1024 + 1; },
      (library: ReturnType<typeof metricFixture>['library']) => { library.assets[0].sourceUrl = 'https://other.example/texture.jpg'; },
      (library: ReturnType<typeof metricFixture>['library']) => { library.materials.brick.normalUri = '../materials/unlisted.jpg'; },
      (library: ReturnType<typeof metricFixture>['library']) => { library.materials.brick.normalUri = library.materials.brick.baseColorUri; },
      (library: ReturnType<typeof metricFixture>['library']) => { library.materials.brick.repeatMeters = [0, 3]; },
      (library: ReturnType<typeof metricFixture>['library']) => { library.materials.brick.sourceId = 'another_surface'; },
      (library: ReturnType<typeof metricFixture>['library']) => { library.assets.push({ ...library.assets[0] }); },
      (library: ReturnType<typeof metricFixture>['library']) => { library.license = 'All rights reserved'; },
    ]) {
      const { value, library } = metricFixture(); mutate(library);
      const { load, fetcher } = transport(value);
      await expect(load()).rejects.toThrow('City visual pack metadata invalid');
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('validates exact canonical ownership across each retained replacement level', async () => {
    for (const corrupt of ['none', 'missing', 'foreign', 'duplicate-child', 'partial-extension']) {
      const value = fixture(), ids = ['openmaptiles_buildings:123', 'openmaptiles_buildings:456'];
      value.manifest.populationCompatibility.canonicalIds = ids; value.manifest.stats.buildings = 2;
      Object.assign(value.manifest.assets[0], { canonicalIds: ids });
      const children = ['near-a', 'near-b'].map((name, index) => ({ ...glb, uri: `tiles/${name}-${glb.sha256.slice(0, 16)}.glb`, canonicalIds: [ids[index]] }));
      if (corrupt === 'missing') children[1].canonicalIds = [];
      if (corrupt === 'foreign') children[1].canonicalIds = ['openmaptiles_buildings:999'];
      if (corrupt === 'duplicate-child') children[1].canonicalIds = [ids[0]];
      if (corrupt === 'partial-extension') delete (children[1] as Partial<typeof children[number]>).canonicalIds;
      value.manifest.assets.push(...children); value.manifest.stats.tiles = 3;
      Object.assign(value.tileset.root, { children: children.map(entry => ({ boundingVolume: value.tileset.root.boundingVolume,
        geometricError: 0, refine: 'REPLACE', content: { uri: entry.uri } })) });
      const { load } = transport(value);
      if (corrupt === 'none') await expect(load()).resolves.toBeDefined();
      else await expect(load()).rejects.toThrow('City visual pack metadata invalid');
    }
  });

  it('makes exactly two credential-free requests and preserves canonical IDs and coordinate frames', async () => {
    const { load, fetcher } = transport();
    const pack = await load();
    expect(pack.tilesetUrl).toBe('https://assets.example.org/immutable/quarter/tileset.json');
    expect(pack.origin).toEqual({ longitude: 61.39466, latitude: 55.1654, altitude: 0 });
    expect(pack.bounds).toEqual(fixture().manifest.bounds);
    expect(pack.manifest.populationCompatibility.canonicalIds).toEqual(['openmaptiles_buildings:123']);
    expect(pack.tileset.root.content.uri).toBe(glb.uri);
    expect(pack.assetUrls).toContain(new URL(texture.uri, manifestUrl).href);
    expect(pack.assetIntegrity).toContainEqual({url: new URL(texture.uri, manifestUrl).href, bytes: texture.bytes, sha256: texture.sha256});
    expect(pack.assetIntegrity).toContainEqual({url: new URL(glb.uri, manifestUrl).href, bytes: glb.bytes, sha256: glb.sha256});
    expect(pack.assetIntegrity.some(entry => entry.url === pack.tilesetUrl)).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, init] of fetcher.mock.calls) expect(init).toMatchObject({ credentials: 'omit', redirect: 'error' });
  });

  it('rejects unsafe manifest schemes and path normalization before any fetch', async () => {
    for (const url of ['http://assets.example.org/manifest.json', 'file:///manifest.json', 'data:application/json,{}',
      'https://user:password@example.org/manifest.json', 'https://example.org/a/../manifest.json',
      'https://example.org/%2e%2e/manifest.json', 'https://example.org/manifest.json?token=secret',
      'https://example.org/manifest.json#fragment', 'https://example.org/a\\manifest.json',
      'https:example.org/manifest.json', '//example.org/manifest.json', '\u0000https://example.org/manifest.json']) {
      const fetcher = vi.fn<typeof fetch>();
      await expect(loadCityVisualPack({ manifestUrl: url, populationDatasetId, fetcher })).rejects.toThrow('City visual pack');
      expect(fetcher).not.toHaveBeenCalled();
    }
  });

  it('allows HTTP only for exact loopback local preview hosts', async () => {
    for (const base of ['http://localhost:4178', 'http://127.0.0.1:4178', 'http://[::1]:4178']) {
      const value = fixture(); const data = transport(value);
      const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => data.fetcher(String(input).replace(base, 'https://assets.example.org'), init));
      await expect(loadCityVisualPack({ manifestUrl: manifestUrl.replace('https://assets.example.org', base), populationDatasetId, fetcher })).resolves.toBeDefined();
    }
  });

  it('resolves a Pages-relative manifest URL without changing the deployment prefix', async () => {
    vi.stubGlobal('location', { href: 'https://assets.example.org/immutable/index.html' });
    try {
      const { fetcher } = transport();
      const pack = await loadCityVisualPack({ manifestUrl: 'quarter/manifest.json', populationDatasetId, fetcher });
      expect(pack.manifestUrl).toBe(manifestUrl);
    } finally { vi.unstubAllGlobals(); }
  });

  it('permits equal content hashes at distinct declared tile paths', async () => {
    const value = fixture();
    const second = { ...glb, uri: `tiles/near-${'a'.repeat(16)}.glb` };
    value.manifest.assets.push(second); value.manifest.stats.tiles = 2;
    Object.assign(value.tileset.root, { children: [{ boundingVolume: value.tileset.root.boundingVolume,
      geometricError: 0, refine: 'REPLACE', content: { uri: second.uri } }] });
    await expect(transport(value).load()).resolves.toBeDefined();
  });

  it('rejects unsafe, duplicate and inconsistent inventories before the tileset request', async () => {
    const paths = ['../outside.glb', 'a/../b.glb', 'a/./b.glb', '/a.glb', '//outside.test/a.glb', 'a\\b.glb',
      '%2e%2e/a.glb', '%252e%252e/a.glb', 'a%2fb.glb', 'a%5cb.glb', 'a.glb?q=1', 'a.glb#x', 'https:a.glb', 'a b.glb'];
    for (const path of paths) {
      const value = fixture(); value.manifest.assets[0]!.uri = path;
      const { load, fetcher } = transport(value);
      await expect(load()).rejects.toThrow('City visual pack'); expect(fetcher).toHaveBeenCalledTimes(1);
    }
    for (const mutate of [
      (v: ReturnType<typeof fixture>) => { v.manifest.assets.push({ ...glb }); },
      (v: ReturnType<typeof fixture>) => { v.manifest.assets[0]!.bytes = 0; },
      (v: ReturnType<typeof fixture>) => { v.manifest.assets[0]!.sha256 = 'not-a-hash'; },
      (v: ReturnType<typeof fixture>) => { v.manifest.textureAssets[0]!.width = 100_000; },
      (v: ReturnType<typeof fixture>) => { v.manifest.art.textures.atlasUri = '../elsewhere.png'; },
      (v: ReturnType<typeof fixture>) => { v.manifest.textureAssets.push({ ...texture }); },
      (v: ReturnType<typeof fixture>) => { v.manifest.populationCompatibility.canonicalIds.push('openmaptiles_buildings:123'); },
      (v: ReturnType<typeof fixture>) => { v.manifest.populationCompatibility.reassignments = 1; },
      (v: ReturnType<typeof fixture>) => { v.manifest.populationCompatibility.populationMutated = true; },
      (v: ReturnType<typeof fixture>) => { v.manifest.populationCompatibility.sourceDatasetVersion = '0'.repeat(64); },
      (v: ReturnType<typeof fixture>) => { v.manifest.populationCompatibility.datasetId = 'legacy'; },
      (v: ReturnType<typeof fixture>) => { v.manifest.origin[0] = 0; },
    ]) {
      const value = fixture(); mutate(value); const { load, fetcher } = transport(value);
      await expect(load()).rejects.toThrow('City visual pack'); expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('checks decoded tileset size and SHA-256 rather than trusting JSON or response headers', async () => {
    for (const field of ['bytes', 'sha256'] as const) {
      const value = fixture(); const { load } = transport(value);
      if (field === 'bytes') value.manifest.tileset.bytes += 1;
      else value.manifest.tileset.sha256 = '0'.repeat(64);
      await expect(load()).rejects.toThrow('City visual pack integrity');
    }
  });

  it('rejects unlisted, external, nested and implicit tiles despite a matching JSON hash', async () => {
    for (const mutate of [
      (v: ReturnType<typeof fixture>) => { v.tileset.root.content.uri = '../other.glb'; },
      (v: ReturnType<typeof fixture>) => { v.tileset.root.content.uri = 'https://outside.test/other.glb'; },
      (v: ReturnType<typeof fixture>) => { v.tileset.root.content.uri = 'tiles/nested.json'; },
      (v: ReturnType<typeof fixture>) => { Object.assign(v.tileset.root.content, { url: 'https://outside.test/other.glb' }); },
      (v: ReturnType<typeof fixture>) => { Object.assign(v.tileset.root, { implicitTiling: { subtreeLevels: 1 } }); },
      (v: ReturnType<typeof fixture>) => { Object.assign(v.tileset, { extensions: { external: { uri: 'https://outside.test' } } }); },
      (v: ReturnType<typeof fixture>) => { v.tileset.root.extras.origin = [0, 0, 0]; },
    ]) {
      const value = fixture(); mutate(value); const { load, fetcher } = transport(value);
      await expect(load()).rejects.toThrow('City visual pack'); expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });

  it('bounds the streamed body and sanitizes HTTP, JSON and network errors for native fallback', async () => {
    for (const fetcher of [
      vi.fn<typeof fetch>().mockRejectedValue(new Error('secret request headers')),
      vi.fn<typeof fetch>().mockResolvedValue(new Response('secret server body', { status: 403 })),
      vi.fn<typeof fetch>().mockResolvedValue(new Response('{"secret body":')),
      vi.fn<typeof fetch>().mockResolvedValue(new Response(' '.repeat(1_048_577))),
    ]) {
      await expect(loadCityVisualPack({ manifestUrl, populationDatasetId, fetcher })).rejects.toThrow(/^City visual pack/);
      try { await loadCityVisualPack({ manifestUrl, populationDatasetId, fetcher }); }
      catch (error) { expect(String(error)).not.toContain('secret'); }
    }
    const signal = AbortSignal.abort(); const fetcher = vi.fn<typeof fetch>();
    await expect(loadCityVisualPack({ manifestUrl, populationDatasetId, signal, fetcher })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('forwards one cancellation signal to both requests and never returns a pack after cancellation', async () => {
    const abort = new AbortController(); const fixtureTransport = transport();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      expect(init?.signal).toBe(abort.signal);
      const response = await fixtureTransport.fetcher(input, init);
      if (String(input).endsWith('tileset.json')) abort.abort();
      return response;
    });
    await expect(loadCityVisualPack({ manifestUrl, populationDatasetId, fetcher, signal: abort.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  const fixtureDirectory = new URL('../../../../.cache/city-visual-v1/', import.meta.url);
  it.skipIf(!existsSync(new URL('manifest.json', fixtureDirectory)))('accepts the actual compiler manifest and exact tileset bytes, without reading GLBs', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const name = new URL(String(input)).pathname.split('/').at(-1);
      expect(['manifest.json', 'tileset.json']).toContain(name);
      return new Response(await readFile(new URL(name!, fixtureDirectory)));
    });
    const pack = await loadCityVisualPack({ manifestUrl, populationDatasetId, fetcher });
    expect(pack.manifest.populationCompatibility.canonicalIds).toHaveLength(pack.manifest.stats.buildings);
    expect(pack.manifest.populationCompatibility.reassignments).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  for (const directory of ['city-visual-courtyard-v2/', 'city-visual-courtyard-v2/scenes/courtyard/', 'city-visual-courtyard-v2/scenes/waterfront/']) {
    const path = new URL(`../../../../.cache/${directory}`, import.meta.url);
    it.skipIf(!existsSync(new URL('manifest.json', path)))(`accepts the compiler metric material pack ${directory}`, async () => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async input => {
        const name = new URL(String(input)).pathname.split('/').at(-1)!;
        expect(['manifest.json', 'tileset.json']).toContain(name);
        return new Response(await readFile(new URL(name, path)));
      });
      const pack = await loadCityVisualPack({ manifestUrl, populationDatasetId, fetcher });
      expect(pack.manifest.materialLibrary?.assets).toHaveLength(21);
      expect(pack.assetAliases).toBeUndefined();
      expect(pack.manifest.assets.every(asset => asset.canonicalIds !== undefined)).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  }
});
