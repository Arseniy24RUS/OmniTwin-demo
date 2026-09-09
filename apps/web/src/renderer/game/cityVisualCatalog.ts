import { loadCityVisualPack, validateCityMaterialLibrary, type CityMaterialLibraryV2, type CityVisualAsset, type CityVisualPack, type CityVisualTile } from './cityVisualPack';
import type { GameOrigin } from './cameraAdapter';

type Bounds = readonly [number, number, number, number];
export interface CityVisualCatalogCell {
  readonly key: string;
  readonly bounds: Bounds;
  readonly manifest: CityVisualAsset;
  readonly estimatedResidentBytes: number;
  readonly canonicalIds: readonly string[];
  readonly lodLevels: number;
  /** Actual compiled tile bounds transformed to ECEF, required for streaming. */
  readonly boundingVolume?: { readonly box: readonly number[] };
}
export interface CityVisualCatalogV1 {
  readonly contract: 'CityVisualCatalogV1';
  readonly version: 1;
  readonly catalogId: string;
  readonly coordinateSystem: 'east-up-south';
  readonly bounds: Bounds;
  readonly source: { readonly packId: string; readonly datasetVersion: string; readonly manifestSha256: string };
  readonly populationDatasetId: string;
  /** Empty jobs require verified source receipts in the compiler; they have no GLB. */
  readonly coverage: { readonly status: 'partial' | 'complete'; readonly plannedCells: number; readonly compiledCells: number; readonly emptyCells?: number };
  readonly cells: readonly CityVisualCatalogCell[];
  readonly materialLibrary?: CityMaterialLibraryV2;
}
export interface LoadedCityVisualCatalog {
  readonly manifest: CityVisualCatalogV1;
  readonly catalogUrl: string;
  readonly catalogSha256: string;
  readonly catalogBytes: number;
}
export interface LoadCityVisualCatalogOptions {
  readonly catalogUrl: string;
  readonly populationDatasetId: string;
  readonly sourceDatasetVersion?: string;
  readonly integrity?: Pick<CityVisualAsset, 'bytes' | 'sha256'>;
  readonly signal?: AbortSignal;
  readonly fetcher?: typeof fetch;
}
export const CITY_VISUAL_CATALOG_LIMITS = {
  bytes: 8 * 1024 * 1024, cells: 4096, totalCanonicalIds: 200_000,
  cellManifestBytes: 1024 * 1024, cellResidentBytes: 576 * 1024 * 1024,
} as const;
const SHA = /^[a-f0-9]{64}$/;
const fail = (reason = 'metadata invalid'): never => { throw new Error(`City visual catalog ${reason}`); };
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function integer(value: unknown, min: number, max: number): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max; }
function validBounds(value: unknown): value is Bounds {
  return Array.isArray(value) && value.length === 4 && value.every(Number.isFinite)
    && value[0] >= -180 && value[2] <= 180 && value[1] > -85.051129 && value[3] < 85.051129 && value[0] < value[2] && value[1] < value[3];
}
function validEcefBox(value: unknown): value is { box: number[] } {
  if (!record(value) || !Array.isArray(value.box) || value.box.length !== 12 || !value.box.every(Number.isFinite)) return false;
  const box = value.box, radius = Math.hypot(...box.slice(0, 3));
  return radius > 6_000_000 && radius < 6_600_000 && [3, 6, 9].every(offset => {
    const length = Math.hypot(...box.slice(offset, offset + 3)); return length > 0 && length <= 100_000;
  });
}
function catalogUrl(value: string): URL {
  if (!value || value.length > 2048 || /[\s\u0000-\u001f\u007f\\%?#]/.test(value) || value.startsWith('//')
    || (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) && !/^https?:\/\//.test(value)) || value.split('/').some(part => part === '.' || part === '..')) return fail('URL invalid');
  const url = new URL(value, globalThis.location?.href), loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) return fail('URL invalid');
  return url;
}
function equalArray(a: readonly unknown[], b: readonly unknown[]): boolean { return a.length === b.length && a.every((value, index) => value === b[index]); }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** A partial catalog remains explicitly partial even if every returned cell is ready. */
export function validateCityVisualCatalog(value: unknown, populationDatasetId: string, sourceDatasetVersion?: string): CityVisualCatalogV1 {
  if (!record(value) || value.contract !== 'CityVisualCatalogV1' || value.version !== 1 || value.coordinateSystem !== 'east-up-south'
    || typeof value.catalogId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,100}$/.test(value.catalogId) || !validBounds(value.bounds)
    || !populationDatasetId || value.populationDatasetId !== populationDatasetId || !record(value.source)
    || typeof value.source.packId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,100}$/.test(value.source.packId)
    || typeof value.source.datasetVersion !== 'string' || !SHA.test(value.source.datasetVersion)
    || typeof value.source.manifestSha256 !== 'string' || !SHA.test(value.source.manifestSha256)
    || (sourceDatasetVersion !== undefined && value.source.datasetVersion !== sourceDatasetVersion)
    || !record(value.coverage) || !['partial', 'complete'].includes(String(value.coverage.status))
    || !integer(value.coverage.plannedCells, 1, CITY_VISUAL_CATALOG_LIMITS.cells)
    || !integer(value.coverage.compiledCells, 0, value.coverage.plannedCells)
    || !integer(value.coverage.emptyCells ?? 0, 0, value.coverage.plannedCells)
    || !Array.isArray(value.cells) || value.cells.length !== value.coverage.compiledCells) return fail();
  const finished = value.coverage.compiledCells + Number(value.coverage.emptyCells ?? 0);
  if (finished > value.coverage.plannedCells || (value.coverage.status === 'complete') !== (finished === value.coverage.plannedCells)) return fail();
  const allIds = new Set<string>(); let previousKey = '';
  for (const cell of value.cells) {
    if (!record(cell) || typeof cell.key !== 'string' || !/^[a-z0-9_-]{1,80}$/.test(cell.key) || cell.key <= previousKey
      || !validBounds(cell.bounds) || cell.bounds[0] < value.bounds[0] || cell.bounds[1] < value.bounds[1] || cell.bounds[2] > value.bounds[2] || cell.bounds[3] > value.bounds[3]
      || !record(cell.manifest) || typeof cell.manifest.sha256 !== 'string' || !SHA.test(cell.manifest.sha256)
      || cell.manifest.uri !== `cells/${cell.key}/${cell.manifest.sha256}/manifest.json`
      || !integer(cell.manifest.bytes, 1, CITY_VISUAL_CATALOG_LIMITS.cellManifestBytes)
      || !integer(cell.estimatedResidentBytes, 1, CITY_VISUAL_CATALOG_LIMITS.cellResidentBytes) || !integer(cell.lodLevels, 1, 6)
      || (cell.boundingVolume !== undefined && !validEcefBox(cell.boundingVolume))
      || !Array.isArray(cell.canonicalIds) || cell.canonicalIds.length < 1 || cell.canonicalIds.length > 1500) return fail();
    previousKey = cell.key; let previousId = '';
    for (const id of cell.canonicalIds) {
      if (typeof id !== 'string' || !/^openmaptiles_buildings:[1-9]\d{0,19}$/.test(id) || id <= previousId || allIds.has(id)) return fail();
      allIds.add(id); previousId = id;
      if (allIds.size > CITY_VISUAL_CATALOG_LIMITS.totalCanonicalIds) return fail();
    }
  }
  if (value.materialLibrary !== undefined) {
    try { validateCityMaterialLibrary(value.materialLibrary); } catch { return fail(); }
  }
  return value as unknown as CityVisualCatalogV1;
}

