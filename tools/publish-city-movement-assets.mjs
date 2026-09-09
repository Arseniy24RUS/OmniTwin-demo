#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {readFile,stat,realpath} from 'node:fs/promises';
import {resolve,relative,isAbsolute,sep,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {collectMovementClosure,movementPath,MOVEMENT_PUBLICATION_LIMITS as LIMITS} from './movement-release/closure.mjs';
import {registerMovementPublicationPlan,readMovementPublicationPlan} from './movement-release/verified-plan.mjs';
import {publishFirebaseCityAssets,PROJECT_ID,PROJECT_NUMBER,PUBLIC_ASSET_BUCKET} from './publish-firebase-city-assets.mjs';
import {writeVisualPublicationReport} from './publish-city-visual-assets.mjs';
const ROOT=resolve(import.meta.dirname,'..'),SHA='625391b37ea50add3c40c4ad715124e8fcf395cbd5610f55bc7f5a68b74a7245';
const BASES={population:'demo-v2/manifest.json',spatial:'demo-v2/spatial/manifest.json',geography:'city-v2/manifest.json'};
const CODE={populationCodec:'index.mjs',spatialCodec:'spatial.mjs',codec:'movement-index.mjs',movementRoadPolicy:'movement-road-policy.mjs'};
const hash=b=>createHash('sha256').update(b).digest('hex'),fail=m=>{throw Error(`Movement publication ${m}`);};
const freeze=v=>{if(v&&typeof v==='object'){for(const item of Object.values(v))freeze(item);Object.freeze(v);}return v;};
async function body(root,path,expected,max){
  movementPath(path);const absolute=resolve(root,...path.split('/'));let physical,info;
  try{physical=await realpath(absolute);info=await stat(physical);}catch{fail(`file missing: ${path}`);}
  const part=relative(root,physical);if(!part||isAbsolute(part)||part==='..'||part.startsWith(`..${sep}`)||relative(absolute,physical)!=='')fail(`symlink or path escape: ${path}`);
  if(!info.isFile()||info.size<1||info.size>max||expected&&info.size!==expected.bytes)fail(`file size changed: ${path}`);
  const bytes=await readFile(physical);if(bytes.length!==info.size||expected&&hash(bytes)!==expected.sha256)fail(`file digest changed: ${path}`);return bytes;
}
export async function planCityMovementAssets({overlayRoot=join(ROOT,'.cache/movement-mode-v2'),publicRoot=join(ROOT,'apps/web/public'),manifestName=`manifest-${SHA.slice(0,16)}.json`,manifestSha256=SHA}={}){
  const root=await realpath(resolve(overlayRoot)),source=await realpath(resolve(publicRoot)),bases={},sourceFiles=[];
  for(const[key,path]of Object.entries(BASES)){const bytes=await body(source,path,null,8*1024*1024),sha256=hash(bytes);bases[key]={sha256,manifest:JSON.parse(bytes)};sourceFiles.push({path,bytes:bytes.length,sha256});}
  const codeHashes={};for(const[key,path]of Object.entries(CODE))codeHashes[key]=hash(await readFile(join(ROOT,'shared/demo-population',path)));
  const closure=await collectMovementClosure({manifestName,manifestSha256,bases,codeHashes,read:(path,expected,max)=>body(root,path,expected,max)});
  const releaseId=hash(JSON.stringify({contract:'CityMovementPublicationV1',delivery:'gzip-canonical-and-opaque-alias-v1',root:{path:closure.root.path,bytes:closure.root.bytes,sha256:closure.root.sha256}}));
  const prefix=`packs/${releaseId}/movement-overlay-v2/`,objects=closure.deliveries.map(item=>({path:item.path,name:prefix+item.path,rawBytes:item.raw.bytes,storedBytes:item.stored.bytes,sha256:item.stored.sha256,md5Hash:item.stored.md5Hash,
    contentType:item.path.endsWith('.gz')?'application/gzip':'application/json; charset=utf-8',...(item.contentEncoding?{contentEncoding:item.contentEncoding}:{}),cacheControl:'public, max-age=31536000, immutable, no-transform',
    metadata:{sha256:item.stored.sha256,storedBytes:String(item.stored.bytes),rawSha256:item.raw.sha256,rawBytes:String(item.raw.bytes),releaseId,projectId:PROJECT_ID,sourcePath:`movement-overlay-v2/${item.path}`}}));
  const activation={contract:'CityMovementActivationV1',version:1,datasetId:closure.manifest.datasetId,presentation:'bounded_source_overlay',chatCompatibility:'pending',baseHashes:closure.manifest.baseHashes,
    manifest:{url:`https://storage.googleapis.com/${PUBLIC_ASSET_BUCKET}/${prefix}${manifestName}`,bytes:closure.root.bytes,sha256:closure.root.sha256}};
  const plan=freeze({contract:'CityMovementPublicationV1',version:1,projectId:PROJECT_ID,projectNumber:PROJECT_NUMBER,bucket:PUBLIC_ASSET_BUCKET,releaseId,prefix,objects,activation,
    totalStoredBytes:objects.reduce((sum,item)=>sum+item.storedBytes,0),verifiedFileBytes:closure.totalBytes,verifiedFileCount:closure.files.length,rootManifestHashes:{[manifestName]:manifestSha256},stats:closure.stats,sourceCodeHashes:codeHashes,publicReady:false});
  registerMovementPublicationPlan(plan,{rootPaths:[manifestName],dependentManifests:[],revalidate:async signal=>{
    for(const file of sourceFiles){if(signal?.aborted)fail('cancelled');await body(source,file.path,file,8*1024*1024);}
    for(const[key,path]of Object.entries(CODE))if(hash(await readFile(join(ROOT,'shared/demo-population',path)))!==codeHashes[key])fail('source codec changed');
    for(const file of closure.files){if(signal?.aborted)fail('cancelled');await body(root,file.path,file,LIMITS.assetBytes);}
  },readStoredBody:async expected=>{const item=closure.deliveries.find(item=>item.path===expected.path);return body(root,item.stored.path,item.stored,LIMITS.assetBytes);}});
  return plan;
}
export function summarizeCityMovementPlan(plan){if(!readMovementPublicationPlan(plan))fail('verified in-process plan required');return {contract:plan.contract,version:1,releaseId:plan.releaseId,prefix:plan.prefix,bucket:PUBLIC_ASSET_BUCKET,
  objectCount:plan.objects.length,totalStoredBytes:plan.totalStoredBytes,verifiedFileBytes:plan.verifiedFileBytes,activation:plan.activation,stats:plan.stats,sourceCodeHashes:plan.sourceCodeHashes,publicReady:false,
  excluded:['source population/spatial/geography manifests and source shards','unreferenced files, receipts and mutable activation pointers'],concurrency:2};}
export async function publishCityMovementAssets(plan,options){if(!readMovementPublicationPlan(plan))fail('verified in-process plan required');const receipt=await publishFirebaseCityAssets(plan,options);return {...receipt,activation:plan.activation,publicReady:false};}
async function main(argv){const options={};let execute=false;for(let i=0;i<argv.length;i++){const key=argv[i];if(key==='--execute'&&!execute){execute=true;continue;}
  if(!['--overlay-root','--public-root','--manifest-name','--manifest-sha','--report-dir','--bucket','--expected-release'].includes(key)||options[key]!==undefined||!argv[i+1]||argv[i+1].startsWith('--'))fail('invalid CLI option');options[key]=argv[++i];}
  const plan=await planCityMovementAssets({overlayRoot:options['--overlay-root'],publicRoot:options['--public-root'],manifestName:options['--manifest-name'],manifestSha256:options['--manifest-sha']}),summary=summarizeCityMovementPlan(plan);console.log(JSON.stringify({mode:execute?'verified-before-upload':'offline-dry-run',...summary},null,2));
  if(options['--report-dir'])await writeVisualPublicationReport(join(options['--report-dir'],`plan-${plan.releaseId}.json`),summary);if(!execute)return;
  if(options['--bucket']!==PUBLIC_ASSET_BUCKET||options['--expected-release']!==plan.releaseId)fail('execute requires exact reviewed release and dedicated bucket');
  const receipt=await publishCityMovementAssets(plan,{bucket:options['--bucket'],getAccessToken:async()=>process.env.FIREBASE_CITY_ASSET_ACCESS_TOKEN});
  if(options['--report-dir'])await writeVisualPublicationReport(join(options['--report-dir'],`receipt-${plan.releaseId}.json`),receipt);console.log(JSON.stringify(receipt,null,2));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
