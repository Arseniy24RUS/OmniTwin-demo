import type { SceneCachePolicy, SceneDeviceTier } from '../sceneStreamer';
import type {
  SceneImmutableAssetLoader,
  SceneImmutableAssetRequest,
  SceneVerifiedAsset,
} from '../types';

/** Exact owned browser cache. Scientific bundles, settings, and scenario drafts never live here. */
export const SCENE_ASSET_CACHE = 'omnitwin-immutable-scene-assets-v1';

export interface SceneAssetCacheDeletion {
  readonly cacheExisted: boolean;
  readonly entries: number;
  readonly deleted: boolean;
}

type SceneCacheStorage = Pick<CacheStorage, 'keys' | 'open' | 'delete'>;

export interface SceneAssetCacheSnapshot {
  readonly requestedPolicy: SceneCachePolicy;
  readonly effectivePolicy: 'memory' | 'persistent';
  readonly memoryBudgetBytes: number;
  readonly memoryBytes: number;
  readonly memoryEntries: number;
  readonly memoryHits: number;
  readonly persistentHits: number;
  readonly networkLoads: number;
  readonly evictions: number;
  readonly rejected: number;
}

export interface CreateSceneAssetLoaderOptions {
  readonly cachePolicy: SceneCachePolicy;
  readonly memoryBudgetBytes?: number;
  readonly deviceTier?: SceneDeviceTier;
  readonly cacheStorage?: Pick<CacheStorage, 'open'>;
  readonly fetch?: typeof fetch;
  readonly applicationOrigin?: string;
}

interface MemoryEntry {
  readonly asset: SceneVerifiedAsset;
  lastUsed: number;
}

const SHA256 = /^[a-f0-9]{64}$/u;

function defaultMemoryBudget(deviceTier: SceneDeviceTier | undefined): number {
  if (deviceTier === 'low') return 16 * 1024 * 1024;
  if (deviceTier === 'high') return 96 * 1024 * 1024;
  return 48 * 1024 * 1024;
}

function resolveOrigin(origin: string | undefined): string {
  if (origin) return new URL(origin).origin;
  if (typeof location !== 'undefined') return location.origin;
  return 'http://localhost';
}

function assetUrl(
  request: SceneImmutableAssetRequest,
  applicationOrigin: string,
): URL {
  if (!SHA256.test(request.sha256)) throw new Error('Immutable asset SHA-256 is invalid');
  if (!request.sceneId.match(/^[a-z0-9][a-z0-9_-]{0,127}$/u)) {
    throw new Error('Immutable asset scene ID is invalid');
  }
  if (request.bytes !== null && request.bytes !== undefined && (
    !Number.isSafeInteger(request.bytes) || request.bytes < 0
  )) throw new Error('Immutable asset byte length is invalid');
  const url = new URL(request.url, applicationOrigin);
  if (url.origin !== applicationOrigin) throw new Error('Immutable scene asset must be same-origin');
  const prefix = `/scenes/${request.sceneId}/${request.sha256}/`;
  if (!url.pathname.startsWith(prefix)) {
    throw new Error('Immutable scene asset URL is not content-addressed');
  }
  return url;
}

async function digestHex(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto SHA-256 is unavailable');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (value) => (
    value.toString(16).padStart(2, '0')
  )).join('');
}

async function verifyAssetResponse(
  request: SceneImmutableAssetRequest,
  url: URL,
  response: Response,
): Promise<SceneVerifiedAsset> {
  if (!response.ok) throw new Error(`Immutable scene asset request failed: ${response.status}`);
  const bytes = await response.arrayBuffer();
  if (request.bytes !== null && request.bytes !== undefined && bytes.byteLength !== request.bytes) {
    throw new Error('Immutable scene asset byte length mismatch');
  }
  if (await digestHex(bytes) !== request.sha256) {
    throw new Error('Immutable scene asset SHA-256 mismatch');
  }
  const contentType = response.headers.get('content-type');
  if (request.contentType && !contentType?.toLowerCase().includes(request.contentType.toLowerCase())) {
    throw new Error('Immutable scene asset content type mismatch');
  }
  return { url: url.href, sha256: request.sha256, bytes, contentType };
}

function copyAsset(asset: SceneVerifiedAsset): SceneVerifiedAsset {
  return { ...asset, bytes: asset.bytes.slice(0) };
}

/**
 * One verified byte loader for manifest, cell index/cells, environment data,
 * PMTiles and renderer assets. CacheStorage admission occurs only after hash,
 * length and optional MIME verification.
 */
