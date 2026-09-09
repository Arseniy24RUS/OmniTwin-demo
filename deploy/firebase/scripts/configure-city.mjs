import { lstat, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, dirname, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCityActivation, cityActivationPayload, validateCityActivation } from './city-activation.mjs';

export const ACTIVATION_PATH = fileURLToPath(new URL('../city-activation.json', import.meta.url));
const usage = 'Usage: --project omnitwin-demo (--legacy | --pack-base-url URL --population-sha256 SHA --spatial-sha256 SHA) [--write --expect-current SHA]';

export function parseConfigureArguments(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (values.has(key) || !['--project', '--legacy', '--pack-base-url', '--population-sha256', '--spatial-sha256', '--write', '--expect-current'].includes(key)) throw new Error(usage);
    if (['--legacy', '--write'].includes(key)) values.set(key, true);
    else {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(usage);
      values.set(key, argv[++i]);
    }
  }
  const write = values.has('--write');
  const expectedCurrent = values.get('--expect-current');
  if (write ? typeof expectedCurrent !== 'string' || !/^[a-f0-9]{64}$/.test(expectedCurrent) : expectedCurrent !== undefined) throw new Error('Writing requires --write and --expect-current from the reviewed preview.');
  const activation = createCityActivation({ projectId: values.get('--project'), legacy: values.has('--legacy'), packBaseUrl: values.get('--pack-base-url'), populationManifestSha256: values.get('--population-sha256'), spatialManifestSha256: values.get('--spatial-sha256') });
  return { activation, write, expectedCurrent };
}

async function checkRegularPath(path) {
  let current = resolve(path); let file = true;
  for (;;) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (file ? !stat.isFile() || stat.size > 4096 : !stat.isDirectory())) throw new Error('City configuration requires a small regular file without symlink parents.');
    if (current === parse(current).root) break;
    current = dirname(current); file = false;
  }
}

export async function readCityActivationFile(path = ACTIVATION_PATH) {
  await checkRegularPath(path);
  return validateCityActivation(JSON.parse(await readFile(path, 'utf8')));
}

export async function writeCityActivation(path, value, expectedCurrent) {
  const activation = validateCityActivation(value);
  const before = cityActivationPayload(await readCityActivationFile(path));
  if (before.sha256 !== expectedCurrent) throw new Error('City activation changed since the reviewed preview.');
  const temporary = resolve(dirname(path), `.city-activation-${randomUUID()}.tmp`);
  let created = false;
  try {
    await writeFile(temporary, `${JSON.stringify(activation, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); created = true;
    if (cityActivationPayload(await readCityActivationFile(path)).sha256 !== expectedCurrent) throw new Error('City activation changed during the write.');
    await rename(temporary, path); created = false;
  } finally { if (created) await unlink(temporary); }
  return activation;
}

export async function configureCity(argv) {
  const { activation, write, expectedCurrent } = parseConfigureArguments(argv);
  const current = cityActivationPayload(await readCityActivationFile());
  const next = cityActivationPayload(activation);
  if (write) await writeCityActivation(ACTIVATION_PATH, activation, expectedCurrent);
  return { projectId: activation.projectId, written: write, deployed: false, currentActivationSha256: current.sha256, nextActivationSha256: next.sha256, mode: next.mode, labels: next.labels, activation };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await configureCity(process.argv.slice(2)), null, 2)); }
  catch { console.error(`City activation configuration failed. ${usage}. No deployment was attempted.`); process.exitCode = 1; }
}
