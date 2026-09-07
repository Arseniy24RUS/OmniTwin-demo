import type { AddProtocolAction } from 'maplibre-gl';
import { FetchSource, PMTiles, Protocol, TileType } from 'pmtiles';
import type { Source } from 'pmtiles';
import {
  UNIVERSAL_PMTILES_PROTOCOL,
} from './mapProvider';
import type { MapSourceDescriptorV1 } from './types';
import type { MapLibreProtocolRegistry } from './scenePmtilesProtocol';

interface UniversalArchive {
  source: Pick<Source, 'getKey'>;
  getHeader(): Promise<{ tileType: TileType }>;
  getMetadata(): Promise<unknown>;
}

interface UniversalProtocolLike {
  tiles: Map<string, UniversalArchive>;
  add(archive: UniversalArchive): void;
  tile: AddProtocolAction;
}

interface UniversalRegistryEntry {
  archive: UniversalArchive;
  descriptor: MapSourceDescriptorV1;
  controllers: Set<AbortController>;
  lifetime: AbortController;
  references: number;
}

interface UniversalRegistryState {
  protocol: UniversalProtocolLike;
  entries: Map<string, UniversalRegistryEntry>;
}

export interface UniversalPmtilesRangeEvidence {
  etag: string | null;
  contentRange: string;
}

export interface UniversalPmtilesProtocolHandle {
  readonly status: 'ready';
  readonly providerId: string;
  readonly datasetVersion: string;
  readonly usage: MapSourceDescriptorV1['usage'];
  readonly archiveUrl: string;
  readonly sourceUrl: string;
  readonly sourceLayers: readonly string[];
  readonly rangeEvidence: UniversalPmtilesRangeEvidence;
  readonly sourceSpecification: {
    readonly type: 'vector';
    readonly url: string;
    readonly attribution: string;
  };
  dispose(): void;
}

export interface UniversalPmtilesDependencies {
  preflightRange(
    url: string,
    signal: AbortSignal,
  ): Promise<UniversalPmtilesRangeEvidence>;
  createProtocol(): UniversalProtocolLike;
  createArchive(url: string): UniversalArchive;
}

const defaultDependencies: UniversalPmtilesDependencies = {
  preflightRange: (url, signal) => preflightUniversalPmtilesRange(url, signal),
  createProtocol: () => new Protocol({ metadata: true, errorOnMissingTile: false }) as unknown as UniversalProtocolLike,
  createArchive: (url) => new PMTiles(new FetchSource(
    url,
    new Headers({ Accept: 'application/octet-stream' }),
    'same-origin',
  )) as unknown as UniversalArchive,
};

const registryStates = new WeakMap<MapLibreProtocolRegistry, UniversalRegistryState>();

export const UNIVERSAL_PMTILES_PREFLIGHT_TIMEOUT_MS = 5_000;
export const UNIVERSAL_PMTILES_REGISTRATION_TIMEOUT_MS = 8_000;

/** A successful fetch proves browser CORS access; 206 proves byte-range delivery. */
export async function preflightUniversalPmtilesRange(
  url: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = UNIVERSAL_PMTILES_PREFLIGHT_TIMEOUT_MS,
): Promise<UniversalPmtilesRangeEvidence> {
  const headers = new Headers({
    Accept: 'application/octet-stream',
    Range: 'bytes=0-126',
  });
  const requestController = new AbortController();
  const forwardAbort = () => requestController.abort(signal.reason);
  if (signal.aborted) forwardAbort();
  else signal.addEventListener('abort', forwardAbort, { once: true });
  let deadlineExceeded = false;
  let deadlineHandle: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    deadlineHandle = setTimeout(() => {
      deadlineExceeded = true;
      requestController.abort('Universal PMTiles range preflight timed out');
      reject(new Error('UNIVERSAL_PMTILES_PREFLIGHT_TIMEOUT'));
    }, timeoutMs);
  });
  let response: Response;
  try {
    response = await Promise.race([fetchImpl(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      headers,
      signal: requestController.signal,
    }), deadline]);
  } catch (error) {
    if (deadlineExceeded) throw new Error('UNIVERSAL_PMTILES_PREFLIGHT_TIMEOUT', { cause: error });
    throw new Error('UNIVERSAL_PMTILES_CORS_PREFLIGHT_FAILED', { cause: error });
  } finally {
    if (deadlineHandle !== undefined) clearTimeout(deadlineHandle);
    signal.removeEventListener('abort', forwardAbort);
  }
  if (response.status !== 206) {
    throw new Error(`UNIVERSAL_PMTILES_RANGE_REQUIRED:${response.status}`);
  }
  const contentRange = response.headers.get('content-range');
  if (!contentRange || !/^bytes 0-126\/\d+$/u.test(contentRange)) {
    throw new Error('UNIVERSAL_PMTILES_CONTENT_RANGE_INVALID');
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== 127) {
    throw new Error('UNIVERSAL_PMTILES_RANGE_LENGTH_INVALID');
  }
  return {
    etag: response.headers.get('etag'),
    contentRange,
  };
}

