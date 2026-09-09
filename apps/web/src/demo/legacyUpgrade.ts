import type { readCityActivation } from './data/cityAssetActivation';
import type { DemoContextV1 } from './types';

export const CITY_DATASET_ID = 'omnitwin-fictional-city-v2';

/** Accept only activation already validated by readCityActivation/parseCityActivation. */
export function eligibleCityUpgrade(activation: Awaited<ReturnType<typeof readCityActivation>>): boolean {
  return activation.defaultDatasetId === CITY_DATASET_ID && Boolean(activation.cityAssets);
}

/** Preserve the bookmark's view; the caller separately clears selection and pushes history. */
export function upgradeLegacyContext(context: DemoContextV1): DemoContextV1 {
  return { ...context, datasetId: CITY_DATASET_ID, cohort: null, agentQuery: undefined, agentOffset: undefined };
}
