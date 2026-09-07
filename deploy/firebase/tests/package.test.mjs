import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, symlink, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {buildPayload, stage, PORTABLE_MODULES, validateStageEntries, existingEntries} from '../scripts/stage.mjs';
import {FUNCTION_OPTIONS, ALLOWED_ORIGIN} from '../template/policy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const payload = buildPayload();

test('function options explicitly bound scaling and avoid default full CPU', () => {
  assert.equal(ALLOWED_ORIGIN, 'https://arseniy24rus.github.io');
  assert.deepEqual(FUNCTION_OPTIONS, {region: 'europe-west1', minInstances: 0, maxInstances: 2, concurrency: 1, timeoutSeconds: 30, memory: '256MiB', cpu: 'gcf_gen1', serviceAccount: 'omnitwin-chat-runtime@omnitwin-demo.iam.gserviceaccount.com', cors: false, invoker: 'public'});
});

test('package contains only allowlisted portable modules and approved immutable profile data', async () => {
  const {files, evidence} = await payload;
  assert.deepEqual(PORTABLE_MODULES, ['config.mjs', 'handler.mjs', 'quota.mjs', 'sessions.mjs', 'openrouter.mjs', 'firestore.mjs', 'firebase-http.mjs', 'population-resolver.mjs']);
  for (const name of ['index.mjs', 'spatial.mjs']) {
    const bytes = await readFile(resolve(root, '../../shared/demo-population', name));
    assert.equal(hash(files.get(`data/demo-population/${name}`)), hash(bytes), 'server uses the exact shared frontend codec');
  }
  for (const path of files.keys()) assert.equal(/ydb|metadata-auth|\.env|\.secret|operator|prepare-yandex|node_modules|\.zip/i.test(path), false);
  assert.equal(hash(files.get('data/chat-profiles.json')), evidence.profileSha256);
  const manifest = JSON.parse(files.get('package.json'));
  assert.equal(manifest.engines.node, '22');
  assert.equal(manifest.dependencies['firebase-admin'], '14.3.0');
  assert.equal(manifest.dependencies['firebase-functions'], '7.3.2');
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['firebase-admin', 'firebase-functions']);
  assert.equal(manifest.scripts, undefined);
  assert.equal(files.get('package-lock.json').toString().includes('ydb-sdk'), false);
  assert.equal(evidence.deployed, false); assert.equal(evidence.liveInferenceVerified, false);
});

test('stage validation rejects extra files rather than copying or deleting them', async () => {
  assert.throws(() => validateStageEntries(['.env'], new Set(['index.mjs'])), /Unexpected/);
  assert.throws(() => validateStageEntries(['src/ydb.mjs'], new Set(['index.mjs'])), /Unexpected/);
  assert.doesNotThrow(() => validateStageEntries(['index.mjs'], new Set(['index.mjs'])));
  const built = await payload;
  await assert.rejects(stage({ ...built, files: new Map([...built.files, ['.env', Buffer.from('not-a-secret')]]) }), /Unexpected/);
  await assert.rejects(stage({ ...built, files: new Map([['index.mjs', Buffer.from('')]]) }), /Incomplete/);
});

