import { describe, expect, it } from 'vitest';
import { parseCityActivation } from './cityAssetActivation';

const city = { baseUrl: `https://storage.googleapis.com/omnitwin-demo-city-assets/packs/${'a'.repeat(64)}/`, populationManifestSha256: 'b'.repeat(64), spatialManifestSha256: 'c'.repeat(64) };
describe('atomic public city dataset activation', () => {
  it('retains the current legacy configuration and accepts a pinned city pack', () => {
    expect(parseCityActivation({ version: 1, chatApiUrl: 'https://example.test', assetBaseUrl: null })).toEqual({ defaultDatasetId: undefined, cityAssets: undefined });
    expect(parseCityActivation({ defaultDatasetId: 'omnitwin-fictional-city-v2', cityAssets: city }).cityAssets).toEqual(city);
  });
  it('rejects a partially activated or mutable city dataset', () => {
    expect(() => parseCityActivation({ defaultDatasetId: 'omnitwin-fictional-city-v2' })).toThrow('immutable');
    expect(() => parseCityActivation({ cityAssets: { ...city, spatialManifestSha256: null } })).toThrow('pinned');
    expect(() => parseCityActivation({ cityAssets: { ...city, baseUrl: city.baseUrl.replace('a'.repeat(64), 'latest') } })).toThrow('namespace');
  });
  it('rejects unrelated buckets, origins, query credentials and fragments', () => {
    for (const baseUrl of [city.baseUrl.replace('omnitwin-demo-city-assets', 'other-project'), city.baseUrl.replace('storage.googleapis.com', 'example.com'), `${city.baseUrl}?token=value`, `${city.baseUrl}#x`, city.baseUrl.replace('https://', 'https://user@')]) {
      expect(() => parseCityActivation({ cityAssets: { ...city, baseUrl } })).toThrow('namespace');
    }
  });
});
