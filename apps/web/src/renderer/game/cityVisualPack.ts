/** Bounded visual metadata, not a population source or proof of GLB content integrity. */
import type { GameAssetIntegrity } from './verifiedAssetResponse';
export interface CityVisualAsset {
  readonly uri: string;
  readonly sha256: string;
  readonly bytes: number;
}
export interface CityVisualTexture extends CityVisualAsset {
  readonly role: 'atlas' | 'normal' | 'orm';
  readonly width: number;
  readonly height: number;
}
export interface CityVisualGeometryAsset extends CityVisualAsset {
  /** Optional legacy extension; when present, every GLB declares actual building owners. */
  readonly canonicalIds?: readonly string[];
}
export interface CityMetricTexture extends CityVisualAsset {
  readonly role: 'baseColor' | 'normal' | 'orm';
  readonly width: number;
  readonly height: number;
  readonly colorSpace: 'sRGB' | 'linear';
  readonly sourceId: string;
  readonly sourceUrl: string;
  readonly sourcePage: string;
  readonly filename: string;
  readonly providerMd5: string;
  readonly resolution: '1k';
  readonly license: 'CC0-1.0';
  readonly licenseUrl: 'https://polyhaven.com/license';
  readonly representation: 'visual_synthesis';
  readonly encoding: 'provider-authored-jpeg';
}
export interface CityMetricMaterial {
  readonly baseColorUri: string;
  readonly normalUri?: string;
  readonly ormUri?: string;
  readonly repeatMeters: readonly [number, number];
  readonly normalScale: number;
  readonly sourceId: string;
  readonly license: 'CC0-1.0';
}
export interface CityMaterialLibraryV2 {
  readonly contract: 'CityMaterialLibraryV2';
  readonly version: 2;
  readonly mode: 'metric_repeat';
  readonly representation: 'visual_synthesis';
  readonly provider: 'Poly Haven';
  readonly license: 'CC0-1.0';
  readonly licenseUrl: 'https://polyhaven.com/license';
  readonly sourceCatalogSha256: string;
  readonly assets: readonly CityMetricTexture[];
  readonly materials: Readonly<Record<string, CityMetricMaterial>>;
}
export interface CityVisualPackManifestV1 {
  readonly contract: 'CityVisualPackManifestV1';
  readonly version: 1;
  readonly origin: readonly [number, number, number];
  readonly bounds: readonly [number, number, number, number];
  readonly coordinateSystem: 'east-up-south';
  readonly tileFrame: 'east-north-up_to_ecef';
  readonly coverage: 'bounded_quarter';
  readonly source: { readonly packId: string; readonly datasetVersion: string; readonly manifestSha256: string;
    readonly cells: readonly { readonly key: string; readonly sha256: string; readonly bytes: number }[] };
  readonly populationCompatibility: { readonly datasetId: string; readonly sourceDatasetVersion: string;
    readonly canonicalIds: readonly string[]; readonly reassignments: 0; readonly populationMutated: false };
  readonly art: { readonly representation: 'visual_synthesis'; readonly textures: Readonly<Partial<Record<'atlasUri' | 'normalUri' | 'ormUri', string>>> };
  readonly semantics: CityVisualAsset;
  readonly tileset: CityVisualAsset;
  readonly assets: readonly CityVisualGeometryAsset[];
  readonly textureAssets: readonly CityVisualTexture[];
  readonly materialLibrary?: CityMaterialLibraryV2;
  readonly visualCatalog?: CityVisualAsset;
  readonly stats: Readonly<Record<string, number>>;
  readonly limitations: readonly string[];
}
export interface CityVisualTile {
  boundingVolume: { box: number[] };
  geometricError: number;
  refine: 'REPLACE';
  content: { uri: string };
  transform?: number[];
  children?: CityVisualTile[];
  extras?: Record<string, unknown>;
}
export interface CityVisualTileset {
  asset: { version: '1.1'; tilesetVersion: 'omnitwin-city-visual-v1' };
  geometricError: number;
  root: CityVisualTile;
}
export interface CityVisualPack {
  readonly manifest: CityVisualPackManifestV1;
  readonly manifestUrl: string;
  readonly tilesetUrl: string;
  /** Supply this verified root through the renderer fetch plugin; do not re-fetch it. */
  readonly tileset: CityVisualTileset;
  readonly origin: { readonly longitude: number; readonly latitude: number; readonly altitude: number };
  readonly bounds: readonly [number, number, number, number];
  /** Exact inventory URLs for the downstream renderer's separate request policy. */
  readonly assetUrls: readonly string[];
  readonly assetIntegrity: readonly GameAssetIntegrity[];
  /** Catalog-only exact verified material reuse; never network redirects. */
  readonly assetAliases?: readonly { readonly fromUrl: string; readonly toUrl: string }[];
}
export interface LoadCityVisualPackOptions {
  readonly manifestUrl: string;
  readonly populationDatasetId: string;
  readonly signal?: AbortSignal;
  readonly fetcher?: typeof fetch;
  /** Optional independently pinned catalog descriptor; checked before parsing. */
  readonly manifestIntegrity?: Pick<CityVisualAsset, 'bytes' | 'sha256'>;
}

