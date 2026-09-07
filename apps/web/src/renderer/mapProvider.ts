import type { ScenePmtilesProtocolHandle } from './scenePmtilesProtocol';
import { rendererAssetUrl } from './assetUrl';
import type {
  MapSourceDescriptorV1,
  MapSourceRightsV1,
  StaticSourceAvailability,
} from './types';

export type MapProviderId = 'openfreemap' | 'offline_fallback' | 'pmtiles';
export const UNIVERSAL_PMTILES_PROTOCOL = 'omnitwin-pmtiles' as const;

export interface MapProviderDescriptor {
  id: MapProviderId;
  label: string;
  mapEnabled: boolean;
  networkRequired: boolean;
  styleUrl: string | null;
  unavailableReason: string | null;
  attribution: string | null;
}

export interface MapProviderRuntimeBindings {
  /** A handle exists only after feature flag, URL, hash/ETag, and MVT preflight succeed. */
  scenePmtiles?: ScenePmtilesProtocolHandle | null;
}

export type MapDeploymentEnvironment = 'development' | 'production';
export type OvertureSourceUsage = 'development_inspection' | 'production';

export interface OvertureBuildingsSourceOptions {
  /** Deliberately optional: no Overture endpoint is guessed or silently pinned. */
  url?: string | null;
  /** Immutable Overture release or derived production shard version. */
  datasetVersion?: string | null;
  environment?: MapDeploymentEnvironment;
  usage?: OvertureSourceUsage;
  transport?: 'pmtiles' | 'tilejson_mvt' | 'xyz_mvt';
  sourceLayers?: readonly string[];
  auth?: MapSourceDescriptorV1['auth'];
  attributionHtml?: string;
  rights?: MapSourceRightsV1;
}

export interface UniversalMapSourceCatalogV1 {
  basemap: MapSourceDescriptorV1;
  buildings: {
    primary: MapSourceDescriptorV1 | null;
    fallback: MapSourceDescriptorV1;
  };
  terrain: MapSourceDescriptorV1 | null;
}

export interface BuildingSourceSelectionInput {
  primary: MapSourceDescriptorV1 | null;
  fallback: MapSourceDescriptorV1;
  primaryState: StaticSourceAvailability;
  fallbackState: StaticSourceAvailability;
  primaryFailureReason?: string | null;
}

export interface BuildingSourceSelection {
  /** Exactly one complete provider, or null. Individual tiles are never mixed. */
  active: MapSourceDescriptorV1 | null;
  state: StaticSourceAvailability;
  fallbackActive: boolean;
  reason: string | null;
}

const OPENSTREETMAP_ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>';
const OPENFREE_MAP_ATTRIBUTION = `${OPENSTREETMAP_ATTRIBUTION} · ` +
  '<a href="https://openmaptiles.org/" target="_blank" rel="noopener noreferrer">OpenMapTiles</a> · ' +
  '<a href="https://openfreemap.org/" target="_blank" rel="noopener noreferrer">OpenFreeMap</a>';
const OVERTURE_ATTRIBUTION =
  '<a href="https://overturemaps.org/" target="_blank" rel="noopener noreferrer">Overture Maps Foundation</a> · ' +
  OPENSTREETMAP_ATTRIBUTION;

export const OPENFREE_MAP_BASEMAP_SOURCE: MapSourceDescriptorV1 = Object.freeze({
  contractVersion: 1,
  id: 'openfreemap_basemap',
  role: 'basemap',
  transport: 'tilejson_mvt',
  schema: Object.freeze({
    id: 'openmaptiles',
    version: '3.x',
    requiredLayers: Object.freeze(['landcover', 'landuse', 'water', 'transportation', 'place']),
  }),
  datasetVersion: 'provider_current',
  url: 'https://tiles.openfreemap.org/planet',
  minZoom: 0,
  maxZoom: 20,
  auth: 'none',
  usage: 'public_service',
  attributionHtml: OPENFREE_MAP_ATTRIBUTION,
  rights: Object.freeze({
    browserCache: true,
    edgeCache: false,
    proxy: false,
    prefetch: 'visible_only',
  }),
});

