import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CITY_PROJECT_ID, CITY_API_URI, cityActivationPayload } from './city-activation.mjs';
import { readCityActivationFile } from './configure-city.mjs';

/** Accept filtered metadata, never credentials or secret values. No cloud I/O. */
export function verifyDeployment(metadata, expected) {
  if (metadata?.name !== `projects/${CITY_PROJECT_ID}/locations/europe-west1/functions/chatApi` || metadata.state !== 'ACTIVE' || metadata.environment !== 'GEN_2' ||
      typeof metadata.serviceConfig?.revision !== 'string' || !/^chatapi-[a-z0-9-]+$/.test(metadata.serviceConfig.revision) || metadata.serviceConfig.uri !== CITY_API_URI || metadata.serviceConfig.allTrafficOnLatestRevision !== true ||
      Object.entries(expected.labels).some(([key, value]) => metadata.labels?.[key] !== value)) throw new Error('Deployment metadata does not match the reviewed activation.');
  return { projectId: CITY_PROJECT_ID, revision: metadata.serviceConfig.revision, mode: expected.mode, activationSha256: expected.sha256, configurationVerified: true, liveInferenceVerified: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('No arguments accepted.');
    const expected = cityActivationPayload(await readCityActivationFile());
    const evidence = JSON.parse(await readFile(new URL('../stage-evidence.json', import.meta.url), 'utf8'));
    if (evidence.cityActivation?.sha256 !== expected.sha256 || evidence.files?.['approved-city-assets.mjs']?.sha256 !== createHash('sha256').update(expected.module).digest('hex')) throw new Error('Stage evidence differs from reviewed configuration.');
    let input = ''; let size = 0;
    for await (const chunk of process.stdin) { size += chunk.length; if (size > 16_384) throw new Error('Metadata exceeds filtered read-back limit.'); input += chunk.toString('utf8'); }
    console.log(JSON.stringify(verifyDeployment(JSON.parse(input), expected), null, 2));
  } catch { console.error('Deployment read-back failed. Require fresh staging and filtered ACTIVE GEN_2 metadata for the exact project/function/revision and activation labels.'); process.exitCode = 1; }
}
