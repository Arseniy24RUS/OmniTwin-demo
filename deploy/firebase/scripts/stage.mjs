import { readFile, readdir, lstat, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '../../../server/chat/src/config.mjs';
import { cityActivationPayload, assertDeploymentProject } from './city-activation.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const repository = resolve(root, '../..');
const output = resolve(root, 'functions');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const PORTABLE_MODULES = Object.freeze(['config.mjs', 'handler.mjs', 'quota.mjs', 'sessions.mjs', 'openrouter.mjs', 'firestore.mjs', 'firebase-http.mjs', 'population-resolver.mjs']);
const TEMPLATE_MODULES = ['index.mjs', 'runtime.mjs', 'policy.mjs'];
const PAYLOAD_NAMES = new Set([...PORTABLE_MODULES.map((name) => `src/${name}`), ...TEMPLATE_MODULES, 'data/chat-profiles.json', 'data/fictionalProfile.mjs', 'data/demo-population/index.mjs', 'data/demo-population/spatial.mjs', 'approved-profile.mjs', 'approved-city-assets.mjs', 'package.json', 'package-lock.json']);

/** No symlink traversal, including through a parent directory inside the root. */
async function regularFile(path, base = repository) {
  const suffix = relative(base, path);
  if (!suffix || suffix.startsWith(`..${sep}`) || suffix === '..') throw new Error('File is outside the approved source root.');
  const parts = suffix.split(sep);
  let current = base;
  if ((await lstat(base)).isSymbolicLink()) throw new Error('Symlink source root is not allowed.');
  for (let index = 0; index < parts.length; index += 1) {
    current = resolve(current, parts[index]);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw new Error('Source must contain only regular files and directories.');
  }
  return readFile(path);
}

export function validateStageEntries(entries, allowed) {
  for (const entry of entries) if (!allowed.has(entry)) throw new Error(`Unexpected staged entry: ${entry}`);
}

export async function buildPayload({ cityActivation } = {}) {
  const files = new Map();
  const city = cityActivationPayload(cityActivation ?? JSON.parse(await regularFile(resolve(root, 'city-activation.json'))));
  files.set('approved-city-assets.mjs', Buffer.from(city.module));
  const add = async (path, name) => files.set(name, await regularFile(path));
  for (const name of PORTABLE_MODULES) await add(resolve(repository, 'server/chat/src', name), `src/${name}`);
  for (const name of TEMPLATE_MODULES) await add(resolve(root, 'template', name), name);
  await add(resolve(repository, 'apps/web/public/demo/chat-profiles.json'), 'data/chat-profiles.json');
  await add(resolve(repository, 'apps/web/src/demo/data/fictionalProfile.mjs'), 'data/fictionalProfile.mjs');
  for (const name of ['index.mjs', 'spatial.mjs']) await add(resolve(repository, 'shared/demo-population', name), `data/demo-population/${name}`);
  const publicManifest = JSON.parse(await regularFile(resolve(repository, 'apps/web/public/demo/manifest.json')));
  const profileBytes = files.get('data/chat-profiles.json');
  const profileSha256 = digest(profileBytes);
  if (profileBytes.length > 20_000_000 || publicManifest.assets?.chatProfiles?.sha256 !== profileSha256 || publicManifest.assets.chatProfiles.bytes !== profileBytes.length) throw new Error('Profiles are not the approved immutable fictional asset.');
  const approved = validateManifest(JSON.parse(profileBytes.toString('utf8')));
  if (publicManifest.datasetId !== approved.datasetId) throw new Error('Profile dataset does not match the public manifest.');
  files.set('approved-profile.mjs', Buffer.from(`// Generated from the manifest-approved fictional profile asset.\nexport const PROFILE_MANIFEST_SHA256 = ${JSON.stringify(profileSha256)};\n`));
  const sourcePackage = JSON.parse(await regularFile(resolve(root, 'package.json')));
  const { name, version, type, main, engines, dependencies } = sourcePackage;
  if (type !== 'module' || main !== 'index.mjs' || engines.node !== '22' || Object.keys(dependencies).sort().join(',') !== 'firebase-admin,firebase-functions' || dependencies['firebase-admin'] !== '14.3.0' || dependencies['firebase-functions'] !== '7.3.2') throw new Error('Unexpected Firebase production dependencies.');
  files.set('package.json', Buffer.from(`${JSON.stringify({ name, version, private: true, type, main, engines, dependencies }, null, 2)}\n`));
  await add(resolve(root, 'package-lock.json'), 'package-lock.json');
  const lock = JSON.parse(files.get('package-lock.json'));
  if (lock.lockfileVersion !== 3 || lock.name !== name || JSON.stringify(lock.packages?.['']?.dependencies) !== JSON.stringify(dependencies) || lock.packages?.['']?.engines?.node !== '22') throw new Error('Firebase lockfile is out of sync.');
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path && (!path.startsWith('node_modules/') || /ydb-sdk/.test(path) || typeof entry.integrity !== 'string' || !entry.resolved?.startsWith('https://registry.npmjs.org/'))) throw new Error('Unexpected locked dependency source.');
  }
  const evidence = {
    artifact: 'functions', representation: 'fictional_demo', datasetId: approved.datasetId,
    profiles: approved.profiles.size, profileSha256,
    cityActivation: { sha256: city.sha256, mode: city.mode, projectId: city.activation.projectId, pins: city.env, labels: city.labels },
    profileModuleSha256: digest(files.get('data/fictionalProfile.mjs')),
    files: Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => [path, { sha256: digest(bytes), bytes: bytes.length }])),
    dependencies, nodeRuntime: '22', deployed: false, liveInferenceVerified: false,
  };
  return { files, evidence };
}

