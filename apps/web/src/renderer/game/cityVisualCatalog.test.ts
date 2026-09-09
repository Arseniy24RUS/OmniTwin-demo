import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { createCityVisualCatalogTileset, loadCityVisualCatalog, loadCityVisualCatalogCell, selectCityVisualCatalogCells, type CityVisualCatalogV1 } from './cityVisualCatalog';

const dataset = 'omnitwin-fictional-city-v2', url = 'https://assets.example.org/visual/catalog.json';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const source = { packId: 'chelyabinsk-test', datasetVersion: 'c'.repeat(64), manifestSha256: 'd'.repeat(64) };
function descriptor(key: string, bounds: number[], id: string, sha256 = 'a'.repeat(64), bytes = 100) {
  return { key, bounds, canonicalIds: [id], lodLevels: 1, estimatedResidentBytes: 40 * 1024 * 1024,
    manifest: { uri: `cells/${key}/${sha256}/manifest.json`, sha256, bytes } };
}
function fixture() {
  return { contract: 'CityVisualCatalogV1', version: 1, catalogId: 'chelyabinsk-visual-v1', coordinateSystem: 'east-up-south',
    bounds: [61.3, 55.1, 61.6, 55.3], source: { ...source }, populationDatasetId: dataset,
    coverage: { status: 'partial', plannedCells: 4, compiledCells: 3, emptyCells: 0 },
    cells: [descriptor('cell-a', [61.38, 55.15, 61.40, 55.17], 'openmaptiles_buildings:123'),
      descriptor('cell-b', [61.40, 55.15, 61.42, 55.17], 'openmaptiles_buildings:456'),
      descriptor('cell-c', [61.5, 55.2, 61.52, 55.22], 'openmaptiles_buildings:789')] };
}
function catalogTransport(value = fixture()) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(value)));
  return { fetcher, load: () => loadCityVisualCatalog({ catalogUrl: url, populationDatasetId: dataset, sourceDatasetVersion: source.datasetVersion, fetcher }) };
}

