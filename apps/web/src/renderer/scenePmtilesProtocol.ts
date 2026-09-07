import type { AddProtocolAction } from 'maplibre-gl';
import { FetchSource, PMTiles, Protocol, TileType } from 'pmtiles';
import type { RangeResponse, Source } from 'pmtiles';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SCENE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const CONTENT_PATH_PATTERN = /^content\/[A-Za-z0-9._/-]+\.pmtiles$/u;

export const SCENE_PMTILES_PROTOCOL = 'pmtiles' as const;

export interface ScenePmtilesAssetBinding {
  /** PMTiles is opt-in until a verified immutable scene asset is bound. */
  featureEnabled: boolean;
  sceneId: string;
  assetPath: string;
  assetUrl: string;
  sha256: string;
  bytes: number;
  /** Attribution is shown by MapLibre through the returned source specification. */
  attribution: string;
  applicationOrigin: string;
}

export interface VerifiedScenePmtilesAsset {
  sceneId: string;
  assetPath: string;
  assetUrl: string;
  sha256: string;
  bytes: number;
  attribution: string;
}

export interface ScenePmtilesProtocolHandle {
  readonly status: 'ready';
  readonly providerId: 'pmtiles';
  readonly archiveUrl: string;
  readonly sourceUrl: string;
  readonly attribution: string;
  readonly sourceSpecification: {
    readonly type: 'vector';
    readonly url: string;
    readonly attribution: string;
  };
  dispose(): void;
}

export interface MapLibreProtocolRegistry {
  addProtocol(name: string, action: AddProtocolAction): void;
  removeProtocol(name: string): void;
}

interface ProtocolArchive {
  source: Source;
  getHeader(): Promise<{ tileType: TileType }>;
}

interface ProtocolLike {
  tiles: Map<string, ProtocolArchive>;
  add(archive: ProtocolArchive): void;
  tile: AddProtocolAction;
}

interface RegistryEntry {
  archive: ProtocolArchive;
  controllers: Set<AbortController>;
  lifetime: AbortController;
  references: number;
}

interface RegistryState {
  protocol: ProtocolLike;
  entries: Map<string, RegistryEntry>;
}

interface ScenePmtilesDependencies {
  createProtocol(): ProtocolLike;
  createArchive(source: Source): ProtocolArchive;
}

const defaultDependencies: ScenePmtilesDependencies = {
  createProtocol: () => new Protocol({ metadata: false, errorOnMissingTile: false }) as unknown as ProtocolLike,
  createArchive: (source) => new PMTiles(source) as unknown as ProtocolArchive,
};

const registryStates = new WeakMap<MapLibreProtocolRegistry, RegistryState>();

function assertPortableContentPath(path: string): void {
  if (!CONTENT_PATH_PATTERN.test(path) || path.includes('/../') || path.includes('//')) {
    throw new Error('SCENE_PMTILES_INVALID_ASSET_PATH');
  }
}

function normalizeOrigin(origin: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error('SCENE_PMTILES_INVALID_APPLICATION_ORIGIN');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('SCENE_PMTILES_INVALID_APPLICATION_ORIGIN');
  }
  return parsed;
}