export interface CityVisualCatalogTileset {
  readonly asset: { readonly version: '1.1'; readonly tilesetVersion: 'omnitwin-city-visual-catalog-v1' };
  readonly geometricError: number;
  readonly root: {
    readonly boundingVolume: { readonly box: readonly number[] };
    readonly geometricError: number;
    readonly refine: 'ADD';
    readonly extras: {
      readonly origin: readonly [number, number, number]; readonly bounds: Bounds;
      readonly coordinateSystem: 'east-up-south'; readonly boundingVolumeCoordinateSystem: 'ecef';
      readonly units: 'metres'; readonly coverage: 'catalog'; readonly catalogSha256: string;
      readonly representation: 'source_geometry_with_visual_synthesis';
    };
    readonly children: readonly {
      readonly boundingVolume: { readonly box: readonly number[] };
      readonly geometricError: number; readonly refine: 'REPLACE';
      readonly content: { readonly uri: string };
      readonly extras: { readonly key: string; readonly canonicalIds: readonly string[]; readonly manifestSha256: string };
    }[];
  };
}

/**
 * Standard external-tileset hierarchy, with no invented global coarse geometry.
 * The existing renderer fetch plugin must intercept each declared manifest URL,
 * call loadCityVisualCatalogCell, register its verified inventory, and return that
 * pack's tileset JSON. Every cell then retains its own exact ECEF root transform.
 * This prepares descriptors only; off-screen cells trigger no metadata requests.
 */
