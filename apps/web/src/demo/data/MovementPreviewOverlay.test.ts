import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import policySource from '../../../../../shared/demo-population/movement-road-policy.mjs?raw';
import spatialSource from '../../../../../shared/demo-population/spatial.mjs?raw';
import movementSource from '../../../../../shared/demo-population/movement-index.mjs?raw';
import { loadMovementPreviewOverlay } from './MovementPreviewOverlay';
import type {CityMovementActivation} from './movementAssetActivation';

const manifestUrl = 'https://assets.example.org/preview/manifest.json';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const baseHashes = { spatial: 'a'.repeat(64), population: 'b'.repeat(64), geography: 'c'.repeat(64) };
const asset = (url: string, body = '{}') => ({ url, bytes: new TextEncoder().encode(body).length, sha256: digest(body) });
function fixture() {
  const context = { contract: 'DemoMovementCellContextV2', key: '16/43944/20676', bindings: [[1, 2000000, null], [2, null, null]], roads: [{
    index: 2000000, sourceRoadIndex: 1000000, mode: 'walk', id: 'overlay:walk:1',
    coordinates: [[61.394, 55.164], [61.395, 55.165]], oneway: false, walkable: true, drivable: false,
    connectivity: 'source_node_ids', semantics: 'connected_source_road_local_visual_synthesis_not_home_work_route',
    segments: [{ fromNodeId: 'osm-node:1', toNodeId: 'osm-node:2' }],
  }] };
  const body = JSON.stringify(context);
  const manifest = { contract: 'DemoMovementOverlayV2', version: 'source-mode-v2', datasetId: 'omnitwin-fictional-city-v2',
    representation: 'visual_synthesis', scientificClaim: false, scope: 'local_preview', chatCompatibility: 'pending',
    baseHashes, overlayCodecSha256: digest(policySource), bounds: [61.39, 55.16, 61.4, 55.17], sourceBounds: [61.38, 55.15, 61.41, 55.18], origin: [61.39466, 55.1654, 0],
    coveredBuildingIndices: [1, 2], indexNamespace: { kind: 'local_overlay', sourceRoadIndexBase: 1000000, ordering: 'lexicographic_verified_source_road_id', notGlobalGeographyOrdinals: true },
    bindings: { ...asset('bindings.json', body), key: context.key }, cellZoom: 16, pageSize: 2048, maxPageSize: 8192, maxPageBytes: 8388608,
    recordCount: 100, householdCount: 50, buildingCount: 10,
    cells: [{ key: context.key, bbox: [61.39, 55.16, 61.4, 55.17], count: 2, context: asset('cell.json'), pages: [{ ...asset('page.json'), count: 2, firstPersonIndex: 1, lastPersonIndex: 4 }] }],
    sourceHashes: { populationManifest: baseHashes.population, geographyManifest: baseHashes.geography, spatialCodec: digest(spatialSource), codec: digest(movementSource), baseSpatialManifest: baseHashes.spatial, routeCorridorCodec: 'f'.repeat(64), movementRoadPolicy: digest(policySource), compiler: '0'.repeat(64) },
    stats: { cells: 1, pages: 1, coveredBuildings: 2 }, semantics: { coverage: 'core', scope: 'preview', indexing: 'route cells', modeIntegrity: 'source', householdCompleteness: 'complete', activity: 'shared', sourceBounds: 'guard' },
  };
  return { context, manifest, body };
}
function transport(value = fixture(), pin = true, bindingKey = true) {
  const contextBody = JSON.stringify(value.context);
  if (pin) value.manifest.bindings = { ...asset('bindings.json', contextBody), key: value.context.key };
  if (!bindingKey) delete (value.manifest.bindings as { key?: string }).key;
  const text = JSON.stringify(value.manifest);
  const request = vi.fn<typeof fetch>().mockImplementation(async input => {
    if (String(input) === manifestUrl) return new Response(text);
    if (String(input) === 'https://assets.example.org/preview/bindings.json') return new Response(contextBody);
    throw Error('Unexpected page fetch');
  });
  return { request, options: { manifestUrl, manifestSha256: digest(text), baseHashes, request } };
}
describe('local movement preview overlay', () => {
  it('separates public chat attestation from unchanged historical source scope and verifies all three source pins',async()=>{
    const value=fixture(),text=JSON.stringify(value.manifest),sha256=digest(text),publicUrl=`https://storage.googleapis.com/omnitwin-demo-city-assets/packs/${'d'.repeat(64)}/movement-overlay-v2/manifest-${sha256.slice(0,16)}.json`;
    const activation:CityMovementActivation={contract:'CityMovementActivationV1',version:1,datasetId:'omnitwin-fictional-city-v2',presentation:'bounded_source_overlay',chatCompatibility:'base_profiles_unchanged',baseHashes,
      manifest:{url:publicUrl,bytes:new TextEncoder().encode(text).length,sha256}};
    const request=vi.fn<typeof fetch>().mockImplementation(async input=>new Response(String(input)===publicUrl?text:value.body));
    const options={manifestUrl:publicUrl,manifestSha256:sha256,manifestBytes:activation.manifest.bytes,baseHashes,activation,request};
    const loaded=await loadMovementPreviewOverlay(options);expect(loaded.activation?.chatCompatibility).toBe('base_profiles_unchanged');
    expect(loaded.manifest).toEqual(value.manifest);expect(loaded.manifest.scope).toBe('local_preview');expect(loaded.manifest.chatCompatibility).toBe('pending');
    for(const key of ['population','spatial','geography'] as const){request.mockClear();await expect(loadMovementPreviewOverlay({...options,baseHashes:{...baseHashes,[key]:'9'.repeat(64)}})).rejects.toThrow();expect(request).not.toHaveBeenCalled();}
    request.mockClear();await expect(loadMovementPreviewOverlay({...options,manifestBytes:activation.manifest.bytes+1})).rejects.toThrow();expect(request).not.toHaveBeenCalled();
    request.mockClear();await expect(loadMovementPreviewOverlay({...options,activation:undefined,manifestBytes:activation.manifest.bytes+1})).rejects.toThrow();expect(request).toHaveBeenCalledTimes(1);
  });
  it('accepts a two-coordinate compiler origin without a redundant descriptor key', async () => {
    const value = fixture(); value.manifest.origin = [61.39466, 55.1654];
    const good = transport(value, true, false);
    await expect(loadMovementPreviewOverlay(good.options)).resolves.toMatchObject({ bindings: { key: value.context.key } });
    expect(good.request).toHaveBeenCalledTimes(2);
    for (const origin of [[61.39466], [61.39466, 55.1654, 1], [61.39466, 55.1654, 0, 0]]) {
      const invalid = fixture(); invalid.manifest.origin = origin;
      const bad = transport(invalid, true, false);
      await expect(loadMovementPreviewOverlay(bad.options)).rejects.toThrow(/Movement preview/);
      expect(bad.request).toHaveBeenCalledTimes(1);
    }
    const wrong = fixture(); wrong.context.key = '16/43945/20676';
    const bad = transport(wrong, true, false);
    await expect(loadMovementPreviewOverlay(bad.options)).rejects.toThrow(/Movement preview/);
    expect(bad.request).toHaveBeenCalledTimes(2);
  });
  const compiledManifestFile = new URL('../../../../../.cache/movement-mode-v2/manifest-625391b37ea50add.json', import.meta.url);
  it.skipIf(!existsSync(compiledManifestFile))('loads the frozen local compiler manifest and gzip bindings only', async () => {
    const manifestText = readFileSync(compiledManifestFile, 'utf8');
    const manifestHash = '625391b37ea50add3c40c4ad715124e8fcf395cbd5610f55bc7f5a68b74a7245';
    expect(digest(manifestText)).toBe(manifestHash);
    const compiled = JSON.parse(manifestText) as { bindings: { gzip: { url: string } } };
    const gzipName = 'bindings-a6b24c0b78d56cad.json.gz';
    expect(compiled.bindings.gzip.url).toBe(gzipName);
    const gzipBytes = readFileSync(new URL(gzipName, compiledManifestFile));
    const request = vi.fn<typeof fetch>().mockImplementation(async input => {
      if (String(input) === manifestUrl) return new Response(manifestText);
      if (String(input) === new URL(gzipName, manifestUrl).href) return new Response(new Uint8Array(gzipBytes), { headers: { 'Content-Type': 'application/gzip' } });
      throw new Error('Only the two pinned local fixture resources may be requested');
    });
    const result = await loadMovementPreviewOverlay({ manifestUrl, manifestSha256: manifestHash, request, baseHashes: {
      spatial: 'ec886d770baa1bbb83afab4973b857a6d50d9a1eac0135c1f90508a88557567d',
      population: '646bef9ee30c2f061f80b1ce26cd9d7ca2c7da170c6d55c086dea24d2d95bca1',
      geography: 'e8e1627801eb79ac353e9a1bf37419519980ad48d071d9c1f9b67318c2f3f62a',
    } });
    expect(result.bindings.bindings).toHaveLength(151);
    expect(result.manifest.cells).toHaveLength(34);
    expect(result.store.retainedBytes).toBe(367443);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('loads exactly two pinned resources and preserves explicit null origins', async () => {
    const { options, request } = transport(); const result = await loadMovementPreviewOverlay(options);
    expect(result.baseURL).toBe('https://assets.example.org/preview/');
    expect(result.bindings.bindings).toEqual([[1, 2000000, null], [2, null, null]]);
    expect(result.store.maxBytes).toBe(8388608); expect(request).toHaveBeenCalledTimes(2);
    for (const [, init] of request.mock.calls) expect(init).toMatchObject({ credentials: 'omit', redirect: 'error' });
  });
  it('rejects manifest hash and supplied base mismatches before bindings', async () => {
    for (const change of [{ manifestSha256: 'f'.repeat(64) }, { baseHashes: { ...baseHashes, spatial: 'f'.repeat(64) } }]) {
      const { options, request } = transport(); await expect(loadMovementPreviewOverlay({ ...options, ...change })).rejects.toThrow(/Movement preview/); expect(request).toHaveBeenCalledTimes(1);
    }
  });
  it('rejects unsafe initial URLs before fetching', async () => {
    for (const url of ['http://remote.test/x', 'file:///x', 'data:application/json,{}', 'https://u:p@x.test/x', 'https://x.test/a/../x', 'https://x.test/%2e/x', 'https://x.test/x?q=1', 'https://x.test/x#f', 'https://x.test/a\\x', '\u0000https://x.test/x']) {
      const request = vi.fn<typeof fetch>(); await expect(loadMovementPreviewOverlay({ manifestUrl: url, manifestSha256: 'a'.repeat(64), baseHashes, request })).rejects.toThrow(/Movement preview/); expect(request).not.toHaveBeenCalled();
    }
  });
  it('rejects unsafe page paths without fetching them', async () => {
    for (const path of ['../page.json', '/page.json', '//other.test/x', 'a\\b', '%252e%252e/x', 'x?y', 'x#y', 'https://assets.example.org/preview/x']) {
      const f = fixture(); f.manifest.cells[0]!.pages[0]!.url = path;
      const { options, request } = transport(f); await expect(loadMovementPreviewOverlay(options)).rejects.toThrow(/Movement preview/); expect(request).toHaveBeenCalledTimes(1);
    }
  });
  it('rejects wrong lineage, codec, namespace, bounds and descriptor counts', async () => {
    const changes = [
      (f: ReturnType<typeof fixture>) => { f.manifest.overlayCodecSha256 = '9'.repeat(64); },
      (f: ReturnType<typeof fixture>) => { f.manifest.sourceHashes.populationManifest = '9'.repeat(64); },
      (f: ReturnType<typeof fixture>) => { f.manifest.indexNamespace.sourceRoadIndexBase = 0; },
      (f: ReturnType<typeof fixture>) => { f.manifest.sourceBounds = [...f.manifest.bounds]; f.manifest.sourceBounds[0] = 61.395; },
      (f: ReturnType<typeof fixture>) => { f.manifest.origin[0] = 0; },
      (f: ReturnType<typeof fixture>) => { f.manifest.coveredBuildingIndices = [2, 1]; },
      (f: ReturnType<typeof fixture>) => { f.manifest.cells[0]!.count = 3; },
      (f: ReturnType<typeof fixture>) => { f.manifest.cells[0]!.key = '16/65536/1'; },
      (f: ReturnType<typeof fixture>) => { f.manifest.cells[0]!.pages[0]!.count = 8193; },
      (f: ReturnType<typeof fixture>) => { f.manifest.cells[0]!.pages[0]!.bytes = 8388609; },
      (f: ReturnType<typeof fixture>) => { f.manifest.cells[0]!.context = { ...asset('page.json'), sha256: '9'.repeat(64) }; },
    ];
    for (const change of changes) { const f = fixture(); change(f); const { options, request } = transport(f); await expect(loadMovementPreviewOverlay(options)).rejects.toThrow(/Movement preview/); expect(request).toHaveBeenCalledTimes(1); }
  });
  it('requires exactly covered bindings and isolated road namespace after exact decode', async () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => { f.context.bindings.pop(); },
      (f: ReturnType<typeof fixture>) => { f.context.key = '16/43945/20676'; },
      (f: ReturnType<typeof fixture>) => { f.context.roads[0]!.index = 0; f.context.roads[0]!.sourceRoadIndex = 0; f.context.bindings[0]![1] = 0; },
    ]) { const f = fixture(); change(f); const { options, request } = transport(f); await expect(loadMovementPreviewOverlay(options)).rejects.toThrow(/Movement preview/); expect(request.mock.calls.length).toBeLessThanOrEqual(2); }
  });
  it('rejects stale spatial and movement-index runtime codecs before fetching bindings', async () => {
    for (const key of ['spatialCodec', 'codec'] as const) {
      const f = fixture(); f.manifest.sourceHashes[key] = '8'.repeat(64);
      const { options, request } = transport(f);
      await expect(loadMovementPreviewOverlay(options)).rejects.toThrow(/Movement preview/);
      expect(request).toHaveBeenCalledTimes(1);
    }
  });
  it('validates an optional bounded source-cell ledger without fetching its source files', async () => {
    const row = { key: '16/43944/20676', sha256: '1'.repeat(64), bytes: 100 };
    const valid = fixture(); Object.assign(valid.manifest, { sourceCells: [row] });
    const good = transport(valid); await expect(loadMovementPreviewOverlay(good.options)).resolves.toBeDefined(); expect(good.request).toHaveBeenCalledTimes(2);
    for (const sourceCells of [[row, row], [{ ...row, key: '16/65536/1' }], [{ ...row, sha256: 'bad' }], [{ ...row, bytes: 0 }], [{ ...row, bytes: 32 * 1024 * 1024 + 1 }], Array(257).fill(row)]) {
      const value = fixture(); Object.assign(value.manifest, { sourceCells }); const { options, request } = transport(value);
      await expect(loadMovementPreviewOverlay(options)).rejects.toThrow(/Movement preview/); expect(request).toHaveBeenCalledTimes(1);
    }
  });
  it('rejects changed bindings bytes and pre-aborted requests', async () => {
    const f = fixture(); f.context.bindings.pop(); const { options } = transport(f, false);
    await expect(loadMovementPreviewOverlay(options)).rejects.toThrow(/Movement preview/);
    const request = vi.fn<typeof fetch>(); await expect(loadMovementPreviewOverlay({ ...options, request, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' }); expect(request).not.toHaveBeenCalled();
  });
  it('allows loopback HTTP preview delivery with the same credential-free policy', async () => {
    const { options, request: remote } = transport();
    const request = vi.fn<typeof fetch>().mockImplementation((input, init) => remote(String(input).replace('http://127.0.0.1:4178', 'https://assets.example.org'), init));
    const result = await loadMovementPreviewOverlay({ ...options, manifestUrl: manifestUrl.replace('https://assets.example.org', 'http://127.0.0.1:4178'), request });
    expect(result.baseURL).toBe('http://127.0.0.1:4178/preview/'); expect(request).toHaveBeenCalledTimes(2);
  });
  it('bounds decoded manifest bodies and rejects redirects without exposing transport details', async () => {
    for (const response of [new Response(' '.repeat(2 * 1024 * 1024 + 1)), new Response('private server detail', { status: 403 }), Object.defineProperty(new Response('{}'), 'redirected', { value: true }), Object.defineProperty(new Response('{}'), 'url', { value: 'https://other.test/manifest.json' })]) {
      const { options } = transport(); const request = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(loadMovementPreviewOverlay({ ...options, request })).rejects.toThrow(/^Movement preview validation failed$/); expect(request).toHaveBeenCalledTimes(1);
    }
  });
});