const MAX_MANIFEST_BYTES = 1_048_576;
const MAX_TILESET_BYTES = 262_144;
const MAX_GLB_BYTES = 96 * 1024 * 1024;
const MAX_TEXTURE_BYTES = 16 * 1024 * 1024;
const MAX_PACK_BYTES = 576 * 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const fail = (reason = 'metadata invalid'): never => { throw new Error(`City visual pack ${reason}`); };
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
function numbers(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && value.every(v => typeof v === 'number' && Number.isFinite(v));
}
function relativePath(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_./-]{1,250}$/.test(value)
    && !value.split('/').some(part => !part || part === '.' || part === '..');
}
function asset(value: unknown, max: number): value is CityVisualAsset {
  return record(value) && relativePath(value.uri) && typeof value.sha256 === 'string' && SHA.test(value.sha256)
    && integer(value.bytes, 1, max);
}
function keysOnly(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}
function canonicalIds(value: unknown, allowEmpty = false): value is string[] {
  if (!Array.isArray(value) || value.length < (allowEmpty ? 0 : 1) || value.length > 1500) return false;
  let previous = '';
  for (const id of value) {
    if (typeof id !== 'string' || !/^openmaptiles_buildings:[1-9]\d{0,19}$/.test(id) || id <= previous) return false;
    previous = id;
  }
  return true;
}