export function createCityVisualCatalogTileset(catalog: LoadedCityVisualCatalog, origin: GameOrigin): {
  readonly tileset: CityVisualCatalogTileset;
  readonly tilesetUrl: string;
  readonly cellManifestUrls: ReadonlyMap<string, CityVisualCatalogCell>;
} {
  if (![origin.longitude, origin.latitude, origin.altitude ?? 0].every(Number.isFinite)
    || Math.abs(origin.longitude) > 180 || Math.abs(origin.latitude) >= 85.051129 || Math.abs(origin.altitude ?? 0) > 10000) return fail('origin invalid');
  if (!catalog.manifest.cells.length || catalog.manifest.cells.some(cell => !validEcefBox(cell.boundingVolume))) return fail('missing cell bounds');
  const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  for (const cell of catalog.manifest.cells) {
    const box = cell.boundingVolume!.box;
    for (let axis = 0; axis < 3; axis++) {
      const radius = Math.abs(box[3 + axis]) + Math.abs(box[6 + axis]) + Math.abs(box[9 + axis]);
      minimum[axis] = Math.min(minimum[axis], box[axis] - radius); maximum[axis] = Math.max(maximum[axis], box[axis] + radius);
    }
  }
  const center = minimum.map((value, axis) => (value + maximum[axis]) / 2), radius = minimum.map((value, axis) => (maximum[axis] - value) / 2);
  const rootBox = [...center, radius[0], 0, 0, 0, radius[1], 0, 0, 0, radius[2]];
  const cellManifestUrls = new Map(catalog.manifest.cells.map(cell => [new URL(cell.manifest.uri, catalog.catalogUrl).href, cell]));
  return {
    tilesetUrl: new URL(`runtime-${catalog.catalogSha256}.tileset.json`, catalog.catalogUrl).href,
    cellManifestUrls,
    tileset: {
      asset: { version: '1.1', tilesetVersion: 'omnitwin-city-visual-catalog-v1' }, geometricError: 1e7,
      root: { boundingVolume: { box: rootBox }, geometricError: 1e7, refine: 'ADD',
        extras: { origin: [origin.longitude, origin.latitude, origin.altitude ?? 0], bounds: catalog.manifest.bounds,
          coordinateSystem: 'east-up-south', boundingVolumeCoordinateSystem: 'ecef', units: 'metres', coverage: 'catalog',
          representation: 'source_geometry_with_visual_synthesis', catalogSha256: catalog.catalogSha256 },
        children: [...cellManifestUrls].map(([uri, cell]) => ({ boundingVolume: { box: [...cell.boundingVolume!.box] },
          geometricError: 128, refine: 'REPLACE', content: { uri },
          extras: { key: cell.key, canonicalIds: cell.canonicalIds, manifestSha256: cell.manifest.sha256 } })),
      },
    },
  };
}