/** Validate the immutable same-origin scene asset before any protocol or network work. */
export function verifyScenePmtilesAsset(binding: ScenePmtilesAssetBinding): VerifiedScenePmtilesAsset {
  if (!binding.featureEnabled) {
    throw new Error('SCENE_PMTILES_FEATURE_DISABLED');
  }
  if (!SCENE_ID_PATTERN.test(binding.sceneId)) {
    throw new Error('SCENE_PMTILES_INVALID_SCENE_ID');
  }
  assertPortableContentPath(binding.assetPath);
  if (!SHA256_PATTERN.test(binding.sha256)) {
    throw new Error('SCENE_PMTILES_INVALID_SHA256');
  }
  if (!Number.isSafeInteger(binding.bytes) || binding.bytes <= 0) {
    throw new Error('SCENE_PMTILES_INVALID_SIZE');
  }
  const attribution = binding.attribution.trim();
  if (!attribution) {
    throw new Error('SCENE_PMTILES_ATTRIBUTION_REQUIRED');
  }

  const applicationOrigin = normalizeOrigin(binding.applicationOrigin);
  let assetUrl: URL;
  try {
    assetUrl = new URL(binding.assetUrl, applicationOrigin);
  } catch {
    throw new Error('SCENE_PMTILES_INVALID_ASSET_URL');
  }
  if (assetUrl.protocol !== applicationOrigin.protocol || assetUrl.origin !== applicationOrigin.origin) {
    throw new Error('SCENE_PMTILES_CROSS_ORIGIN_FORBIDDEN');
  }
  if (assetUrl.username || assetUrl.password || assetUrl.search || assetUrl.hash) {
    throw new Error('SCENE_PMTILES_INVALID_ASSET_URL');
  }
  const expectedPath = `/scenes/${binding.sceneId}/${binding.sha256}/${binding.assetPath}`;
  if (assetUrl.pathname !== expectedPath) {
    throw new Error('SCENE_PMTILES_CONTENT_HASH_URL_MISMATCH');
  }

  return Object.freeze({
    sceneId: binding.sceneId,
    assetPath: binding.assetPath,
    assetUrl: assetUrl.href,
    sha256: binding.sha256,
    bytes: binding.bytes,
    attribution,
  });
}

function normalizedStrongEtag(etag: string | undefined): string | null {
  if (!etag) return null;
  const trimmed = etag.trim();
  if (trimmed.startsWith('W/')) return null;
  const unquoted = trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
  return SHA256_PATTERN.test(unquoted) ? unquoted : null;
}

function composedSignal(primary: AbortSignal | undefined, lifetime: AbortSignal): AbortSignal {
  if (!primary) return lifetime;
  if (primary.aborted) return primary;
  if (lifetime.aborted) return lifetime;
  return AbortSignal.any([primary, lifetime]);
}

/** A PMTiles Source that accepts only the hash-bound immutable API representation. */
export class HashBoundScenePmtilesSource implements Source {
  readonly #asset: VerifiedScenePmtilesAsset;
  readonly #delegate: Source;
  readonly #lifetimeSignal: AbortSignal;

  constructor(
    asset: VerifiedScenePmtilesAsset,
    lifetimeSignal: AbortSignal,
    delegate: Source = new FetchSource(asset.assetUrl, new Headers({ Accept: 'application/octet-stream' }), 'same-origin'),
  ) {
    this.#asset = asset;
    this.#delegate = delegate;
    this.#lifetimeSignal = lifetimeSignal;
  }

  getKey(): string {
    return this.#asset.assetUrl;
  }

  async getBytes(offset: number, length: number, signal?: AbortSignal): Promise<RangeResponse> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0) {
      throw new Error('SCENE_PMTILES_INVALID_RANGE');
    }
    const response = await this.#delegate.getBytes(
      offset,
      length,
      composedSignal(signal, this.#lifetimeSignal),
      this.#asset.sha256,
    );
    const etag = normalizedStrongEtag(response.etag);
    if (etag === null) {
      throw new Error('SCENE_PMTILES_STRONG_ETAG_REQUIRED');
    }
    if (etag !== this.#asset.sha256) {
      throw new Error('SCENE_PMTILES_RESPONSE_HASH_MISMATCH');
    }
    return { ...response, etag: this.#asset.sha256 };
  }
}

function archiveUrlFromRequest(url: string, type: string | undefined): string | null {
  const prefix = `${SCENE_PMTILES_PROTOCOL}://`;
  if (!url.startsWith(prefix)) return null;
  if (type === 'json') return url.slice(prefix.length);
  const match = /^pmtiles:\/\/(.+)\/([0-9]+)\/([0-9]+)\/([0-9]+)$/u.exec(url);
  return match?.[1] ?? null;
}