/** Whole-source fallback already present in the OpenFreeMap/OpenMapTiles basemap. */
export const OPENMAPTILES_BUILDINGS_SOURCE: MapSourceDescriptorV1 = Object.freeze({
  contractVersion: 1,
  id: 'openmaptiles_buildings',
  role: 'buildings',
  transport: 'tilejson_mvt',
  schema: Object.freeze({
    id: 'openmaptiles.building',
    version: '3.x',
    requiredLayers: Object.freeze(['building']),
  }),
  datasetVersion: 'provider_current',
  url: OPENFREE_MAP_BASEMAP_SOURCE.url,
  minZoom: 11,
  maxZoom: 20,
  auth: 'none',
  usage: 'public_service',
  attributionHtml: OPENFREE_MAP_ATTRIBUTION,
  rights: OPENFREE_MAP_BASEMAP_SOURCE.rights,
});

const DEFAULT_PRODUCTION_RIGHTS: MapSourceRightsV1 = Object.freeze({
  browserCache: true,
  edgeCache: true,
  proxy: true,
  prefetch: 'visible_plus_one_ring',
});

const DEFAULT_INSPECTION_RIGHTS: MapSourceRightsV1 = Object.freeze({
  browserCache: true,
  edgeCache: false,
  proxy: false,
  prefetch: 'visible_only',
});

const PROVIDERS: Readonly<Record<MapProviderId, MapProviderDescriptor>> = {
  openfreemap: {
    id: 'openfreemap',
    label: 'OpenFreeMap · online',
    mapEnabled: true,
    networkRequired: true,
    styleUrl: rendererAssetUrl('/map/openfreemap-liberty.json'),
    unavailableReason: null,
    attribution: '© OpenStreetMap contributors',
  },
  offline_fallback: {
    id: 'offline_fallback',
    label: 'Процедурная карта · OFFLINE_FALLBACK',
    mapEnabled: false,
    networkRequired: false,
    styleUrl: null,
    unavailableReason: null,
    attribution: null,
  },
  pmtiles: {
    id: 'pmtiles',
    label: 'PMTiles · локальный городской пакет',
    mapEnabled: false,
    networkRequired: false,
    styleUrl: null,
    unavailableReason: 'PMTiles недоступен: проверенный локальный scene-pack не подключён',
    attribution: null,
  },
};

export function resolveMapProvider(id: MapProviderId, bindings: MapProviderRuntimeBindings = {}): MapProviderDescriptor {
  if (id === 'pmtiles' && bindings.scenePmtiles?.status === 'ready') {
    return {
      id: 'pmtiles',
      label: 'PMTiles · проверенный локальный scene-pack',
      mapEnabled: true,
      networkRequired: false,
      styleUrl: null,
      unavailableReason: null,
      attribution: bindings.scenePmtiles.attribution,
    };
  }
  return PROVIDERS[id];
}

/**
 * Builds an Overture descriptor only from explicit runtime configuration.
 * Official Overture PMTiles are suitable for development inspection, while
 * production must point at an owned/SLA-backed immutable shard.
 */
export function createOvertureBuildingsSource(
  options: OvertureBuildingsSourceOptions = {},
): MapSourceDescriptorV1 | null {
  const rawUrl = options.url?.trim();
  if (!rawUrl) return null;
  const environment = options.environment ?? 'development';
  const usage = options.usage ?? 'development_inspection';
  if (usage === 'development_inspection' && environment === 'production') {
    throw new Error('Overture inspection tiles are development-only; configure a production shard');
  }
  const datasetVersion = options.datasetVersion?.trim();
  if (!datasetVersion) {
    throw new Error('Overture buildings datasetVersion is required');
  }
  if (environment === 'production' && datasetVersion.toLowerCase() === 'latest') {
    throw new Error('Production Overture datasetVersion must be immutable, not latest');
  }
  const transport = options.transport ?? 'pmtiles';
  validateSourceUrl(rawUrl, environment, transport);
  const sourceLayers = options.sourceLayers?.map((value) => value.trim()).filter(Boolean) ?? [
    'building',
    'building_part',
  ];
  if (sourceLayers.length === 0 || new Set(sourceLayers).size !== sourceLayers.length) {
    throw new Error('Overture buildings sourceLayers must be non-empty and unique');
  }
  return Object.freeze({
    contractVersion: 1,
    id: 'overture_buildings',
    role: 'buildings',
    transport,
    schema: Object.freeze({
      id: 'overture.buildings',
      version: '1',
      requiredLayers: Object.freeze(sourceLayers),
    }),
    datasetVersion,
    url: stripPmtilesProtocol(rawUrl),
    minZoom: 11,
    maxZoom: 14,
    auth: options.auth ?? 'none',
    usage,
    attributionHtml: options.attributionHtml?.trim() || OVERTURE_ATTRIBUTION,
    rights: options.rights ?? (
      usage === 'production' ? DEFAULT_PRODUCTION_RIGHTS : DEFAULT_INSPECTION_RIGHTS
    ),
  });
}