async function responseBytes(response: Response, expectedUrl: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.ok || response.redirected || (response.url && response.url !== expectedUrl) || !response.body) {
    await response.body?.cancel().catch(() => {}); return fail('unavailable');
  }
  if (Number(response.headers.get('content-length') ?? 0) > CITY_VISUAL_CATALOG_LIMITS.bytes) {
    await response.body.cancel().catch(() => {}); return fail('response too large');
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read(); signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength; if (size > CITY_VISUAL_CATALOG_LIMITS.bytes) return fail('response too large');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { signal?.removeEventListener('abort', abort); reader.releaseLock(); }
}

/** Catalog metadata only. No GLBs, textures, population rows or cell requests. */
export async function loadCityVisualCatalog(options: LoadCityVisualCatalogOptions): Promise<LoadedCityVisualCatalog> {
  try {
    options.signal?.throwIfAborted();
    const url = catalogUrl(options.catalogUrl), fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    const bytes = await responseBytes(await fetcher(url.href, { signal: options.signal, credentials: 'omit', redirect: 'error' }), url.href, options.signal);
    if (!globalThis.crypto?.subtle) return fail('integrity mismatch');
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (options.integrity && (bytes.byteLength !== options.integrity.bytes || sha256 !== options.integrity.sha256)) return fail('integrity mismatch');
    const manifest = validateCityVisualCatalog(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), options.populationDatasetId, options.sourceDatasetVersion);
    options.signal?.throwIfAborted();
    return { manifest, catalogUrl: url.href, catalogSha256: sha256, catalogBytes: bytes.byteLength };
  } catch (error) {
    if (options.signal?.aborted) throw new DOMException('City visual catalog request aborted', 'AbortError');
    if (error instanceof Error && /^City visual catalog (metadata invalid|URL invalid|unavailable|response too large|integrity mismatch)$/.test(error.message)) throw error;
    return fail('unavailable');
  }
}

export interface CityVisualCatalogSelectionOptions {
  readonly maxCells?: number;
  readonly maxResidentBytes?: number;
  readonly neighborPaddingMeters?: number;
}
/** Deterministic bounded camera selection. Omitted cells retain the native map. */
export function selectCityVisualCatalogCells(catalog: LoadedCityVisualCatalog, viewport: Bounds, options: CityVisualCatalogSelectionOptions = {}) {
  const maxCells = options.maxCells ?? 8, maxResidentBytes = options.maxResidentBytes ?? 192 * 1024 * 1024;
  const padding = options.neighborPaddingMeters ?? 1200;
  if (!validBounds(viewport) || !integer(maxCells, 1, 16) || !integer(maxResidentBytes, 1, 1024 * 1024 * 1024)
    || !Number.isFinite(padding) || padding < 0 || padding > 5000) return fail('selection invalid');
  const latitude = (viewport[1] + viewport[3]) / 2, longitude = (viewport[0] + viewport[2]) / 2;
  const longitudeScale = Math.cos(latitude * Math.PI / 180), marginY = padding / 111320, marginX = marginY / longitudeScale;
  const expanded: Bounds = [viewport[0] - marginX, viewport[1] - marginY, viewport[2] + marginX, viewport[3] + marginY];
  const intersects = (a: Bounds, b: Bounds) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
  const candidates = catalog.manifest.cells.filter(cell => intersects(cell.bounds, expanded)).map(cell => ({
    cell, inViewport: intersects(cell.bounds, viewport),
    distance: ((cell.bounds[0] + cell.bounds[2]) / 2 - longitude) ** 2 * longitudeScale ** 2 + ((cell.bounds[1] + cell.bounds[3]) / 2 - latitude) ** 2,
  })).sort((a, b) => Number(b.inViewport) - Number(a.inViewport) || a.distance - b.distance || (a.cell.key < b.cell.key ? -1 : 1));
  const cells: CityVisualCatalogCell[] = []; let estimatedResidentBytes = 0, omittedViewportCells = 0;
  for (const candidate of candidates) {
    if (cells.length >= maxCells || estimatedResidentBytes + candidate.cell.estimatedResidentBytes > maxResidentBytes) {
      if (candidate.inViewport) omittedViewportCells++; continue;
    }
    cells.push(candidate.cell); estimatedResidentBytes += candidate.cell.estimatedResidentBytes;
  }
  return { cells, estimatedResidentBytes, omittedViewportCells };
}