function createState(
  registry: MapLibreProtocolRegistry,
  dependencies: ScenePmtilesDependencies,
): RegistryState {
  const protocol = dependencies.createProtocol();
  const state: RegistryState = { protocol, entries: new Map() };
  const guardedAction: AddProtocolAction = async (request, abortController) => {
    const archiveUrl = archiveUrlFromRequest(request.url, request.type);
    const entry = archiveUrl === null ? undefined : state.entries.get(archiveUrl);
    if (!entry) {
      throw new Error('SCENE_PMTILES_UNREGISTERED_ARCHIVE');
    }
    entry.controllers.add(abortController);
    try {
      return await protocol.tile(request, abortController);
    } finally {
      entry.controllers.delete(abortController);
    }
  };
  registry.addProtocol(SCENE_PMTILES_PROTOCOL, guardedAction);
  registryStates.set(registry, state);
  return state;
}

/**
 * Register a verified local scene PMTiles archive with MapLibre.
 *
 * The caller must add `sourceSpecification` to its style and must call `dispose`
 * when the scene binding is replaced or the map is destroyed.
 */
export async function registerScenePmtilesProtocol(
  registry: MapLibreProtocolRegistry,
  binding: ScenePmtilesAssetBinding,
  dependencies: ScenePmtilesDependencies = defaultDependencies,
): Promise<ScenePmtilesProtocolHandle> {
  const asset = verifyScenePmtilesAsset(binding);
  let state = registryStates.get(registry);
  const existing = state?.entries.get(asset.assetUrl);
  if (existing) {
    existing.references += 1;
    return createHandle(registry, state!, asset);
  }

  const lifetime = new AbortController();
  const source = new HashBoundScenePmtilesSource(asset, lifetime.signal);
  const archive = dependencies.createArchive(source);
  let header: { tileType: TileType };
  try {
    header = await archive.getHeader();
  } catch (error) {
    lifetime.abort('PMTiles registration failed');
    throw error;
  }
  if (header.tileType !== TileType.Mvt) {
    lifetime.abort('Non-MVT archive rejected');
    throw new Error('SCENE_PMTILES_MVT_REQUIRED');
  }

  state = registryStates.get(registry) ?? createState(registry, dependencies);
  if (state.entries.has(asset.assetUrl)) {
    lifetime.abort('Duplicate registration discarded');
    state.entries.get(asset.assetUrl)!.references += 1;
  } else {
    state.entries.set(asset.assetUrl, { archive, controllers: new Set(), lifetime, references: 1 });
    state.protocol.add(archive);
  }
  return createHandle(registry, state, asset);
}

function createHandle(
  registry: MapLibreProtocolRegistry,
  state: RegistryState,
  asset: VerifiedScenePmtilesAsset,
): ScenePmtilesProtocolHandle {
  let disposed = false;
  const sourceUrl = `${SCENE_PMTILES_PROTOCOL}://${asset.assetUrl}`;
  return Object.freeze({
    status: 'ready' as const,
    providerId: 'pmtiles' as const,
    archiveUrl: asset.assetUrl,
    sourceUrl,
    attribution: asset.attribution,
    sourceSpecification: Object.freeze({ type: 'vector' as const, url: sourceUrl, attribution: asset.attribution }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      const entry = state.entries.get(asset.assetUrl);
      if (!entry) return;
      entry.references -= 1;
      if (entry.references > 0) return;
      for (const controller of entry.controllers) controller.abort('Scene PMTiles binding disposed');
      entry.controllers.clear();
      entry.lifetime.abort('Scene PMTiles binding disposed');
      state.entries.delete(asset.assetUrl);
      state.protocol.tiles.delete(asset.assetUrl);
      if (state.entries.size === 0) {
        registry.removeProtocol(SCENE_PMTILES_PROTOCOL);
        registryStates.delete(registry);
      }
    },
  });
}
