import type { DemoAsset } from '../types';
import { DATASET_ID } from '../../../../../shared/demo-population/index.mjs';
import { spatialCellKey } from '../../../../../shared/demo-population/spatial.mjs';
import { decodeMovementCellContext, type DemoMovementCellContext } from '../../../../../shared/demo-population/movement-index.mjs';
import policySource from '../../../../../shared/demo-population/movement-road-policy.mjs?raw';
import spatialSource from '../../../../../shared/demo-population/spatial.mjs?raw';
import movementSource from '../../../../../shared/demo-population/movement-index.mjs?raw';
import { VerifiedShardStore } from './VerifiedShardStore';
import {parseMovementActivation,type CityMovementActivation} from './movementAssetActivation';

type Bounds = readonly [number, number, number, number];
export interface MovementPreviewBaseHashes { spatial: string; population: string; geography: string }
export interface MovementPreviewPage extends DemoAsset { count: number; firstPersonIndex: number; lastPersonIndex: number }
export interface MovementPreviewCell { key: string; bbox: Bounds; count: number; context: DemoAsset; pages: MovementPreviewPage[] }
export interface MovementPreviewOverlayManifest {
  contract: 'DemoMovementOverlayV2'; version: 'source-mode-v2'; datasetId: typeof DATASET_ID;
  representation: 'visual_synthesis'; scientificClaim: false; scope: 'local_preview'; chatCompatibility: 'pending';
  baseHashes: MovementPreviewBaseHashes; overlayCodecSha256: string;
  bounds: Bounds; sourceBounds: Bounds; origin: [number, number] | [number, number, 0]; coveredBuildingIndices: number[];
  indexNamespace: { kind: 'local_overlay'; sourceRoadIndexBase: 1000000; ordering: 'lexicographic_verified_source_road_id'; notGlobalGeographyOrdinals: true };
  bindings: DemoAsset & { key?: string }; cells: MovementPreviewCell[];
  cellZoom: 16; pageSize: 2048; maxPageSize: 8192; maxPageBytes: 8388608;
  recordCount: number; householdCount: number; buildingCount: number;
  sourceCells?: { key: string; sha256: string; bytes: number }[];
  sourceHashes: Record<string, string>; stats: Record<string, number>; semantics: Record<string, string>;
}
export interface MovementPreviewOverlayOptions {
  manifestUrl: string; manifestSha256: string; baseHashes: MovementPreviewBaseHashes;
  manifestBytes?: number; activation?:CityMovementActivation;
  signal?: AbortSignal; request?: typeof fetch;
}
export interface MovementPreviewOverlay {
  manifest: MovementPreviewOverlayManifest; bindings: DemoMovementCellContext;
  baseURL: string; store: VerifiedShardStore;
  activation?:CityMovementActivation;
}
const MAX_MANIFEST = 2 * 1024 * 1024, MAX_ASSET = 8 * 1024 * 1024, MAX_PAGES = 8192, MAX_INDEX = 9_999_999;
const SHA = /^[a-f0-9]{64}$/;
const failure = (): never => { throw new Error('Movement preview validation failed'); };
const check: (condition: unknown) => asserts condition = condition => { if (!condition) failure(); };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const hashString = (v: unknown): v is string => typeof v === 'string' && SHA.test(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).every(k => allowed.includes(k));
const relative = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_./-]{1,250}$/.test(v) && !v.split('/').some(p => !p || p === '.' || p === '..');
function bounds(v: unknown): v is Bounds {
  return Array.isArray(v) && v.length === 4 && v.every(n => typeof n === 'number' && Number.isFinite(n))
    && v[0] >= -180 && v[2] <= 180 && v[1] > -85.05112878 && v[3] < 85.05112878 && v[0] < v[2] && v[1] < v[3];
}
function cellKey(v: unknown): v is string {
  return typeof v === 'string' && /^16\/(0|[1-9]\d{0,4})\/(0|[1-9]\d{0,4})$/.test(v) && v.split('/').slice(1).every(n => Number(n) < 65536);
}
function hashes(v: unknown): v is MovementPreviewBaseHashes {
  return record(v) && keys(v, ['spatial', 'population', 'geography']) && hashString(v.spatial) && hashString(v.population) && hashString(v.geography);
}
function approvedUrl(input: string): URL {
  check(typeof input === 'string' && input.length > 0 && input.length <= 2048 && !/[\s\\%?#\u0000-\u001f\u007f]/.test(input)
    && !input.split('/').some(part => part === '.' || part === '..'));
  const url = new URL(input, globalThis.location?.href);
  check((url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    && !url.username && !url.password && !url.search && !url.hash && !url.pathname.endsWith('/'));
  return url;
}
async function hash(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
}
async function manifestBytes(response: Response, url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  if (!response.ok || response.redirected || response.url && response.url !== url || !response.body) { void response.body?.cancel().catch(() => {}); return failure(); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted(); const part = await reader.read(); signal?.throwIfAborted(); if (part.done) break;
      total += part.value.byteLength; check(total <= MAX_MANIFEST); chunks.push(part.value);
    }
    check(total > 0);
  } catch (error) { cancel(); throw error; }
  finally { signal?.removeEventListener('abort', cancel); reader.releaseLock(); }
  const output = new Uint8Array(total); let at = 0;
  for (const chunk of chunks) { output.set(chunk, at); at += chunk.byteLength; }
  return output.buffer;
}
function validateManifest(value: unknown, expected: MovementPreviewBaseHashes): MovementPreviewOverlayManifest {
  check(record(value) && keys(value, ['contract', 'version', 'datasetId', 'representation', 'scientificClaim', 'scope', 'chatCompatibility', 'baseHashes', 'overlayCodecSha256', 'bounds', 'sourceBounds', 'origin', 'coveredBuildingIndices', 'indexNamespace', 'bindings', 'cells', 'cellZoom', 'pageSize', 'maxPageSize', 'maxPageBytes', 'recordCount', 'householdCount', 'buildingCount', 'sourceCells', 'sourceHashes', 'stats', 'semantics']));
  check(value.contract === 'DemoMovementOverlayV2' && value.version === 'source-mode-v2' && value.datasetId === DATASET_ID
    && value.representation === 'visual_synthesis' && value.scientificClaim === false && value.scope === 'local_preview' && value.chatCompatibility === 'pending');
  const base = value.baseHashes;
  check(hashes(base) && Object.keys(expected).every(k => base[k as keyof MovementPreviewBaseHashes] === expected[k as keyof MovementPreviewBaseHashes]) && hashString(value.overlayCodecSha256));
  check(bounds(value.bounds) && bounds(value.sourceBounds));
  check(value.sourceBounds[0] <= value.bounds[0] && value.sourceBounds[1] <= value.bounds[1] && value.sourceBounds[2] >= value.bounds[2] && value.sourceBounds[3] >= value.bounds[3]);
  check(Array.isArray(value.origin) && (value.origin.length === 2 || value.origin.length === 3 && value.origin[2] === 0) && value.origin.every(n => typeof n === 'number' && Number.isFinite(n))
    && value.origin[0] >= value.bounds[0] && value.origin[0] <= value.bounds[2] && value.origin[1] >= value.bounds[1] && value.origin[1] <= value.bounds[3]);
  check(value.cellZoom === 16 && value.pageSize === 2048 && value.maxPageSize === 8192 && value.maxPageBytes === MAX_ASSET);
  check(integer(value.recordCount, 1, MAX_INDEX + 1) && integer(value.householdCount, 1, MAX_INDEX + 1) && integer(value.buildingCount, 1, MAX_INDEX + 1));
  if (value.sourceCells !== undefined) {
    check(Array.isArray(value.sourceCells) && value.sourceCells.length <= 256);
    const seen = new Set<string>();
    for (const cell of value.sourceCells) {
      check(record(cell) && keys(cell, ['key', 'sha256', 'bytes']) && cellKey(cell.key) && !seen.has(cell.key)
        && hashString(cell.sha256) && integer(cell.bytes, 1, 32 * 1024 * 1024));
      seen.add(cell.key);
    }
  }
  const namespace = value.indexNamespace;
  check(record(namespace) && keys(namespace, ['kind', 'sourceRoadIndexBase', 'ordering', 'notGlobalGeographyOrdinals']) && namespace.kind === 'local_overlay' && namespace.sourceRoadIndexBase === 1000000
    && namespace.ordering === 'lexicographic_verified_source_road_id' && namespace.notGlobalGeographyOrdinals === true);
  check(Array.isArray(value.coveredBuildingIndices) && value.coveredBuildingIndices.length <= 16_384);
  let previous = -1;
  for (const index of value.coveredBuildingIndices) { check(integer(index, 0, value.buildingCount - 1) && index > previous); previous = index; }
  const descriptors = new Map<string, string>();
  const byteDescriptor = (descriptor: unknown, allowed: string[]): void => {
    check(record(descriptor) && keys(descriptor, allowed) && relative(descriptor.url) && hashString(descriptor.sha256) && integer(descriptor.bytes, 1, MAX_ASSET));
    const identity = `${descriptor.sha256}:${descriptor.bytes}`;
    check(!descriptors.has(descriptor.url) || descriptors.get(descriptor.url) === identity); descriptors.set(descriptor.url, identity);
  };
  const asset = (descriptor: unknown, extra: string[] = []): void => {
    byteDescriptor(descriptor, ['url', 'sha256', 'bytes', 'gzip', ...extra]);
    const item = descriptor as DemoAsset;
    if (item.gzip !== undefined) { byteDescriptor(item.gzip, ['url', 'sha256', 'bytes']); check(item.gzip.url !== item.url); }
    check(descriptors.size <= MAX_PAGES * 4);
  };
  asset(value.bindings, ['key']);
  check(record(value.bindings) && (value.bindings.key === undefined || cellKey(value.bindings.key) && value.bindings.key === spatialCellKey(value.origin[0], value.origin[1])));
  check(Array.isArray(value.cells) && value.cells.length >= 1 && value.cells.length <= 256);
  const cellKeys = new Set<string>(); let pages = 0, associations = 0;
  for (const cell of value.cells) {
    check(record(cell) && keys(cell, ['key', 'bbox', 'count', 'context', 'pages']) && cellKey(cell.key) && !cellKeys.has(cell.key) && bounds(cell.bbox)); cellKeys.add(cell.key);
    check(cell.bbox[0] <= value.sourceBounds[2] && cell.bbox[2] >= value.sourceBounds[0] && cell.bbox[1] <= value.sourceBounds[3] && cell.bbox[3] >= value.sourceBounds[1]);
    check(integer(cell.count, 0, value.recordCount) && Array.isArray(cell.pages) && cell.pages.length <= MAX_PAGES);
    asset(cell.context); let count = 0, last = -1;
    for (const page of cell.pages) {
      check(++pages <= MAX_PAGES); asset(page, ['count', 'firstPersonIndex', 'lastPersonIndex']);
      check(record(page) && integer(page.count, 1, 8192) && integer(page.firstPersonIndex, 0, value.recordCount - 1)
        && integer(page.lastPersonIndex, page.firstPersonIndex, value.recordCount - 1) && page.firstPersonIndex > last && page.count <= page.lastPersonIndex - page.firstPersonIndex + 1);
      last = page.lastPersonIndex; count += page.count;
    }
    check(count === cell.count); associations += count; check(Number.isSafeInteger(associations));
  }
  check(record(value.sourceHashes) && Object.keys(value.sourceHashes).length <= 32 && Object.values(value.sourceHashes).every(hashString));
  for (const key of ['populationManifest', 'geographyManifest', 'spatialCodec', 'codec', 'baseSpatialManifest', 'routeCorridorCodec', 'movementRoadPolicy', 'compiler']) check(hashString(value.sourceHashes[key]));
  check(value.sourceHashes.populationManifest === expected.population && value.sourceHashes.geographyManifest === expected.geography
    && value.sourceHashes.baseSpatialManifest === expected.spatial && value.sourceHashes.movementRoadPolicy === value.overlayCodecSha256);
  check(record(value.stats) && Object.keys(value.stats).length <= 128 && Object.values(value.stats).every(n => integer(n, 0, Number.MAX_SAFE_INTEGER))
    && value.stats.cells === value.cells.length && value.stats.pages === pages && value.stats.coveredBuildings === value.coveredBuildingIndices.length);
  const semantics = ['coverage', 'scope', 'indexing', 'modeIntegrity', 'householdCompleteness', 'activity', 'sourceBounds'];
  const meanings = value.semantics;
  check(record(meanings) && keys(meanings, semantics) && semantics.every(k => typeof meanings[k] === 'string' && (meanings[k] as string).length > 0 && (meanings[k] as string).length <= 4096));
  return value as unknown as MovementPreviewOverlayManifest;
}

/** Historical source overlay, loaded through localhost preview or explicit pinned
 * deployment activation. No population mutation or page scan. */
export async function loadMovementPreviewOverlay(options: MovementPreviewOverlayOptions): Promise<MovementPreviewOverlay> {
  try {
    options.signal?.throwIfAborted(); check(hashString(options.manifestSha256) && hashes(options.baseHashes));
    if(options.manifestBytes!==undefined)check(integer(options.manifestBytes,1,MAX_MANIFEST));
    const activation=options.activation===undefined?undefined:parseMovementActivation(options.activation,{populationManifestSha256:options.baseHashes.population,spatialManifestSha256:options.baseHashes.spatial});
    if(activation)check(activation.baseHashes.geography===options.baseHashes.geography&&activation.manifest.url===options.manifestUrl
      &&activation.manifest.sha256===options.manifestSha256&&activation.manifest.bytes===options.manifestBytes);
    const url = approvedUrl(options.manifestUrl), baseURL = new URL('.', url).href;
    const transport = options.request ?? ((input, init) => globalThis.fetch(input, init));
    const request: typeof fetch = (input, init) => transport(input, { ...init, credentials: 'omit', redirect: 'error' });
    const bytes = await manifestBytes(await request(url.href, { signal: options.signal }), url.href, options.signal);
    check((options.manifestBytes===undefined||bytes.byteLength===options.manifestBytes)&&await hash(bytes) === options.manifestSha256); options.signal?.throwIfAborted();
    const manifest = validateManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), options.baseHashes);
    const encoder = new TextEncoder();
    const [policyHash, spatialHash, movementHash] = await Promise.all([policySource, spatialSource, movementSource].map(source => hash(encoder.encode(source).buffer)));
    check(policyHash === manifest.overlayCodecSha256 && spatialHash === manifest.sourceHashes.spatialCodec && movementHash === manifest.sourceHashes.codec);
    options.signal?.throwIfAborted();
    const store = new VerifiedShardStore(baseURL, MAX_ASSET, request);
    const bindings = decodeMovementCellContext(await store.read(manifest.bindings, options.signal));
    check(bindings.key === spatialCellKey(manifest.origin[0], manifest.origin[1]) && bindings.bindings.length <= 16_384 && bindings.roads.length <= 8192
      && bindings.bindings.length === manifest.coveredBuildingIndices.length);
    const covered = new Set(manifest.coveredBuildingIndices);
    for (const binding of bindings.bindings) check(covered.has(binding[0]));
    for (const road of bindings.roads) check(integer(road.index, 2_000_000, MAX_INDEX) && integer(road.sourceRoadIndex, 1_000_000, Math.floor(MAX_INDEX / 2)));
    options.signal?.throwIfAborted();
    return { manifest, bindings, baseURL, store, ...(activation?{activation}:{}) };
  } catch (error) {
    if (options.signal?.aborted) throw new DOMException('Movement preview request aborted', 'AbortError');
    if (error instanceof Error && error.message === 'Movement preview validation failed') throw error;
    return failure();
  }
}
