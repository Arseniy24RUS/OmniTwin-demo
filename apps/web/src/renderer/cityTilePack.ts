import type { StyleSpecification } from 'maplibre-gl';

interface CityPackAsset { readonly url: string; readonly sha256: string; readonly bytes: number }
interface CityPackTile extends CityPackAsset { readonly z: number; readonly x: number; readonly y: number }
export interface CityTilePackManifest {
  readonly contract: 'DemoCityPackManifestV1';
  readonly packId: string;
  readonly datasetVersion: string;
  readonly sourceTileJSON: string;
  readonly sourceTiles: string;
  readonly sourceSnapshot: CityPackAsset;
  readonly minzoom: number;
  readonly maxzoom: number;
  readonly tileCount: number;
  readonly tileBytes: number;
  readonly tiles: readonly CityPackTile[];
}
export interface CityTilePack {
  readonly manifest: CityTilePackManifest;
  readonly sourceMinZoom: number;
  readonly sourceMaxZoom: number;
  readonly sourceBounds: [number, number, number, number];
  /** Synchronous MapLibre seam; only exact pinned source tile URLs are redirected. */
  readonly transformRequest: (url: string, resourceType?: string) => { url: string };
}
export interface LoadCityTilePackOptions {
  readonly baseUrl?: string;
  readonly origin?: string;
  readonly fetcher?: typeof fetch;
  readonly signal?: AbortSignal;
}
const SOURCE_TILEJSON = 'https://tiles.openfreemap.org/planet';
const MAX_MANIFEST_BYTES = 1_048_576;
const MAX_SNAPSHOT_BYTES = 524_288;
const MAX_TILE_COUNT = 2_048;
const MAX_TILE_BYTES = 4_194_304;
const MAX_PACK_BYTES = 67_108_864;
const ATTRIBUTION = '© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function asset(value: unknown, maximumBytes: number): value is CityPackAsset {
  return record(value) && typeof value.url === 'string' && /^[a-zA-Z0-9_./-]{1,250}$/.test(value.url)
    && !value.url.startsWith('/') && !value.url.split('/').some((part) => !part || part === '.' || part === '..')
    && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)
    && integer(value.bytes, 1, maximumBytes);
}
function manifestFrom(value: unknown): CityTilePackManifest {
  if (!record(value) || value.contract !== 'DemoCityPackManifestV1'
    || typeof value.packId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,100}$/.test(value.packId)
    || typeof value.datasetVersion !== 'string' || !/^\d{8}_\d{6}_pt$/.test(value.datasetVersion)
    || value.sourceTileJSON !== SOURCE_TILEJSON
    || value.sourceTiles !== `${SOURCE_TILEJSON}/${value.datasetVersion}/{z}/{x}/{y}.pbf`
    || !asset(value.sourceSnapshot, MAX_SNAPSHOT_BYTES)
    || value.sourceSnapshot.url !== `${value.packId}/source-tilejson.json`
    || !integer(value.minzoom, 0, 22) || !integer(value.maxzoom, value.minzoom, 22)
    || !integer(value.tileCount, 1, MAX_TILE_COUNT) || !Array.isArray(value.tiles)
    || value.tiles.length !== value.tileCount || !integer(value.tileBytes, 1, MAX_PACK_BYTES)) {
    throw new Error('Invalid bounded city pack manifest');
  }
  const tiles: CityPackTile[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const tile of value.tiles) {
    if (!asset(tile, MAX_TILE_BYTES) || !record(tile) || !integer(tile.z, value.minzoom, value.maxzoom)
      || !integer(tile.x, 0, 2 ** tile.z - 1) || !integer(tile.y, 0, 2 ** tile.z - 1)) {
      throw new Error('Invalid city tile inventory');
    }
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    if (seen.has(key) || tile.url !== `${value.packId}/tiles/${key}.pbf`) throw new Error('Duplicate or misplaced city tile');
    seen.add(key);
    bytes += tile.bytes;
    tiles.push(Object.freeze({ z: tile.z, x: tile.x, y: tile.y, url: tile.url, bytes: tile.bytes, sha256: tile.sha256 }));
  }
  if (bytes !== value.tileBytes) throw new Error('City tile byte inventory does not reconcile');
  return Object.freeze({ contract: 'DemoCityPackManifestV1', packId: value.packId,
    datasetVersion: value.datasetVersion, sourceTileJSON: value.sourceTileJSON,
    sourceTiles: value.sourceTiles, sourceSnapshot: Object.freeze({ ...value.sourceSnapshot }),
    minzoom: value.minzoom, maxzoom: value.maxzoom, tileCount: value.tileCount,
    tileBytes: value.tileBytes, tiles: Object.freeze(tiles) });
}