test('staging rejects a directory junction without following it', async () => {
  const temp = await mkdtemp(resolve(tmpdir(), 'omnitwin-firebase-stage-test-'));
  const target = resolve(temp, 'outside');
  const stageRoot = resolve(temp, 'stage');
  try {
    await mkdir(target); await mkdir(stageRoot);
    await symlink(target, resolve(stageRoot, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(existingEntries(stageRoot), /Symlinks/);
  } finally {
    // Only the exact fresh test directory is removed, never deployment data.
    assert.ok(temp.startsWith(resolve(tmpdir(), 'omnitwin-firebase-stage-test-')));
    await rm(temp, { recursive: true, force: true });
  }
});

test('Firestore rules deny all client access and TTL deletes only expiresAt records asynchronously', async () => {
  const rules = await readFile(resolve(root, 'firestore.rules'), 'utf8');
  assert.match(rules, /allow read, write: if false;/);
  assert.equal(/allow .*if true/.test(rules), false);
  const indexes = JSON.parse(await readFile(resolve(root, 'firestore.indexes.json'), 'utf8'));
  assert.deepEqual(indexes.fieldOverrides, [{collectionGroup: 'demo_chat_state', fieldPath: 'expiresAt', ttl: true, indexes: []}]);
  const deployment = JSON.parse(await readFile(resolve(root, 'firebase.json'), 'utf8'));
  assert.equal(deployment.functions[0].source, 'functions');
  assert.equal(deployment.functions[0].runtime, 'nodejs22');
  assert.deepEqual(deployment.functions[0].predeploy, ['npm --prefix "$PROJECT_DIR" run stage']);
});

test('staged real Firebase export imports without credentials, initialization or network calls', async () => {
  await stage(await payload);
  const result = await exec(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {EventEmitter} from 'node:events';
    let calls=0;
    globalThis.fetch=async()=>{calls++;throw new Error('Network forbidden');};
    const entry=await import('./functions/index.mjs');
    assert.deepEqual(Object.keys(entry),['chatApi']);
    assert.equal(typeof entry.chatApi,'function');
    assert.equal(entry.chatApi.__endpoint.platform,'gcfv2');
    assert.equal(entry.chatApi.__endpoint.availableMemoryMb,256);
    assert.equal(entry.chatApi.__endpoint.timeoutSeconds,30);
    assert.equal(entry.chatApi.__endpoint.maxInstances,2);
    assert.equal(entry.chatApi.__endpoint.minInstances,0);
    assert.equal(entry.chatApi.__endpoint.concurrency,1);
    assert.equal(entry.chatApi.__endpoint.cpu,'gcf_gen1');
    assert.equal(entry.chatApi.__endpoint.serviceAccountEmail,'omnitwin-chat-runtime@omnitwin-demo.iam.gserviceaccount.com');
    assert.deepEqual(entry.chatApi.__endpoint.httpsTrigger.invoker,['public']);
    assert.deepEqual(entry.chatApi.__endpoint.region,['europe-west1']);
    assert.deepEqual(entry.chatApi.__endpoint.secretEnvironmentVariables.map(s=>s.key).sort(),['OPENROUTER_API_KEY','SESSION_SIGNING_SECRET']);
    const {getApps}=await import('firebase-admin/app');
    assert.equal(getApps().length,0);
    const response=Object.assign(new EventEmitter(),{headersSent:false,status(code){this.code=code;return this;},set(headers){this.headers=headers;return this;},send(body){this.body=body;this.emit('finish');return this;},end(){this.ended=true;this.emit('finish');return this;}});
    await entry.chatApi({method:'POST',path:'/session',headers:{origin:'https://arseniy24rus.github.io','content-type':'application/json'},rawBody:Buffer.from('{}'),query:{}},response);
    assert.equal(response.code,503);
    assert.deepEqual(JSON.parse(response.body),{source:'unavailable',reason:'service_not_configured'});
    assert.equal(response.headers['Access-Control-Allow-Origin'],'https://arseniy24rus.github.io');
    assert.equal(getApps().length,0);
    assert.equal(calls,0);
    const {loadConfig}=await import('./functions/src/config.mjs');
    const {PROFILE_MANIFEST_SHA256}=await import('./functions/approved-profile.mjs');
    const fixtureConfig={OPENROUTER_API_KEY:'test-only-not-a-provider-key',SESSION_SIGNING_SECRET:'test-only-session-material-at-least-32-bytes',ALLOWED_ORIGINS:'https://arseniy24rus.github.io',PROFILE_MANIFEST_SHA256};
    const config=await loadConfig(fixtureConfig,{storage:'firestore'});
    assert.deepEqual(config.firestore,{collection:'demo_chat_state'});
    assert.equal(config.ydb,undefined);
    assert.equal(config.profiles.size,${(await payload).evidence.profiles});
    const pinned={V2_POPULATION_MANIFEST_URL:'https://example.github.io/demo-v2/manifest.json',V2_POPULATION_MANIFEST_SHA256:'a'.repeat(64),V2_SPATIAL_MANIFEST_URL:'https://example.github.io/demo-v2/spatial/manifest.json',V2_SPATIAL_MANIFEST_SHA256:'b'.repeat(64)};
    const v2=await loadConfig({...fixtureConfig,...pinned},{storage:'firestore'});
    assert.equal(v2.acceptsDataset('omnitwin-fictional-city-v2'),true);
    assert.equal(v2.acceptsDataset(config.datasetId),true);
    assert.equal(v2.acceptsDataset('unapproved'),false);
    assert.match(v2.profileRevisionFor('omnitwin-fictional-city-v2'),/^[a-f0-9]{64}$/);
    assert.equal(v2.profileRevisionFor(config.datasetId),null);
    assert.equal(v2.canResolvePerson('omnitwin-fictional-city-v2','demo2-p-0000001'),true);
    assert.equal(v2.canResolvePerson('omnitwin-fictional-city-v2','malformed'),false);
    assert.equal(await v2.resolveProfile({datasetId:'omnitwin-fictional-city-v2',personId:'malformed'}),null);
    assert.equal(calls,0,'V2 configuration and invalid contexts never fetch the city');
    await assert.rejects(loadConfig({...fixtureConfig,PROFILE_MANIFEST_SHA256:'0'.repeat(64)},{storage:'firestore'}),/digest mismatch/);
    assert.equal(calls,0);
    assert.equal(getApps().length,0);
    process.stdout.write('firebase-source-import-safe');
  `], {cwd: root, env: {}, timeout: 20_000});
  assert.equal(result.stdout, 'firebase-source-import-safe'); assert.equal(result.stderr, '');
});
