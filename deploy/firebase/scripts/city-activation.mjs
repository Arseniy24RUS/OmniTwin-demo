import { createHash } from 'node:crypto';

export const CITY_PROJECT_ID = 'omnitwin-demo';
export const CITY_API_URI = 'https://chatapi-avypjak2xq-ew.a.run.app';
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fields = ['V2_POPULATION_MANIFEST_URL', 'V2_POPULATION_MANIFEST_SHA256', 'V2_SPATIAL_MANIFEST_URL', 'V2_SPATIAL_MANIFEST_SHA256'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => plain(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const basePattern = /^https:\/\/storage\.googleapis\.com\/omnitwin-demo-city-assets\/packs\/[a-f0-9]{64}\/$/;

export function assertDeploymentProject(projectId) {
  if (projectId !== CITY_PROJECT_ID) throw new Error('Invalid Firebase deployment project.');
}

/** Operator-reviewed public configuration only. Never inspect ambient V2 env. */
export function validateCityActivation(value) {
  if (!exact(value, ['version', 'projectId', 'v2']) || value.version !== 1 || value.projectId !== CITY_PROJECT_ID) throw new Error('Invalid city activation configuration.');
  if (value.v2 === null) return Object.freeze({ version: 1, projectId: CITY_PROJECT_ID, v2: null });
  if (!exact(value.v2, fields)) throw new Error('Incomplete city activation pins.');
  const pins = value.v2;
  if (!sha(pins.V2_POPULATION_MANIFEST_SHA256) || !sha(pins.V2_SPATIAL_MANIFEST_SHA256) || typeof pins.V2_POPULATION_MANIFEST_URL !== 'string') throw new Error('Invalid city activation pins.');
  const suffix = 'demo-v2/manifest.json';
  const base = pins.V2_POPULATION_MANIFEST_URL.endsWith(suffix) ? pins.V2_POPULATION_MANIFEST_URL.slice(0, -suffix.length) : '';
  if (!basePattern.test(base) || pins.V2_SPATIAL_MANIFEST_URL !== `${base}demo-v2/spatial/manifest.json`) throw new Error('Unapproved immutable city asset namespace.');
  // Rebuild in fixed order so formatting/property order never changes the hash.
  const v2 = Object.freeze(Object.fromEntries(fields.map(key => [key, pins[key]])));
  return Object.freeze({ version: 1, projectId: CITY_PROJECT_ID, v2 });
}

export function createCityActivation({ projectId, legacy = false, packBaseUrl, populationManifestSha256, spatialManifestSha256 }) {
  assertDeploymentProject(projectId);
  if (legacy) {
    if ([packBaseUrl, populationManifestSha256, spatialManifestSha256].some(value => value !== undefined)) throw new Error('Invalid mixed activation intent.');
    return validateCityActivation({ version: 1, projectId, v2: null });
  }
  if (typeof packBaseUrl !== 'string' || !basePattern.test(packBaseUrl)) throw new Error('Unapproved immutable city asset namespace.');
  return validateCityActivation({ version: 1, projectId, v2: {
    V2_POPULATION_MANIFEST_URL: `${packBaseUrl}demo-v2/manifest.json`,
    V2_POPULATION_MANIFEST_SHA256: populationManifestSha256,
    V2_SPATIAL_MANIFEST_URL: `${packBaseUrl}demo-v2/spatial/manifest.json`,
    V2_SPATIAL_MANIFEST_SHA256: spatialManifestSha256,
  } });
}

export function cityActivationPayload(value) {
  const activation = validateCityActivation(value);
  const sha256 = createHash('sha256').update(JSON.stringify(activation)).digest('hex');
  const mode = activation.v2 ? 'v2' : 'legacy';
  const env = activation.v2 ?? Object.freeze({});
  const labels = Object.freeze({ 'omnitwin-city-mode': mode, 'omnitwin-city-pin-a': sha256.slice(0, 32), 'omnitwin-city-pin-b': sha256.slice(32) });
  const module = '// Generated from reviewed non-secret city-activation.json; never from ambient V2 environment.\n'
    + `export const CITY_PROJECT_ID = ${JSON.stringify(CITY_PROJECT_ID)};\n`
    + `export const CITY_ACTIVATION_SHA256 = ${JSON.stringify(sha256)};\n`
    + `export const CITY_ACTIVATION_ENV = Object.freeze(${JSON.stringify(env)});\n`
    + `export const CITY_DEPLOYMENT_LABELS = Object.freeze(${JSON.stringify(labels)});\n`;
  return { activation, sha256, mode, env, labels, module };
}