async function boundedBody(response: Response, maximum: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.ok) throw new Error('City pack asset unavailable');
  const declaredBytes = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredBytes) && declaredBytes > maximum) throw new Error('City pack response too large');
  if (!response.body) throw new Error('City pack response is empty');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new Error('City pack response exceeds its bounded size');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

/**
 * Optional local acceleration for a bounded subset of a pinned global source.
 * Manifest and snapshot failure return null so callers can retain their online
 * provider. The snapshot bytes are SHA-256 verified here; individual MVT bytes
 * remain ordinary MapLibre requests, with file integrity checked by the pack build.
 */
export async function loadCityTilePack(options: LoadCityTilePackOptions = {}): Promise<CityTilePack | null> {
  try {
    const page = new URL(options.origin ?? globalThis.location?.href ?? 'http://localhost/');
    const rawBase = options.baseUrl ?? import.meta.env.BASE_URL ?? '/';
    const base = new URL(rawBase.endsWith('/') ? rawBase : `${rawBase}/`, page);
    if (!['http:', 'https:'].includes(base.protocol) || base.origin !== page.origin
      || base.username || base.password || base.search || base.hash) return null;
    const cityBase = new URL('city/', base);
    const fetcher = options.fetcher ?? fetch;
    const request = { signal: options.signal, redirect: 'error' as const, credentials: 'same-origin' as const };
    const bytes = await boundedBody(await fetcher(new URL('manifest.json', cityBase).href, request), MAX_MANIFEST_BYTES);
    const manifest = manifestFrom(JSON.parse(new TextDecoder().decode(bytes)));
    const snapshotBytes = await boundedBody(await fetcher(new URL(manifest.sourceSnapshot.url, cityBase).href, request), MAX_SNAPSHOT_BYTES);
    if (snapshotBytes.byteLength !== manifest.sourceSnapshot.bytes || !globalThis.crypto?.subtle) return null;
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', snapshotBytes))]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    if (digest !== manifest.sourceSnapshot.sha256) return null;
    const snapshot: unknown = JSON.parse(new TextDecoder().decode(snapshotBytes));
    if (!record(snapshot) || !Array.isArray(snapshot.tiles) || snapshot.tiles.length !== 1
      || snapshot.tiles[0] !== manifest.sourceTiles || !integer(snapshot.minzoom, 0, 22)
      || !integer(snapshot.maxzoom, snapshot.minzoom, 22) || snapshot.minzoom > manifest.minzoom
      || snapshot.maxzoom < manifest.maxzoom || !Array.isArray(snapshot.bounds)
      || snapshot.bounds.length !== 4 || !snapshot.bounds.every((v) => typeof v === 'number' && Number.isFinite(v))
      || snapshot.bounds[0] < -180 || snapshot.bounds[2] > 180 || snapshot.bounds[1] < -90 || snapshot.bounds[3] > 90
      || snapshot.bounds[0] >= snapshot.bounds[2] || snapshot.bounds[1] >= snapshot.bounds[3]) return null;
    const urls = new Map<string, string>();
    for (const tile of manifest.tiles) {
      const remote = manifest.sourceTiles.replace('{z}', String(tile.z)).replace('{x}', String(tile.x)).replace('{y}', String(tile.y));
      urls.set(remote, new URL(tile.url, cityBase).href);
    }
    return Object.freeze({ manifest, sourceMinZoom: snapshot.minzoom, sourceMaxZoom: snapshot.maxzoom,
      sourceBounds: [...snapshot.bounds] as [number, number, number, number],
      transformRequest: (url: string, resourceType?: string) => ({
        url: resourceType === undefined || resourceType === 'Tile' ? urls.get(url) ?? url : url,
      }) });
  } catch { return null; }
}

/** Preserve the original style and global coverage; only the OMT delivery source changes. */
export function applyCityTilePack(style: StyleSpecification, pack: CityTilePack | null): StyleSpecification {
  const source = style.sources.openmaptiles;
  if (!pack || !source || source.type !== 'vector') return style;
  const { url: _url, ...retained } = source;
  return { ...style, sources: { ...style.sources, openmaptiles: {
    ...retained, tiles: [pack.manifest.sourceTiles], minzoom: pack.sourceMinZoom,
    maxzoom: pack.sourceMaxZoom, bounds: [...pack.sourceBounds],
    attribution: source.attribution ?? ATTRIBUTION,
  } } };
}
