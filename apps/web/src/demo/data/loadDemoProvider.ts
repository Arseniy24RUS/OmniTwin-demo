import { StaticDemoProvider } from './StaticDemoProvider';
import { readCityActivation } from './cityAssetActivation';

/** Activation is explicit: legacy remains live until the city-scale backend and PNG gates pass. */
export async function loadDemoProvider(baseUrl: string, datasetId?: string, signal?: AbortSignal): Promise<StaticDemoProvider> {
  const activation = await readCityActivation(baseUrl, signal);
  const requested = datasetId ?? activation.defaultDatasetId;
  if (requested === 'omnitwin-fictional-city-v2') {
    const { CityDemoProviderV2 } = await import('./CityDemoProviderV2');
    return CityDemoProviderV2.loadCity(activation.cityAssets?.baseUrl ?? baseUrl, signal, {
      applicationBaseURL: baseUrl,
      populationManifestSha256: activation.cityAssets?.populationManifestSha256,
      spatialManifestSha256: activation.cityAssets?.spatialManifestSha256,
    });
  }
  if (requested && requested !== 'omnitwin-public-fictional-chelyabinsk-v1') {
    throw new Error(`Набор ${requested} ещё не активирован в этой сборке.`);
  }
  return StaticDemoProvider.load(baseUrl, signal);
}
