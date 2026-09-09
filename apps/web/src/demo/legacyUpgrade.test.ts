import { describe, expect, it } from 'vitest';
import { parseCityActivation } from './data/cityAssetActivation';
import { CITY_DATASET_ID, eligibleCityUpgrade, upgradeLegacyContext } from './legacyUpgrade';
import type { DemoContextV1 } from './types';

const legacyDataset = 'omnitwin-public-fictional-chelyabinsk-v1';
const cityAssets = {
  baseUrl: `https://storage.googleapis.com/omnitwin-demo-city-assets/packs/${'a'.repeat(64)}/`,
  populationManifestSha256: 'b'.repeat(64),
  spatialManifestSha256: 'c'.repeat(64),
};

function legacyContext(): DemoContextV1 {
  return {
    datasetId: legacyDataset, analyticsSource: 'observed', observedYear: 2024,
    scenario: 'inflow', comparisonScenario: 'ageing', year: 2032, territoryId: 'RU-CHE-SET-CEN',
    presentationMinutes: 1137.5, weather: 'rain', playing: true, speed: 16,
    camera: { longitude: 61.405, latitude: 55.16, zoom: 16.8, pitch: 35, bearing: -24 },
    cohort: { ageBand: '35-54', sex: 'female', employment: 'employed' },
    agentQuery: 'Анна', agentOffset: 150,
  };
}

describe('explicit legacy bookmark city upgrade', () => {
  it('is available only for the active V2 default with its validated immutable pack', () => {
    expect(CITY_DATASET_ID).toBe('omnitwin-fictional-city-v2');
    expect(eligibleCityUpgrade(parseCityActivation({ defaultDatasetId: CITY_DATASET_ID, cityAssets }))).toBe(true);
  });

  it('does not offer upgrades for inactive configuration, a legacy default, or a pack without the V2 default', () => {
    for (const config of [{}, { defaultDatasetId: legacyDataset }, { cityAssets }, { defaultDatasetId: legacyDataset, cityAssets }]) {
      expect(eligibleCityUpgrade(parseCityActivation(config))).toBe(false);
    }
    expect(eligibleCityUpgrade({ defaultDatasetId: CITY_DATASET_ID })).toBe(false);
  });

  it('keeps namespace and both pinned-hash validation at the activation boundary', () => {
    for (const assets of [
      { ...cityAssets, populationManifestSha256: undefined },
      { ...cityAssets, spatialManifestSha256: undefined },
      { ...cityAssets, baseUrl: cityAssets.baseUrl.replace('storage.googleapis.com', 'example.com') },
    ]) {
      expect(() => parseCityActivation({ defaultDatasetId: CITY_DATASET_ID, cityAssets: assets })).toThrow();
    }
    expect(() => parseCityActivation({ defaultDatasetId: CITY_DATASET_ID })).toThrow();
  });

  it('preserves camera, time, scenario, statistics, weather, speed, territory and comparison', () => {
    const context = legacyContext();
    const migrated = upgradeLegacyContext(context);
    expect(migrated).toEqual({ ...context, datasetId: CITY_DATASET_ID, cohort: null, agentQuery: undefined, agentOffset: undefined });
    expect(migrated.camera).toEqual(context.camera);
    expect(migrated).not.toBe(context);
  });

  it('does not mutate the original bookmark or its nested values', () => {
    const context = legacyContext(), before = structuredClone(context);
    Object.freeze(context.camera); Object.freeze(context.cohort); Object.freeze(context);
    upgradeLegacyContext(context);
    expect(context).toEqual(before);
  });

  it('preserves a paused fictional-statistics context without manufacturing optional settings', () => {
    const context = legacyContext();
    context.playing = false; context.analyticsSource = 'fictional';
    delete context.observedYear; delete context.comparisonScenario;
    const migrated = upgradeLegacyContext(context);
    expect(migrated.playing).toBe(false);
    expect(migrated.analyticsSource).toBe('fictional');
    expect(migrated).not.toHaveProperty('observedYear');
    expect(migrated).not.toHaveProperty('comparisonScenario');
    expect(migrated.cohort).toBeNull();
    expect(migrated.agentQuery).toBeUndefined();
    expect(migrated.agentOffset).toBeUndefined();
  });
});
