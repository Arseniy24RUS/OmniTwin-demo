import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;

export function validateManifest(manifest) {
  if (manifest?.representation !== 'fictional_demo' || manifest.scientificClaim !== false || !text(manifest.datasetId, 100) || !Array.isArray(manifest.profiles) || manifest.profiles.length === 0 || manifest.profiles.length > 25_000) throw new Error('Invalid approved profile manifest.');
  const profiles = new Map();
  for (const raw of manifest.profiles) {
    if (!text(raw.id, 100) || profiles.has(raw.id) || !text(raw.name, 100) || !['male', 'female'].includes(raw.sex) || !text(raw.occupation, 160) || !text(raw.biography, 1200) || !Number.isInteger(raw.birthYear) || raw.birthYear < 1900 || raw.birthYear > 2036 || !raw.membership || typeof raw.membership !== 'object') throw new Error('Invalid approved profile.');
    const membership = {};
    for (const [scenario, dates] of Object.entries(raw.membership)) {
      if (!['baseline', 'inflow', 'ageing'].includes(scenario) || !Number.isInteger(dates.entryYear) || dates.entryYear < 1900 || dates.entryYear > 2036 || !(dates.exitYear === null || (Number.isInteger(dates.exitYear) && dates.exitYear > dates.entryYear))) throw new Error('Invalid profile membership.');
      membership[scenario] = { entryYear: dates.entryYear, exitYear: dates.exitYear };
    }
    if (Object.keys(membership).length === 0 || !Array.isArray(raw.interests) || raw.interests.length > 8 || raw.interests.some((value) => !text(value, 100))) throw new Error('Invalid profile interests.');
    const householdSizes = {};
    for (const scenario of Object.keys(membership)) {
      const sizes = raw.householdSizes?.[scenario];
      if (!Array.isArray(sizes) || sizes.length !== 11 || sizes.some((size) => size !== null && (!Number.isSafeInteger(size) || size < 1 || size > 100))) throw new Error('Invalid profile household sizes.');
      householdSizes[scenario] = [...sizes];
    }
    // Only reviewed fields cross the system-context boundary; unrelated fields
    // in the public dataset can never become model instructions automatically.
    profiles.set(raw.id, Object.freeze({ id: raw.id, sex: raw.sex, name: raw.name, birthYear: raw.birthYear, occupation: raw.occupation, biography: raw.biography, interests: [...raw.interests], membership, householdSizes }));
  }
  return { datasetId: manifest.datasetId, profiles };
}

export function validateStorageConfiguration(env, { storage = 'ydb' } = {}) {
  if (storage === 'firestore') {
    const collection = env.FIRESTORE_COLLECTION ?? 'demo_chat_state';
    if (typeof collection !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(collection)) throw new Error('Invalid Firestore collection.');
    return { firestore: { collection } };
  }
  if (storage !== 'ydb' || !text(env.YDB_ENDPOINT, 1000) || !text(env.YDB_DATABASE, 1000)) throw new Error('Missing storage configuration.');
  return { ydb: { endpoint: env.YDB_ENDPOINT, database: env.YDB_DATABASE, table: env.YDB_TABLE ?? 'demo_chat_state' } };
}

export async function loadConfig(env = process.env, options = {}) {
  const storageConfig = validateStorageConfiguration(env, options);
  const required = ['OPENROUTER_API_KEY', 'SESSION_SIGNING_SECRET', 'ALLOWED_ORIGINS', 'PROFILE_MANIFEST_SHA256'];
  if (required.some((key) => typeof env[key] !== 'string' || env[key].length === 0)) throw new Error('Missing server configuration.');
  const origins = env.ALLOWED_ORIGINS.split(',').map((value) => value.trim());
  if (!origins.length || origins.length > 5 || origins.some((value) => { try { const url = new URL(value); return url.protocol !== 'https:' || url.origin !== value; } catch { return true; } })) throw new Error('Invalid allowed origins.');
  if (Buffer.byteLength(env.SESSION_SIGNING_SECRET) < 32 || !/^[a-f0-9]{64}$/.test(env.PROFILE_MANIFEST_SHA256)) throw new Error('Invalid secret or manifest digest configuration.');
  const path = resolve(root, env.PROFILE_MANIFEST_PATH ?? 'data/chat-profiles.json');
  if (relative(root, path).startsWith('..') || path === root) throw new Error('Manifest must be inside the deployment artifact.');
  const bytes = await readFile(path);
  if (bytes.length > 20_000_000 || createHash('sha256').update(bytes).digest('hex') !== env.PROFILE_MANIFEST_SHA256) throw new Error('Approved manifest digest mismatch.');
  const approved = validateManifest(JSON.parse(bytes.toString('utf8')));
  // The packaging script includes the same reviewed, pure fictional-profile
  // module as the frontend. No client biography or arbitrary module URL is used.
  const { fictionalProfile } = await import(pathToFileURL(resolve(root, 'data/fictionalProfile.mjs')).href);
  const profileForYear = (profile, year, scenario) => {
    const householdSize = profile.householdSizes[scenario][year - 2026];
    if (!Number.isSafeInteger(householdSize)) throw new Error('Missing approved household state.');
    const generated = fictionalProfile(profile, year, scenario, approved.datasetId, householdSize, undefined);
    return { ...profile, name: generated.name, occupation: generated.occupation, biography: generated.biography, interests: generated.interests, householdSize };
  };
  return { ...approved, profileForYear, origins, sessionSecret: env.SESSION_SIGNING_SECRET, profileHash: env.PROFILE_MANIFEST_SHA256, apiKey: env.OPENROUTER_API_KEY, ...storageConfig };
}
