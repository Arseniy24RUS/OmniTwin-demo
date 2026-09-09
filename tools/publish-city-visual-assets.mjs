#!/usr/bin/env node
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,realpath,stat,mkdir,writeFile,link,unlink} from 'node:fs/promises';
import {resolve,relative,isAbsolute,sep,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {collectCityVisualClosure,visualPath,VISUAL_PUBLICATION_LIMITS} from './visual-release/closure.mjs';
import {registerVisualPublicationPlan,readVisualPublicationPlan} from './visual-release/verified-plan.mjs';
import {publishFirebaseCityAssets,PROJECT_ID,PROJECT_NUMBER,PUBLIC_ASSET_BUCKET} from './publish-firebase-city-assets.mjs';

export {VISUAL_PUBLICATION_LIMITS};
const sha=b=>createHash('sha256').update(b).digest('hex');
const freeze=value=>{if(value&&typeof value==='object'){for(const entry of Object.values(value))freeze(entry);Object.freeze(value);}return value;};
const fail=message=>{throw Error(`Visual publication ${message}`);};
async function approvedFile(root,path,max){
  visualPath(path);const absolute=resolve(root,...path.split('/'));let physical,info;
  try{physical=await realpath(absolute);info=await stat(physical);}catch{fail(`file missing or unreadable: ${path}`);}
  const part=relative(root,physical);
  if(!part||isAbsolute(part)||part==='..'||part.startsWith(`..${sep}`)||relative(absolute,physical)!=='')fail(`symlink or path escape: ${path}`);
  if(!info.isFile()||info.size<1||info.size>max)fail(`file size invalid: ${path}`);return {absolute:physical,size:info.size};
}
async function verify(root,entry){
  const file=await approvedFile(root,entry.path,VISUAL_PUBLICATION_LIMITS.glbBytes);
  if(file.size!==entry.bytes)fail(`asset size changed: ${entry.path}`);
  const hash=createHash('sha256');let bytes=0;
  for await(const chunk of createReadStream(file.absolute)){bytes+=chunk.length;if(bytes>entry.bytes)fail(`asset size changed: ${entry.path}`);hash.update(chunk);}
  if(bytes!==entry.bytes||hash.digest('hex')!==entry.sha256)fail(`asset digest changed: ${entry.path}`);
}
function mime(path){return path.endsWith('.glb')?'model/gltf-binary':path.endsWith('.jpg')||path.endsWith('.jpeg')?'image/jpeg':path.endsWith('.png')?'image/png':'application/json; charset=utf-8';}

/** Offline preparation only. Exact catalog closure, bounded reads, no directory
 * discovery, auth lookup, network, public pointer mutation or asset copying. */
export async function planCityVisualAssets({visualRoot=resolve(import.meta.dirname,'../apps/web/public/city-visual-v1'),requireComplete=true}={}){
  let root;try{root=await realpath(resolve(visualRoot));}catch{fail('root directory unavailable');}
  const closure=await collectCityVisualClosure({requireComplete,read:async(path,expected,max)=>{
    const file=await approvedFile(root,path,max);if(expected&&file.size!==expected.bytes)fail(`asset size mismatch: ${path}`);
    const body=await readFile(file.absolute);if(body.length!==file.size)fail(`asset changed during read: ${path}`);return body;
  }});
  const releaseId=sha(JSON.stringify({contract:'CityVisualPublicationV1',delivery:'identity-encoded-relative-closure-v1',root:closure.root}));
  const prefix=`packs/${releaseId}/city-visual-v1/`,baseUrl=`https://storage.googleapis.com/${PUBLIC_ASSET_BUCKET}/${prefix}`;
  const objects=closure.files.map(file=>({path:file.path,name:prefix+file.path,rawBytes:file.bytes,storedBytes:file.bytes,sha256:file.sha256,md5Hash:file.md5Hash,
    contentType:mime(file.path),cacheControl:'public, max-age=31536000, immutable, no-transform',
    metadata:{sha256:file.sha256,storedBytes:String(file.bytes),rawSha256:file.sha256,rawBytes:String(file.bytes),releaseId,projectId:PROJECT_ID,sourcePath:`city-visual-v1/${file.path}`}}));
  const activation={contract:'CityVisualActivationV1',version:1,populationDatasetId:closure.populationDatasetId,sourceDatasetVersion:closure.lineage.datasetVersion,
    manifest:{url:baseUrl+'manifest.json',...closure.root}};
  const plan=freeze({contract:'CityVisualPublicationV1',version:1,projectId:PROJECT_ID,projectNumber:PROJECT_NUMBER,bucket:PUBLIC_ASSET_BUCKET,
    releaseId,prefix,objects,activation,totalStoredBytes:closure.totalBytes,verifiedFileCount:objects.length,
    rootManifestHashes:{'manifest.json':closure.root.sha256},dependentManifestHashes:Object.fromEntries(closure.manifestOrder.filter(path=>path!=='manifest.json').map(path=>[path,closure.files.find(file=>file.path===path).sha256])),
    catalog:closure.catalog,source:closure.lineage,requireComplete,publicReady:false});
  registerVisualPublicationPlan(plan,{
    rootPaths:['manifest.json'],dependentManifests:closure.manifestOrder.filter(path=>path!=='manifest.json'),
    revalidate:async signal=>{for(const file of closure.files){if(signal?.aborted)fail('cancelled before auth');await verify(root,file);}},
    readStoredBody:async expected=>{const file=await approvedFile(root,expected.path,VISUAL_PUBLICATION_LIMITS.glbBytes);return readFile(file.absolute);},
  });
  return plan;
}
export function summarizeCityVisualPlan(plan){
  if(!readVisualPublicationPlan(plan))fail('requires an in-process verified plan');
  return {contract:plan.contract,version:1,projectId:PROJECT_ID,projectNumber:PROJECT_NUMBER,bucket:PUBLIC_ASSET_BUCKET,releaseId:plan.releaseId,prefix:plan.prefix,
    objectCount:plan.objects.length,totalStoredBytes:plan.totalStoredBytes,activation:plan.activation,catalog:plan.catalog,source:plan.source,
    rootManifestHashes:plan.rootManifestHashes,publicReady:false,
    excluded:['unreferenced files and old catalog generations','compiler receipts and source/provenance URLs','bundled Pages actor assets','population/raw/scientific inputs'],
    immutable:true,concurrency:2,requiresPublicByteAndCorsVerification:true};
}
export async function publishCityVisualAssets(plan,options){
  if(!readVisualPublicationPlan(plan))fail('requires an in-process verified plan');
  if(!plan.requireComplete||plan.catalog.coverage.status!=='complete')fail('partial catalog is dry-run only');
  const receipt=await publishFirebaseCityAssets(plan,options);return {...receipt,activation:plan.activation,publicReady:false};
}
/** Immutable local reports: publish a fully written sibling using a create-only
 * hard link. Existing different bytes fail; no runtime configuration is replaced. */
export async function writeVisualPublicationReport(path,value){
  const target=resolve(path),directory=dirname(target);await mkdir(directory,{recursive:true});
  if(await realpath(directory)!==directory)fail('report directory symlink is not allowed');
  const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n'),temporary=join(directory,`.visual-report-${randomUUID()}.pending`);
  try{
    await writeFile(temporary,bytes,{flag:'wx'});
    try{await link(temporary,target);}catch(error){
      if(error.code!=='EEXIST')throw error;
      if(await realpath(target)!==target||!bytes.equals(await readFile(target)))fail('immutable report already exists with different bytes');
    }
  }finally{try{await unlink(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
}
async function main(argv){
  const options={};let execute=false,requireComplete=true;
  for(let i=0;i<argv.length;i++){
    const flag=argv[i];if(flag==='--execute'){if(execute)fail('duplicate execute flag');execute=true;continue;}
    if(flag==='--allow-partial-dry-run'){requireComplete=false;continue;}
    if(!['--visual-root','--report-dir','--bucket','--expected-release'].includes(flag)||!argv[i+1]||argv[i+1].startsWith('--')||options[flag]!==undefined)fail('invalid or duplicate CLI option');
    options[flag]=argv[++i];
  }
  const plan=await planCityVisualAssets({visualRoot:options['--visual-root'],requireComplete}),summary=summarizeCityVisualPlan(plan);
  console.log(JSON.stringify({mode:execute?'verified-before-upload':'offline-dry-run',...summary},null,2));
  if(options['--report-dir'])await writeVisualPublicationReport(join(options['--report-dir'],`plan-${plan.releaseId}.json`),summary);
  if(!execute)return;
  if(options['--bucket']!==PUBLIC_ASSET_BUCKET||options['--expected-release']!==plan.releaseId)fail('execute requires dedicated bucket and exact reviewed release SHA');
  const receipt=await publishCityVisualAssets(plan,{bucket:options['--bucket'],getAccessToken:async()=>process.env.FIREBASE_CITY_ASSET_ACCESS_TOKEN});
  if(options['--report-dir'])await writeVisualPublicationReport(join(options['--report-dir'],`receipt-${plan.releaseId}.json`),receipt);
  console.log(JSON.stringify(receipt,null,2));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
