export interface CityMovementActivation {
  contract: 'CityMovementActivationV1'; version: 1; datasetId: 'omnitwin-fictional-city-v2';
  presentation: 'bounded_source_overlay'; chatCompatibility: 'pending' | 'base_profiles_unchanged';
  baseHashes: { population: string; spatial: string; geography: string };
  manifest: { url: string; bytes: number; sha256: string };
}
type CityPins = {populationManifestSha256:string;spatialManifestSha256:string};
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,allowed:string[])=>Object.keys(v).every(k=>allowed.includes(k));
const fail=():never=>{throw Error('Movement activation requires an approved immutable source descriptor');};

/** Deployment attestation is separate from historical overlay manifest provenance.
 * Geography is checked against loaded source bytes before chat guard relaxation. */
export function parseMovementActivation(value:unknown,city:CityPins|undefined):CityMovementActivation{
  if(!object(value)||!keys(value,['contract','version','datasetId','presentation','chatCompatibility','baseHashes','manifest'])||!city
    ||value.contract!=='CityMovementActivationV1'||value.version!==1||value.datasetId!=='omnitwin-fictional-city-v2'
    ||value.presentation!=='bounded_source_overlay'||!['pending','base_profiles_unchanged'].includes(String(value.chatCompatibility)))return fail();
  const base=value.baseHashes,manifest=value.manifest;
  if(!object(base)||!keys(base,['population','spatial','geography'])||!sha(base.population)||!sha(base.spatial)||!sha(base.geography)
    ||base.population!==city.populationManifestSha256||base.spatial!==city.spatialManifestSha256||!object(manifest)
    ||!keys(manifest,['url','bytes','sha256'])||!sha(manifest.sha256)||!Number.isSafeInteger(manifest.bytes)
    ||Number(manifest.bytes)<1||Number(manifest.bytes)>2*1024*1024||typeof manifest.url!=='string'
    ||!/^https:\/\/storage\.googleapis\.com\/omnitwin-demo-city-assets\/packs\/[a-f0-9]{64}\/movement-overlay-v2\/manifest-[a-f0-9]{16}\.json$/.test(manifest.url)
    ||!manifest.url.endsWith(`/manifest-${manifest.sha256.slice(0,16)}.json`))return fail();
  return {contract:'CityMovementActivationV1',version:1,datasetId:'omnitwin-fictional-city-v2',presentation:'bounded_source_overlay',
    chatCompatibility:value.chatCompatibility as CityMovementActivation['chatCompatibility'],
    baseHashes:{population:base.population,spatial:base.spatial,geography:base.geography},manifest:{url:manifest.url,bytes:Number(manifest.bytes),sha256:manifest.sha256}};
}
export function movementLoadOptions(activation:CityMovementActivation){
  return {manifestUrl:activation.manifest.url,manifestSha256:activation.manifest.sha256,manifestBytes:activation.manifest.bytes,activation};
}
