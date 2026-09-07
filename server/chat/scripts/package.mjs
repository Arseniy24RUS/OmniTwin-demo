import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { validateManifest } from '../src/config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const repository = resolve(root, '../..');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const profilePath = resolve(repository, 'apps/web/public/demo/chat-profiles.json');
const profileBytes = await readFile(profilePath);
const manifest = JSON.parse(await readFile(resolve(repository, 'apps/web/public/demo/manifest.json'), 'utf8'));
const profileHash = sha256(profileBytes);
const approved = validateManifest(JSON.parse(profileBytes.toString('utf8')));
if (manifest.assets?.chatProfiles?.sha256 !== profileHash || manifest.datasetId !== approved.datasetId) throw new Error('Profile source is not the manifest-approved immutable asset.');

const files = {};
async function add(path, archivePath) { files[archivePath] = [new Uint8Array(await readFile(path)), { mtime: new Date('2026-01-01T00:00:00Z') }]; }
for (const name of ['index.js', 'package.json', 'package-lock.json']) await add(resolve(root, name), name);
for (const entry of (await readdir(resolve(root, 'src'), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!entry.isFile() || !entry.name.endsWith('.mjs')) throw new Error('Unexpected server source file.');
  await add(resolve(root, 'src', entry.name), `src/${entry.name}`);
}
await add(profilePath, 'data/chat-profiles.json');
await add(resolve(repository, 'apps/web/src/demo/data/fictionalProfile.mjs'), 'data/fictionalProfile.mjs');
// Explicit allowlist: never traverse the repository, .env, credentials, tests or
// node_modules. Yandex installs the locked production dependencies at deployment.
const zipped = zipSync(files, { level: 6 });
const out = resolve(root, 'dist');
await mkdir(out, { recursive: true });
const archive = resolve(out, 'demo-chat-function.zip');
await writeFile(archive, zipped);
const evidence = {
  artifact: relative(root, archive).replaceAll('\\', '/'), sha256: sha256(zipped), bytes: zipped.length,
  datasetId: approved.datasetId, profiles: approved.profiles.size, profileSha256: profileHash,
  profileModuleSha256: sha256(files['data/fictionalProfile.mjs'][0]), files: Object.keys(files).sort(),
  dependencies: 'Yandex npm ci --production from included package-lock.json',
  liveInferenceVerified: false, deployed: false,
};
await writeFile(resolve(out, 'package-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