function metricLibraryBytes(value: unknown, seen: Set<string>): number {
  if (!record(value) || value.contract !== 'CityMaterialLibraryV2' || value.version !== 2 || value.mode !== 'metric_repeat'
    || value.representation !== 'visual_synthesis' || value.provider !== 'Poly Haven' || value.license !== 'CC0-1.0'
    || value.licenseUrl !== 'https://polyhaven.com/license' || typeof value.sourceCatalogSha256 !== 'string' || !SHA.test(value.sourceCatalogSha256)
    || !Array.isArray(value.assets) || !value.assets.length || value.assets.length > 48 || !record(value.materials)
    || !Object.keys(value.materials).length || Object.keys(value.materials).length > 16) return fail();
  const inventory = new Map<string, CityMetricTexture>(); let bytes = 0;
  for (const entry of value.assets) {
    if (!asset(entry, 2 * 1024 * 1024) || !record(entry) || typeof entry.sourceId !== 'string' || !/^[a-z0-9_]{1,80}$/.test(entry.sourceId)
      || !['baseColor', 'normal', 'orm'].includes(String(entry.role)) || seen.has(entry.uri)
      || entry.uri !== `materials/${entry.sourceId}-${entry.role}-${entry.sha256.slice(0, 16)}.jpg`
      || !integer(entry.width, 256, 2048) || !integer(entry.height, 256, 2048)
      || entry.colorSpace !== (entry.role === 'baseColor' ? 'sRGB' : 'linear') || entry.resolution !== '1k'
      || entry.license !== 'CC0-1.0' || entry.licenseUrl !== 'https://polyhaven.com/license'
      || entry.sourcePage !== `https://polyhaven.com/a/${entry.sourceId}` || typeof entry.filename !== 'string' || !/^[A-Za-z0-9_]+\.jpg$/.test(entry.filename)
      || entry.sourceUrl !== `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/${entry.sourceId}/${entry.filename}`
      || typeof entry.providerMd5 !== 'string' || !/^[a-f0-9]{32}$/.test(entry.providerMd5)
      || entry.representation !== 'visual_synthesis' || entry.encoding !== 'provider-authored-jpeg') return fail();
    seen.add(entry.uri); inventory.set(`../${entry.uri}`, entry as unknown as CityMetricTexture); bytes += entry.bytes;
  }
  if (bytes > 32 * 1024 * 1024) return fail();
  const used = new Set<string>();
  for (const [family, material] of Object.entries(value.materials)) {
    if (!['panel', 'brick', 'plaster', 'glass', 'industrial', 'civic', 'timber', 'neutral', 'bitumen', 'metal', 'tile', 'concrete', 'asphalt', 'paving', 'grass', 'trim'].includes(family)
      || !record(material) || !keysOnly(material, ['baseColorUri', 'normalUri', 'ormUri', 'repeatMeters', 'normalScale', 'sourceId', 'license'])
      || typeof material.sourceId !== 'string' || material.license !== 'CC0-1.0' || !numbers(material.repeatMeters, 2)
      || !material.repeatMeters.every(value => value >= 0.1 && value <= 100)
      || typeof material.normalScale !== 'number' || !Number.isFinite(material.normalScale) || material.normalScale < 0 || material.normalScale > 2
      || typeof material.baseColorUri !== 'string') return fail();
    for (const [role, key] of [['baseColor', 'baseColorUri'], ['normal', 'normalUri'], ['orm', 'ormUri']] as const) {
      const uri = material[key]; if (uri === undefined && role !== 'baseColor') continue;
      const texture = typeof uri === 'string' ? inventory.get(uri) : undefined;
      if (!texture || texture.role !== role || texture.sourceId !== material.sourceId) return fail();
      used.add(uri as string);
    }
  }
  if (used.size !== inventory.size) return fail();
  return bytes;
}
/** Shared catalog material inventories use the exact per-pack contract. */
export function validateCityMaterialLibrary(value: unknown): CityMaterialLibraryV2 {
  metricLibraryBytes(value, new Set()); return value as CityMaterialLibraryV2;
}
function requestUrl(input: string): URL {
  // Reject escapes BEFORE URL parsing, which would silently normalize dot segments.
  if (typeof input !== 'string' || !input || input.length > 2048 || /[\s\u0000-\u001f\u007f\\%?#]/.test(input)
    || input.startsWith('//') || (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(input) && !/^https?:\/\//.test(input))
    || input.split('/').some(part => part === '.' || part === '..')) return fail('URL invalid');
  const url = new URL(input, globalThis.location?.href);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash) return fail('URL invalid');
  return url;
}

function manifestFrom(value: unknown, datasetId: string): CityVisualPackManifestV1 {
  if (!record(value) || value.contract !== 'CityVisualPackManifestV1' || value.version !== 1
    || value.coordinateSystem !== 'east-up-south' || value.tileFrame !== 'east-north-up_to_ecef'
    || value.coverage !== 'bounded_quarter' || !numbers(value.origin, 3) || !numbers(value.bounds, 4)) return fail();
  const [west, south, east, north] = value.bounds;
  const [lon, lat, altitude] = value.origin;
  if (west < -180 || east > 180 || south < -85.1 || north > 85.1 || west >= east || south >= north
    || lon < west || lon > east || lat < south || lat > north || Math.abs(altitude) > 10_000) return fail();
  const source = value.source, compatibility = value.populationCompatibility;
  if (!record(source) || typeof source.packId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,100}$/.test(source.packId)
    || typeof source.datasetVersion !== 'string' || !SHA.test(source.datasetVersion)
    || typeof source.manifestSha256 !== 'string' || !SHA.test(source.manifestSha256)
    || !Array.isArray(source.cells) || source.cells.length < 1 || source.cells.length > 36
    || !record(compatibility) || !datasetId || compatibility.datasetId !== datasetId
    || compatibility.sourceDatasetVersion !== source.datasetVersion || compatibility.reassignments !== 0
    || compatibility.populationMutated !== false || !Array.isArray(compatibility.canonicalIds)
    || compatibility.canonicalIds.length < 1 || compatibility.canonicalIds.length > 1500) return fail();
  const cellKeys = new Set<string>(); let sourceBytes = 0;
  for (const cell of source.cells) {
    if (!record(cell) || typeof cell.key !== 'string' || !/^\d{1,2}\/\d{1,7}\/\d{1,7}$/.test(cell.key)
      || cellKeys.has(cell.key) || typeof cell.sha256 !== 'string' || !SHA.test(cell.sha256)
      || !integer(cell.bytes, 1, 4 * 1024 * 1024)) return fail();
    cellKeys.add(cell.key); sourceBytes += cell.bytes;
  }
  if (sourceBytes > 32 * 1024 * 1024) return fail();
  if (!canonicalIds(compatibility.canonicalIds)) return fail();
  if (!asset(value.tileset, MAX_TILESET_BYTES) || value.tileset.uri !== 'tileset.json'
    || !asset(value.semantics, 16 * 1024 * 1024) || value.semantics.uri !== 'semantics.json'
    || !Array.isArray(value.assets) || value.assets.length < 1 || value.assets.length > 64
    || !Array.isArray(value.textureAssets) || value.textureAssets.length > 3
    || !record(value.art) || value.art.representation !== 'visual_synthesis' || !record(value.art.textures)
    || !keysOnly(value.art.textures, ['atlasUri', 'normalUri', 'ormUri'])
    || !record(value.stats) || value.stats.buildings !== compatibility.canonicalIds.length
    || value.stats.tiles !== value.assets.length || !Object.values(value.stats).every(v => integer(v, 0, Number.MAX_SAFE_INTEGER))
    || !Array.isArray(value.limitations) || !value.limitations.every(v => typeof v === 'string' && v.length < 2048)) return fail();
  const seen = new Set([value.tileset.uri, value.semantics.uri]);
  const owners = new Set(compatibility.canonicalIds);
  const declaresOwners = value.assets.some(entry => record(entry) && entry.canonicalIds !== undefined);
  let totalBytes = value.tileset.bytes + value.semantics.bytes;
  for (const entry of value.assets) {
    if (!asset(entry, MAX_GLB_BYTES) || !/^tiles\/[A-Za-z0-9_-]+\.glb$/.test(entry.uri)
      || !entry.uri.endsWith(`-${entry.sha256.slice(0, 16)}.glb`) || seen.has(entry.uri)) return fail();
    if (declaresOwners && (!record(entry) || !canonicalIds(entry.canonicalIds, true)
      || !entry.canonicalIds.every(id => owners.has(id)))) return fail();
    seen.add(entry.uri); totalBytes += entry.bytes;
  }
  const roles = new Set<string>();
  for (const entry of value.textureAssets) {
    if (!asset(entry, MAX_TEXTURE_BYTES) || !record(entry) || !['atlas', 'normal', 'orm'].includes(String(entry.role))
      || typeof entry.role !== 'string' || roles.has(entry.role) || seen.has(entry.uri)
      || entry.uri !== `materials/${entry.role}-${entry.sha256.slice(0, 16)}.png`
      || !integer(entry.width, 1, 8192) || !integer(entry.height, 1, 8192)
      || entry.width * entry.height > 16_777_216 || value.art.textures[`${entry.role}Uri`] !== `../${entry.uri}`) return fail();
    roles.add(entry.role); seen.add(entry.uri); totalBytes += entry.bytes;
  }
  if (value.materialLibrary !== undefined) totalBytes += metricLibraryBytes(value.materialLibrary, seen);
  if (Object.keys(value.art.textures).length !== roles.size || totalBytes > MAX_PACK_BYTES) return fail();
  // Metadata only: this does not verify the IDs/material URIs embedded in unfetched GLBs.
  if(value.visualCatalog!==undefined){
    const catalog=value.visualCatalog;
    if(!record(catalog)||!relativePath(catalog.uri)||!String(catalog.uri).startsWith('catalog/')
      ||!integer(catalog.bytes,1,8*1024*1024)||typeof catalog.sha256!=='string'||!SHA.test(catalog.sha256))return fail();
  }
  return value as unknown as CityVisualPackManifestV1;
}