describe('bounded visual cell catalog', () => {
  it('verifies one catalog request and selects viewport then neighbors within the resident budget', async () => {
    const { load, fetcher } = catalogTransport(), catalog = await load();
    expect(catalog.catalogSha256).toBe(hash(JSON.stringify(fixture())));
    const selection = selectCityVisualCatalogCells(catalog, [61.382, 55.152, 61.398, 55.168], { maxCells: 2, maxResidentBytes: 80 * 1024 * 1024, neighborPaddingMeters: 1600 });
    expect(selection.cells.map(cell => cell.key)).toEqual(['cell-a', 'cell-b']);
    expect(selection.estimatedResidentBytes).toBe(80 * 1024 * 1024); expect(selection.omittedViewportCells).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: 'omit', redirect: 'error' });
    const tiny = selectCityVisualCatalogCells(catalog, [61.38, 55.15, 61.42, 55.17], { maxCells: 1, maxResidentBytes: 1, neighborPaddingMeters: 0 });
    expect(tiny.cells).toHaveLength(0); expect(tiny.omittedViewportCells).toBe(2);
  });

  it('accepts completed coverage only when compiled plus verified-empty jobs account for the plan', async () => {
    const value = fixture(); value.coverage.status = 'complete'; value.coverage.emptyCells = 1;
    await expect(catalogTransport(value).load()).resolves.toBeDefined();
    value.coverage.emptyCells = 0; await expect(catalogTransport(value).load()).rejects.toThrow('City visual catalog metadata invalid');
  });

  it('rejects incompatible source, duplicate owners, mutable paths and invalid budgets without cell requests', async () => {
    for (const mutate of [
      (value: ReturnType<typeof fixture>) => { value.source.datasetVersion = 'e'.repeat(64); },
      (value: ReturnType<typeof fixture>) => { value.populationDatasetId = 'legacy'; },
      (value: ReturnType<typeof fixture>) => { value.cells[1].canonicalIds = [...value.cells[0].canonicalIds]; },
      (value: ReturnType<typeof fixture>) => { value.cells[0].manifest.uri = 'cells/cell-a/manifest.json'; },
      (value: ReturnType<typeof fixture>) => { value.cells[0].manifest.uri = '../outside/manifest.json'; },
      (value: ReturnType<typeof fixture>) => { value.cells[0].estimatedResidentBytes = Infinity; },
      (value: ReturnType<typeof fixture>) => { value.cells[0].bounds = [0, 0, 1, 1]; },
      (value: ReturnType<typeof fixture>) => { value.coverage.compiledCells = 2; },
    ]) {
      const value = fixture(); mutate(value); const { load, fetcher } = catalogTransport(value);
      await expect(load()).rejects.toThrow('City visual catalog metadata invalid'); expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('checks the independent catalog pin and rejects oversized bodies and unsafe request URLs', async () => {
    const body = JSON.stringify(fixture()), fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(body));
    await expect(loadCityVisualCatalog({ catalogUrl: url, populationDatasetId: dataset, fetcher, integrity: { bytes: body.length, sha256: hash(body) } })).resolves.toBeDefined();
    await expect(loadCityVisualCatalog({ catalogUrl: url, populationDatasetId: dataset, fetcher, integrity: { bytes: body.length, sha256: '0'.repeat(64) } })).rejects.toThrow('integrity mismatch');
    const unavailable = vi.fn<typeof fetch>();
    await expect(loadCityVisualCatalog({ catalogUrl: 'https://example.org/../catalog.json', populationDatasetId: dataset, fetcher: unavailable })).rejects.toThrow('URL invalid');
    expect(unavailable).not.toHaveBeenCalled();
    const oversized = vi.fn<typeof fetch>().mockResolvedValue(new Response(' '.repeat(8 * 1024 * 1024 + 1)));
    await expect(loadCityVisualCatalog({ catalogUrl: url, populationDatasetId: dataset, fetcher: oversized })).rejects.toThrow('response too large');
  });

  it('pins cell manifest bytes before the tileset request and checks catalog source and ownership', async () => {
    const origin = [61.39, 55.16, 0], bounds = [61.38, 55.15, 61.40, 55.17], id = 'openmaptiles_buildings:123';
    const glb = { uri: `tiles/coarse-${'f'.repeat(16)}.glb`, sha256: 'f'.repeat(64), bytes: 100, canonicalIds: [id] };
    const tileset = { asset: { version: '1.1', tilesetVersion: 'omnitwin-city-visual-v1' }, geometricError: 128,
      root: { boundingVolume: { box: [0, 0, 10, 600, 0, 0, 0, 600, 0, 0, 0, 10] }, geometricError: 32, refine: 'REPLACE',
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1], content: { uri: glb.uri },
        extras: { origin, bounds, coordinateSystem: 'east-up-south', boundingVolumeCoordinateSystem: 'east-north-up', units: 'metres', coverage: 'bounded_quarter', representation: 'source_geometry_with_visual_synthesis' } } };
    const tilesetBody = JSON.stringify(tileset);
    const pack = { contract: 'CityVisualPackManifestV1', version: 1, origin, bounds, coordinateSystem: 'east-up-south', tileFrame: 'east-north-up_to_ecef', coverage: 'bounded_quarter',
      source: { ...source, cells: [{ key: '16/43943/20675', sha256: 'e'.repeat(64), bytes: 100 }] },
      populationCompatibility: { datasetId: dataset, sourceDatasetVersion: source.datasetVersion, canonicalIds: [id], reassignments: 0, populationMutated: false },
      art: { representation: 'visual_synthesis', textures: {} }, semantics: { uri: 'semantics.json', bytes: 100, sha256: '0'.repeat(64) },
      tileset: { uri: 'tileset.json', bytes: tilesetBody.length, sha256: hash(tilesetBody) }, assets: [glb], textureAssets: [], stats: { buildings: 1, tiles: 1 }, limitations: [] };
    const body = JSON.stringify(pack), value = fixture();
    value.cells[0] = descriptor('cell-a', bounds, id, hash(body), body.length);
    const catalog = await catalogTransport(value).load();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async input => new Response(String(input).endsWith('manifest.json') ? body : tilesetBody));
    const loaded = await loadCityVisualCatalogCell(catalog, 'cell-a', { fetcher });
    expect(loaded.manifest.populationCompatibility.canonicalIds).toEqual([id]); expect(fetcher).toHaveBeenCalledTimes(2);
    const corrupt = vi.fn<typeof fetch>().mockResolvedValue(new Response(body.replace(id, 'openmaptiles_buildings:999')));
    await expect(loadCityVisualCatalogCell(catalog, 'cell-a', { fetcher: corrupt })).rejects.toThrow('integrity mismatch');
    expect(corrupt).toHaveBeenCalledTimes(1);
    const incorrect = { ...catalog, manifest: { ...catalog.manifest, source: { ...source, manifestSha256: '9'.repeat(64) } } as CityVisualCatalogV1 };
    await expect(loadCityVisualCatalogCell(incorrect, 'cell-a', { fetcher })).rejects.toThrow('cell metadata mismatch');
  });

  it('honors cancellation before starting any catalog or cell request', async () => {
    const fetcher = vi.fn<typeof fetch>(), signal = AbortSignal.abort();
    await expect(loadCityVisualCatalog({ catalogUrl: url, populationDatasetId: dataset, fetcher, signal })).rejects.toMatchObject({ name: 'AbortError' });
    const catalog = await catalogTransport().load();
    await expect(loadCityVisualCatalogCell(catalog, 'cell-a', { fetcher, signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('builds an empty ECEF streaming root with exact immutable cell requests and canonical owners', async () => {
    const value = fixture();
    value.cells.forEach((cell, index) => Object.assign(cell, { boundingVolume: { box: [1800000 + index * 1000, 3200000, 5200000, 200, 0, 0, 0, 300, 0, 0, 0, 400] } }));
    const { load, fetcher } = catalogTransport(value), catalog = await load();
    const result = createCityVisualCatalogTileset(catalog, { longitude: 61.39466, latitude: 55.1654, altitude: 0 });
    expect(result.tileset.root.refine).toBe('ADD'); expect(result.tileset.root).not.toHaveProperty('content');
    expect(result.tileset.root).not.toHaveProperty('transform');
    expect(result.tileset.root.boundingVolume.box).toEqual([1801000, 3200000, 5200000, 1200, 0, 0, 0, 300, 0, 0, 0, 400]);
    expect(result.tileset.root.extras.origin).toEqual([61.39466, 55.1654, 0]);
    expect(result.tileset.root.extras.coverage).toBe('catalog');
    result.tileset.root.children.forEach((child, index) => {
      expect(child.content.uri).toBe(new URL(value.cells[index].manifest.uri, url).href);
      expect(child.extras.key).toBe(value.cells[index].key);
      expect(child.extras.canonicalIds).toEqual(value.cells[index].canonicalIds);
      expect(result.cellManifestUrls.get(child.content.uri)?.key).toBe(value.cells[index].key);
    });
    expect(result.tilesetUrl).toContain(catalog.catalogSha256);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const noBounds = await catalogTransport().load();
    expect(() => createCityVisualCatalogTileset(noBounds, { longitude: 61.39, latitude: 55.16 })).toThrow('missing cell bounds');
  });

  const directory = new URL('../../../../../.cache/city-visual-catalog-v1/build-36f78e3c7ca4ceba/', import.meta.url);
  const catalogName = 'catalog-417ff14441e73464.json';
  it.skipIf(!existsSync(new URL(catalogName, directory)))('loads the actual compiler cell and reuses only its verified shared materials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async input => {
      const path = new URL(String(input)).pathname.replace(/^\/visual\//, '');
      expect(path.endsWith('.json')).toBe(true);
      return new Response(await readFile(new URL(path, directory)));
    });
    const catalog = await loadCityVisualCatalog({ catalogUrl: new URL(catalogName, url).href, populationDatasetId: dataset, fetcher });
    const cell = catalog.manifest.cells[0], pack = await loadCityVisualCatalogCell(catalog, cell.key, { fetcher });
    expect(pack.assetAliases).toHaveLength(21);
    for (const alias of pack.assetAliases!) {
      expect(alias.fromUrl).toContain(`/cells/${cell.key}/${cell.manifest.sha256}/materials/`);
      expect(alias.toUrl).toContain('/visual/materials/');
      expect(pack.assetUrls).toContain(alias.toUrl); expect(pack.assetUrls).not.toContain(alias.fromUrl);
      expect(pack.assetIntegrity.some(asset => asset.url === alias.toUrl)).toBe(true);
    }
    expect(pack.manifest.populationCompatibility.canonicalIds).toEqual(cell.canonicalIds);
    expect(createCityVisualCatalogTileset(catalog, pack.origin).tileset.root.children).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const mutated = structuredClone(catalog);
    (mutated.manifest.materialLibrary!.materials.brick as { normalScale: number }).normalScale = 0;
    await expect(loadCityVisualCatalogCell(mutated, cell.key, { fetcher })).rejects.toThrow('cell material mismatch');
    const moved = structuredClone(catalog);
    (moved.manifest.cells[0].boundingVolume!.box as number[])[0] += 1;
    await expect(loadCityVisualCatalogCell(moved, cell.key, { fetcher })).rejects.toThrow('cell metadata mismatch');
  });
});