/**
 * Registers one or more cross-origin universal archives on a protocol name
 * intentionally separate from the hash-bound local scene PMTiles protocol.
 */
export async function registerUniversalPmtilesProtocol(
  registry: MapLibreProtocolRegistry,
  descriptor: MapSourceDescriptorV1,
  dependencies: UniversalPmtilesDependencies = defaultDependencies,
  timeoutMs = UNIVERSAL_PMTILES_REGISTRATION_TIMEOUT_MS,
): Promise<UniversalPmtilesProtocolHandle> {
  verifyUniversalDescriptor(descriptor);
  const existingState = registryStates.get(registry);
  const existing = existingState?.entries.get(descriptor.url);
  if (existing) {
    if (existing.descriptor.datasetVersion !== descriptor.datasetVersion) {
      throw new Error('UNIVERSAL_PMTILES_DATASET_VERSION_CONFLICT');
    }
    existing.references += 1;
    return createHandle(
      registry,
      existingState!,
      existing,
      { etag: null, contentRange: 'reused' },
    );
  }

  const lifetime = new AbortController();
  let rangeEvidence: UniversalPmtilesRangeEvidence;
  let archive: UniversalArchive;
  let deadlineHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const initialization = (async () => {
      const evidence = await dependencies.preflightRange(descriptor.url, lifetime.signal);
      const candidate = dependencies.createArchive(descriptor.url);
      const [header, metadata] = await Promise.all([
        candidate.getHeader(),
        candidate.getMetadata(),
      ]);
      if (header.tileType !== TileType.Mvt) {
        throw new Error('UNIVERSAL_PMTILES_MVT_REQUIRED');
      }
      verifyRequiredLayers(metadata, descriptor.schema.requiredLayers);
      return { evidence, candidate };
    })();
    const deadline = new Promise<never>((_resolve, reject) => {
      deadlineHandle = setTimeout(() => {
        lifetime.abort('Universal PMTiles registration timed out');
        reject(new Error('UNIVERSAL_PMTILES_REGISTRATION_TIMEOUT'));
      }, timeoutMs);
    });
    const initialized = await Promise.race([initialization, deadline]);
    rangeEvidence = initialized.evidence;
    archive = initialized.candidate;
  } catch (error) {
    lifetime.abort('Universal PMTiles registration failed');
    throw error;
  } finally {
    if (deadlineHandle !== undefined) clearTimeout(deadlineHandle);
  }

  const state = existingState ?? createState(registry, dependencies);
  const entry: UniversalRegistryEntry = {
    archive,
    descriptor,
    controllers: new Set(),
    lifetime,
    references: 1,
  };
  state.entries.set(descriptor.url, entry);
  state.protocol.add(archive);
  return createHandle(registry, state, entry, rangeEvidence);
}