function lodLevels(tile: CityVisualTile): number { return 1 + Math.max(0, ...(tile.children ?? []).map(lodLevels)); }
function transformedRootBox(tile: CityVisualTile): number[] {
  const box = tile.boundingVolume.box, transform = tile.transform;
  if (!transform || transform[3] !== 0 || transform[7] !== 0 || transform[11] !== 0 || transform[15] !== 1) return fail('cell metadata mismatch');
  const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  for (const a of [-1, 1]) for (const b of [-1, 1]) for (const c of [-1, 1]) {
    const point = [0, 1, 2].map(axis => box[axis] + a * box[3 + axis] + b * box[6 + axis] + c * box[9 + axis]);
    for (let axis = 0; axis < 3; axis++) {
      const value = transform[axis] * point[0] + transform[4 + axis] * point[1] + transform[8 + axis] * point[2] + transform[12 + axis];
      minimum[axis] = Math.min(minimum[axis], value); maximum[axis] = Math.max(maximum[axis], value);
    }
  }
  const center = minimum.map((value, axis) => (value + maximum[axis]) / 2), radius = minimum.map((value, axis) => (maximum[axis] - value) / 2);
  return [...center, radius[0], 0, 0, 0, radius[1], 0, 0, 0, radius[2]];
}

/** Pin each cell, prove compatibility, and alias only identical shared material bytes. */
export async function loadCityVisualCatalogCell(catalog: LoadedCityVisualCatalog, key: string, options: { readonly signal?: AbortSignal; readonly fetcher?: typeof fetch } = {}): Promise<CityVisualPack> {
  options.signal?.throwIfAborted();
  const cell = catalog.manifest.cells.find(cell => cell.key === key);
  if (!cell) return fail('unknown cell');
  const pack = await loadCityVisualPack({ manifestUrl: new URL(cell.manifest.uri, catalog.catalogUrl).href,
    manifestIntegrity: cell.manifest, populationDatasetId: catalog.manifest.populationDatasetId, ...options });
  const source = catalog.manifest.source;
  if (pack.manifest.source.packId !== source.packId || pack.manifest.source.datasetVersion !== source.datasetVersion
    || pack.manifest.source.manifestSha256 !== source.manifestSha256 || !equalArray(pack.bounds, cell.bounds)
    || !equalArray(pack.manifest.populationCompatibility.canonicalIds, cell.canonicalIds)
    || !pack.manifest.assets.every(asset => asset.canonicalIds !== undefined) || lodLevels(pack.tileset.root) !== cell.lodLevels) return fail('cell metadata mismatch');
  if (cell.boundingVolume) {
    const actualBox = transformedRootBox(pack.tileset.root);
    if (!cell.boundingVolume.box.every((value, index) => Math.abs(value - actualBox[index]) <= 0.01)) return fail('cell metadata mismatch');
  }
  const shared = catalog.manifest.materialLibrary;
  if (!shared) return pack;
  if (!pack.manifest.materialLibrary || canonicalJson(shared) !== canonicalJson(pack.manifest.materialLibrary)) return fail('cell material mismatch');
  const assetAliases = shared.assets.map(asset => ({ fromUrl: new URL(asset.uri, pack.manifestUrl).href, toUrl: new URL(asset.uri, catalog.catalogUrl).href }));
  const aliases = new Map(assetAliases.map(alias => [alias.fromUrl, alias.toUrl]));
  return { ...pack, assetAliases, assetUrls: pack.assetUrls.map(url => aliases.get(url) ?? url),
    assetIntegrity: pack.assetIntegrity.map(asset => ({ ...asset, url: aliases.get(asset.url) ?? asset.url })) };
}
