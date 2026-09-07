#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';

export const PROJECT_ID = 'omnitwin-demo';
export const PROJECT_NUMBER = '679501553916';
export const PUBLIC_ASSET_BUCKET = 'omnitwin-demo-city-assets';
export const PUBLICATION_LIMITS = Object.freeze({manifestBytes:32*1024*1024,assetBytes:64*1024*1024,objects:40000,totalBytes:4*1024**3,concurrency:2,responseBytes:64*1024,requestTimeoutMs:30000});
const ROOTS = Object.freeze(['city-v2/manifest.json','demo-v2/manifest.json','demo-v2/spatial/manifest.json']);
const CACHE_CONTROL = 'public, max-age=31536000, immutable, no-transform';
const DELIVERY_POLICY = 'canonical-gzip-plus-opaque-gzip-alias-v1';
const EXCLUDED = Object.freeze(['city-v2.sourceLedger (upstream raw URLs)','city-v2.licenses (external documentation URLs)','compiler/provenance/sourceHashes (code and observed-source references, not upload assets)','unreferenced files and superseded generations','everything outside city-v2/ and demo-v2/']);
const privatePlans = new WeakMap();
const responseSignals = new WeakMap();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const validHash = value => typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value!==null && typeof value==='object' && !Array.isArray(value);
const fail = message => {throw new Error(message);};