function tilesetFrom(value: unknown, manifest: CityVisualPackManifestV1): CityVisualTileset {
  if (!record(value) || !keysOnly(value, ['asset', 'geometricError', 'root']) || !record(value.asset)
    || !keysOnly(value.asset, ['version', 'tilesetVersion']) || value.asset.version !== '1.1'
    || value.asset.tilesetVersion !== 'omnitwin-city-visual-v1' || !record(value.root)
    || typeof value.geometricError !== 'number' || !Number.isFinite(value.geometricError) || value.geometricError < 0) return fail();
  const root = value.root, extras = root.extras;
  if (!numbers(root.transform, 16) || !record(extras) || !numbers(extras.origin, 3) || !numbers(extras.bounds, 4)
    || !extras.origin.every((n, i) => n === manifest.origin[i]) || !extras.bounds.every((n, i) => n === manifest.bounds[i])
    || extras.coordinateSystem !== manifest.coordinateSystem || extras.boundingVolumeCoordinateSystem !== 'east-north-up'
    || extras.units !== 'metres' || extras.coverage !== manifest.coverage
    || extras.representation !== 'source_geometry_with_visual_synthesis') return fail();
  const inventory = new Set(manifest.assets.map(entry => entry.uri));
  const seen = new Set<string>(); const pending: unknown[] = [root]; let count = 0;
  while (pending.length) {
    const tile = pending.pop();
    if (++count > 64 || !record(tile) || !keysOnly(tile, ['boundingVolume', 'geometricError', 'refine', 'transform', 'content', 'extras', 'children'])
      || !record(tile.boundingVolume) || !keysOnly(tile.boundingVolume, ['box']) || !numbers(tile.boundingVolume.box, 12)
      || typeof tile.geometricError !== 'number' || !Number.isFinite(tile.geometricError) || tile.geometricError < 0
      || tile.refine !== 'REPLACE' || !record(tile.content) || !keysOnly(tile.content, ['uri'])
      || typeof tile.content.uri !== 'string' || !inventory.has(tile.content.uri) || seen.has(tile.content.uri)
      || (tile !== root && tile.transform !== undefined)) return fail();
    seen.add(tile.content.uri);
    if (tile.children !== undefined) {
      if (!Array.isArray(tile.children) || tile.children.length > 64) return fail();
      pending.push(...tile.children);
    }
  }
  if (seen.size !== inventory.size) return fail();
  if (manifest.assets[0].canonicalIds !== undefined) {
    const ownership = new Map(manifest.assets.map(entry => [entry.uri, entry.canonicalIds!]));
    const rootIds = ownership.get((root.content as { uri: string }).uri)!;
    if (rootIds.length !== manifest.populationCompatibility.canonicalIds.length
      || !rootIds.every((id, index) => id === manifest.populationCompatibility.canonicalIds[index])) return fail();
    const nodes = [root as unknown as CityVisualTile];
    while (nodes.length) {
      const node = nodes.pop()!;
      if (!node.children?.length) continue;
      const parentIds = ownership.get(node.content.uri)!, childrenIds = new Set<string>();
      for (const child of node.children) {
        if (child.geometricError > node.geometricError) return fail();
        for (const id of ownership.get(child.content.uri)!) {
          if (childrenIds.has(id)) return fail(); childrenIds.add(id);
        }
      }
      if (childrenIds.size !== parentIds.length || !parentIds.every(id => childrenIds.has(id))) return fail();
      nodes.push(...node.children);
    }
  }
  return value as unknown as CityVisualTileset;
}

