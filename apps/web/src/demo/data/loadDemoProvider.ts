import { StaticDemoProvider } from './StaticDemoProvider';
import { readCityActivation } from './cityAssetActivation';
import {readLocalMovementPreview} from './localMovementPreview';
import {movementLoadOptions} from './movementAssetActivation';
import {isLocalCityApplication} from './localCityApplication';

/** Activation is explicit: legacy remains live until the city-scale backend and PNG gates pass. */
export async function loadDemoProvider(baseUrl: string, datasetId?: string, signal?: AbortSignal): Promise<StaticDemoProvider> {
  const activation = await readCityActivation(baseUrl, signal);
  const requested = datasetId ?? activation.defaultDatasetId;
  if (requested === 'omnitwin-fictional-city-v2') {
    const local=isLocalCityApplication(import.meta.env.DEV,baseUrl,globalThis.location?.href??'');
    // Published transport is not usable from the separate local development origin.
    // Keep its independent source pins: a stale local copy must fail explicitly.
    // The local overlay retains its local_preview/pending provenance, even after
    // public activation separately attests base-profile chat compatibility.
    const movementPreviewOverlay=local?await readLocalMovementPreview(baseUrl,signal,datasetId===undefined?activation.defaultDatasetId:undefined)
      :activation.movementOverlay?movementLoadOptions(activation.movementOverlay):undefined;
    const { CityDemoProviderV2 } = await import('./CityDemoProviderV2');
    return CityDemoProviderV2.loadCity(local?baseUrl:activation.cityAssets?.baseUrl ?? baseUrl, signal, {
      applicationBaseURL: baseUrl,
      populationManifestSha256: activation.cityAssets?.populationManifestSha256,
      spatialManifestSha256: activation.cityAssets?.spatialManifestSha256,
      movementPreviewOverlay,
    });
  }
  if (requested && requested !== 'omnitwin-public-fictional-chelyabinsk-v1') {
    throw new Error(`Набор ${requested} ещё не активирован в этой сборке.`);
  }
  return StaticDemoProvider.load(baseUrl, signal);
}