function scopedPath(path) {
  if(typeof path!=='string'||path.length>500||! /^(city-v2|demo-v2)\//.test(path)||! /^[A-Za-z0-9_./-]+$/.test(path)||path.split('/').some(part=>!part||part.startsWith('.'))||! /\.(json|bin|pbf)(\.gz)?$/.test(path))fail('Asset path outside approved public scope.');
  return path;
}
function descriptorPath(manifestPath, url) {
  if(typeof url!=='string'||url.length>500||! /^[A-Za-z0-9_./-]+$/.test(url)||url.startsWith('/')||url.split('/').some(part=>!part||part==='.') )fail('Invalid asset path.');
  return scopedPath(posix.normalize(posix.join(posix.dirname(manifestPath),url)));
}
async function localFile(publicRoot, path, maximum) {
  scopedPath(path);
  const absolute=resolve(publicRoot,...path.split('/'));const physical=await realpath(absolute);
  const inside=relative(publicRoot,physical);
  if(isAbsolute(inside)||inside==='..'||inside.startsWith(`..${sep}`))fail('Asset path escapes the public directory.');
  scopedPath(inside.split(sep).join('/'));
  // A manifest cannot use a symlink/junction to change the meaning of its path.
  if(relative(absolute,physical)!=='')fail('Asset symlinks are not publishable.');
  const info=await stat(physical);
  if(!info.isFile()||info.size<0||info.size===0&&!path.endsWith('.bin')||info.size>maximum)fail(`Invalid asset size: ${path}`);
  return {absolute:physical,size:info.size};
}
async function digestStream(stream, maximum) {
  const sha=createHash('sha256');const md5=createHash('md5');let bytes=0;
  for await(const chunk of stream){bytes+=chunk.length;if(bytes>maximum){stream.destroy();fail('Asset exceeds bounded size.');}sha.update(chunk);md5.update(chunk);}
  return {bytes,sha256:sha.digest('hex'),md5Hash:md5.digest('base64')};
}
async function verifyFile(publicRoot, descriptor) {
  const file=await localFile(publicRoot,descriptor.path,PUBLICATION_LIMITS.assetBytes);
  if(file.size!==descriptor.bytes)fail(`Asset size mismatch: ${descriptor.path}`);
  const actual=await digestStream(createReadStream(file.absolute),descriptor.bytes);
  if(actual.sha256!==descriptor.sha256)fail(`Asset digest mismatch: ${descriptor.path}`);
  return actual;
}
async function verifyGzip(publicRoot, raw, gzip) {
  const file=await localFile(publicRoot,gzip.path,PUBLICATION_LIMITS.assetBytes);
  const input=createReadStream(file.absolute);const decoder=createGunzip();
  input.on('error',error=>decoder.destroy(error));input.pipe(decoder);
  try{const decoded=await digestStream(decoder,raw.bytes);if(decoded.bytes!==raw.bytes||decoded.sha256!==raw.sha256)fail(`Gzip/raw digest mismatch: ${raw.path}`);}
  finally{input.destroy();decoder.destroy();}
}
function normalizedDescriptor(manifestPath, value) {
  if(!object(value)||!validHash(value.sha256)||!Number.isSafeInteger(value.bytes)||value.bytes<0||value.bytes>PUBLICATION_LIMITS.assetBytes)fail('Invalid manifest asset descriptor.');
  const path=descriptorPath(manifestPath,value.url);
  if(value.bytes===0&&!path.endsWith('.bin'))fail('Empty non-binary asset descriptor.');
  return {path,sha256:value.sha256,bytes:value.bytes};
}
function contentType(path) {
  if(path.endsWith('.gz'))return 'application/gzip';
  if(path.endsWith('.json'))return 'application/json; charset=utf-8';
  if(path.endsWith('.pbf'))return 'application/vnd.mapbox-vector-tile';
  return 'application/octet-stream';
}

/** Offline only: inspect current manifest descriptors, never enumerate a directory. */
export async function planFirebaseCityAssets({publicRoot=resolve(import.meta.dirname,'../apps/web/public'),gzipAliases=true}={}) {
  if(gzipAliases!==true)fail('Both canonical and opaque gzip aliases are required.');
  publicRoot=await realpath(publicRoot);
  const manifests=new Map();const files=new Map();const deliveries=new Map();const gzipPairs=[];const rootManifestHashes={};
  let referencedBytes=0;
  function registerFile(file) {
    const previous=files.get(file.path);
    if(previous){if(previous.sha256!==file.sha256||previous.bytes!==file.bytes)fail(`Conflicting manifest descriptor: ${file.path}`);return previous;}
    referencedBytes+=file.bytes;
    if(files.size>=PUBLICATION_LIMITS.objects||referencedBytes>PUBLICATION_LIMITS.totalBytes)fail('Publication plan exceeds bounded asset budget.');
    files.set(file.path,file);return file;
  }
  function deliver(path,raw,stored,encoding) {
    const next={path,raw,stored,contentType:contentType(path),...(encoding?{contentEncoding:encoding}:{})};
    const previous=deliveries.get(path);
    if(previous&&JSON.stringify(previous)!==JSON.stringify(next))fail(`Conflicting delivery descriptor: ${path}`);
    deliveries.set(path,next);
  }
  function asset(manifestPath,value) {
    const raw=registerFile(normalizedDescriptor(manifestPath,value));
    if(value.gzip!==undefined){
      const gzip=registerFile(normalizedDescriptor(manifestPath,value.gzip));
      if(raw.path.endsWith('.gz')||gzip.path!==`${raw.path}.gz`)fail('Invalid gzip alias path.');
      gzipPairs.push({raw,gzip});deliver(raw.path,raw,gzip,'gzip');deliver(gzip.path,gzip,gzip);
    }else deliver(raw.path,raw,raw);
  }
  function arrayAssets(manifestPath, values, nested) {
    if(!Array.isArray(values)||values.length>PUBLICATION_LIMITS.objects)fail('Invalid manifest asset table.');
    for(const value of values){asset(manifestPath,value);nested?.(value);}
  }
  for(const path of ROOTS){
    const file=await localFile(publicRoot,path,PUBLICATION_LIMITS.manifestBytes);const bytes=await readFile(file.absolute);
    if(bytes.length!==file.size)fail('Manifest changed during planning.');
    const descriptor=registerFile({path,bytes:bytes.length,sha256:sha256(bytes)});
    manifests.set(path,JSON.parse(bytes.toString('utf8')));rootManifestHashes[path]=descriptor.sha256;deliver(path,descriptor,descriptor);
  }
  const city=manifests.get(ROOTS[0]);const population=manifests.get(ROOTS[1]);const spatial=manifests.get(ROOTS[2]);
  if(city.contract!=='DemoCityPackManifestV2'||city.semantics?.populationTagsImported!==false)fail('Unapproved public city manifest.');
  if(population.contract!=='DemoPopulationManifestV2'||population.datasetId!=='omnitwin-fictional-city-v2'||population.representation!=='fictional_demo'||population.scientificClaim!==false||population.predictiveValidation!==false)fail('Unapproved fictional population manifest.');
  if(spatial.contract!=='DemoSpatialManifestV2'||spatial.datasetId!==population.datasetId||spatial.representation!=='visual_synthesis'||spatial.scientificClaim!==false)fail('Unapproved fictional spatial manifest.');
  if(descriptorPath(ROOTS[1],population.spatial?.geographyManifestUrl)!==ROOTS[0]||population.spatial?.geographyManifestSha256!==rootManifestHashes[ROOTS[0]]||spatial.sourceHashes?.populationManifest!==rootManifestHashes[ROOTS[1]]||spatial.sourceHashes?.geographyManifest!==rootManifestHashes[ROOTS[0]]||spatial.sourceHashes?.buildingIndex!==city.buildingIndex?.sha256||spatial.sourceHashes?.roadIndex!==city.roadIndex?.sha256)fail('Current manifest binding mismatch.');
  for(const field of ['boundaries','buildingIndex','roadIndex'])asset(ROOTS[0],city[field]);
  for(const field of ['buildingPages','cells'])arrayAssets(ROOTS[0],city[field]);
  for(const field of ['personShards','householdShards'])arrayAssets(ROOTS[1],population[field]);
  for(const field of ['summaries','queryIndex'])asset(ROOTS[1],population[field]);
  const populationBuilding=normalizedDescriptor(ROOTS[1],population.spatial.buildingIndex);
  const cityBuilding=normalizedDescriptor(ROOTS[0],city.buildingIndex);
  if(JSON.stringify(populationBuilding)!==JSON.stringify(cityBuilding))fail('Population building index binding mismatch.');
  asset(ROOTS[1],population.spatial.buildingIndex);
  for(const field of ['targetShards','bindingShards','candidateCells'])arrayAssets(ROOTS[2],spatial[field]);
  arrayAssets(ROOTS[2],spatial.roleShards,role=>{
    if(!role.contexts)fail('Missing role context descriptor.');
    asset(ROOTS[2],role.contexts);
    if(!role.contexts.householdTripMasks)fail('Missing household trip-mask descriptor.');
    asset(ROOTS[2],role.contexts.householdTripMasks);
  });
  // Detect a new local runtime descriptor rather than silently omitting it.
  // This traversal discovers omissions only; it never authorizes more uploads.
  const excludedKeys=new Set(['sourceLedger','licenses','compilerSourceHashes','provenance','sourceHashes']);
  for(const [manifestPath,manifest] of manifests){
    const inspect=value=>{
      if(!value||typeof value!=='object')return;
      if(object(value)&&'url' in value&&('bytes' in value||'sha256' in value)){
        const descriptor=normalizedDescriptor(manifestPath,value);const known=files.get(descriptor.path);
        if(!known||known.sha256!==descriptor.sha256||known.bytes!==descriptor.bytes)fail(`Unrecognized manifest asset family: ${descriptor.path}`);
      }
      for(const child of Object.values(value))inspect(child);
    };
    for(const [key,value] of Object.entries(manifest))if(!excludedKeys.has(key))inspect(value);
  }
  // Verify the complete local closure before any caller can acquire auth/upload.
  for(const file of files.values())Object.assign(file,await verifyFile(publicRoot,file));
  for(const {raw,gzip} of gzipPairs)await verifyGzip(publicRoot,raw,gzip);
  const releaseId=sha256(JSON.stringify({contract:'FirebaseCityPublicationV1',delivery:DELIVERY_POLICY,rootManifestHashes}));
  const prefix=`packs/${releaseId}/`;
  const objects=[...deliveries.values()].sort((a,b)=>a.path.localeCompare(b.path,'en')).map(item=>Object.freeze({
    path:item.path,name:`${prefix}${item.path}`,rawBytes:item.raw.bytes,storedBytes:item.stored.bytes,
    sha256:item.stored.sha256,md5Hash:item.stored.md5Hash,contentType:item.contentType,
    ...(item.contentEncoding?{contentEncoding:item.contentEncoding}:{}),cacheControl:CACHE_CONTROL,
    metadata:Object.freeze({sha256:item.stored.sha256,storedBytes:String(item.stored.bytes),rawSha256:item.raw.sha256,rawBytes:String(item.raw.bytes),releaseId,projectId:PROJECT_ID,sourcePath:item.path}),
  }));
  const plan=Object.freeze({contract:'FirebaseCityPublicationV1',projectId:PROJECT_ID,projectNumber:PROJECT_NUMBER,releaseId,prefix,rootManifestHashes:Object.freeze(rootManifestHashes),objects:Object.freeze(objects),excludedFamilies:EXCLUDED,totalStoredBytes:objects.reduce((sum,item)=>sum+item.storedBytes,0),totalRawBytes:objects.reduce((sum,item)=>sum+item.rawBytes,0),verifiedFileCount:files.size,verifiedFileBytes:referencedBytes});
  privatePlans.set(plan,{publicRoot,files:[...files.values()],deliveries});return plan;
}

export function summarizeFirebaseCityPlan(plan) {
  if(!privatePlans.has(plan))fail('Expected an in-process verified publication plan.');
  return {contract:plan.contract,projectId:plan.projectId,projectNumber:plan.projectNumber,releaseId:plan.releaseId,prefix:plan.prefix,
    objectCount:plan.objects.length,canonicalGzipObjects:plan.objects.filter(o=>o.contentEncoding==='gzip').length,opaqueGzipAliases:plan.objects.filter(o=>o.path.endsWith('.gz')).length,
    totalStoredBytes:plan.totalStoredBytes,totalRawBytes:plan.totalRawBytes,verifiedFileCount:plan.verifiedFileCount,verifiedFileBytes:plan.verifiedFileBytes,
    rootManifestHashes:plan.rootManifestHashes,excludedFamilies:plan.excludedFamilies,concurrency:PUBLICATION_LIMITS.concurrency,
    accessStatus:'Upload does not grant public access or configure CORS.'};
}
async function guarded(task,signal,message) {
  let onAbort;
  const cancelled=new Promise((_,reject)=>{onAbort=()=>reject(new Error(message));if(signal.aborted)onAbort();else signal.addEventListener('abort',onAbort,{once:true});});
  try{return await Promise.race([task,cancelled]);}catch{fail(message);}
  finally{signal.removeEventListener('abort',onAbort);}
}
async function responseJson(response) {
  if(!response.body)fail('Missing storage metadata response.');
  const chunks=[];let bytes=0;const reader=response.body.getReader();const signal=responseSignals.get(response);
  try{
    for(;;){const {done,value}=await guarded(reader.read(),signal,'Storage metadata response could not be read safely.');if(done)break;bytes+=value.length;if(bytes>PUBLICATION_LIMITS.responseBytes)fail('Storage metadata exceeds bounded response size.');chunks.push(value);}
    try{return JSON.parse(Buffer.concat(chunks,bytes).toString('utf8'));}catch{fail('Invalid storage metadata response.');}
  }finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
}
function discardResponse(response) {
  // Best effort only: cancellation may itself reject with unsafe upstream text.
  try { void response.body?.cancel().catch(()=>{}); } catch { /* No response body is needed. */ }
}
function sameRemote(remote, expected) {
  return remote?.name===expected.name&&remote.size===String(expected.storedBytes)&&remote.md5Hash===expected.md5Hash
    &&remote.contentType===expected.contentType&&(remote.contentEncoding??'')===(expected.contentEncoding??'')&&remote.cacheControl===expected.cacheControl
    &&Object.entries(expected.metadata).every(([key,value])=>remote.metadata?.[key]===value);
}

/** Explicit upload entry point. No auth discovery, bucket mutation, ACL or overwrite operation exists. */
export async function publishFirebaseCityAssets(plan,{projectId=PROJECT_ID,bucket,getAccessToken,fetchImpl=fetch,signal:outerSignal}={}) {
  const local=privatePlans.get(plan);
  if(!local)fail('Expected an in-process verified publication plan.');
  if(projectId!==PROJECT_ID||bucket!==PUBLIC_ASSET_BUCKET||typeof getAccessToken!=='function'||typeof fetchImpl!=='function')fail('Explicit approved project, dedicated bucket and trusted auth provider required.');
  if(outerSignal?.aborted)fail('Publication cancelled.');
  // A build may have changed after the printed dry-run; reject it before auth.
  for(const file of local.files){if(outerSignal?.aborted)fail('Publication cancelled.');await verifyFile(local.publicRoot,file);}
  const abort=new AbortController();const baseSignal=outerSignal?AbortSignal.any([outerSignal,abort.signal]):abort.signal;
  async function request(url,options={}) {
    if(baseSignal.aborted)fail('Publication cancelled.');
    // One deadline includes auth, transport and metadata streaming. Passing the
    // signal lets cooperative providers cancel; the race also bounds stalled ones.
    const signal=AbortSignal.any([baseSignal,AbortSignal.timeout(PUBLICATION_LIMITS.requestTimeoutMs)]);
    const token=await guarded(Promise.resolve().then(()=>getAccessToken({signal})),signal,'Storage authentication provider failed or expired.');
    if(typeof token!=='string'||token.length>8192||! /^[A-Za-z0-9._~+/=-]+$/.test(token))fail('Storage authentication provider returned an invalid token.');
    const response=await guarded(Promise.resolve().then(()=>fetchImpl(url,{method:'GET',...options,headers:{...options.headers,Authorization:`Bearer ${token}`},credentials:'omit',redirect:'error',signal})),signal,'Storage request failed; resume by verifying existing objects on a new invocation.');
    responseSignals.set(response,signal);return response;
  }
  const bucketUrl=`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}`;
  const bucketResponse=await request(`${bucketUrl}?fields=name,projectNumber`);
  if(!bucketResponse.ok)fail(`Storage bucket verification failed (${bucketResponse.status}).`);
  const approvedBucket=await responseJson(bucketResponse);
  if(approvedBucket.name!==bucket||String(approvedBucket.projectNumber)!==PROJECT_NUMBER)fail('Storage bucket is not verified as belonging to the approved project.');
  async function existing(expected) {
    const response=await request(`${bucketUrl}/o/${encodeURIComponent(expected.name)}?fields=name,size,md5Hash,contentType,contentEncoding,cacheControl,metadata,generation`);
    if(response.status===404){discardResponse(response);return false;}
    if(!response.ok)fail(`Storage object lookup failed (${response.status}).`);
    if(!sameRemote(await responseJson(response),expected))fail(`Immutable object conflict: ${expected.path}`);
    return true;
  }
  async function upload(expected) {
    if(await existing(expected))return 'skipped';
    const delivery=local.deliveries.get(expected.path);const file=await localFile(local.publicRoot,delivery.stored.path,PUBLICATION_LIMITS.assetBytes);
    const bytes=await readFile(file.absolute);
    if(bytes.length!==expected.storedBytes||sha256(bytes)!==expected.sha256)fail(`Asset changed before upload: ${expected.path}`);
    const boundary=`omnitwin-${randomUUID()}`;
    const metadata={name:expected.name,contentType:expected.contentType,cacheControl:expected.cacheControl,...(expected.contentEncoding?{contentEncoding:expected.contentEncoding}:{}),md5Hash:expected.md5Hash,metadata:expected.metadata};
    const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${expected.contentType}\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const response=await request(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=multipart&ifGenerationMatch=0&name=${encodeURIComponent(expected.name)}`,{method:'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`,'Content-Length':String(body.length)},body});
    if(response.status===412){discardResponse(response);if(await existing(expected))return 'skipped';fail('Concurrent creation could not be verified; stopped.');}
    if(!response.ok)fail(`Immutable storage upload failed (${response.status}); no overwrite or retry was attempted.`);
    if(!sameRemote(await responseJson(response),expected))fail(`Uploaded object metadata mismatch: ${expected.path}`);
    return 'uploaded';
  }
  let firstError;let uploaded=0;let skipped=0;
  const runBatch=async(objects,concurrency)=>{
    let next=0;
    const worker=async()=>{
      try{while(!firstError&&next<objects.length){const result=await upload(objects[next++]);if(result==='uploaded')uploaded++;else skipped++;}}
      catch(error){firstError??=error;abort.abort();}
    };
    await Promise.all(Array.from({length:concurrency},worker));
    if(firstError)throw firstError;
  };
  await runBatch(plan.objects.filter(item=>!ROOTS.includes(item.path)),PUBLICATION_LIMITS.concurrency);
  // New root manifests cannot advertise leaves that this invocation has not yet
  // verified remotely. This is publication ordering, not mutable activation.
  await runBatch(ROOTS.map(path=>plan.objects.find(item=>item.path===path)),1);
  return {releaseId:plan.releaseId,prefix:plan.prefix,bucket,projectId:PROJECT_ID,uploaded,skipped,totalStoredBytes:plan.totalStoredBytes,
    manifestUrls:Object.fromEntries(ROOTS.map(path=>[path,`https://storage.googleapis.com/${bucket}/${plan.prefix}${path}`])),publicReady:false};
}

async function main(argv) {
  const values={};let execute=false;
  for(let i=0;i<argv.length;i++){
    const arg=argv[i];if(arg==='--execute'){execute=true;continue;}
    if(!['--public-root','--bucket','--expected-release'].includes(arg)||!argv[i+1]||argv[i+1].startsWith('--'))fail('Usage: node tools/publish-firebase-city-assets.mjs [--public-root PATH] [--execute --bucket NAME --expected-release SHA256]');
    if(values[arg]!==undefined)fail('Duplicate CLI option.');values[arg]=argv[++i];
  }
  const plan=await planFirebaseCityAssets({publicRoot:values['--public-root']});
  console.log(JSON.stringify({mode:execute?'verified-before-upload':'offline-dry-run',...summarizeFirebaseCityPlan(plan)},null,2));
  if(!execute)return;
  if(!values['--bucket']||values['--expected-release']!==plan.releaseId)fail('Execution requires an explicit bucket and the exact reviewed dry-run release hash.');
  const result=await publishFirebaseCityAssets(plan,{bucket:values['--bucket'],getAccessToken:async()=>process.env.FIREBASE_CITY_ASSET_ACCESS_TOKEN});
  console.log(JSON.stringify(result,null,2));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
