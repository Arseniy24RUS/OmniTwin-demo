import {describe,it,expect} from 'vitest';
import {parseMovementActivation} from './movementAssetActivation';
const baseHashes={population:'a'.repeat(64),spatial:'b'.repeat(64),geography:'c'.repeat(64)};
const city={baseUrl:`https://storage.googleapis.com/omnitwin-demo-city-assets/packs/${'d'.repeat(64)}/`,populationManifestSha256:baseHashes.population,spatialManifestSha256:baseHashes.spatial};
const activation={contract:'CityMovementActivationV1',version:1,datasetId:'omnitwin-fictional-city-v2',presentation:'bounded_source_overlay',chatCompatibility:'pending',baseHashes,
  manifest:{url:`https://storage.googleapis.com/omnitwin-demo-city-assets/packs/${'e'.repeat(64)}/movement-overlay-v2/manifest-${'f'.repeat(16)}.json`,bytes:123,sha256:'f'.repeat(64)}};
describe('explicit public movement activation',()=>{
  it('preserves an independent immutable pin and the pending chat guard',()=>{
    expect(parseMovementActivation(activation,city)).toEqual(activation);
    expect(parseMovementActivation({...activation,chatCompatibility:'base_profiles_unchanged'},city).chatCompatibility).toBe('base_profiles_unchanged');
  });
  it('requires approved source deployment, exact pins and explicit compatibility',()=>{
    for(const value of [{...activation,chatCompatibility:'ready'},{...activation,baseHashes:{...baseHashes,population:'f'.repeat(64)}},{...activation,baseHashes:{...baseHashes,spatial:'f'.repeat(64)}},{...activation,manifest:{...activation.manifest,bytes:0}}])expect(()=>parseMovementActivation(value,city)).toThrow();
    expect(()=>parseMovementActivation(activation,undefined)).toThrow();
  });
  it('rejects normalization escapes, foreign/mutable URLs, redirects and source filename mismatch',()=>{
    for(const url of [activation.manifest.url.replace('omnitwin-demo-city-assets','other'),activation.manifest.url.replace('e'.repeat(64),'latest'),activation.manifest.url+'?token=x',activation.manifest.url.replace('/movement-overlay-v2/','/hidden/../movement-overlay-v2/'),activation.manifest.url.replace('f'.repeat(16),'1'.repeat(16))])expect(()=>parseMovementActivation({...activation,manifest:{...activation.manifest,url}},city)).toThrow();
  });
});