export function createSceneAssetLoader(
  options: CreateSceneAssetLoaderOptions,
): SceneImmutableAssetLoader & { snapshot: () => SceneAssetCacheSnapshot } {
  const applicationOrigin = resolveOrigin(options.applicationOrigin);
  const fetchAsset = options.fetch ?? fetch;
  const cacheStorage = options.cacheStorage ?? (
    typeof caches === 'undefined' ? undefined : caches
  );
  const effectivePolicy: SceneAssetCacheSnapshot['effectivePolicy'] =
    options.cachePolicy === 'persistent'
    || (options.cachePolicy === 'auto' && options.deviceTier !== 'low' && Boolean(cacheStorage))
      ? 'persistent'
      : 'memory';
  const memoryBudgetBytes = Number.isFinite(options.memoryBudgetBytes)
    ? Math.max(0, Math.floor(options.memoryBudgetBytes ?? 0))
    : defaultMemoryBudget(options.deviceTier);
  const memory = new Map<string, MemoryEntry>();
  let memoryBytes = 0;
  let generation = 0;
  let disposed = false;
  const counts = {
    memoryHits: 0,
    persistentHits: 0,
    networkLoads: 0,
    evictions: 0,
    rejected: 0,
  };

  const admitMemory = (key: string, asset: SceneVerifiedAsset) => {
    if (asset.bytes.byteLength > memoryBudgetBytes) return;
    const existing = memory.get(key);
    if (existing) memoryBytes -= existing.asset.bytes.byteLength;
    memory.set(key, { asset: copyAsset(asset), lastUsed: ++generation });
    memoryBytes += asset.bytes.byteLength;
    while (memoryBytes > memoryBudgetBytes && memory.size > 0) {
      let oldestKey: string | null = null;
      let oldestUse = Number.POSITIVE_INFINITY;
      for (const [candidateKey, entry] of memory) {
        if (entry.lastUsed < oldestUse) {
          oldestUse = entry.lastUsed;
          oldestKey = candidateKey;
        }
      }
      if (oldestKey === null) break;
      const evicted = memory.get(oldestKey)!;
      memory.delete(oldestKey);
      memoryBytes -= evicted.asset.bytes.byteLength;
      counts.evictions += 1;
    }
  };

  const load: SceneImmutableAssetLoader['load'] = async (request, signal) => {
    if (disposed) throw new Error('Immutable scene asset loader is disposed');
    if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    const url = assetUrl(request, applicationOrigin);
    const key = `${request.sha256}\u0000${url.href}`;
    const cachedMemory = memory.get(key);
    if (cachedMemory) {
      cachedMemory.lastUsed = ++generation;
      counts.memoryHits += 1;
      return copyAsset(cachedMemory.asset);
    }
    const cache = effectivePolicy === 'persistent' && cacheStorage
      ? await cacheStorage.open(SCENE_ASSET_CACHE)
      : null;
    const cacheRequest = new Request(url.href, { headers: { Accept: request.accept ?? '*/*' } });
    const cachedResponse = await cache?.match(cacheRequest);
    if (cachedResponse) {
      try {
        const asset = await verifyAssetResponse(request, url, cachedResponse);
        counts.persistentHits += 1;
        admitMemory(key, asset);
        return copyAsset(asset);
      } catch {
        counts.rejected += 1;
        await cache?.delete(cacheRequest);
      }
    }
    const response = await fetchAsset(cacheRequest, { signal, cache: 'no-store' });
    counts.networkLoads += 1;
    const asset = await verifyAssetResponse(request, url, response);
    if (cache) {
      const headers = new Headers();
      if (asset.contentType) headers.set('content-type', asset.contentType);
      headers.set('x-omnitwin-sha256', asset.sha256);
      await cache.put(cacheRequest, new Response(asset.bytes.slice(0), { status: 200, headers }));
    }
    admitMemory(key, asset);
    return copyAsset(asset);
  };

  return {
    load,
    snapshot: () => ({
      requestedPolicy: options.cachePolicy,
      effectivePolicy,
      memoryBudgetBytes,
      memoryBytes,
      memoryEntries: memory.size,
      ...counts,
    }),
    dispose() {
      disposed = true;
      memory.clear();
      memoryBytes = 0;
    },
  };
}

export async function deleteSceneAssetCache(
  storage: SceneCacheStorage | undefined = typeof caches === 'undefined' ? undefined : caches,
): Promise<SceneAssetCacheDeletion> {
  if (!storage) return { cacheExisted: false, entries: 0, deleted: false };
  const cacheExisted = (await storage.keys()).includes(SCENE_ASSET_CACHE);
  if (!cacheExisted) return { cacheExisted: false, entries: 0, deleted: false };
  const cache = await storage.open(SCENE_ASSET_CACHE);
  const entries = (await cache.keys()).length;
  return { cacheExisted: true, entries, deleted: await storage.delete(SCENE_ASSET_CACHE) };
}