/**
 * Pinned official archive for local inspection only. Its ~180 GB global file
 * is HTTP-range streamed; production must configure a slim owned shard.
 */
export const OFFICIAL_OVERTURE_DEVELOPMENT_BUILDINGS_SOURCE =
  createOvertureBuildingsSource({
    url: 'https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/2026-08-19.0/buildings.pmtiles',
    datasetVersion: '2026-08-19.0',
    environment: 'development',
    usage: 'development_inspection',
  })!;

export function resolveUniversalSourceCatalog(
  overture?: OvertureBuildingsSourceOptions,
): UniversalMapSourceCatalogV1 {
  return {
    basemap: OPENFREE_MAP_BASEMAP_SOURCE,
    buildings: {
      primary: createOvertureBuildingsSource(overture),
      fallback: OPENMAPTILES_BUILDINGS_SOURCE,
    },
    terrain: null,
  };
}

export function resolveBuildingSourceSelection(
  input: BuildingSourceSelectionInput,
): BuildingSourceSelection {
  assertBuildingDescriptor(input.fallback, 'fallback');
  if (input.primary) assertBuildingDescriptor(input.primary, 'primary');

  if (input.primary && input.primaryState === 'ready') {
    return { active: input.primary, state: 'ready', fallbackActive: false, reason: null };
  }
  if (input.fallbackState === 'ready' || input.fallbackState === 'degraded') {
    const reason = input.primaryFailureReason?.trim() || (
      input.primary ? `primary_${input.primaryState}` : 'overture_not_configured'
    );
    return {
      active: input.fallback,
      state: 'degraded',
      fallbackActive: true,
      reason,
    };
  }
  if (
    input.primaryState === 'checking' ||
    input.fallbackState === 'checking'
  ) {
    return { active: null, state: 'checking', fallbackActive: false, reason: null };
  }
  return {
    active: null,
    state: 'unavailable',
    fallbackActive: false,
    reason: input.primaryFailureReason?.trim() || 'building_sources_unavailable',
  };
}

function assertBuildingDescriptor(
  descriptor: MapSourceDescriptorV1,
  label: string,
): void {
  if (descriptor.role !== 'buildings') {
    throw new Error(`${label} source must have the buildings role`);
  }
  if (descriptor.schema.requiredLayers.length === 0) {
    throw new Error(`${label} building source must declare at least one owned source layer`);
  }
}

function stripPmtilesProtocol(url: string): string {
  return url.startsWith('pmtiles://') ? url.slice('pmtiles://'.length) : url;
}

function validateSourceUrl(
  rawUrl: string,
  environment: MapDeploymentEnvironment,
  transport: OvertureBuildingsSourceOptions['transport'],
): void {
  const value = stripPmtilesProtocol(rawUrl);
  let parsed: URL;
  try {
    parsed = new URL(value, environment === 'development' ? 'http://127.0.0.1' : undefined);
  } catch {
    throw new Error('Overture buildings URL is invalid');
  }
  const isLocalDevelopment = environment === 'development' &&
    parsed.protocol === 'http:' &&
    (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
  if (parsed.protocol !== 'https:' && !isLocalDevelopment) {
    throw new Error('Remote map sources require HTTPS');
  }
  if (environment === 'production' && parsed.protocol !== 'https:') {
    throw new Error('Production map sources require HTTPS');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Map source credentials must use runtime auth, not URL userinfo');
  }
  for (const key of parsed.searchParams.keys()) {
    if (/^(?:access_?token|api_?key|key|token)$/i.test(key)) {
      throw new Error('Map source credentials must use runtime auth, not URL parameters');
    }
  }
  if (transport === 'pmtiles' && !parsed.pathname.toLowerCase().endsWith('.pmtiles')) {
    throw new Error('PMTiles source URL must identify a .pmtiles archive');
  }
}