export async function existingEntries(directory, prefix = '') {
  const stat = await lstat(directory).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return [];
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Staging directory must not be a symlink or file.');
  const entries = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const name = `${prefix}${item.name}`;
    if (item.isSymbolicLink()) throw new Error('Symlinks are not allowed in staging.');
    if (item.isDirectory()) {
      entries.push(`${name}/`);
      entries.push(...await existingEntries(resolve(directory, item.name), `${name}/`));
    } else if (item.isFile()) entries.push(name);
    else throw new Error('Unexpected filesystem object in staging.');
  }
  return entries;
}

export async function stage({ files, evidence }) {
  validateStageEntries(files.keys(), PAYLOAD_NAMES);
  if (files.size !== PAYLOAD_NAMES.size) throw new Error('Incomplete Firebase payload.');
  const allowed = new Set(files.keys());
  for (const name of files.keys()) {
    if (name.startsWith('/') || name.includes('\\') || name.split('/').some((part) => part === '..' || part === '.' || !part)) throw new Error('Invalid payload path.');
    const parts = name.split('/');
    while (parts.length > 1) { parts.pop(); allowed.add(`${parts.join('/')}/`); }
  }
  // An existing unknown file (including .env or node_modules) is an explicit
  // stop, never silently copied, uploaded or recursively deleted.
  validateStageEntries(await existingEntries(output), allowed);
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Symlink deployment root is not allowed.');
  const evidencePath = resolve(root, 'stage-evidence.json');
  const evidenceStat = await lstat(evidencePath).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (evidenceStat && (!evidenceStat.isFile() || evidenceStat.isSymbolicLink())) throw new Error('Evidence output must be a regular file.');
  await mkdir(output, { recursive: true });
  for (const [name, bytes] of files) {
    const path = resolve(output, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 1 || args[0] !== '--firebase-predeploy')) throw new Error('Invalid staging arguments.');
    // Firebase CLI supplies the selected project to predeploy hooks. Offline
    // staging remains credential/environment independent; deployment does not.
    if (args.length) assertDeploymentProject(process.env.GCLOUD_PROJECT);
    console.log(JSON.stringify(await stage(await buildPayload()), null, 2));
  }
  catch { console.error('Firebase staging failed. Inspect local source and the explicit file allowlist; no deployment was attempted.'); process.exitCode = 1; }
}