function createState(
  registry: MapLibreProtocolRegistry,
  dependencies: UniversalPmtilesDependencies,
): UniversalRegistryState {
  const protocol = dependencies.createProtocol();
  const state: UniversalRegistryState = { protocol, entries: new Map() };
  const guardedAction: AddProtocolAction = async (request, abortController) => {
    const archiveUrl = archiveUrlFromRequest(request.url, request.type);
    const entry = archiveUrl ? state.entries.get(archiveUrl) : undefined;
    if (!entry) throw new Error('UNIVERSAL_PMTILES_UNREGISTERED_ARCHIVE');
    entry.controllers.add(abortController);
    try {
      const protocolUrl = canonicalizeNestedHttpScheme(request.url.replace(
        `${UNIVERSAL_PMTILES_PROTOCOL}://`,
        'pmtiles://',
      ));
      const response = await protocol.tile({
        ...request,
        url: protocolUrl,
      }, abortController);
      if (request.type !== 'json') return response;
      const data = response.data;
      if (!data || typeof data !== 'object' || !Array.isArray(data.tiles)) return response;
      return {
        ...response,
        data: {
          ...data,
          // PMTiles generates its own protocol URLs in TileJSON. Keep them on
          // our registered namespace so MapLibre never hands `pmtiles://` to fetch/CSP.
          tiles: data.tiles.map((tile: unknown) => typeof tile === 'string'
            ? tile.replace(/^pmtiles:\/\//u, `${UNIVERSAL_PMTILES_PROTOCOL}://`)
            : tile),
        },
      };
    } finally {
      entry.controllers.delete(abortController);
    }
  };
  registry.addProtocol(UNIVERSAL_PMTILES_PROTOCOL, guardedAction);
  registryStates.set(registry, state);
  return state;
}

function archiveUrlFromRequest(url: string, type: string | undefined): string | null {
  const prefix = `${UNIVERSAL_PMTILES_PROTOCOL}://`;
  if (!url.startsWith(prefix)) return null;
  if (type === 'json') return canonicalizeNestedHttpScheme(url.slice(prefix.length));
  const escaped = UNIVERSAL_PMTILES_PROTOCOL.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(
    `^${escaped}://(.+)/[0-9]+/[0-9]+/[0-9]+(?:\\.[A-Za-z0-9]+)?(?:\\?.*)?$`,
    'u',
  ).exec(url);
  return match ? canonicalizeNestedHttpScheme(match[1]) : null;
}

/** MapLibre URL parsing removes the inner colon from nested HTTP URLs. */
function canonicalizeNestedHttpScheme(value: string): string {
  return value
    .replace(/^https\/\//u, 'https://')
    .replace(/^http\/\//u, 'http://')
    .replace(/^pmtiles:\/\/https\/\//u, 'pmtiles://https://')
    .replace(/^pmtiles:\/\/http\/\//u, 'pmtiles://http://');
}

function verifyRequiredLayers(metadata: unknown, requiredLayers: readonly string[]): void {
  const vectorLayers = metadata && typeof metadata === 'object'
    ? (metadata as { vector_layers?: unknown }).vector_layers
    : null;
  if (!Array.isArray(vectorLayers)) {
    throw new Error('UNIVERSAL_PMTILES_VECTOR_METADATA_REQUIRED');
  }
  const available = new Set(vectorLayers.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const id = (value as { id?: unknown }).id;
    return typeof id === 'string' ? [id] : [];
  }));
  for (const layer of requiredLayers) {
    if (!available.has(layer)) throw new Error(`UNIVERSAL_PMTILES_MISSING_LAYER:${layer}`);
  }
}

function verifyUniversalDescriptor(descriptor: MapSourceDescriptorV1): void {
  if (descriptor.role !== 'buildings' || descriptor.transport !== 'pmtiles') {
    throw new Error('UNIVERSAL_PMTILES_BUILDING_DESCRIPTOR_REQUIRED');
  }
  if (descriptor.schema.requiredLayers.length === 0) {
    throw new Error('UNIVERSAL_PMTILES_SOURCE_LAYERS_REQUIRED');
  }
  if (!descriptor.attributionHtml.trim()) {
    throw new Error('UNIVERSAL_PMTILES_ATTRIBUTION_REQUIRED');
  }
}

function createHandle(
  registry: MapLibreProtocolRegistry,
  state: UniversalRegistryState,
  entry: UniversalRegistryEntry,
  rangeEvidence: UniversalPmtilesRangeEvidence,
): UniversalPmtilesProtocolHandle {
  let disposed = false;
  const { descriptor } = entry;
  const sourceUrl = `${UNIVERSAL_PMTILES_PROTOCOL}://${descriptor.url}`;
  return Object.freeze({
    status: 'ready' as const,
    providerId: descriptor.id,
    datasetVersion: descriptor.datasetVersion,
    usage: descriptor.usage,
    archiveUrl: descriptor.url,
    sourceUrl,
    sourceLayers: descriptor.schema.requiredLayers,
    rangeEvidence,
    sourceSpecification: Object.freeze({
      type: 'vector' as const,
      url: sourceUrl,
      attribution: descriptor.attributionHtml,
    }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      const current = state.entries.get(descriptor.url);
      if (!current) return;
      current.references -= 1;
      if (current.references > 0) return;
      for (const controller of current.controllers) {
        controller.abort('Universal PMTiles binding disposed');
      }
      current.controllers.clear();
      current.lifetime.abort('Universal PMTiles binding disposed');
      state.entries.delete(descriptor.url);
      state.protocol.tiles.delete(descriptor.url);
      if (state.entries.size === 0) {
        registry.removeProtocol(UNIVERSAL_PMTILES_PROTOCOL);
        registryStates.delete(registry);
      }
    },
  });
}
