export interface CityAssetActivation {
  baseUrl: string;
  populationManifestSha256: string;
  spatialManifestSha256: string;
}

const CITY_DATASET = 'omnitwin-fictional-city-v2';
const LEGACY_DATASET = 'omnitwin-public-fictional-chelyabinsk-v1';
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Only this demo's immutable public asset namespace is eligible for activation. */
export function parseCityActivation(value: unknown): { defaultDatasetId?: string; cityAssets?: CityAssetActivation; movementOverlay?:CityMovementActivation } {
  if (!value || typeof value !== 'object') throw new Error('Invalid deployment configuration');
  const config = value as Record<string, unknown>;
  if (config.defaultDatasetId !== undefined && ![CITY_DATASET, LEGACY_DATASET].includes(String(config.defaultDatasetId))) throw new Error('Unknown activated dataset');
  let cityAssets: CityAssetActivation | undefined;
  if (config.cityAssets !== undefined && config.cityAssets !== null) {
    const assets = config.cityAssets as Record<string, unknown>;
    if (typeof assets.baseUrl !== 'string' || !sha(assets.populationManifestSha256) || !sha(assets.spatialManifestSha256)) throw new Error('City activation requires pinned manifests');
    const url = new URL(assets.baseUrl);
    if (url.origin !== 'https://storage.googleapis.com' || url.username || url.password || url.search || url.hash ||
      !/^\/omnitwin-demo-city-assets\/packs\/[a-f0-9]{64}\/$/.test(url.pathname)) throw new Error('Unapproved city asset namespace');
    cityAssets = { baseUrl: url.href, populationManifestSha256: assets.populationManifestSha256, spatialManifestSha256: assets.spatialManifestSha256 };
  }
  if (config.defaultDatasetId === CITY_DATASET && !cityAssets) throw new Error('City activation requires its immutable asset pack');
  const movementOverlay=config.movementOverlay===undefined?undefined:parseMovementActivation(config.movementOverlay,cityAssets);
  return { defaultDatasetId: config.defaultDatasetId as string | undefined, cityAssets, ...(movementOverlay?{movementOverlay}:{}) };
}

export async function readCityActivation(applicationBaseUrl: string, signal?: AbortSignal) {
  const root = new URL(applicationBaseUrl.endsWith('/') ? applicationBaseUrl : `${applicationBaseUrl}/`, globalThis.location?.href ?? 'http://localhost/');
  const response = await fetch(new URL('runtime-config.json', root), { signal, cache: 'no-cache' });
  if (!response.ok) throw new Error(`Deployment configuration HTTP ${response.status}`);
  return parseCityActivation(await response.json());
}
import {parseMovementActivation,type CityMovementActivation} from './movementAssetActivation';