async function boundedBody(response: Response, maximum: number, url: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.ok || response.redirected || (response.url && response.url !== url)) return fail('unavailable');
  if (Number(response.headers.get('content-length')) > maximum || !response.body) return fail('response too large');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); return fail('response too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  signal?.throwIfAborted();
  const output = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

/**
 * Resolve only after manifest validation and exact decoded tileset SHA/byte verification.
 * Callers MUST retain the native city on rejection. No geometry, textures, semantics,
 * biographies or population shards are fetched here. HTTPS authenticates delivery but
 * a self-described manifest hash is not an independent provenance/authenticity pin.
 * Downstream GLB/texture allowlisting and hashes are the renderer/publisher's boundary.
 */
export async function loadCityVisualPack(options: LoadCityVisualPackOptions): Promise<CityVisualPack> {
  try {
    options.signal?.throwIfAborted();
    const url = requestUrl(options.manifestUrl);
    const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    const request = { signal: options.signal, credentials: 'omit' as const, redirect: 'error' as const };
    const manifestBytes = await boundedBody(await fetcher(url.href, request), MAX_MANIFEST_BYTES, url.href, options.signal);
    if (options.manifestIntegrity) {
      const expected = options.manifestIntegrity;
      if (!integer(expected.bytes, 1, MAX_MANIFEST_BYTES) || !SHA.test(expected.sha256) || manifestBytes.byteLength !== expected.bytes
        || !globalThis.crypto?.subtle) return fail('integrity mismatch');
      const digest = [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', manifestBytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (digest !== expected.sha256) return fail('integrity mismatch');
    }
    const manifest = manifestFrom(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)), options.populationDatasetId);
    const tilesetUrl = new URL(manifest.tileset.uri, url).href;
    const bytes = await boundedBody(await fetcher(tilesetUrl, request), MAX_TILESET_BYTES, tilesetUrl, options.signal);
    if (bytes.byteLength !== manifest.tileset.bytes || !globalThis.crypto?.subtle) return fail('integrity mismatch');
    const digest = [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))]
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (digest !== manifest.tileset.sha256) return fail('integrity mismatch');
    const tileset = tilesetFrom(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), manifest);
    options.signal?.throwIfAborted();
    return { manifest, manifestUrl: url.href, tilesetUrl, tileset,
      origin: { longitude: manifest.origin[0], latitude: manifest.origin[1], altitude: manifest.origin[2] },
      bounds: [...manifest.bounds],
      assetUrls: [manifest.tileset, manifest.semantics, ...manifest.assets, ...manifest.textureAssets, ...(manifest.materialLibrary?.assets ?? [])].map(entry => new URL(entry.uri, url).href),
      assetIntegrity: [manifest.semantics, ...manifest.assets, ...manifest.textureAssets, ...(manifest.materialLibrary?.assets ?? [])]
        .map(entry => ({url: new URL(entry.uri, url).href, sha256: entry.sha256, bytes: entry.bytes})) };
  } catch (error) {
    if (options.signal?.aborted) throw new DOMException('City visual pack request aborted', 'AbortError');
    if (error instanceof Error && /^City visual pack (metadata invalid|URL invalid|unavailable|response too large|integrity mismatch)$/.test(error.message)) throw error;
    return fail('unavailable');
  }
}
